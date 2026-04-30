"""
Módulo de reporte de URLs maliciosas a múltiples plataformas.
Cada función devuelve {"ok": bool, "message": str}.
"""
import os
import requests


def _result(ok: bool, msg: str) -> dict:
    return {"ok": ok, "message": msg}


# ── Google Safe Browsing ──────────────────────────────────────────────────────

def report_google_safebrowsing(url: str) -> dict:
    try:
        r = requests.post(
            "https://safebrowsing.google.com/safebrowsing/report_phish/",
            data={"hl": "es", "url": url},
            timeout=10,
        )
        if r.status_code in (200, 204):
            return _result(True, "Reporte enviado a Google Safe Browsing.")
        return _result(False, f"Código {r.status_code}")
    except Exception as e:
        return _result(False, str(e))


# ── Netcraft ──────────────────────────────────────────────────────────────────

def report_netcraft(url: str) -> dict:
    try:
        r = requests.post(
            "https://report.netcraft.com/api/v3/report/urls",
            json={
                "email": os.getenv("NETCRAFT_EMAIL", "ciberinteligencia@bancolombia.com.co"),
                "urls": [{"country": "CO", "reason": "Phishing site impersonating Bancolombia brand", "url": url}],
            },
            timeout=10,
        )
        if 200 <= r.status_code < 300:
            data = r.json()
            return _result(True, f"Aceptado por Netcraft. ID: {data.get('id', 'N/A')}")
        return _result(False, f"Código {r.status_code}: {r.text[:120]}")
    except Exception as e:
        return _result(False, str(e))


# ── URLhaus ───────────────────────────────────────────────────────────────────

def report_urlhaus(url: str) -> dict:
    try:
        r = requests.post(
            "https://urlhaus.abuse.ch/api/",
            data={"anonymous": "1", "url": url},
            timeout=10,
        )
        if r.status_code == 200:
            try:
                status = r.json().get("query_status", "enviado")
            except Exception:
                status = "enviado"
            return _result(True, f"URLhaus: {status}")
        return _result(False, f"Código {r.status_code}")
    except Exception as e:
        return _result(False, str(e))


# ── Microsoft SmartScreen ─────────────────────────────────────────────────────

def report_smartscreen(url: str) -> dict:
    try:
        r = requests.post(
            "https://www.microsoft.com/en-us/wdsi/support/report-unsafe-site-guest",
            json={"url": url, "locale": "en-US"},
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
        if r.status_code in (200, 201, 204):
            return _result(True, "Reporte enviado a Microsoft SmartScreen.")
        return _result(False, f"Código {r.status_code}")
    except Exception as e:
        return _result(False, str(e))


# ── Phish Report ──────────────────────────────────────────────────────────────

def report_phishreport(url: str) -> dict:
    api_key = os.getenv("PHISHREPORT_API_KEY", "")
    if not api_key:
        return _result(False, "API Key de Phish Report no configurada (PHISHREPORT_API_KEY).")
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        r = requests.post(
            "https://phish.report/api/v0/cases",
            json={"ignore_duplicates": True, "url": url},
            headers=headers,
            timeout=10,
        )
        if r.status_code in (200, 201):
            data = r.json()
            return _result(True, f"Phish Report ID: {data.get('id', 'N/A')}. Resuelto: {'Sí' if data.get('resolved') else 'No'}")
        return _result(False, f"Código {r.status_code}: {r.text[:120]}")
    except Exception as e:
        return _result(False, str(e))


# ── PhishLabs — Crear Caso (Credential Theft / Phishing) ─────────────────────

PHISHLABS_BRANDS = {
    "Banco Agricola BAES":                  "Banco Agricola BAES",
    "Banco Agromercantil de Guatemala (BAM)": "Banco Agromercantil de Guatemala (BAM)",
    "Bancolombia":                          "Bancolombia",
    "Banistmo (Panamá)":                    "Banistmo (Panamá)",
    "Cibest":                               "Cibest",
    "Financomer":                           "Financomer",
    "Nequi":                                "Nequi",
    "WENIA":                                "WENIA",
    "WOMPI":                                "WOMPI",
}

PHISHLABS_CASE_TYPES = {
    "Phishing":           "Phishing",
    "Phishing Redirect":  "Phishing Redirect",
    "Malware":            "Malware",
    "Credential Theft":   "Credential Theft",
    "Crimeware":          "Crimeware",
    "Customer Inquiry":   "Customer Inquiry",
    "Dark Web":           "Dark Web",
    "Domains":            "Domains",
    "Mobile":             "Mobile",
    "Open Web":           "Open Web",
    "Social Media":       "Social Media",
    "Other":              "Other",
}

PHISHLABS_DESCRIPTIONS = {
    "Phishing":           "Malicious Phishing site",
    "Phishing Redirect":  "Malicious redirect site",
    "Malware":            "Malware distribution site",
    "Credential Theft":   "Credential theft site targeting brand customers",
    "Crimeware":          "Crimeware activity detected",
    "Customer Inquiry":   "Customer inquiry regarding suspicious activity",
    "Dark Web":           "Dark web mention or exposure",
    "Domains":            "Suspicious domain impersonating brand",
    "Mobile":             "Malicious mobile application or content",
    "Open Web":           "Open web exposure or brand abuse",
    "Social Media":       "Social media impersonation or abuse",
    "Other":              "Other malicious activity",
}


def create_phishlabs_case(url: str, brand: str, case_type: str, username: str, password: str) -> dict:
    if not username or not password:
        return _result(False, "Credenciales PhishLabs no configuradas.")
    brand_value = PHISHLABS_BRANDS.get(brand, brand)
    description = PHISHLABS_DESCRIPTIONS.get(case_type, "Malicious Phishing site")
    payload = {
        "newCase": {
            "title":         url,
            "url":           url,
            "description":   description,
            "caseType":      case_type,
            "brand":         brand_value,
            "attackSources": [{"url": url}],
        }
    }
    try:
        r = requests.post(
            "https://caseapi.phishlabs.com/v1/create/newCase",
            json=payload,
            auth=(username, password),
            timeout=20,
            verify=False,
        )
        try:
            data = r.json()
        except Exception:
            data = {}
        case_id  = data.get("caseId") or "N/A"
        case_num = data.get("caseNumber") or ""
        msgs     = "; ".join(data.get("messages") or [])

        if 200 <= r.status_code < 300:
            suffix = f" — {msgs}" if msgs else ""
            return _result(True, f"Caso #{case_num} creado en PhishLabs (ID: {case_id}){suffix}")

        # 400 con caseId = la URL ya tiene un caso activo
        if r.status_code == 400 and case_id != "N/A":
            return _result(True, f"URL ya asignada al caso #{case_num} en PhishLabs. {msgs}")

        return _result(False, f"Código {r.status_code}: {r.text[:200]}")
    except Exception as e:
        return _result(False, str(e))
