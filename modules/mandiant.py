import base64
import re
import time
import requests


class MandiantClient:
    """
    Integración con Mandiant Threat Intelligence API v4.
    Consulta indicadores (IP, dominio, URL), actores de amenaza,
    familias de malware y campañas asociadas.
    """

    BASE = "https://api.intelligence.mandiant.com"

    def __init__(self, key_id: str, key_secret: str):
        self.key_id     = key_id
        self.key_secret = key_secret
        self.enabled    = bool(key_id and key_secret)
        self._token        = None
        self._token_expiry = 0.0

    # ── Auth ──────────────────────────────────────────────────────────────────

    def _get_token(self) -> str:
        if self._token and time.time() < self._token_expiry:
            return self._token

        creds = base64.b64encode(f"{self.key_id}:{self.key_secret}".encode()).decode()
        r = requests.post(
            f"{self.BASE}/token",
            headers={
                "Authorization": f"Basic {creds}",
                "Content-Type":  "application/x-www-form-urlencoded",
                "X-App-Name":    "ThreatIntelPlatform/1.0",
            },
            data="grant_type=client_credentials",
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        self._token        = data["access_token"]
        self._token_expiry = time.time() + data.get("expires_in", 3600) - 60
        return self._token

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._get_token()}",
            "Accept":        "application/json",
            "X-App-Name":    "ThreatIntelPlatform/1.0",
        }

    def _get(self, path: str, params: dict = None) -> dict | None:
        try:
            r = requests.get(
                f"{self.BASE}{path}",
                headers=self._headers(),
                params=params or {},
                timeout=15,
            )
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:
                return None
        except Exception:
            pass
        return None

    # ── Public entry point ────────────────────────────────────────────────────

    def query(self, target: str) -> dict:
        if not self.enabled:
            return {"error": "API keys de Mandiant no configuradas", "target": target}

        result = {
            "target":         target,
            "indicator":      None,
            "threat_actors":  [],
            "malware":        [],
            "campaigns":      [],
            "reports":        [],
            "mscore":         None,
            "verdict":        None,
            "categories":     [],
            "first_seen":     None,
            "last_seen":      None,
            "error":          None,
        }

        try:
            itype = self._indicator_type(target)

            # 1. Datos del indicador
            ind = self._get(f"/v4/indicator/{itype}/{target}")
            if not ind:
                # Fallback: búsqueda general
                search = self._get("/v4/indicator", {"search": target, "limit": 1})
                indicators = (search or {}).get("indicators", [])
                ind = indicators[0] if indicators else None

            if not ind:
                result["verdict"] = "NOT_FOUND"
                return result

            result["indicator"] = ind
            result["mscore"]    = ind.get("mscore")
            result["verdict"]   = self._verdict(ind.get("mscore"))
            result["first_seen"]= ind.get("first_seen")
            result["last_seen"] = ind.get("last_seen")
            result["categories"]= ind.get("categories", [])

            # 2. Actores de amenaza asociados
            actors = self._get(f"/v4/indicator/{itype}/{target}/threat-actors")
            if actors:
                result["threat_actors"] = [
                    {
                        "name":        a.get("name"),
                        "aliases":     a.get("aliases", [])[:4],
                        "motivation":  a.get("motivations", [{}])[0].get("name") if a.get("motivations") else None,
                        "country":     a.get("country_name"),
                        "industries":  [i.get("name") for i in a.get("industries", [])[:4]],
                        "description": (a.get("description") or "")[:300],
                        "profile_url": f"https://advantage.mandiant.com/threat-actors/{a.get('id','')}",
                    }
                    for a in actors.get("threat-actors", [])[:5]
                ]

            # 3. Familias de malware
            mal = self._get(f"/v4/indicator/{itype}/{target}/malware-families")
            if mal:
                result["malware"] = [
                    {
                        "name":        m.get("name"),
                        "aliases":     m.get("aliases", [])[:4],
                        "description": (m.get("description") or "")[:200],
                        "roles":       [r.get("name") for r in m.get("roles", [])],
                        "capabilities":[c.get("name") for c in m.get("capabilities", [])[:6]],
                    }
                    for m in mal.get("malware-families", [])[:5]
                ]

            # 4. Campañas
            camp = self._get(f"/v4/indicator/{itype}/{target}/campaigns")
            if camp:
                result["campaigns"] = [
                    {
                        "name":        c.get("name"),
                        "short_name":  c.get("short_name"),
                        "profile_url": f"https://advantage.mandiant.com/campaigns/{c.get('id','')}",
                    }
                    for c in camp.get("campaigns", [])[:5]
                ]

            # 5. Reportes relacionados
            rpts = self._get(f"/v4/indicator/{itype}/{target}/reports")
            if rpts:
                result["reports"] = [
                    {
                        "title":        r.get("title"),
                        "published":    r.get("published_date"),
                        "report_type":  r.get("report_type"),
                        "threat_detail":r.get("threat_detail"),
                        "url":          f"https://advantage.mandiant.com/reports/{r.get('report_id','')}",
                    }
                    for r in rpts.get("reports", [])[:5]
                ]

        except Exception as e:
            result["error"] = str(e)

        return result

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _indicator_type(self, target: str) -> str:
        if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", target):
            return "ipv4"
        if target.startswith("http"):
            return "url"
        return "fqdn"

    def _verdict(self, mscore: int | None) -> str:
        if mscore is None:
            return "UNKNOWN"
        if mscore >= 80:
            return "MALICIOUS"
        if mscore >= 50:
            return "SUSPICIOUS"
        if mscore >= 20:
            return "LOW_RISK"
        return "CLEAN"
