import re
import requests


class SOCRadarClient:
    """
    Integración con SOCRadar Threat Intelligence API.
    Consulta reputación, categorías de amenaza, actores asociados
    y menciones en dark web para IPs y dominios.
    """

    BASE = "https://platform.socradar.com/api"

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.enabled = bool(api_key)

    def query(self, target: str) -> dict:
        if not self.enabled:
            return {"error": "API key de SOCRadar no configurada", "target": target}

        # Verificar conectividad con el endpoint base
        try:
            probe = requests.get(f"{self.BASE}/", timeout=5)
        except Exception as e:
            return {"error": f"SOCRadar API inaccesible: {e}", "target": target,
                    "verdict": "UNKNOWN", "risk_score": None}

        result = {
            "target":         target,
            "risk_score":     None,
            "verdict":        None,
            "categories":     [],
            "threat_actors":  [],
            "malware_families": [],
            "tags":           [],
            "first_seen":     None,
            "last_seen":      None,
            "country":        None,
            "asn":            None,
            "isp":            None,
            "is_vpn":         False,
            "is_tor":         False,
            "is_proxy":       False,
            "darkweb_mentions": [],
            "related_iocs":   [],
            "raw":            {},
            "error":          None,
        }

        try:
            is_ip = bool(re.match(r"^\d{1,3}(\.\d{1,3}){3}$", target))
            if is_ip:
                self._query_ip(target, result)
            else:
                self._query_domain(target, result)
        except Exception as e:
            result["error"] = str(e)

        return result

    # ── IP ────────────────────────────────────────────────────────────────────

    def _query_ip(self, ip: str, result: dict):
        # Score / reputación
        data = self._get("/v2/socradar_labs/ip_score/", {"ip": ip})
        if data:
            result["raw"] = data
            result["risk_score"] = data.get("score") or data.get("risk_score")
            result["verdict"]    = self._verdict(result["risk_score"])
            result["categories"] = data.get("categories", []) or data.get("classification", [])
            result["tags"]       = data.get("tags", [])
            result["country"]    = data.get("country_code") or data.get("country")
            result["asn"]        = data.get("asn") or data.get("as_number")
            result["isp"]        = data.get("isp") or data.get("organization")
            result["is_vpn"]     = bool(data.get("is_vpn") or data.get("vpn"))
            result["is_tor"]     = bool(data.get("is_tor") or data.get("tor"))
            result["is_proxy"]   = bool(data.get("is_proxy") or data.get("proxy"))
            result["first_seen"] = data.get("first_seen")
            result["last_seen"]  = data.get("last_seen")

            # Actores y malware pueden venir en el mismo response
            result["threat_actors"]    = self._extract_list(data, ["threat_actors", "actors"])
            result["malware_families"] = self._extract_list(data, ["malware_families", "malware"])

        # Intentar endpoint de threat intelligence general
        ti = self._get("/threat/intelligence/", {"type": "ip", "value": ip})
        if ti:
            self._merge_ti(ti, result)

    # ── Domain ────────────────────────────────────────────────────────────────

    def _query_domain(self, domain: str, result: dict):
        data = self._get("/v2/socradar_labs/domain_score/", {"domain": domain})
        if not data:
            data = self._get("/v2/socradar_labs/ip_score/", {"domain": domain})
        if data:
            result["raw"]        = data
            result["risk_score"] = data.get("score") or data.get("risk_score")
            result["verdict"]    = self._verdict(result["risk_score"])
            result["categories"] = data.get("categories", []) or data.get("classification", [])
            result["tags"]       = data.get("tags", [])
            result["first_seen"] = data.get("first_seen")
            result["last_seen"]  = data.get("last_seen")
            result["threat_actors"]    = self._extract_list(data, ["threat_actors", "actors"])
            result["malware_families"] = self._extract_list(data, ["malware_families", "malware"])

        ti = self._get("/threat/intelligence/", {"type": "domain", "value": domain})
        if ti:
            self._merge_ti(ti, result)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _get(self, path: str, params: dict = None) -> dict | None:
        p = {"api_key": self.api_key, **(params or {})}
        try:
            r = requests.get(f"{self.BASE}{path}", params=p, timeout=12)
            if r.status_code == 200:
                data = r.json()
                # SOCRadar envuelve errores en distintos campos
                if isinstance(data, dict) and data.get("is_successful") is False:
                    return None
                return data
        except Exception:
            pass
        return None

    def _verdict(self, score) -> str:
        if score is None:
            return "UNKNOWN"
        try:
            score = float(score)
        except (ValueError, TypeError):
            return "UNKNOWN"
        if score >= 75:
            return "MALICIOUS"
        if score >= 50:
            return "SUSPICIOUS"
        if score >= 25:
            return "LOW_RISK"
        return "CLEAN"

    def _extract_list(self, data: dict, keys: list) -> list:
        for k in keys:
            val = data.get(k)
            if val:
                if isinstance(val, list):
                    return [str(v) if not isinstance(v, dict) else v.get("name", str(v)) for v in val]
                if isinstance(val, str):
                    return [val]
        return []

    def _merge_ti(self, ti: dict, result: dict):
        items = ti if isinstance(ti, list) else ti.get("results", ti.get("data", []))
        if not isinstance(items, list):
            return
        for item in items[:10]:
            actor = item.get("threat_actor") or item.get("actor")
            if actor and actor not in result["threat_actors"]:
                result["threat_actors"].append(actor)
            malware = item.get("malware") or item.get("malware_family")
            if malware and malware not in result["malware_families"]:
                result["malware_families"].append(malware)
            ioc = item.get("ioc") or item.get("indicator")
            if ioc:
                result["related_iocs"].append({
                    "value": ioc,
                    "type":  item.get("ioc_type", "ioc"),
                    "context": item.get("context", ""),
                })
