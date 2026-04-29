from datetime import datetime


class ThreatProfile:
    """Agrega todos los módulos OSINT en un perfil estructurado."""

    def __init__(self, target: str):
        self.target      = target
        self.created_at  = datetime.utcnow().isoformat() + "Z"
        self.whois        = {}
        self.virustotal   = {}
        self.geolocation  = {}
        self.intel        = {}
        self.urlscan      = {}
        self.mandiant     = {}
        self.socradar     = {}
        self.host_tracker = {}
        self._risk_score  = None

    def build(
        self,
        whois_data: dict,
        vt_data: dict,
        geo_data: dict,
        intel_data: dict,
        urlscan_data: dict = None,
        mandiant_data: dict = None,
        socradar_data: dict = None,
        host_tracker_data: dict = None,
    ) -> dict:
        self.whois        = whois_data
        self.virustotal   = vt_data
        self.geolocation  = geo_data
        self.intel        = intel_data
        self.urlscan      = urlscan_data or {}
        self.mandiant     = mandiant_data or {}
        self.socradar     = socradar_data or {}
        self.host_tracker = host_tracker_data or {}
        self._risk_score  = self._calculate_risk()

        return {
            "schema_version":    "1.3",
            "generated_at":      self.created_at,
            "target":            self.target,
            "risk_summary":      self._risk_summary(),
            "iocs":              self._extract_iocs(),
            "whois":             self.whois,
            "geolocation":       self.geolocation,
            "virustotal":        self.virustotal,
            "urlscan":           self.urlscan,
            "mandiant":          self.mandiant,
            "socradar":          self.socradar,
            "threat_intelligence": self.intel,
            "host_tracker":      self.host_tracker,
            "graph_nodes":       self._extract_graph_nodes(),
            "graph_edges":       self._extract_graph_edges(),
        }

    def _calculate_risk(self) -> int:
        score = 0

        # VirusTotal
        verdict = self.virustotal.get("threat_verdict", "CLEAN")
        score += {"MALICIOUS": 50, "SUSPICIOUS": 25, "LOW_RISK": 10, "CLEAN": 0}.get(verdict, 0)

        # SOCRadar Risk Score (0-100)
        sr_score = self.socradar.get("risk_score")
        if sr_score is not None:
            try:
                score += int(float(sr_score) * 0.3)  # aporta hasta 30 pts
            except (ValueError, TypeError):
                pass

        # Mandiant MScore (0-100)
        mscore = self.mandiant.get("mscore")
        if mscore is not None:
            score += int(mscore * 0.4)   # aporta hasta 40 pts

        # URLScan
        vs = self.urlscan.get("verdicts", {})
        if vs.get("malicious"):
            score += 20
        score += min(vs.get("engine_malicious", 0) * 3, 15)

        # OTX / URLhaus / ThreatFox
        score += min(self.intel.get("otx_pulse_count", 0) * 5, 20)
        score += min(len(self.intel.get("urlhaus", [])) * 5, 15)
        score += min(len(self.intel.get("threatfox", [])) * 5, 15)

        # Geo flags
        flags = self.geolocation.get("flags", [])
        if "PROXY/VPN" in flags:
            score += 10
        if "HOSTING/DATACENTER" in flags:
            score += 5

        return min(score, 100)

    def _risk_summary(self) -> dict:
        score = self._risk_score
        if score >= 70:
            level = "CRITICAL"
        elif score >= 45:
            level = "HIGH"
        elif score >= 20:
            level = "MEDIUM"
        elif score > 0:
            level = "LOW"
        else:
            level = "CLEAN"

        vs = self.urlscan.get("verdicts", {})
        return {
            "score":             score,
            "level":             level,
            "vt_verdict":        self.virustotal.get("threat_verdict", "N/A"),
            "urlscan_malicious": vs.get("malicious", False),
            "urlscan_score":     vs.get("score", 0),
            "mandiant_verdict":  self.mandiant.get("verdict", "N/A"),
            "mandiant_mscore":   self.mandiant.get("mscore"),
            "mandiant_actors":   len(self.mandiant.get("threat_actors", [])),
            "mandiant_malware":  len(self.mandiant.get("malware", [])),
            "socradar_verdict":  self.socradar.get("verdict", "N/A"),
            "socradar_score":    self.socradar.get("risk_score"),
            "otx_pulses":        self.intel.get("otx_pulse_count", 0),
            "urlhaus_hits":      len(self.intel.get("urlhaus", [])),
            "threatfox_hits":    len(self.intel.get("threatfox", [])),
            "geo_flags":         self.geolocation.get("flags", []),
        }

    def _extract_graph_nodes(self) -> list:
        nodes = [{"id": self.target, "label": self.target, "type": "target", "risk": self._risk_score}]

        for ip in self.whois.get("resolved_ips", []):
            nodes.append({"id": ip, "label": ip, "type": "ip"})

        # IPs vistas por URLScan
        _us_scan = self.urlscan.get("latest_scan") or self.urlscan.get("new_scan") or {}
        for ip in _us_scan.get("ips", []):
            nodes.append({"id": ip, "label": ip, "type": "ip"})

        asn = self.whois.get("asn") or self.geolocation.get("asn")
        if asn:
            nodes.append({"id": str(asn), "label": str(asn), "type": "asn"})

        country = self.geolocation.get("country_code")
        if country:
            nodes.append({"id": country, "label": country, "type": "country"})

        registrar = self.whois.get("registrar")
        if registrar:
            short = registrar[:30]
            nodes.append({"id": short, "label": short, "type": "registrar"})

        isp = self.geolocation.get("isp")
        if isp:
            nodes.append({"id": isp, "label": isp[:25], "type": "isp"})

        for hit in self.intel.get("threatfox", []):
            malware = hit.get("malware")
            if malware:
                nodes.append({"id": malware, "label": malware, "type": "malware"})

        # Deduplicate
        seen, unique = set(), []
        for n in nodes:
            if n["id"] not in seen:
                seen.add(n["id"])
                unique.append(n)
        return unique

    def _extract_graph_edges(self) -> list:
        edges = []
        t = self.target

        for ip in self.whois.get("resolved_ips", []):
            edges.append({"source": t, "target": ip, "label": "resolves_to"})

        asn = self.whois.get("asn") or self.geolocation.get("asn")
        if asn:
            anchor = self.whois.get("resolved_ips", [t])[0] if self.whois.get("resolved_ips") else t
            edges.append({"source": anchor, "target": str(asn), "label": "belongs_to_asn"})

        country = self.geolocation.get("country_code")
        if country:
            edges.append({"source": t, "target": country, "label": "located_in"})

        registrar = self.whois.get("registrar")
        if registrar:
            edges.append({"source": t, "target": registrar[:30], "label": "registered_with"})

        isp = self.geolocation.get("isp")
        if isp:
            edges.append({"source": t, "target": isp, "label": "hosted_by"})

        for hit in self.intel.get("threatfox", []):
            malware = hit.get("malware")
            if malware:
                edges.append({"source": t, "target": malware, "label": "associated_malware"})

        return edges

    def _extract_iocs(self) -> list:
        """
        Consolida todos los IOCs encontrados en las distintas fuentes
        en una lista deduplicada con tipo, valor, fuente y contexto.
        """
        seen: set = set()
        iocs: list = []

        def add(ioc_type: str, value: str, source: str, context: str = "", risk: str = "info"):
            value = str(value).strip()
            if not value or value == "—":
                return
            key = f"{ioc_type}:{value.lower()}"
            if key in seen:
                return
            seen.add(key)
            iocs.append({
                "type":    ioc_type,
                "value":   value,
                "source":  source,
                "context": context,
                "risk":    risk,
            })

        # ── Target principal ──────────────────────────────────────────────────
        import re
        is_ip = bool(re.match(r"^\d{1,3}(\.\d{1,3}){3}$", self.target))
        add("ip" if is_ip else "domain", self.target, "Análisis", "Target principal", "high")

        # ── WHOIS ─────────────────────────────────────────────────────────────
        for ip in self.whois.get("resolved_ips", []):
            add("ip", ip, "WHOIS", f"IP resuelta de {self.target}", "medium")
        for ns in self.whois.get("name_servers", []):
            add("domain", ns.lower().rstrip("."), "WHOIS", "Name server", "info")

        # ── VirusTotal ────────────────────────────────────────────────────────
        vt_verdict = self.virustotal.get("threat_verdict", "CLEAN")
        vt_risk    = {"MALICIOUS": "critical", "SUSPICIOUS": "high", "LOW_RISK": "medium"}.get(vt_verdict, "info")
        for det in self.virustotal.get("detections", []):
            result = det.get("result", "")
            if result:
                add("signature", result, "VirusTotal", f"Motor: {det.get('engine','')}", vt_risk)

        # ── URLScan ───────────────────────────────────────────────────────────
        scan = self.urlscan.get("latest_scan") or self.urlscan.get("new_scan") or {}
        for ip in scan.get("ips", []):
            add("ip", ip, "URLScan", "IP contactada durante carga", "medium")
        for domain in scan.get("domains", []):
            if domain != self.target:
                add("domain", domain, "URLScan", "Dominio contactado durante carga", "medium")
        for url in scan.get("urls", [])[:10]:
            add("url", url, "URLScan", "URL observada durante carga", "medium")

        # ── SOCRadar ──────────────────────────────────────────────────────────
        sr_risk = {"MALICIOUS": "critical", "SUSPICIOUS": "high", "LOW_RISK": "medium"}.get(
            self.socradar.get("verdict", ""), "info")
        for actor in self.socradar.get("threat_actors", []):
            add("threat_actor", str(actor), "SOCRadar", "Actor asociado", sr_risk)
        for malware in self.socradar.get("malware_families", []):
            add("malware", str(malware), "SOCRadar", "Familia de malware", sr_risk)
        for ioc in self.socradar.get("related_iocs", []):
            add(ioc.get("type", "ioc"), ioc.get("value", ""), "SOCRadar",
                ioc.get("context", "IOC relacionado"), sr_risk)

        # ── Mandiant ──────────────────────────────────────────────────────────
        m_verdict = self.mandiant.get("verdict", "CLEAN")
        m_risk    = {"MALICIOUS": "critical", "SUSPICIOUS": "high", "LOW_RISK": "medium"}.get(m_verdict, "info")
        for actor in self.mandiant.get("threat_actors", []):
            add("threat_actor", actor.get("name", ""), "Mandiant",
                f"País: {actor.get('country','?')} · Motivación: {actor.get('motivation','?')}", "critical")
        for mal in self.mandiant.get("malware", []):
            add("malware", mal.get("name", ""), "Mandiant",
                ", ".join(mal.get("capabilities", [])[:3]), "critical")
        for camp in self.mandiant.get("campaigns", []):
            add("campaign", camp.get("name", ""), "Mandiant", camp.get("short_name", ""), "high")

        # ── OTX AlienVault ────────────────────────────────────────────────────
        for pulse in self.intel.get("otx_pulses", []):
            for family in pulse.get("malware_families", []):
                add("malware", family, "OTX", f"Pulse: {pulse.get('name','')}", "critical")
            for attack in pulse.get("attack_ids", []):
                add("attack_id", attack, "OTX", f"Pulse: {pulse.get('name','')}", "high")

        # ── ThreatFox ─────────────────────────────────────────────────────────
        for ioc in self.intel.get("threatfox", []):
            ioc_type_map = {
                "ip:port":     "ip",
                "domain":      "domain",
                "url":         "url",
                "md5_hash":    "hash_md5",
                "sha256_hash": "hash_sha256",
            }
            raw_type = ioc.get("ioc_type", "ioc")
            mapped   = ioc_type_map.get(raw_type, raw_type)
            val      = ioc.get("ioc", "")
            malware  = ioc.get("malware", "")
            alias    = ioc.get("malware_alias", "")
            ctx      = malware + (f" ({alias})" if alias else "")
            conf     = ioc.get("confidence", 0)
            risk     = "critical" if conf >= 75 else "high" if conf >= 50 else "medium"
            add(mapped, val, "ThreatFox", ctx, risk)
            if malware:
                add("malware", malware, "ThreatFox", f"Confianza {conf}%", risk)

        # ── URLhaus ───────────────────────────────────────────────────────────
        for entry in self.intel.get("urlhaus", []):
            url = entry.get("url", "")
            threat = entry.get("threat", "")
            status = entry.get("url_status", "")
            risk   = "critical" if status == "online" else "high"
            add("url", url, "URLhaus", f"{threat} · {status}", risk)

        # Ordenar: critical primero
        order = {"critical": 0, "high": 1, "medium": 2, "info": 3}
        iocs.sort(key=lambda x: order.get(x["risk"], 9))
        return iocs
