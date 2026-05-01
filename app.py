#!/usr/bin/env python3
"""
Threat Intelligence Platform — servidor Flask unificado.
Uso: python app.py  →  http://localhost:5050
"""

import json
import os
import queue
import re
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import yaml
from flask import Flask, Response, jsonify, render_template, request, send_from_directory, send_file

from modules import WhoisLookup, VirusTotalClient, GeoLocator, ForumScraper, URLScanClient, MandiantClient, SOCRadarClient, ThreatProfile, HostTracker, PhishLabsClient
from modules.reporter import (
    report_google_safebrowsing, report_netcraft, report_urlhaus,
    report_smartscreen, report_phishreport, create_phishlabs_case,
    PHISHLABS_BRANDS, PHISHLABS_CASE_TYPES,
)
from graph_builder import GraphBuilder

app      = Flask(__name__)
OUTPUT   = Path(os.environ.get("OUTPUT_DIR", "output"))
PROFILES = OUTPUT / "profiles"
GRAPHS   = OUTPUT / "graphs"
HISTORY_FILE = OUTPUT / "history.json"

# Crear directorios al iniciar (necesario con gunicorn)
OUTPUT.mkdir(parents=True, exist_ok=True)
PROFILES.mkdir(parents=True, exist_ok=True)
GRAPHS.mkdir(parents=True, exist_ok=True)

jobs: dict[str, dict] = {}   # job_id → {queue, profile, error}
_history_lock = threading.Lock()


# ── History helpers ───────────────────────────────────────────────────────────

