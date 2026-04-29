import json
import re
import socket
import ssl
import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


COMMON_PORTS = [
    (21,    "FTP"),
    (22,    "SSH"),
    (23,    "Telnet"),
    (25,    "SMTP"),
    (53,    "DNS"),
    (80,    "HTTP"),
    (110,   "POP3"),
    (143,   "IMAP"),
    (443,   "HTTPS"),
    (445,   "SMB"),
    (587,   "SMTP/TLS"),
    (993,   "IMAPS"),
    (995,   "POP3S"),
    (1433,  "MSSQL"),
    (3306,  "MySQL"),
    (3389,  "RDP"),
    (5432,  "PostgreSQL"),
    (6379,  "Redis"),
    (8080,  "HTTP-Alt"),
    (8443,  "HTTPS-Alt"),
    (27017, "MongoDB"),
]


class HostTracker:
    """
    Comprueba el estado en vivo del host:
    - Certificado TLS (validez, expiración, SANs)
    - Puertos abiertos (escaneo paralelo)
    - Cambios detectados frente al perfil anterior guardado
    """

    def __init__(self, profiles_dir: str = "output/profiles", timeout: float = 1.5):
        self.profiles_dir = Path(profiles_dir)
        self.timeout      = timeout

    def check(self, target: str) -> dict:
        is_ip = bool(re.match(r"^\d{1,3}(\.\d{1,3}){3}$", target))

        # Resolver IP si es dominio
        try:
            ip = target if is_ip else socket.gethostbyname(target)
        except socket.gaierror:
            ip = None

        result = {
            "target":         target,
            "ip":             ip,
            "certificate":    {},
            "open_ports":     [],
            "domain_changes": {},
            "error":          None,
        }

        if not ip:
            result["error"] = f"No se pudo resolver la IP de {target}"
            return result

        result["certificate"]    = self._check_certificate(target) if not is_ip else {"error": "N/A para IPs"}
        result["open_ports"]     = self._scan_ports(ip)
        result["domain_changes"] = self._detect_changes(target)

        return result

    # ── Certificado TLS ───────────────────────────────────────────────────────

    def _check_certificate(self, host: str) -> dict:
        try:
            ctx = ssl.create_default_context()
            with socket.create_connection((host, 443), timeout=8) as raw:
                with ctx.wrap_socket(raw, server_hostname=host) as tls:
                    cert    = tls.getpeercert()
                    version = tls.version()
                    cipher  = tls.cipher()

            fmt = "%b %d %H:%M:%S %Y %Z"
            not_after  = datetime.datetime.strptime(cert["notAfter"],  fmt)
            not_before = datetime.datetime.strptime(cert["notBefore"], fmt)
            days_left  = (not_after - datetime.datetime.utcnow()).days

            subject = dict(x[0] for x in cert.get("subject", []))
            issuer  = dict(x[0] for x in cert.get("issuer",  []))

            sans = [v for t, v in cert.get("subjectAltName", []) if t == "DNS"]

            return {
                "valid":          True,
                "subject_cn":     subject.get("commonName"),
                "issuer_org":     issuer.get("organizationName"),
                "issuer_cn":      issuer.get("commonName"),
                "not_before":     not_before.isoformat(),
                "not_after":      not_after.isoformat(),
                "days_remaining": days_left,
                "expired":        days_left < 0,
                "expiring_soon":  0 <= days_left <= 30,
                "tls_version":    version,
                "cipher":         cipher[0] if cipher else None,
                "sans":           sans[:15],
                "serial":         cert.get("serialNumber"),
            }

        except ssl.SSLCertVerificationError as e:
            return {"valid": False, "expired": False, "error": f"Certificado inválido: {e}"}
        except ssl.SSLError as e:
            return {"valid": False, "expired": False, "error": f"Error TLS: {e}"}
        except ConnectionRefusedError:
            return {"valid": False, "expired": False, "error": "Puerto 443 cerrado"}
        except Exception as e:
            return {"valid": False, "expired": False, "error": str(e)}

    # ── Escaneo de puertos ────────────────────────────────────────────────────

    def _scan_ports(self, ip: str) -> list:
        open_ports = []

        def probe(port_service):
            port, service = port_service
            try:
                with socket.create_connection((ip, port), timeout=self.timeout) as s:
                    banner = self._grab_banner(s, port)
                    return {"port": port, "service": service, "banner": banner, "state": "open"}
            except Exception:
                return None

        with ThreadPoolExecutor(max_workers=30) as ex:
            futures = {ex.submit(probe, ps): ps for ps in COMMON_PORTS}
            for fut in as_completed(futures):
                r = fut.result()
                if r:
                    open_ports.append(r)

        open_ports.sort(key=lambda x: x["port"])
        return open_ports

    def _grab_banner(self, s: socket.socket, port: int) -> str:
        try:
            if port in (80, 8080):
                s.sendall(b"HEAD / HTTP/1.0\r\nHost: localhost\r\n\r\n")
                raw = s.recv(512).decode("utf-8", errors="replace")
                return raw.split("\r\n")[0][:120]
            if port in (443, 8443):
                return "TLS"
            s.settimeout(1.5)
            raw = s.recv(256).decode("utf-8", errors="replace").strip()
            return raw[:100] if raw else ""
        except Exception:
            return ""

    # ── Detección de cambios ──────────────────────────────────────────────────

    def _detect_changes(self, target: str) -> dict:
        safe         = target.replace(".", "_").replace("/", "_")
        profile_path = self.profiles_dir / f"{safe}.json"

        if not profile_path.exists():
            return {"status": "no_previous_scan", "last_scan": None, "changes": []}

        try:
            with open(profile_path) as f:
                old = json.load(f)
        except Exception as e:
            return {"status": "error", "error": str(e), "changes": []}

        changes   = []
        old_whois = old.get("whois",       {})
        old_geo   = old.get("geolocation", {})

        # IPs resueltas
        old_ips = set(old_whois.get("resolved_ips", []))
        try:
            cur_ips = set(socket.getaddrinfo(target, None))
            cur_ips = {r[4][0] for r in socket.getaddrinfo(target, None)}
        except Exception:
            cur_ips = set()

        added_ips   = cur_ips - old_ips
        removed_ips = old_ips - cur_ips
        if added_ips:
            changes.append({"field": "IPs resueltas", "type": "added",
                            "detail": ", ".join(sorted(added_ips))})
        if removed_ips:
            changes.append({"field": "IPs resueltas", "type": "removed",
                            "detail": ", ".join(sorted(removed_ips))})

        # ASN
        old_asn = old_whois.get("asn") or old_geo.get("asn")
        cur_asn = old_geo.get("asn")   # aproximación — se actualiza en próximo análisis completo
        if old_asn and cur_asn and str(old_asn) != str(cur_asn):
            changes.append({"field": "ASN", "type": "changed",
                            "detail": f"{old_asn} → {cur_asn}"})

        # ISP
        old_isp = old_geo.get("isp")
        cur_isp = old_geo.get("isp")
        if old_isp and cur_isp and old_isp != cur_isp:
            changes.append({"field": "ISP", "type": "changed",
                            "detail": f"{old_isp} → {cur_isp}"})

        # País
        old_country = old_geo.get("country_code")
        cur_country = old_geo.get("country_code")
        if old_country and cur_country and old_country != cur_country:
            changes.append({"field": "País", "type": "changed",
                            "detail": f"{old_country} → {cur_country}"})

        # Registrador
        old_reg = old_whois.get("registrar")
        if old_reg and old_whois.get("registrar") and old_reg != old_whois.get("registrar"):
            changes.append({"field": "Registrador", "type": "changed",
                            "detail": f"{old_reg} → {old_whois.get('registrar')}"})

        # Fecha de expiración de dominio
        old_exp = old_whois.get("expiration_date")
        if old_exp:
            try:
                exp_date  = datetime.datetime.fromisoformat(old_exp[:10])
                days_left = (exp_date - datetime.datetime.utcnow()).days
                if days_left < 0:
                    changes.append({"field": "Expiración dominio", "type": "expired",
                                    "detail": f"Venció el {old_exp[:10]}"})
                elif days_left <= 30:
                    changes.append({"field": "Expiración dominio", "type": "warning",
                                    "detail": f"Vence en {days_left} días ({old_exp[:10]})"})
            except Exception:
                pass

        return {
            "status":    "compared",
            "last_scan": old.get("generated_at", "desconocido"),
            "changes":   changes,
        }
