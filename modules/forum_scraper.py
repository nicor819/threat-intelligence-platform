import requests
import time
import re
from bs4 import BeautifulSoup
from urllib.parse import quote_plus


HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; ThreatProfileBot/1.0; +security-research)",
    "Accept-Language": "en-US,en;q=0.9",
}


class ForumScraper:
    """
    Busca menciones del indicador en fuentes de inteligencia de amenazas.
    OTX y ThreatFox usan autenticación cuando hay API key disponible.
    """

    def __init__(self, shodan_key: str = "", alienvault_key: str = "",
                 threatfox_key: str = "", max_pages: int = 3, delay: float = 1.5):
        self.shodan_key     = shodan_key
        self.alienvault_key = alienvault_key
        self.threatfox_key  = threatfox_key
        self.max_pages      = max_pages
        self.delay          = delay

    def search(self, target: str) -> dict:
        results = {
            "target": target,
            "otx_pulse_count": 0,
            "otx_pulses": [],
            "urlhaus": [],
            "threatfox": [],
            "shodan_summary": None,
            "errors": [],
        }

        self._query_otx(target, results)
        time.sleep(self.delay)

        self._query_urlhaus(target, results)
        time.sleep(self.delay)

        self._query_threatfox(target, results)
        time.sleep(self.delay)

        if self.shodan_key:
            self._query_shodan(target, results)

        return results

    # ── AlienVault OTX ────────────────────────────────────────────────────────
    def _query_otx(self, target: str, results: dict):
        itype = "IPv4" if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", target) else "domain"
        url   = f"https://otx.alienvault.com/api/v1/indicators/{itype}/{target}/general"
        hdrs  = {**HEADERS}
        if self.alienvault_key:
            hdrs["X-OTX-API-KEY"] = self.alienvault_key
        try:
            r = requests.get(url, headers=hdrs, timeout=10)
            if r.status_code == 200:
                data   = r.json()
                pulses = data.get("pulse_info", {})
                results["otx_pulse_count"] = pulses.get("count", 0)
                results["otx_pulses"] = [
                    {
                        "name":        p.get("name"),
                        "author":      p.get("author_name"),
                        "tags":        p.get("tags", [])[:5],
                        "created":     p.get("created"),
                        "tlp":         p.get("tlp"),
                        "description": p.get("description", "")[:200],
                        "malware_families": p.get("malware_families", []),
                        "attack_ids":  [a.get("display_name") for a in p.get("attack_ids", [])],
                    }
                    for p in pulses.get("pulses", [])[:15]
                ]
                # Datos adicionales solo disponibles con key autenticada
                results["otx_reputation"]    = data.get("reputation", 0)
                results["otx_country"]       = data.get("country_code")
                results["otx_asn"]           = data.get("asn")
                results["otx_malware_count"] = data.get("malware", {}).get("count", 0)
                results["otx_url_count"]     = data.get("url_list", {}).get("count", 0)
        except Exception as e:
            results["errors"].append(f"OTX: {e}")

    # ── URLhaus (abuse.ch) ─────────────────────────────────────────────────────
    def _query_urlhaus(self, target: str, results: dict):
        try:
            payload = {}
            if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", target):
                payload = {"host": target}
            else:
                payload = {"host": target}

            r = requests.post(
                "https://urlhaus-api.abuse.ch/v1/host/",
                data=payload,
                headers=HEADERS,
                timeout=10,
            )
            if r.status_code == 200:
                data = r.json()
                if data.get("query_status") == "is_host":
                    urls = data.get("urls", [])[:10]
                    results["urlhaus"] = [
                        {
                            "url": u.get("url"),
                            "url_status": u.get("url_status"),
                            "threat": u.get("threat"),
                            "tags": u.get("tags", []),
                            "date_added": u.get("date_added"),
                        }
                        for u in urls
                    ]
        except Exception as e:
            results["errors"].append(f"URLhaus: {e}")

    # ── ThreatFox (abuse.ch) ───────────────────────────────────────────────────
    def _query_threatfox(self, target: str, results: dict):
        try:
            payload = {"query": "search_ioc", "search_term": target}
            if self.threatfox_key:
                payload["auth_key"] = self.threatfox_key
            r = requests.post(
                "https://threatfox-api.abuse.ch/api/v1/",
                json=payload,
                headers=HEADERS,
                timeout=10,
            )
            if r.status_code == 200:
                data = r.json()
                if data.get("query_status") == "ok":
                    results["threatfox"] = [
                        {
                            "ioc":          i.get("ioc"),
                            "ioc_type":     i.get("ioc_type"),
                            "threat_type":  i.get("threat_type"),
                            "malware":      i.get("malware"),
                            "malware_alias":i.get("malware_alias", ""),
                            "malware_malpedia": i.get("malware_malpedia", ""),
                            "confidence":   i.get("confidence_level"),
                            "first_seen":   i.get("first_seen"),
                            "last_seen":    i.get("last_seen"),
                            "reporter":     i.get("reporter"),
                            "tags":         i.get("tags", []),
                            "reference":    i.get("reference", ""),
                        }
                        for i in data.get("data", [])[:15]
                    ]
        except Exception as e:
            results["errors"].append(f"ThreatFox: {e}")

    # ── Shodan (requiere clave) ────────────────────────────────────────────────
    def _query_shodan(self, target: str, results: dict):
        if not re.match(r"^\d{1,3}(\.\d{1,3}){3}$", target):
            return
        try:
            r = requests.get(
                f"https://api.shodan.io/shodan/host/{target}",
                params={"key": self.shodan_key},
                timeout=10,
            )
            if r.status_code == 200:
                data = r.json()
                results["shodan_summary"] = {
                    "ports": data.get("ports", []),
                    "hostnames": data.get("hostnames", []),
                    "os": data.get("os"),
                    "tags": data.get("tags", []),
                    "vulns": list(data.get("vulns", {}).keys())[:10],
                    "last_update": data.get("last_update"),
                }
        except Exception as e:
            results["errors"].append(f"Shodan: {e}")
