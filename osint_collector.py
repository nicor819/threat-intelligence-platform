#!/usr/bin/env python3
"""
Threat Actor Profile Generator
Uso: python osint_collector.py <target> [target2 ...]
     python osint_collector.py --batch targets.txt
"""

import argparse
import json
import sys
import time
from pathlib import Path
from datetime import datetime

import yaml
from jinja2 import Environment, FileSystemLoader
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn
from rich.table import Table
from rich import box

from modules import WhoisLookup, VirusTotalClient, GeoLocator, ForumScraper, ThreatProfile
from graph_builder import GraphBuilder

console = Console()


def load_config(path: str = "config.yaml") -> dict:
    with open(path) as f:
        return yaml.safe_load(f)


def build_profile(target: str, cfg: dict, output_dir: Path) -> dict:
    keys = cfg.get("api_keys", {})
    settings = cfg.get("settings", {})
    delay = settings.get("rate_limit_delay", 1)

    steps = [
        ("WHOIS / DNS",       lambda: WhoisLookup().query(target)),
        ("VirusTotal",        lambda: VirusTotalClient(keys.get("virustotal", ""), delay).query(target)),
        ("Geolocalización",   lambda: GeoLocator().locate(target)),
        ("Threat Intel",      lambda: ForumScraper(
                                    shodan_key=keys.get("shodan", ""),
                                    max_pages=settings.get("max_forum_pages", 3),
                                    delay=delay,
                                ).search(target)),
    ]

    results = {}
    with Progress(
        SpinnerColumn(),
        TextColumn("[bold cyan]{task.description}"),
        BarColumn(),
        console=console,
        transient=True,
    ) as progress:
        task = progress.add_task(f"Analizando {target}", total=len(steps))
        for name, fn in steps:
            progress.update(task, description=f"[cyan]{name}[/cyan] — {target}")
            results[name] = fn()
            progress.advance(task)
            time.sleep(delay)

    profile = ThreatProfile(target)
    full = profile.build(
        whois_data=results["WHOIS / DNS"],
        vt_data=results["VirusTotal"],
        geo_data=results["Geolocalización"],
        intel_data=results["Threat Intel"],
    )

    # Grafo
    graph_cfg = cfg.get("graph", {})
    gb = GraphBuilder(output_dir=str(output_dir / "graphs"), cfg=graph_cfg)
    graph_paths = gb.build(full)
    full["graph_png"] = graph_paths.get("png")
    full["graph_html"] = graph_paths.get("html")

    # Guardar JSON
    safe_name = target.replace(".", "_").replace("/", "_")
    json_path = output_dir / "profiles" / f"{safe_name}.json"
    json_path.parent.mkdir(parents=True, exist_ok=True)
    with open(json_path, "w") as f:
        json.dump(full, f, indent=2, default=str)

    # Generar reporte HTML
    env = Environment(loader=FileSystemLoader("templates"))
    env.filters["tojson"] = lambda v, indent=0: json.dumps(v, indent=indent, default=str)
    tmpl = env.get_template("report.html")
    html_content = tmpl.render(
        target=full["target"],
        generated_at=full["generated_at"],
        schema_version=full["schema_version"],
        risk=full["risk_summary"],
        whois=full["whois"],
        geo=full["geolocation"],
        vt=full["virustotal"],
        intel=full["threat_intelligence"],
        graph_png=Path(full["graph_png"]).name if full.get("graph_png") else None,
        graph_html=Path(full["graph_html"]).name if full.get("graph_html") else None,
    )
    html_path = output_dir / "graphs" / f"{safe_name}_report.html"
    with open(html_path, "w") as f:
        f.write(html_content)

    full["report_html"] = str(html_path)
    full["report_json"] = str(json_path)
    return full


def print_summary(profile: dict):
    risk = profile["risk_summary"]
    level = risk["level"]
    color_map = {"CRITICAL": "red", "HIGH": "red1", "MEDIUM": "yellow", "LOW": "green3", "CLEAN": "green"}
    color = color_map.get(level, "white")

    panel_text = (
        f"[bold {color}]{level}[/bold {color}]  Score: {risk['score']}/100\n"
        f"VT: {risk['vt_verdict']}  |  OTX: {risk['otx_pulses']} pulses  "
        f"|  URLhaus: {risk['urlhaus_hits']}  |  ThreatFox: {risk['threatfox_hits']}\n"
    )
    if risk.get("geo_flags"):
        panel_text += f"Flags: {' '.join(risk['geo_flags'])}"

    console.print(Panel(panel_text, title=f"[bold white]{profile['target']}[/bold white]", border_style=color))

    table = Table(box=box.SIMPLE, show_header=True, header_style="dim")
    table.add_column("Campo", style="cyan")
    table.add_column("Valor")

    geo = profile.get("geolocation", {})
    whois = profile.get("whois", {})
    table.add_row("País", f"{geo.get('country_code','?')} — {geo.get('country','?')}")
    table.add_row("Ciudad", geo.get("city", "N/D"))
    table.add_row("ISP", geo.get("isp", "N/D"))
    table.add_row("ASN", str(whois.get("asn") or geo.get("asn", "N/D")))
    table.add_row("Registrador", whois.get("registrar", "N/D"))
    table.add_row("Creación dominio", whois.get("creation_date", "N/D"))

    console.print(table)
    console.print(f"[dim]JSON:[/dim] {profile.get('report_json')}")
    console.print(f"[dim]HTML:[/dim] {profile.get('report_html')}")
    console.print(f"[dim]Grafo:[/dim] {profile.get('graph_png')}")


def main():
    parser = argparse.ArgumentParser(
        description="Threat Actor Profile Generator — OSINT automatizado",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Ejemplos:
  python osint_collector.py 8.8.8.8
  python osint_collector.py evil-domain.com
  python osint_collector.py --batch targets.txt
  python osint_collector.py 1.2.3.4 malware-c2.net
        """,
    )
    parser.add_argument("targets", nargs="*", help="IPs o dominios a analizar")
    parser.add_argument("--batch", metavar="FILE", help="Archivo con targets (uno por línea)")
    parser.add_argument("--config", default="config.yaml", help="Ruta al archivo de configuración")
    parser.add_argument("--output", default="output", help="Directorio de salida")
    args = parser.parse_args()

    targets = list(args.targets)
    if args.batch:
        batch_path = Path(args.batch)
        if not batch_path.exists():
            console.print(f"[red]No se encontró el archivo: {args.batch}[/red]")
            sys.exit(1)
        targets += [line.strip() for line in batch_path.read_text().splitlines() if line.strip()]

    if not targets:
        parser.print_help()
        sys.exit(0)

    cfg = load_config(args.config)
    output_dir = Path(args.output)

    console.print(Panel(
        f"[bold red]Threat Actor Profile Generator[/bold red]\n"
        f"Targets: {len(targets)} | Output: {output_dir}",
        border_style="red",
    ))

    for i, target in enumerate(targets, 1):
        console.rule(f"[{i}/{len(targets)}] {target}")
        try:
            profile = build_profile(target, cfg, output_dir)
            print_summary(profile)
        except KeyboardInterrupt:
            console.print("[yellow]Interrumpido por el usuario.[/yellow]")
            sys.exit(0)
        except Exception as e:
            console.print(f"[red]Error procesando {target}: {e}[/red]")


if __name__ == "__main__":
    main()
