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
from pathlib import Path
from urllib.parse import urlparse

import yaml
from flask import Flask, Response, jsonify, render_template, request, send_from_directory

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

# Crear directorios al iniciar (necesario con gunicorn)
OUTPUT.mkdir(parents=True, exist_ok=True)
PROFILES.mkdir(parents=True, exist_ok=True)
GRAPHS.mkdir(parents=True, exist_ok=True)

jobs: dict[str, dict] = {}   # job_id → {queue, profile, error}


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
    """Devuelve opciones disponibles para el formulario de PhishLabs."""
    return jsonify({
        "brands":     list(PHISHLABS_BRANDS.keys()),
        "case_types": list(PHISHLABS_CASE_TYPES.keys()),
    })


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
    ("PhishLabs",       "phishlabs"),
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
            t.join(timeout=35)  # máximo 35s para no bloquear el análisis
            if t.is_alive():
                container[0]["error"] = "Timeout al consultar PhishLabs (>35s)"
            return container[0]

        phishlabs = step("PhishLabs", _phishlabs_query)
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
        json_path = PROFILES / f"{safe}.json"
        with open(json_path, "w") as f:
            json.dump(full, f, indent=2, default=str)

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