def _load_history() -> list:
    try:
        with open(HISTORY_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []

def _save_history(entries: list) -> None:
    with open(HISTORY_FILE, "w") as f:
        json.dump(entries, f, indent=2, default=str)

def _append_history(entry: dict) -> None:
    with _history_lock:
        entries = _load_history()
        entries = [e for e in entries if e.get("id") != entry["id"]]
        entries.insert(0, entry)
        _save_history(entries[:500])


# ── Helpers ───────────────────────────────────────────────────────────────────

def load_cfg() -> dict:
    try:
        with open("config.yaml") as f:
            cfg = yaml.safe_load(f) or {}
    except FileNotFoundError:
        cfg = {}

    # Variables de entorno sobreescriben config.yaml (útil en producción)
    env_map = {
        "VT_API_KEY":              ("api_keys", "virustotal"),
        "URLSCAN_API_KEY":         ("api_keys", "urlscan"),
        "ALIENVAULT_API_KEY":      ("api_keys", "alienvault"),
        "THREATFOX_API_KEY":       ("api_keys", "threatfox"),
        "MANDIANT_KEY_ID":         ("api_keys", "mandiant_key_id"),
        "MANDIANT_KEY_SECRET":     ("api_keys", "mandiant_key_secret"),
        "SOCRADAR_API_KEY":        ("api_keys", "socradar"),
        "SHODAN_API_KEY":          ("api_keys", "shodan"),
        "PHISHLABS_USERNAME":      ("api_keys", "phishlabs_username"),
        "PHISHLABS_PASSWORD":      ("api_keys", "phishlabs_password"),
    }
    for env_var, (section, key) in env_map.items():
        val = os.environ.get(env_var)
        if val:
            cfg.setdefault(section, {})[key] = val

    return cfg


def extract_target(raw: str) -> tuple[str, str]:
    """
    Acepta URL completa, dominio o IP.
    Devuelve (target_limpio, url_original).
    """
    raw = raw.strip()
    original = raw

    # Si parece URL (tiene ://) o empieza con www, parsear
    if "://" in raw:
        parsed = urlparse(raw)
        host = parsed.hostname or ""
    elif raw.startswith("www."):
        host = raw.split("/")[0]
    else:
        host = raw.split("/")[0]   # strip any path if bare domain/IP

    # Quitar puerto si lo hay
    host = re.sub(r":\d+$", "", host).strip().lower()
    return host, original


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/analyze", methods=["POST"])
def analyze():
    data   = request.json or {}
    raw    = data.get("target", "").strip()
    if not raw:
        return jsonify({"error": "URL o indicador requerido"}), 400

    target, original_url = extract_target(raw)
    if not target:
        return jsonify({"error": "No se pudo extraer un host válido"}), 400

    job_id = str(uuid.uuid4())
    q: queue.Queue = queue.Queue()
    jobs[job_id] = {"queue": q, "profile": None, "error": None,
                    "target": target, "original_url": original_url}

    threading.Thread(target=_worker, args=(job_id, target, original_url, q),
                     daemon=True).start()

    return jsonify({"job_id": job_id, "target": target})


@app.route("/stream/<job_id>")
def stream(job_id: str):
    if job_id not in jobs:
        return Response("data: {}\n\n", mimetype="text/event-stream")

    def generate():
        q = jobs[job_id]["queue"]
        while True:
            try:
                event = q.get(timeout=90)
            except queue.Empty:
                yield _sse("error_event", {"message": "timeout"})
                break
            etype = event["type"]
            if etype == "step":
                yield _sse("step",        event["data"])
            elif etype == "done":
                yield _sse("done",        event["data"])
                break
            elif etype == "error":
                yield _sse("error_event", event["data"])
                break

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/output/<path:filename>")
def serve_output(filename: str):
    return send_from_directory(OUTPUT, filename)


@app.route("/proxy/img")
def proxy_img():
    """Proxy de imágenes para html2pdf (evita bloqueos CORS en canvas)."""
    import requests as _req
    url = request.args.get("url", "")
    if not url or not url.startswith("https://"):
        return "", 400
    try:
        r = _req.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        return Response(r.content, content_type=r.headers.get("Content-Type", "image/jpeg"))
    except Exception:
        return "", 404


# ── Reporting endpoints ───────────────────────────────────────────────────────

REPORT_HANDLERS = {
    "google_sb":    report_google_safebrowsing,
    "netcraft":     report_netcraft,
    "urlhaus":      report_urlhaus,
    "smartscreen":  report_smartscreen,
    "phishreport":  report_phishreport,
}

@app.route("/report", methods=["POST"])
def report():
    data    = request.json or {}
    service = data.get("service", "")
    url     = data.get("url", "").strip()
    if not url:
        return jsonify({"ok": False, "message": "URL requerida"}), 400
    handler = REPORT_HANDLERS.get(service)
    if not handler:
        return jsonify({"ok": False, "message": f"Servicio '{service}' no reconocido"}), 400
    result = handler(url)
    return jsonify(result)


@app.route("/report/phishlabs_case", methods=["POST"])
def report_phishlabs_case():
    data      = request.json or {}
    url       = data.get("url", "").strip()
    brand     = data.get("brand", "")
    case_type = data.get("case_type", "Phishing")
    if not url or not brand:
        return jsonify({"ok": False, "message": "URL y marca son requeridos"}), 400
    cfg  = load_cfg()
    keys = cfg.get("api_keys", {})
    result = create_phishlabs_case(
        url=url,
        brand=brand,
        case_type=case_type,
        username=keys.get("phishlabs_username", ""),
        password=keys.get("phishlabs_password", ""),
    )
    return jsonify(result)


@app.route("/report/config")
def report_config():
    """Devuelve opciones disponibles para el formulario de Fortra."""
    return jsonify({
        "brands":     list(PHISHLABS_BRANDS.keys()),
        "case_types": list(PHISHLABS_CASE_TYPES.keys()),
    })


@app.route("/ai/analyze", methods=["POST"])
def ai_analyze():
    data    = request.json or {}
    profile = data.get("profile", {})
    if not profile:
        return jsonify({"error": "Perfil requerido"}), 400
    cfg      = load_cfg()
    settings = cfg.get("settings", {})
    model    = settings.get("ollama_model", "") or os.environ.get("OLLAMA_MODEL", "llama3")
    base_url = settings.get("ollama_url",   "") or os.environ.get("OLLAMA_URL",   "http://localhost:11434")
    try:
        analysis = _call_ollama(_build_ai_prompt(profile), model, base_url)
        return jsonify({"analysis": analysis})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


def _build_ai_prompt(p: dict) -> str:
    risk  = p.get("risk_summary", {})
    vt    = p.get("virustotal", {})
    geo   = p.get("geolocation", {})
    whois = p.get("whois", {})
    man   = p.get("mandiant", {})
    intel = p.get("threat_intelligence", {})
    iocs  = p.get("iocs", [])
    ht    = p.get("host_tracker", {})
    pl    = p.get("phishlabs", {})
    us    = p.get("urlscan", {})
    vs    = (us.get("verdicts") or {})

    lines = [
        "Eres un analista senior de ciberinteligencia de un SOC corporativo.",
        "Con base en el perfil de amenaza a continuación, redacta un Threat Intelligence Report (TIR) completo en español.",
        "El informe debe ser profesional, técnico y orientado a la toma de decisiones.",
        "",
        f"INDICADOR: {p.get('target', '?')}",
        f"URL ORIGINAL: {p.get('original_url', p.get('target', ''))}",
        f"FECHA DE ANÁLISIS: {str(p.get('generated_at', ''))[:16]}",
        "",
        "PUNTUACIÓN DE RIESGO:",
        f"  Score: {risk.get('score', '?')}/100  |  Nivel: {risk.get('level', '?')}",
        f"  VirusTotal: {risk.get('vt_verdict', '?')} — {vt.get('malicious', 0)} motores maliciosos, {vt.get('suspicious', 0)} sospechosos, {vt.get('harmless', 0)} limpios",
        f"  URLScan.io: {'MALICIOSO' if vs.get('malicious') else 'Limpio'} (score {vs.get('score', '?')}/100)",
        f"  Mandiant MScore: {man.get('mscore', 'N/A')} — Veredicto: {man.get('verdict', 'N/A')}",
        f"  OTX Pulses: {risk.get('otx_pulses', 0)}  |  ThreatFox IOCs: {risk.get('threatfox_hits', 0)}  |  URLhaus: {risk.get('urlhaus_hits', 0)}",
        f"  SOCRadar Score: {p.get('socradar', {}).get('score', 'N/A')}",
        f"  Casos Fortra/PhishLabs: {len(pl.get('cases', []))} encontrado(s) en {pl.get('total_searched', 0)} registros revisados",
    ]

    if man.get("threat_actors"):
        actors = ", ".join(f"{a.get('name','')} ({a.get('country','?')})" for a in man["threat_actors"][:5])
        lines.append(f"  Actores de amenaza (Mandiant): {actors}")
    if man.get("malware"):
        mal = ", ".join(m.get("name","") for m in man["malware"][:5])
        lines.append(f"  Familias de malware: {mal}")

    lines += [
        "",
        "INFRAESTRUCTURA:",
        f"  País: {geo.get('country_code','?')} — {geo.get('country','?')}  |  Ciudad: {geo.get('city','?')}, {geo.get('region','?')}",
        f"  ISP: {geo.get('isp','?')}  |  Organización: {geo.get('org','?')}",
        f"  ASN: {geo.get('asn', whois.get('asn','?'))}  |  Red CIDR: {whois.get('network_cidr','?')}",
        f"  Flags de riesgo: {', '.join(risk.get('geo_flags', [])) or 'Ninguna'}",
        f"  Registrador: {whois.get('registrar','?')}  |  Org registrante: {whois.get('registrant_org','?')}",
        f"  Dominio creado: {str(whois.get('creation_date',''))[:10] or '?'}  |  Expira: {str(whois.get('expiration_date',''))[:10] or '?'}",
    ]

    if whois.get("resolved_ips"):
        lines.append(f"  IPs resueltas: {', '.join(whois['resolved_ips'][:6])}")

    ports = ht.get("open_ports", [])
    if ports:
        lines.append("  Puertos abiertos: " + ", ".join(f"{pp['port']}/{pp.get('service','?')}" for pp in ports[:10]))

    cert = ht.get("certificate", {})
    if cert and not cert.get("error"):
        estado = "EXPIRADO" if cert.get("expired") else f"Válido ({cert.get('days_remaining','?')} días restantes)"
        lines.append(f"  TLS: {estado} — Emisor: {cert.get('issuer_org', cert.get('issuer_cn','?'))} — Subject: {cert.get('subject_cn','?')}")

    if iocs:
        lines += ["", f"IOCs DETECTADOS ({len(iocs)} total):"]
        for ioc in iocs[:15]:
            lines.append(f"  [{ioc.get('type','?').upper()}] {ioc.get('value','?')}  fuente={ioc.get('source','')}  ctx={ioc.get('context','')}")

    if vt.get("detections"):
        lines += ["", f"DETECCIONES VIRUSTOTAL ({len(vt['detections'])} motores):"]
        for d in vt["detections"][:8]:
            lines.append(f"  {d.get('engine')}: {d.get('result','?')} ({d.get('category','')})")

    if intel.get("otx_pulses"):
        lines += ["", f"PULSES ALIENVAULT OTX ({intel.get('otx_pulse_count',0)} total):"]
        for pp in intel["otx_pulses"][:5]:
            fams = ", ".join(pp.get("malware_families", [])[:3])
            ttps = ", ".join(pp.get("attack_ids", [])[:3])
            lines.append(f"  '{pp.get('name','?')}' autor={pp.get('author','')} familias={fams or 'N/A'} ATT&CK={ttps or 'N/A'}")

    if intel.get("threatfox"):
        lines += ["", "THREATFOX IOCs:"]
        for t in intel["threatfox"][:5]:
            lines.append(f"  {t.get('ioc','')} — {t.get('malware','')} confianza={t.get('confidence','?')}%")

    if pl.get("cases"):
        lines += ["", f"CASOS FORTRA/PHISHLABS ({len(pl['cases'])} encontrado(s)):"]
        for c in pl["cases"][:5]:
            lines.append(f"  Caso #{c.get('case_number','')} [{c.get('case_type','')}] estado={c.get('case_status','')} marca={c.get('brand','')} creado={str(c.get('date_created',''))[:10]}")

    lines += [
        "",
        "INSTRUCCIONES: Genera un TIR completo usando EXACTAMENTE estas secciones en Markdown.",
        "Cada sección debe tener contenido sustancial. Interpreta los datos, no los copies.",
        "Usa terminología de ciberseguridad. Razona sobre la amenaza. Sé específico y accionable.",
        "",
        "## 1. Resumen Ejecutivo",
        "(Contextualiza el hallazgo, nivel de riesgo y urgencia. Apto para directivos.)",
        "",
        "## 2. Clasificación y Severidad de la Amenaza",
        "(Justifica el nivel de riesgo con evidencia. Tipo de amenaza: phishing, C2, malware, etc.)",
        "",
        "## 3. Análisis de Inteligencia de Amenazas",
        "(Interpreta hallazgos de Mandiant, OTX, ThreatFox, URLhaus, Fortra. Conecta patrones.)",
        "",
        "## 4. Análisis de Infraestructura",
        "(Analiza geolocalización, ISP, ASN, puertos, TLS, dominio. Infraestructura dedicada o comprometida?)",
        "",
        "## 5. Indicadores de Compromiso Clave",
        "(IOCs más críticos y su relevancia operacional para el equipo de seguridad.)",
        "",
        "## 6. Recomendaciones de Mitigación",
        "(Acciones concretas priorizadas: bloqueos, revisiones de logs, alertas SIEM, notificaciones.)",
        "",
        "## 7. Conclusión",
        "(Síntesis del riesgo. ¿Requiere acción inmediata o monitoreo continuo?)",
    ]
    return "\n".join(lines)


@app.route("/ai/report/pdf", methods=["POST"])
def ai_report_pdf():
    """Recibe HTML del informe y devuelve un PDF generado con WeasyPrint."""
    import io
    data     = request.json or {}
    html_str = data.get("html", "")
    filename = data.get("filename", "TIR-IA.pdf")
    if not html_str:
        return jsonify({"error": "HTML requerido"}), 400
    try:
        from weasyprint import HTML
        pdf_bytes = HTML(string=html_str, base_url=request.host_url).write_pdf()
        return send_file(
            io.BytesIO(pdf_bytes),
            mimetype="application/pdf",
            as_attachment=True,
            download_name=filename,
        )
    except Exception as exc:
        return jsonify({"error": f"WeasyPrint: {exc}"}), 500


def _call_ollama(prompt: str, model: str, base_url: str) -> str:
    import requests as _req
    url  = base_url.rstrip("/") + "/api/generate"
    body = {"model": model, "prompt": prompt, "stream": False,
            "options": {"temperature": 0.3, "num_predict": 4096}}
    r = _req.post(url, json=body, timeout=300)
    if r.status_code != 200:
        raise Exception(f"Ollama HTTP {r.status_code}: {r.text[:200]}")
    data = r.json()
    text = data.get("response", "")
    if not text:
        raise Exception(f"Ollama no devolvió texto. Respuesta: {str(data)[:200]}")
    return text


@app.route("/history")
def get_history():
    return jsonify(_load_history())

@app.route("/history/<entry_id>")
def get_history_entry(entry_id: str):
    entries = _load_history()
    entry = next((e for e in entries if e.get("id") == entry_id), None)
    if not entry:
        return jsonify({"error": "No encontrado"}), 404
    profile_path = PROFILES / entry.get("profile_file", "")
    if not profile_path.exists():
        return jsonify({"error": "Archivo de perfil no encontrado"}), 404
    with open(profile_path) as f:
        return jsonify(json.load(f))

@app.route("/history/<entry_id>", methods=["DELETE"])
def delete_history_entry(entry_id: str):
    with _history_lock:
        entries = _load_history()
        entry = next((e for e in entries if e.get("id") == entry_id), None)
        if entry:
            p = PROFILES / entry.get("profile_file", "")
            p.unlink(missing_ok=True)
        _save_history([e for e in entries if e.get("id") != entry_id])
    return jsonify({"ok": True})

@app.route("/history", methods=["DELETE"])
def clear_history():
    with _history_lock:
        for e in _load_history():
            p = PROFILES / e.get("profile_file", "")
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass
        _save_history([])
    return jsonify({"ok": True})


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


# ── Worker ────────────────────────────────────────────────────────────────────

STEPS = [
    ("WHOIS / DNS",     "whois"),
    ("VirusTotal",      "vt"),
    ("URLScan.io",      "urlscan"),
    ("Geolocalización", "geo"),
    ("Threat Intel",    "intel"),
    ("Mandiant",        "mandiant"),
    ("SOCRadar",        "socradar"),
    ("Host Tracker",    "hosttracker"),
    ("Fortra",          "phishlabs"),
    ("Grafo",           "graph"),
]

def _worker(job_id: str, target: str, original_url: str, q: queue.Queue):
    cfg      = load_cfg()
    keys     = cfg.get("api_keys", {})
    settings = cfg.get("settings", {})
    delay    = settings.get("rate_limit_delay", 1)

    def step(name, fn):
        q.put({"type": "step", "data": {"name": name, "status": "running"}})
        try:
            r = fn()
            q.put({"type": "step", "data": {"name": name, "status": "done"}})
            return r
        except Exception as exc:
            q.put({"type": "step", "data": {"name": name, "status": "error"}})
            raise exc

    try:
        whois   = step("WHOIS / DNS",     lambda: WhoisLookup().query(target))
        time.sleep(delay)
        vt      = step("VirusTotal",      lambda: VirusTotalClient(keys.get("virustotal",""), delay).query(target))
        time.sleep(delay)
        urlscan = step("URLScan.io",      lambda: URLScanClient(keys.get("urlscan","")).query(target, original_url))
        time.sleep(delay)
        geo     = step("Geolocalización", lambda: GeoLocator().locate(target))
        time.sleep(delay)
        mandiant = step("Mandiant",        lambda: MandiantClient(
            key_id=keys.get("mandiant_key_id", ""),
            key_secret=keys.get("mandiant_key_secret", ""),
        ).query(target))
        time.sleep(delay)
        socradar = step("SOCRadar",        lambda: SOCRadarClient(keys.get("socradar", "")).query(target))
        time.sleep(delay)
        intel   = step("Threat Intel",    lambda: ForumScraper(
            shodan_key=keys.get("shodan", ""),
            alienvault_key=keys.get("alienvault", ""),
            threatfox_key=keys.get("threatfox", ""),
            max_pages=settings.get("max_forum_pages", 3),
            delay=delay,
        ).search(target))
        time.sleep(delay)
        host_track = step("Host Tracker", lambda: HostTracker(
            profiles_dir=str(PROFILES),
        ).check(target))
        time.sleep(delay)
        def _phishlabs_query():
            result = {"cases": [], "total_searched": 0, "found": 0, "target": target}
            container = [result]
            def _run():
                try:
                    container[0] = PhishLabsClient(
                        username=keys.get("phishlabs_username", ""),
                        password=keys.get("phishlabs_password", ""),
                    ).query(target)
                except Exception as e:
                    container[0]["error"] = str(e)
            t = threading.Thread(target=_run, daemon=True)
            t.start()
            t.join(timeout=65)  # máximo 65s para 3 páginas × ~17s
            if t.is_alive():
                container[0]["error"] = "Timeout al consultar Fortra (>65s)"
            return container[0]

        phishlabs = step("Fortra", _phishlabs_query)
        time.sleep(delay)

        profile = ThreatProfile(target)
        full    = profile.build(whois, vt, geo, intel, urlscan, mandiant, socradar, host_track, phishlabs)
        full["original_url"] = original_url

        q.put({"type": "step", "data": {"name": "Grafo", "status": "running"}})
        gb    = GraphBuilder(output_dir=str(GRAPHS), cfg=cfg.get("graph", {}))
        paths = gb.build(full)
        q.put({"type": "step", "data": {"name": "Grafo", "status": "done"}})

        safe = target.replace(".", "_").replace("/", "_")
        full["graph_png_url"]  = f"/output/graphs/{Path(paths['png']).name}"  if paths.get("png")  else None
        full["graph_html_url"] = f"/output/graphs/{Path(paths['html']).name}" if paths.get("html") else None

        PROFILES.mkdir(parents=True, exist_ok=True)
        ts           = datetime.now().strftime("%Y%m%d_%H%M%S")
        profile_file = f"{safe}_{ts}.json"
        json_path    = PROFILES / profile_file
        with open(json_path, "w") as f:
            json.dump(full, f, indent=2, default=str)

        risk = full.get("risk_summary", {})
        _append_history({
            "id":           job_id,
            "target":       target,
            "original_url": original_url,
            "analyzed_at":  datetime.now().isoformat(timespec="seconds"),
            "risk_level":   risk.get("level", "UNKNOWN"),
            "risk_score":   risk.get("score", 0),
            "ioc_count":    len(full.get("iocs", [])),
            "profile_file": profile_file,
        })

        jobs[job_id]["profile"] = full
        q.put({"type": "done", "data": full})

    except Exception as exc:
        jobs[job_id]["error"] = str(exc)
        q.put({"type": "error", "data": {"message": str(exc)}})


if __name__ == "__main__":
    OUTPUT.mkdir(parents=True, exist_ok=True)
    PROFILES.mkdir(parents=True, exist_ok=True)
    GRAPHS.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get("PORT", 5050))
    print("\n  Threat Intelligence Platform")
    print(f"  →  http://localhost:{port}\n")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
