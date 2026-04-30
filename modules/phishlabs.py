import requests


class PhishLabsClient:
    """Busca casos en PhishLabs (Case Data API) relacionados con un target."""

    DATA_URL  = "https://api.phishlabs.com/pdapi/cases"
    MAX_PAGES = 1    # 1 × 200 = 200 casos más recientes (la API tarda ~17s/página)
    PAGE_SIZE = 200

    def __init__(self, username: str, password: str):
        self.auth = (username, password) if username and password else None

    def query(self, target: str) -> dict:
        if not self.auth:
            return {"error": "Credenciales PhishLabs no configuradas", "cases": [], "total_searched": 0}

        domain = target.lower().strip().lstrip("www.")

        matches        = []
        total_searched = 0

        for page in range(self.MAX_PAGES):
            payload = {
                "maxRecords": self.PAGE_SIZE,
                "offset":     page * self.PAGE_SIZE,
            }
            try:
                resp = requests.post(
                    self.DATA_URL,
                    json=payload,
                    auth=self.auth,
                    timeout=20,
                )
                resp.raise_for_status()
                data = resp.json()
            except Exception as exc:
                return {"error": str(exc), "cases": matches, "total_searched": total_searched}

            cases = data.get("data") or []
            total_searched += len(cases)

            for case in cases:
                if self._matches(case, domain, target):
                    matches.append(self._summarize(case, domain))

            if len(cases) < self.PAGE_SIZE:
                break

        return {
            "cases":          matches,
            "total_searched": total_searched,
            "found":          len(matches),
            "target":         target,
        }

    # ── helpers ──────────────────────────────────────────────────────────────

    def _matches(self, case: dict, domain: str, original: str) -> bool:
        title = (case.get("title") or "").lower()
        if domain in title or original.lower() in title:
            return True
        for src in case.get("attackSources") or []:
            src_domain = (src.get("domain") or "").lower()
            src_fqdn   = (src.get("fqdn")   or "").lower()
            src_url    = (src.get("url")     or "").lower()
            if domain in src_domain or domain in src_fqdn or domain in src_url:
                return True
        return False

    def _summarize(self, case: dict, domain: str) -> dict:
        sources = []
        for src in case.get("attackSources") or []:
            sources.append({
                "url":      src.get("url", ""),
                "url_type": src.get("urlType", ""),
                "ip":       src.get("ipAddress", ""),
                "country":  src.get("country", ""),
                "isp":      src.get("isp", ""),
                "brands":   src.get("targetedBrands", []),
                "screenshot": src.get("screenshot_url", ""),
            })
        return {
            "case_id":      case.get("caseId", ""),
            "case_number":  case.get("caseNumber"),
            "title":        case.get("title", ""),
            "case_type":    case.get("caseType", ""),
            "case_status":  case.get("caseStatus", ""),
            "brand":        case.get("brand", ""),
            "date_created": case.get("dateCreated", ""),
            "date_closed":  case.get("dateClosed", ""),
            "source_name":  case.get("sourceName", ""),
            "customer":     case.get("customer", ""),
            "attack_sources": sources,
        }
