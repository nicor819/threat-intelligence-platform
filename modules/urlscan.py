import time
import requests


class URLScanClient:
    """
    Integración con URLScan.io:
    - Busca escaneos previos del dominio/IP (sin consumir cuota de escaneo).
    - Si no hay resultados previos, lanza un escaneo nuevo y espera el resultado.
    """

    BASE    = "https://urlscan.io/api/v1"
    HEADERS = {"Content-Type": "application/json"}

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.enabled = bool(api_key)
        if api_key:
            self.HEADERS["API-Key"] = api_key

    def query(self, target: str, original_url: str = "") -> dict:
        if not self.enabled:
            return {"error": "API key de URLScan no configurada", "target": target}

        # Usar la URL original si está disponible (da mejores resultados)
        url_to_scan = original_url if (original_url and original_url.startswith("http")) else f"https://{target}"

        result = {
            "target": target,
            "scanned_url": url_to_scan,
            "existing_results": [],
            "latest_scan": None,
            "new_scan": None,
            "verdicts": {},
            "screenshot_url": None,
            "dom_url": None,
            "error": None,
        }

        # 1. Buscar escaneos previos
        existing = self._search(target)
        result["existing_results"] = existing[:5]

        if existing:
            # Cargar el más reciente
            latest_uuid = existing[0].get("_id")
            if latest_uuid:
                detail = self._get_result(latest_uuid)
                if detail:
                    result["latest_scan"] = self._parse_result(detail)
                    result["verdicts"]       = result["latest_scan"].get("verdicts", {})
                    result["screenshot_url"] = result["latest_scan"].get("screenshot_url")
                    result["dom_url"]        = result["latest_scan"].get("dom_url")
            return result

        # 2. Sin resultados previos → lanzar escaneo nuevo
        scan = self._submit_scan(url_to_scan)
        if not scan:
            result["error"] = "No se pudo lanzar el escaneo"
            return result

        scan_uuid = scan.get("uuid")
        result["new_scan"] = {"uuid": scan_uuid, "api_url": scan.get("api"), "status": "pending"}

        # Esperar hasta 45s
        detail = self._poll_result(scan_uuid, retries=9, wait=5)
        if detail:
            parsed = self._parse_result(detail)
            result["new_scan"]       = parsed
            result["verdicts"]       = parsed.get("verdicts", {})
            result["screenshot_url"] = parsed.get("screenshot_url")
            result["dom_url"]        = parsed.get("dom_url")
        else:
            result["new_scan"]["status"] = "timeout — consulta más tarde"

        return result

    # ── Internos ──────────────────────────────────────────────────────────────

    def _search(self, target: str) -> list:
        try:
            r = requests.get(
                f"{self.BASE}/search/",
                params={"q": f"domain:{target} OR page.ip:{target}", "size": 5, "sort": "date:desc"},
                headers=self.HEADERS,
                timeout=10,
            )
            if r.status_code == 200:
                return r.json().get("results", [])
        except Exception:
            pass
        return []

    def _submit_scan(self, url: str) -> dict | None:
        try:
            r = requests.post(
                f"{self.BASE}/scan/",
                json={"url": url, "visibility": "public"},
                headers=self.HEADERS,
                timeout=10,
            )
            if r.status_code in (200, 201):
                return r.json()
            if r.status_code == 400:
                pass  # URL ya escaneada recientemente
        except Exception:
            pass
        return None

    def _poll_result(self, uuid: str, retries: int = 9, wait: int = 5) -> dict | None:
        for _ in range(retries):
            time.sleep(wait)
            result = self._get_result(uuid)
            if result:
                return result
        return None

    def _get_result(self, uuid: str) -> dict | None:
        try:
            r = requests.get(f"{self.BASE}/result/{uuid}/", headers=self.HEADERS, timeout=10)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        return None

    def _parse_result(self, data: dict) -> dict:
        page     = data.get("page", {})
        verdicts = data.get("verdicts", {})
        meta     = data.get("meta", {})
        lists    = data.get("lists", {})
        stats    = data.get("stats", {})
        task     = data.get("task", {})

        overall = verdicts.get("overall", {})
        vt_v    = verdicts.get("urlscan", {})
        engines = verdicts.get("engines", {})

        return {
            "uuid":            data.get("_id") or task.get("uuid"),
            "scan_date":       task.get("time"),
            "url":             page.get("url"),
            "domain":          page.get("domain"),
            "ip":              page.get("ip"),
            "country":         page.get("country"),
            "server":          page.get("server"),
            "status_code":     page.get("status"),
            "title":           page.get("title"),
            "tls_issuer":      page.get("tlsIssuer"),
            "tls_valid_days":  page.get("tlsValidDays"),
            "verdicts": {
                "malicious":   overall.get("malicious", False),
                "score":       overall.get("score", 0),
                "tags":        overall.get("tags", []),
                "brands":      overall.get("brands", []),
                "categories":  overall.get("categories", []),
                "urlscan_score":   vt_v.get("score", 0),
                "engine_malicious": engines.get("malicious", 0),
                "engine_benign":    engines.get("benign", 0),
            },
            "screenshot_url":  f"https://urlscan.io/screenshots/{data.get('_id') or task.get('uuid')}.png",
            "dom_url":         f"https://urlscan.io/dom/{data.get('_id') or task.get('uuid')}/",
            "report_url":      f"https://urlscan.io/result/{data.get('_id') or task.get('uuid')}/",
            "ips":             lists.get("ips", [])[:10],
            "domains":         lists.get("domains", [])[:10],
            "urls":            lists.get("urls", [])[:10],
            "certificates":    [c.get("subjectName") for c in lists.get("certificates", [])[:5]],
            "requests_total":  stats.get("requests", {}).get("total", 0),
            "ads_blocked":     stats.get("adBlocked", 0),
        }
