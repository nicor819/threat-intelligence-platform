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
        r = requests.get(
            "https://safebrowsing.google.com/safebrowsing/report_phish/",
            params={"hl": "es", "url": url},
            timeout=10,
            verify=False,
        )
        if r.status_code == 200:
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
            "https://feedback.smartscreen.microsoft.com/feedback.aspx",
            data={"product": "DefenderEdge", "formName": "Phishing", "url": url},
            timeout=10,
        )
        if r.status_code == 200:
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
        if r.status_code == 200:
            data = r.json()
            return _result(True, f"Phish Report ID: {data.get('id', 'N/A')}. Resuelto: {'Sí' if data.get('resolved') else 'No'}")
        return _result(False, f"Código {r.status_code}: {r.text[:120]}")
    except Exception as e:
        return _result(False, str(e))


# ── PhishLabs — Crear Caso (Credential Theft / Phishing) ─────────────────────

PHISHLABS_BRANDS = {
    "Bancolombia":          "Bancolombia",
    "Nequi":                "Nequi",
    "Wenia":                "Wenia",
    "Wompi":                "Wompi",
    "Banistmo":             "Banistmo Panama",
    "BAM Guatemala":        "Banco Agromercantil de Guatemala BAM",
    "Banco Agricola BAES":  "Banco Agricola BAES",
    "Financomer":           "Financomer",
    "Cibest":               "Cibest",
}

PHISHLABS_CASE_TYPES = {
    "Phishing":          "Phishing",
    "Malware":           "Malware",
    "Phishing Redirect": "Phishing Redirect",
}

PHISHLABS_DESCRIPTIONS = {
    "Phishing":          "Malicious Phishing site",
    "Malware":           "Malware",
    "Phishing Redirect": "Malicious redirect site",
}


def create_phishlabs_case(url: str, brand: str, case_type: str, username: str, password: str) -> dict:
    if not username or not password:
        return _result(False, "Credenciales PhishLabs no configuradas.")
    description = PHISHLABS_DESCRIPTIONS.get(case_type, "Malicious Phishing site")
    payload = {
        "newCase": {
            "title":       url,
            "url":         url,
            "description": description,
            "caseType":    case_type,
            "brand":       brand,
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
        if 200 <= r.status_code < 300:
            data     = r.json()
            case_id  = data.get("caseId") or "N/A"
            case_num = data.get("caseNumber") or ""
            msgs     = "; ".join(data.get("messages") or [])
            suffix   = f" — {msgs}" if msgs else ""
            return _result(True, f"Caso #{case_num} creado en PhishLabs (ID: {case_id}){suffix}")
        return _result(False, f"Código {r.status_code}: {r.text[:200]}")
    except Exception as e:
        return _result(False, str(e))
