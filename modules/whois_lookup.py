import whois
import dns.resolver
from ipwhois import IPWhois
from datetime import datetime
import socket
import re


class WhoisLookup:
    """Extrae registros WHOIS y datos DNS para IPs y dominios."""

    def query(self, target: str) -> dict:
        if self._is_ip(target):
            return self._ip_whois(target)
        return self._domain_whois(target)

    def _is_ip(self, target: str) -> bool:
        pattern = r"^\d{1,3}(\.\d{1,3}){3}$"
        return bool(re.match(pattern, target))

    def _domain_whois(self, domain: str) -> dict:
        result = {
            "type": "domain",
            "target": domain,
            "registrar": None,
            "creation_date": None,
            "expiration_date": None,
            "name_servers": [],
            "registrant_org": None,
            "registrant_country": None,
            "dns_records": {},
            "resolved_ips": [],
            "raw_error": None,
        }
        try:
            w = whois.whois(domain)
            result["registrar"] = str(w.registrar) if w.registrar else None
            result["registrant_org"] = str(w.org) if w.org else None
            result["registrant_country"] = str(w.country) if w.country else None

            for field in ("creation_date", "expiration_date"):
                val = getattr(w, field, None)
                if isinstance(val, list):
                    val = val[0]
                if isinstance(val, datetime):
                    result[field] = val.isoformat()
                elif val:
                    result[field] = str(val)

            if w.name_servers:
                ns = w.name_servers
                result["name_servers"] = list(ns) if not isinstance(ns, list) else ns

        except Exception as e:
            result["raw_error"] = str(e)

        result["dns_records"] = self._get_dns_records(domain)
        result["resolved_ips"] = self._resolve_ips(domain)
        return result

    def _ip_whois(self, ip: str) -> dict:
        result = {
            "type": "ip",
            "target": ip,
            "asn": None,
            "asn_description": None,
            "asn_country": None,
            "network_cidr": None,
            "network_name": None,
            "abuse_contact": None,
            "raw_error": None,
        }
        try:
            obj = IPWhois(ip)
            data = obj.lookup_rdap(depth=1)
            result["asn"] = data.get("asn")
            result["asn_description"] = data.get("asn_description")
            result["asn_country"] = data.get("asn_country_code")
            network = data.get("network", {})
            result["network_cidr"] = network.get("cidr")
            result["network_name"] = network.get("name")

            for obj_entry in data.get("objects", {}).values():
                contact = obj_entry.get("contact", {})
                if contact and contact.get("kind") == "abuse":
                    emails = contact.get("email", [])
                    if emails:
                        result["abuse_contact"] = emails[0].get("value")
                    break
        except Exception as e:
            result["raw_error"] = str(e)

        return result

    def _get_dns_records(self, domain: str) -> dict:
        records = {}
        for rtype in ("A", "MX", "TXT", "NS", "CNAME"):
            try:
                answers = dns.resolver.resolve(domain, rtype, lifetime=5)
                records[rtype] = [str(r) for r in answers]
            except Exception:
                pass
        return records

    def _resolve_ips(self, domain: str) -> list:
        try:
            return list({r[4][0] for r in socket.getaddrinfo(domain, None)})
        except Exception:
            return []
