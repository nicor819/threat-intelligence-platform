import requests
import time
import re


class VirusTotalClient:
    """Consulta reputación en VirusTotal v3 API."""

    BASE = "https://www.virustotal.com/api/v3"

    def __init__(self, api_key: str, delay: float = 1.0):
        self.headers = {"x-apikey": api_key}
        self.delay = delay
        self.enabled = bool(api_key)

    def query(self, target: str) -> dict:
        if not self.enabled:
            return {"error": "API key no configurada", "target": target}

        endpoint = self._get_endpoint(target)
        try:
            resp = requests.get(
                f"{self.BASE}/{endpoint}/{target}",
                headers=self.headers,
                timeout=15,
            )
            time.sleep(self.delay)

            if resp.status_code == 404:
                return {"target": target, "found": False}
            if resp.status_code == 401:
                return {"error": "API key inválida"}
            if resp.status_code == 429:
                return {"error": "Rate limit alcanzado"}

            resp.raise_for_status()
            return self._parse_response(target, resp.json())

        except requests.RequestException as e:
            return {"target": target, "error": str(e)}

    def _get_endpoint(self, target: str) -> str:
        if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", target):
            return "ip_addresses"
        return "domains"

    def _parse_response(self, target: str, data: dict) -> dict:
        attrs = data.get("data", {}).get("attributes", {})
        stats = attrs.get("last_analysis_stats", {})
        votes = attrs.get("total_votes", {})

        result = {
            "target": target,
            "found": True,
            "malicious": stats.get("malicious", 0),
            "suspicious": stats.get("suspicious", 0),
            "harmless": stats.get("harmless", 0),
            "undetected": stats.get("undetected", 0),
            "reputation_score": attrs.get("reputation", None),
            "community_harmless": votes.get("harmless", 0),
            "community_malicious": votes.get("malicious", 0),
            "tags": attrs.get("tags", []),
            "categories": attrs.get("categories", {}),
            "last_analysis_date": attrs.get("last_analysis_date", None),
            "threat_verdict": self._verdict(stats),
        }

        # Motores que lo detectaron como malicioso
        analysis = attrs.get("last_analysis_results", {})
        result["detections"] = [
            {"engine": engine, "result": info.get("result"), "category": info.get("category")}
            for engine, info in analysis.items()
            if info.get("category") in ("malicious", "suspicious")
        ][:20]  # top 20

        return result

    def _verdict(self, stats: dict) -> str:
        mal = stats.get("malicious", 0)
        sus = stats.get("suspicious", 0)
        if mal >= 5:
            return "MALICIOUS"
        if mal > 0 or sus >= 3:
            return "SUSPICIOUS"
        if sus > 0:
            return "LOW_RISK"
        return "CLEAN"
