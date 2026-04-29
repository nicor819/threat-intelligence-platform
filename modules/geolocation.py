import requests
import re


class GeoLocator:
    """Geolocalización de IPs usando ip-api.com (gratuito, sin clave)."""

    BATCH_URL = "http://ip-api.com/batch"
    SINGLE_URL = "http://ip-api.com/json/{ip}"
    FIELDS = "status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,mobile,proxy,hosting,query"

    def locate(self, target: str) -> dict:
        ip = self._resolve_to_ip(target)
        if not ip:
            return {"target": target, "error": "No se pudo resolver a IP"}

        try:
            resp = requests.get(
                self.SINGLE_URL.format(ip=ip),
                params={"fields": self.FIELDS},
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()

            if data.get("status") == "fail":
                return {"target": target, "ip": ip, "error": data.get("message", "fallo")}

            return {
                "target": target,
                "ip": ip,
                "country": data.get("country"),
                "country_code": data.get("countryCode"),
                "region": data.get("regionName"),
                "city": data.get("city"),
                "latitude": data.get("lat"),
                "longitude": data.get("lon"),
                "timezone": data.get("timezone"),
                "isp": data.get("isp"),
                "org": data.get("org"),
                "asn": data.get("as"),
                "asn_name": data.get("asname"),
                "is_mobile": data.get("mobile", False),
                "is_proxy": data.get("proxy", False),
                "is_hosting": data.get("hosting", False),
                "flags": self._build_flags(data),
            }
        except requests.RequestException as e:
            return {"target": target, "ip": ip, "error": str(e)}

    def _resolve_to_ip(self, target: str) -> str | None:
        if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", target):
            return target
        import socket
        try:
            return socket.gethostbyname(target)
        except Exception:
            return None

    def _build_flags(self, data: dict) -> list:
        flags = []
        if data.get("proxy"):
            flags.append("PROXY/VPN")
        if data.get("hosting"):
            flags.append("HOSTING/DATACENTER")
        if data.get("mobile"):
            flags.append("MOBILE_NETWORK")
        return flags
