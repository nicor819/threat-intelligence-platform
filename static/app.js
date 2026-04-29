'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const S = { jobs: {}, activeId: null };

// ── Boot ──────────────────────────────────────────────────────────────────────
const landingInput = document.getElementById('landing-input');
const landingBtn   = document.getElementById('landing-btn');
const landingErr   = document.getElementById('landing-error');
const platInput    = document.getElementById('plat-input');
const platBtn      = document.getElementById('plat-btn');
const historyList  = document.getElementById('history-list');
const platMain     = document.getElementById('plat-main');

landingBtn.addEventListener('click', () => submitTarget(landingInput.value));
landingInput.addEventListener('keydown', e => e.key === 'Enter' && submitTarget(landingInput.value));
platBtn.addEventListener('click', () => submitTarget(platInput.value));
platInput.addEventListener('keydown', e => e.key === 'Enter' && submitTarget(platInput.value));

// ── Submit ────────────────────────────────────────────────────────────────────
async function submitTarget(raw) {
  const val = raw.trim();
  if (!val) return;

  landingErr.style.display = 'none';
  landingBtn.disabled = true;
  platBtn.disabled    = true;

  let res, body;
  try {
    res  = await fetch('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: val }),
    });
    body = await res.json();
  } catch (err) {
    showInputError('Error de red: ' + err.message);
    return;
  }

  if (!res.ok) {
    showInputError(body.error || 'Error desconocido');
    landingBtn.disabled = false; platBtn.disabled = false;
    return;
  }

  // Switch to platform view on first analysis
  switchToPlatform();

  platInput.value = '';
  const { job_id, target } = body;
  addHistoryItem(job_id, target, val);
  renderProgress(job_id, target, val);
  streamJob(job_id);
}

function showInputError(msg) {
  landingErr.textContent = msg;
  landingErr.style.display = 'block';
  document.getElementById('landing-input-wrap').classList.add('error');
  landingBtn.disabled = false; platBtn.disabled = false;
}

// ── View switch ───────────────────────────────────────────────────────────────
function switchToPlatform() {
  document.getElementById('view-landing').style.display  = 'none';
  document.getElementById('view-platform').style.display = 'grid';
}

// ── History ───────────────────────────────────────────────────────────────────
function addHistoryItem(jobId, target, original) {
  // Deactivate others
  document.querySelectorAll('.h-item').forEach(i => i.classList.remove('active'));

  const item = el('div', 'h-item active');
  item.dataset.id = jobId;
  item.innerHTML = `
    <div class="h-dot" id="hdot-${jobId}" style="background:var(--border)"></div>
    <div class="h-info">
      <span class="h-target">${esc(target)}</span>
      <span class="h-original">${esc(truncate(original, 30))}</span>
      <span class="h-score" id="hscore-${jobId}">analizando…</span>
    </div>`;
  item.addEventListener('click', () => selectJob(jobId));
  historyList.prepend(item);
  S.activeId = jobId;
}

function updateHistoryItem(jobId, profile) {
  const risk = profile.risk_summary;
  const dot  = document.getElementById(`hdot-${jobId}`);
  const sc   = document.getElementById(`hscore-${jobId}`);
  if (dot) dot.style.background = riskColor(risk.level);
  if (sc)  sc.textContent = `${risk.level} · ${risk.score}/100`;
}

function selectJob(jobId) {
  document.querySelectorAll('.h-item').forEach(i => i.classList.remove('active'));
  document.querySelector(`.h-item[data-id="${jobId}"]`)?.classList.add('active');
  S.activeId = jobId;
  if (S.jobs[jobId]) renderProfile(S.jobs[jobId]);
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function streamJob(jobId) {
  const es = new EventSource(`/stream/${jobId}`);

  es.addEventListener('step', e => {
    const { name, status } = JSON.parse(e.data);
    if (S.activeId === jobId) updateStep(name, status);
  });

  es.addEventListener('done', e => {
    es.close();
    landingBtn.disabled = false; platBtn.disabled = false;
    const profile = JSON.parse(e.data);
    S.jobs[jobId] = profile;
    updateHistoryItem(jobId, profile);
    if (S.activeId === jobId) renderProfile(profile);
  });

  es.addEventListener('error_event', e => {
    es.close();
    landingBtn.disabled = false; platBtn.disabled = false;
    const { message } = JSON.parse(e.data);
    if (S.activeId === jobId) renderError(message);
  });
}

// ── Progress render ───────────────────────────────────────────────────────────
const STEPS = [
  { name: 'WHOIS / DNS',     icon: '○' },
  { name: 'VirusTotal',      icon: '○' },
  { name: 'URLScan.io',      icon: '○' },
  { name: 'Geolocalización', icon: '○' },
  { name: 'Threat Intel',    icon: '○' },
  { name: 'Mandiant',        icon: '○' },
  { name: 'SOCRadar',        icon: '○' },
  { name: 'Host Tracker',    icon: '○' },
  { name: 'Grafo',           icon: '○' },
];

function renderProgress(jobId, target, original) {
  clearMain();
  const wrap = el('div', 'progress-wrap fade-in');
  wrap.innerHTML = `
    <p class="progress-target">Analizando <strong>${esc(target)}</strong>${original !== target ? ` <span style="color:var(--muted)">← ${esc(truncate(original,50))}</span>` : ''}</p>
    <div class="step-list" id="steplist-${jobId}">
      ${STEPS.map(s => `
        <div class="step-row" id="step-${jobId}-${slug(s.name)}">
          <div class="step-icon-wrap"><span class="step-dot" style="color:var(--subtle);font-size:.9rem">○</span></div>
          <span>${s.name}</span>
        </div>`).join('')}
    </div>`;
  platMain.appendChild(wrap);
}

function updateStep(name, status) {
  const row = document.getElementById(`step-${S.activeId}-${slug(name)}`);
  if (!row) return;
  const iconWrap = row.querySelector('.step-icon-wrap');

  row.classList.remove('active', 'done', 'error');

  if (status === 'running') {
    row.classList.add('active');
    iconWrap.innerHTML = `<div class="spinner"></div>`;
  } else if (status === 'done') {
    row.classList.add('done');
    iconWrap.innerHTML = `<span class="step-check">✓</span>`;
  } else if (status === 'error') {
    row.classList.add('error');
    iconWrap.innerHTML = `<span style="font-size:.8rem">✕</span>`;
  }
}

// ── Profile render ────────────────────────────────────────────────────────────
function renderProfile(p) {
  window._currentProfile = p;
  clearMain();
  const risk = p.risk_summary;

  // ①  Risk header
  platMain.appendChild(riskHeaderEl(p));

  // ②  Quick stats
  platMain.appendChild(statsGridEl(p));

  // ③  WHOIS + Geo side by side
  const row = el('div', 'two-col');
  row.appendChild(whoisEl(p.whois || {}));
  row.appendChild(geoEl(p.geolocation || {}));
  platMain.appendChild(row);

  // ④  IOCs
  if (p.iocs?.length) platMain.appendChild(iocsEl(p.iocs));

  // ⑤  VirusTotal
  platMain.appendChild(vtEl(p.virustotal || {}));

  // ⑥  URLScan.io
  if (p.urlscan && !p.urlscan.error) platMain.appendChild(urlscanEl(p.urlscan));

  // ⑦  Mandiant
  if (p.mandiant && !p.mandiant.error) platMain.appendChild(mandiantEl(p.mandiant));

  // ⑧  SOCRadar
  if (p.socradar && !p.socradar.error) platMain.appendChild(socradarEl(p.socradar));

  // ⑦  Threat Intel
  platMain.appendChild(intelEl(p.threat_intelligence || {}));

  // ⑧  Host Tracker
  if (p.host_tracker) platMain.appendChild(hostTrackerEl(p.host_tracker));

  // ⑨  Graph
  if (p.graph_png_url) platMain.appendChild(graphEl(p));

  platMain.querySelectorAll('.section, .stat-cell, .risk-header')
          .forEach((e,i) => { e.classList.add('fade-in'); e.style.animationDelay = `${i*30}ms`; });
}

// ── Risk header ───────────────────────────────────────────────────────────────
function riskHeaderEl(p) {
  const risk    = p.risk_summary;
  const cls     = `rc-${risk.level}`;
  const original = p.original_url && p.original_url !== p.target ? p.original_url : null;

  const d = el('div', 'risk-header');
  d.innerHTML = `
    <div class="risk-circle ${cls}">
      <span class="rc-num ${cls}">${risk.score}</span>
      <span class="rc-denom">/100</span>
    </div>
    <div class="risk-body">
      <div class="risk-level ${cls}">${risk.level}</div>
      <div class="risk-target-name">${esc(p.target)}</div>
      ${original ? `<div class="risk-original">${esc(truncate(original, 80))}</div>` : ''}
      <div class="risk-stats">
        VT: <span>${risk.vt_verdict || 'N/A'}</span>
        &nbsp;·&nbsp; Mandiant: <span>${risk.mandiant_mscore != null ? `MScore ${risk.mandiant_mscore}` : (risk.mandiant_verdict || 'N/A')}</span>
        &nbsp;·&nbsp; SOCRadar: <span>${risk.socradar_score != null ? `Score ${risk.socradar_score}` : (risk.socradar_verdict || 'N/A')}</span>
        &nbsp;·&nbsp; URLScan: <span>${risk.urlscan_malicious ? '⚠ MALICIOUS' : 'OK'}</span>
        &nbsp;·&nbsp; OTX: <span>${risk.otx_pulses} pulses</span>
        &nbsp;·&nbsp; URLhaus: <span>${risk.urlhaus_hits}</span>
        &nbsp;·&nbsp; ThreatFox: <span>${risk.threatfox_hits}</span>
      </div>
      ${risk.geo_flags?.length
        ? `<div class="flag-row">${risk.geo_flags.map(f => `<span class="flag-pill">${f}</span>`).join('')}</div>`
        : ''}
    </div>
    <button class="btn-tir" onclick="downloadReport(window._currentProfile)" title="Descargar informe TIR">
      ↓ TIR
    </button>`;
  return d;
}

// ── Stats grid ────────────────────────────────────────────────────────────────
function statsGridEl(p) {
  const geo   = p.geolocation || {};
  const whois = p.whois || {};
  const vt    = p.virustotal || {};

  const items = [
    { l: 'País',       v: geo.country    ? `${geo.country_code} — ${geo.country}` : '—' },
    { l: 'Ciudad',     v: geo.city       || '—' },
    { l: 'ISP',        v: geo.isp        || '—' },
    { l: 'ASN',        v: (whois.asn || geo.asn || '—') },
    { l: 'Registrador', v: whois.registrar || '—' },
    { l: 'Creación',   v: whois.creation_date ? whois.creation_date.slice(0,10) : '—' },
    { l: 'VT Malicioso', v: vt.malicious ?? '—', s: vt.malicious > 0 ? 'motores detectan amenaza' : '' },
  ];

  const g = el('div', 'stat-grid');
  items.forEach(i => {
    const c = el('div', 'stat-cell');
    c.innerHTML = `<div class="sc-label">${i.l}</div>
                   <div class="sc-value">${esc(String(i.v))}</div>
                   ${i.s ? `<div class="sc-sub">${i.s}</div>` : ''}`;
    g.appendChild(c);
  });
  return g;
}

// ── WHOIS ─────────────────────────────────────────────────────────────────────
function whoisEl(w) {
  const s = section('WHOIS / DNS');
  const bd = s.querySelector('.section-bd');

  const rows = [
    ['Tipo',        w.type],
    ['Registrador', w.registrar],
    ['Org',         w.registrant_org],
    ['País',        w.registrant_country],
    ['Creación',    w.creation_date?.slice(0,10)],
    ['Expiración',  w.expiration_date?.slice(0,10)],
    ['ASN',         w.asn],
    ['Red',         w.network_cidr],
    ['Abuso',       w.abuse_contact],
  ].filter(([,v]) => v && v !== 'None' && v !== 'none' && v !== 'null');

  bd.appendChild(kvList(rows));

  const ips = w.resolved_ips || [];
  if (ips.length) {
    const tl = el('div', 'tag-row'); tl.style.marginTop = '.6rem';
    ips.forEach(ip => { const t = el('span','tag'); t.textContent = ip; tl.appendChild(t); });
    bd.appendChild(tl);
  }

  const dns = w.dns_records || {};
  if (Object.keys(dns).length) {
    const lbl = el('div','sub-label'); lbl.textContent = 'DNS'; bd.appendChild(lbl);
    const pre = el('div','dns-block');
    pre.textContent = Object.entries(dns).map(([k,v]) => `${k.padEnd(6)} ${v.join(', ')}`).join('\n');
    bd.appendChild(pre);
  }
  return s;
}

// ── Geo ───────────────────────────────────────────────────────────────────────
function geoEl(g) {
  const s = section('Geolocalización');
  const bd = s.querySelector('.section-bd');

  const rows = [
    ['IP',       g.ip],
    ['País',     g.country ? `${g.country_code} — ${g.country}` : null],
    ['Región',   g.region],
    ['Ciudad',   g.city],
    ['Coords',   g.latitude  ? `${g.latitude}, ${g.longitude}` : null],
    ['Timezone', g.timezone],
    ['ISP',      g.isp],
    ['Org',      g.org],
  ].filter(([,v]) => v);

  bd.appendChild(kvList(rows));

  const flags = g.flags || [];
  if (flags.length) {
    const row = el('div','flag-row'); row.style.marginTop = '.6rem';
    flags.forEach(f => { const p = el('span','flag-pill'); p.textContent = f; row.appendChild(p); });
    bd.appendChild(row);
  }
  return s;
}

// ── VirusTotal ────────────────────────────────────────────────────────────────
function vtEl(vt) {
  const s = section('VirusTotal');
  const bd = s.querySelector('.section-bd');

  if (vt.error) { bd.innerHTML = `<p class="no-data">${esc(vt.error)}</p>`; return s; }
  if (!vt.found) { bd.innerHTML = `<p class="no-data">No encontrado en VirusTotal. Configura una API key en config.yaml.</p>`; return s; }

  const stats = el('div', 'vt-stats');
  [
    { k: 'Malicioso',   v: vt.malicious,        c: vt.malicious  > 0 ? 'var(--risk-crit)' : null },
    { k: 'Sospechoso',  v: vt.suspicious,       c: vt.suspicious > 0 ? 'var(--risk-med)'  : null },
    { k: 'Limpio',      v: vt.harmless,         c: null },
    { k: 'No detectado',v: vt.undetected,       c: null },
    { k: 'Reputación',  v: vt.reputation_score ?? '—', c: null },
  ].forEach(i => {
    const c = el('div','vt-cell');
    c.innerHTML = `<div class="vl" style="${i.c ? `color:${i.c}` : ''}">${i.v}</div><div class="vk">${i.k}</div>`;
    stats.appendChild(c);
  });
  bd.appendChild(stats);

  if (vt.tags?.length) {
    const tl = el('div','tag-row');
    vt.tags.forEach(t => { const sp = el('span','tag'); sp.textContent = t; tl.appendChild(sp); });
    bd.appendChild(tl);
  }

  if (vt.detections?.length) {
    const lbl = el('div','sub-label'); lbl.textContent = 'Detecciones'; bd.appendChild(lbl);
    const t = tbl(['Motor AV', 'Resultado', 'Categoría']);
    vt.detections.forEach(d => {
      const cat = d.category === 'malicious' ? 'b-red' : 'b-amber';
      addRow(t, [esc(d.engine), esc(d.result||'—'), `<span class="badge ${cat}">${d.category}</span>`]);
    });
    bd.appendChild(t);
  }
  return s;
}

// ── Intel ─────────────────────────────────────────────────────────────────────
function intelEl(intel) {
  const s = section('Threat Intelligence');
  const bd = s.querySelector('.section-bd');
  let any = false;

  if (intel.otx_pulses?.length) {
    any = true;
    // Stats de reputación OTX
    if (intel.otx_reputation !== undefined || intel.otx_malware_count > 0) {
      const statsRow = el('div','vt-stats'); statsRow.style.marginBottom = '.75rem';
      [
        { k: 'Pulses',      v: intel.otx_pulse_count ?? 0 },
        { k: 'Reputación',  v: intel.otx_reputation ?? '—',  c: intel.otx_reputation < 0 ? 'var(--risk-crit)' : null },
        { k: 'Muestras',    v: intel.otx_malware_count ?? 0, c: intel.otx_malware_count > 0 ? 'var(--risk-high)' : null },
        { k: 'URLs maliciosas', v: intel.otx_url_count ?? 0  },
      ].forEach(i => {
        const c = el('div','vt-cell');
        c.innerHTML = `<div class="vl" style="${i.c ? `color:${i.c}` : ''}">${i.v}</div><div class="vk">${i.k}</div>`;
        statsRow.appendChild(c);
      });
      bd.appendChild(statsRow);
    }
    label(bd, `OTX AlienVault — ${intel.otx_pulse_count} pulses`);
    const t = tbl(['Nombre', 'Autor', 'Familias', 'ATT&CK', 'TLP']);
    intel.otx_pulses.forEach(p => {
      addRow(t, [
        esc(p.name||''),
        esc(p.author||''),
        (p.malware_families||[]).map(f => `<span class="badge b-red">${esc(f)}</span>`).join(' ') || '—',
        (p.attack_ids||[]).slice(0,3).map(a => `<span class="badge b-amber">${esc(a)}</span>`).join(' ') || '—',
        esc(p.tlp||''),
      ]);
    });
    bd.appendChild(t);
  }

  if (intel.urlhaus?.length) {
    any = true;
    label(bd, `URLhaus — ${intel.urlhaus.length} URLs`);
    const t = tbl(['URL', 'Estado', 'Tipo']);
    intel.urlhaus.forEach(u => {
      const b = u.url_status === 'online' ? 'b-red' : 'b-green';
      addRow(t, [
        `<span style="font-size:.75rem">${esc(truncate(u.url||'',60))}</span>`,
        `<span class="badge ${b}">${u.url_status}</span>`,
        esc(u.threat||''),
      ]);
    });
    bd.appendChild(t);
  }

  if (intel.threatfox?.length) {
    any = true;
    label(bd, `ThreatFox — ${intel.threatfox.length} IOCs`);
    const t = tbl(['IOC', 'Malware', 'Alias', 'Confianza', 'Visto', 'Reporter']);
    intel.threatfox.forEach(i => {
      addRow(t, [
        esc(i.ioc||''),
        `<span class="badge b-red">${esc(i.malware||'')}</span>`,
        i.malware_alias ? `<span style="color:var(--text-2);font-size:.75rem">${esc(i.malware_alias)}</span>` : '—',
        `${i.confidence ?? '—'}%`,
        esc((i.first_seen||'').slice(0,10)),
        esc(i.reporter||''),
      ]);
    });
    bd.appendChild(t);
  }

  if (intel.shodan_summary) {
    any = true;
    const sh = intel.shodan_summary;
    label(bd, 'Shodan');
    bd.appendChild(kvList([
      ['Puertos', sh.ports?.join(', ')||'—'],
      ['OS',      sh.os||'—'],
      ['CVEs',    sh.vulns?.join(', ')||'—'],
    ]));
  }

  if (!any) {
    bd.innerHTML = `<p class="no-data">Sin detecciones en feeds públicos (OTX, URLhaus, ThreatFox).<br>Añade una API key de VirusTotal o Shodan en config.yaml para resultados adicionales.</p>`;
  }

  if (intel.errors?.length) {
    const e = el('p',''); e.style.cssText='font-size:.7rem;color:var(--subtle);margin-top:.5rem';
    e.textContent = 'Errores: ' + intel.errors.join(' · ');
    bd.appendChild(e);
  }

  return s;
}

// ── IOCs ──────────────────────────────────────────────────────────────────────
function iocsEl(iocs) {
  const s  = section('Indicadores de Compromiso (IOCs)');
  const hd = s.querySelector('.section-hd');
  const bd = s.querySelector('.section-bd');

  // Contador en el header
  const cnt = el('span', '');
  cnt.style.cssText = 'font-size:.7rem;color:var(--muted);margin-left:auto';
  cnt.textContent   = `${iocs.length} indicadores`;
  hd.appendChild(cnt);

  // Filtros por tipo
  const types   = ['todos', ...new Set(iocs.map(i => i.type))];
  const filterRow = el('div', 'ioc-filter-row');
  let   activeFilter = 'todos';

  types.forEach(t => {
    const btn = el('button', 'ioc-filter' + (t === 'todos' ? ' active' : ''));
    btn.textContent = t === 'todos' ? `Todos (${iocs.length})` : `${t} (${iocs.filter(i=>i.type===t).length})`;
    btn.dataset.filter = t;
    btn.addEventListener('click', () => {
      filterRow.querySelectorAll('.ioc-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = t;
      renderRows(activeFilter);
    });
    filterRow.appendChild(btn);
  });
  bd.appendChild(filterRow);

  // Tabla
  const tableWrap = el('div', '');
  bd.appendChild(tableWrap);

  function renderRows(filter) {
    const visible = filter === 'todos' ? iocs : iocs.filter(i => i.type === filter);
    tableWrap.innerHTML = '';

    if (!visible.length) {
      tableWrap.innerHTML = '<p class="no-data">Sin indicadores para este filtro.</p>';
      return;
    }

    const t  = el('table', 'tbl');
    t.innerHTML = `<thead><tr>
      <th></th><th>Tipo</th><th>Valor</th><th>Fuente</th><th>Contexto</th><th></th>
    </tr></thead>`;
    const tb = el('tbody', '');

    visible.forEach(ioc => {
      const tr   = el('tr', '');
      const typeCls = `ioc-${ioc.type}`;
      const dotCls  = `risk-dot risk-dot-${ioc.risk}`;

      tr.innerHTML = `
        <td style="width:14px"><span class="${dotCls}"></span></td>
        <td><span class="ioc-type ${typeCls}">${esc(ioc.type)}</span></td>
        <td><span class="ioc-value">${esc(ioc.value)}</span></td>
        <td style="color:var(--muted);font-size:.78rem;white-space:nowrap">${esc(ioc.source)}</td>
        <td style="color:var(--muted);font-size:.78rem">${esc(ioc.context)}</td>
        <td><button class="ioc-copy" title="Copiar" onclick="navigator.clipboard.writeText('${esc(ioc.value)}')">⎘</button></td>
      `;
      tb.appendChild(tr);
    });

    t.appendChild(tb);
    tableWrap.appendChild(t);
  }

  renderRows('todos');
  return s;
}

// ── Mandiant ──────────────────────────────────────────────────────────────────
function mandiantEl(m) {
  const s  = section('Mandiant Threat Intelligence');
  const hd = s.querySelector('.section-hd');
  const bd = s.querySelector('.section-bd');

  // Badge de veredicto en header
  const vmap  = { MALICIOUS:'b-red', SUSPICIOUS:'b-amber', LOW_RISK:'b-amber', CLEAN:'b-green', UNKNOWN:'b-gray' };
  const vbadge = el('span', `badge ${vmap[m.verdict] || 'b-gray'}`);
  vbadge.style.marginLeft = 'auto';
  vbadge.textContent = m.verdict || 'UNKNOWN';
  hd.appendChild(vbadge);

  if (m.verdict === 'NOT_FOUND') {
    bd.innerHTML = '<p class="no-data">Indicador no encontrado en Mandiant Threat Intelligence.</p>';
    return s;
  }

  // Stats rápidos
  const statsRow = el('div', 'vt-stats');
  [
    { k: 'MScore',   v: m.mscore ?? '—', c: m.mscore >= 80 ? 'var(--risk-crit)' : m.mscore >= 50 ? 'var(--risk-high)' : null },
    { k: 'Actores',  v: m.threat_actors?.length || 0, c: m.threat_actors?.length ? 'var(--risk-crit)' : null },
    { k: 'Malware',  v: m.malware?.length || 0,       c: m.malware?.length ? 'var(--risk-high)' : null },
    { k: 'Campañas', v: m.campaigns?.length || 0 },
    { k: 'Reportes', v: m.reports?.length || 0 },
  ].forEach(i => {
    const c = el('div', 'vt-cell');
    c.innerHTML = `<div class="vl" style="${i.c ? `color:${i.c}` : ''}">${i.v}</div><div class="vk">${i.k}</div>`;
    statsRow.appendChild(c);
  });
  bd.appendChild(statsRow);

  // Sin detalles adicionales
  const noDetails = !m.threat_actors?.length && !m.malware?.length && !m.campaigns?.length && !m.reports?.length;
  if (noDetails) {
    const note = el('p', 'no-data');
    note.style.marginTop = '.5rem';
    note.textContent = 'Indicador detectado en Mandiant — sin actores, malware ni campañas asociadas en la base de datos.';
    bd.appendChild(note);
  }

  // Categorías
  if (m.categories?.length) {
    const tl = el('div','tag-row'); tl.style.marginBottom = '.75rem';
    m.categories.forEach(c => { const sp = el('span','tag'); sp.textContent = c; tl.appendChild(sp); });
    bd.appendChild(tl);
  }

  // Actores de amenaza
  if (m.threat_actors?.length) {
    label(bd, 'Actores de Amenaza');
    m.threat_actors.forEach(a => {
      const card = el('div', '');
      card.style.cssText = 'background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:.75rem 1rem;margin-bottom:.5rem';
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.4rem">
          <span style="font-size:.85rem;font-weight:600;color:var(--text)">${esc(a.name)}</span>
          ${a.country ? `<span class="badge b-gray">${esc(a.country)}</span>` : ''}
          ${a.motivation ? `<span class="badge b-amber">${esc(a.motivation)}</span>` : ''}
        </div>
        ${a.aliases?.length ? `<div style="font-size:.75rem;color:var(--muted);margin-bottom:.3rem">También conocido como: ${a.aliases.map(x=>`<span class="badge b-gray">${esc(x)}</span>`).join(' ')}</div>` : ''}
        ${a.industries?.length ? `<div style="font-size:.75rem;color:var(--muted);margin-bottom:.3rem">Sectores objetivo: ${a.industries.map(i=>`<span class="tag">${esc(i)}</span>`).join(' ')}</div>` : ''}
        ${a.description ? `<div style="font-size:.78rem;color:var(--text-2);line-height:1.5">${esc(a.description)}</div>` : ''}
        <a href="${a.profile_url}" target="_blank" style="font-size:.72rem;color:var(--muted);text-decoration:none;margin-top:.35rem;display:inline-block">Ver perfil completo ↗</a>`;
      bd.appendChild(card);
    });
  }

  // Familias de malware
  if (m.malware?.length) {
    label(bd, 'Familias de Malware');
    const t = tbl(['Nombre', 'Aliases', 'Capacidades']);
    m.malware.forEach(mal => {
      addRow(t, [
        `<span class="badge b-red">${esc(mal.name)}</span>`,
        (mal.aliases||[]).map(a=>`<span class="badge b-gray">${esc(a)}</span>`).join(' ') || '—',
        (mal.capabilities||[]).slice(0,4).map(c=>`<span class="tag">${esc(c)}</span>`).join(' ') || '—',
      ]);
    });
    bd.appendChild(t);
  }

  // Campañas
  if (m.campaigns?.length) {
    label(bd, 'Campañas');
    const t = tbl(['Nombre', 'Código', 'Enlace']);
    m.campaigns.forEach(c => {
      addRow(t, [
        esc(c.name||''),
        c.short_name ? `<span class="badge b-amber">${esc(c.short_name)}</span>` : '—',
        `<a href="${c.profile_url}" target="_blank" style="color:var(--muted);font-size:.75rem">Ver campaña ↗</a>`,
      ]);
    });
    bd.appendChild(t);
  }

  // Reportes
  if (m.reports?.length) {
    label(bd, 'Reportes de Inteligencia');
    const t = tbl(['Título', 'Tipo', 'Publicado', 'Enlace']);
    m.reports.forEach(r => {
      addRow(t, [
        `<span style="font-size:.8rem">${esc(truncate(r.title||'',60))}</span>`,
        r.report_type ? `<span class="badge b-gray">${esc(r.report_type)}</span>` : '—',
        esc((r.published||'').slice(0,10)),
        `<a href="${r.url}" target="_blank" style="color:var(--muted);font-size:.75rem">Abrir ↗</a>`,
      ]);
    });
    bd.appendChild(t);
  }

  // Fechas
  if (m.first_seen || m.last_seen) {
    const d = el('div',''); d.style.cssText='font-size:.75rem;color:var(--muted);margin-top:.75rem';
    d.innerHTML = `Primera detección: <span style="color:var(--text-2)">${(m.first_seen||'—').slice(0,10)}</span>
      &nbsp;·&nbsp; Última detección: <span style="color:var(--text-2)">${(m.last_seen||'—').slice(0,10)}</span>`;
    bd.appendChild(d);
  }

  return s;
}

// ── SOCRadar ──────────────────────────────────────────────────────────────────
function socradarEl(sr) {
  const s  = section('SOCRadar Threat Intelligence');
  const hd = s.querySelector('.section-hd');
  const bd = s.querySelector('.section-bd');

  const vmap   = { MALICIOUS:'b-red', SUSPICIOUS:'b-amber', LOW_RISK:'b-amber', CLEAN:'b-green', UNKNOWN:'b-gray' };
  const vbadge = el('span', `badge ${vmap[sr.verdict] || 'b-gray'}`);
  vbadge.style.marginLeft = 'auto';
  vbadge.textContent = sr.verdict || 'UNKNOWN';
  hd.appendChild(vbadge);

  if (!sr.verdict || sr.verdict === 'UNKNOWN') {
    bd.innerHTML = `<p class="no-data">SOCRadar no devolvió datos de reputación para este indicador.${sr.error ? ` <span style="color:var(--subtle)">(${esc(sr.error)})</span>` : ''}</p>`;
    return s;
  }

  // Stats
  const statsRow = el('div', 'vt-stats');
  [
    { k: 'Risk Score',  v: sr.risk_score ?? '—', c: sr.risk_score >= 75 ? 'var(--risk-crit)' : sr.risk_score >= 50 ? 'var(--risk-high)' : null },
    { k: 'Actores',     v: sr.threat_actors?.length  || 0 },
    { k: 'Malware',     v: sr.malware_families?.length || 0 },
    { k: 'IOCs relac.', v: sr.related_iocs?.length   || 0 },
  ].forEach(i => {
    const c = el('div', 'vt-cell');
    c.innerHTML = `<div class="vl" style="${i.c ? `color:${i.c}` : ''}">${i.v}</div><div class="vk">${i.k}</div>`;
    statsRow.appendChild(c);
  });
  bd.appendChild(statsRow);

  // Flags de infraestructura
  const flags = [];
  if (sr.is_tor)   flags.push('TOR EXIT NODE');
  if (sr.is_vpn)   flags.push('VPN');
  if (sr.is_proxy) flags.push('PROXY');
  if (flags.length) {
    const row = el('div','flag-row'); row.style.margin = '.5rem 0 .75rem';
    flags.forEach(f => { const p = el('span','flag-pill'); p.textContent = f; row.appendChild(p); });
    bd.appendChild(row);
  }

  // Geo / red
  const geoRows = [
    ['País',       sr.country],
    ['ASN',        sr.asn],
    ['ISP',        sr.isp],
    ['Primera vez', sr.first_seen?.slice(0,10)],
    ['Última vez',  sr.last_seen?.slice(0,10)],
  ].filter(([,v]) => v);
  if (geoRows.length) bd.appendChild(kvList(geoRows));

  // Categorías
  if (sr.categories?.length) {
    const tl = el('div','tag-row'); tl.style.margin = '.5rem 0';
    sr.categories.forEach(c => { const sp = el('span','tag'); sp.textContent = c; tl.appendChild(sp); });
    bd.appendChild(tl);
  }

  // Tags
  if (sr.tags?.length) {
    const tl = el('div','tag-row'); tl.style.marginBottom = '.5rem';
    sr.tags.forEach(t => { const sp = el('span','tag'); sp.textContent = t; tl.appendChild(sp); });
    bd.appendChild(tl);
  }

  // Actores
  if (sr.threat_actors?.length) {
    label(bd, 'Actores de Amenaza');
    const tl = el('div','tag-row');
    sr.threat_actors.forEach(a => { const sp = el('span','badge b-red'); sp.textContent = a; tl.appendChild(sp); });
    bd.appendChild(tl);
  }

  // Malware
  if (sr.malware_families?.length) {
    label(bd, 'Familias de Malware');
    const tl = el('div','tag-row');
    sr.malware_families.forEach(m => { const sp = el('span','badge b-amber'); sp.textContent = m; tl.appendChild(sp); });
    bd.appendChild(tl);
  }

  // IOCs relacionados
  if (sr.related_iocs?.length) {
    label(bd, 'IOCs Relacionados');
    const t = tbl(['Tipo', 'Valor', 'Contexto']);
    sr.related_iocs.forEach(i => {
      addRow(t, [
        `<span class="badge b-gray">${esc(i.type||'ioc')}</span>`,
        `<span class="ioc-value">${esc(i.value||'')}</span>`,
        esc(i.context||''),
      ]);
    });
    bd.appendChild(t);
  }

  return s;
}

// ── URLScan ───────────────────────────────────────────────────────────────────
function urlscanEl(us) {
  const s  = section('URLScan.io');
  const bd = s.querySelector('.section-bd');

  const scan = us.latest_scan || us.new_scan || {};
  const vs   = us.verdicts || scan.verdicts || {};

  if (!scan.uuid && !us.existing_results?.length) {
    bd.innerHTML = `<p class="no-data">Sin resultados en URLScan para este target.</p>`;
    return s;
  }

  // Veredicto + stats rápidos
  const malicious = vs.malicious ?? scan.verdicts?.malicious;
  const statsRow  = el('div', 'vt-stats');
  [
    { k: 'Veredicto',  v: malicious ? '⚠ MALICIOUS' : 'Limpio',     c: malicious ? 'var(--risk-crit)' : 'var(--risk-clean)' },
    { k: 'Score',      v: vs.score ?? vs.urlscan_score ?? '—',        c: null },
    { k: 'Motores',    v: `${vs.engine_malicious ?? 0} maliciosos`,   c: (vs.engine_malicious > 0) ? 'var(--risk-high)' : null },
    { k: 'Requests',   v: scan.requests_total ?? '—',                 c: null },
    { k: 'Ads blocked',v: scan.ads_blocked ?? '—',                    c: null },
  ].forEach(i => {
    const c = el('div', 'vt-cell');
    c.innerHTML = `<div class="vl" style="${i.c ? `color:${i.c}` : ''}">${i.v}</div><div class="vk">${i.k}</div>`;
    statsRow.appendChild(c);
  });
  bd.appendChild(statsRow);

  // Info de la página escaneada
  const pageRows = [
    ['URL escaneada',  scan.url],
    ['Título',         scan.title],
    ['Servidor',       scan.server],
    ['IP',             scan.ip],
    ['País',           scan.country],
    ['Estado HTTP',    scan.status_code],
    ['TLS Issuer',     scan.tls_issuer],
    ['TLS Días',       scan.tls_valid_days],
    ['Fecha escaneo',  scan.scan_date],
  ].filter(([,v]) => v);
  if (pageRows.length) {
    label(bd, 'Página analizada');
    bd.appendChild(kvList(pageRows));
  }

  // Tags / brands / categories
  const tags = [...(vs.tags||[]), ...(vs.brands||[]), ...(vs.categories||[])];
  if (tags.length) {
    const tl = el('div','tag-row'); tl.style.marginTop = '.5rem';
    tags.forEach(t => { const sp = el('span','tag'); sp.textContent = t; tl.appendChild(sp); });
    bd.appendChild(tl);
  }

  // Dominios observados
  const domains = scan.domains || [];
  if (domains.length) {
    label(bd, 'Dominios contactados');
    const tl = el('div','tag-row');
    domains.forEach(d => { const sp = el('span','tag'); sp.textContent = d; tl.appendChild(sp); });
    bd.appendChild(tl);
  }

  // Certificados
  const certs = scan.certificates || [];
  if (certs.length) {
    label(bd, 'Certificados');
    const tl = el('div','tag-row');
    certs.forEach(c => { const sp = el('span','tag'); sp.textContent = c; tl.appendChild(sp); });
    bd.appendChild(tl);
  }

  // Links al reporte
  if (scan.uuid) {
    const acts = el('div','graph-actions'); acts.style.marginTop = '.75rem';
    const rpt  = el('a','btn-ghost');
    rpt.href   = `https://urlscan.io/result/${scan.uuid}/`;
    rpt.target = '_blank';
    rpt.textContent = 'Ver reporte completo ↗';
    acts.appendChild(rpt);

    if (us.screenshot_url) {
      const ss  = el('a','btn-ghost');
      ss.href   = us.screenshot_url;
      ss.target = '_blank';
      ss.textContent = 'Screenshot ↗';
      acts.appendChild(ss);
    }
    bd.appendChild(acts);
  }

  // Resultados previos (historial)
  if (us.existing_results?.length) {
    label(bd, `${us.existing_results.length} escaneos previos`);
    const t = tbl(['UUID', 'URL', 'Fecha']);
    us.existing_results.forEach(r => {
      const task = r.task || {};
      const link = `https://urlscan.io/result/${r._id}/`;
      addRow(t, [
        `<a href="${link}" target="_blank" style="color:var(--text-2);font-size:.75rem">${(r._id||'').slice(0,8)}…</a>`,
        esc(truncate(task.url || r.page?.url || '', 50)),
        esc((task.time || '').slice(0, 10)),
      ]);
    });
    bd.appendChild(t);
  }

  return s;
}

// ── Graph ─────────────────────────────────────────────────────────────────────
function graphEl(p) {
  const s = section('Diagrama de Relaciones');
  const bd = s.querySelector('.section-bd');
  const img = el('img', 'graph-img');
  img.src = p.graph_png_url;
  img.alt = 'Relationship graph';
  bd.appendChild(img);
  const acts = el('div','graph-actions');
  const dl   = el('a','btn-ghost'); dl.href = p.graph_png_url; dl.download = ''; dl.textContent = 'Descargar PNG';
  acts.appendChild(dl);
  if (p.graph_html_url) {
    const op = el('a','btn-ghost'); op.href = p.graph_html_url; op.target='_blank'; op.textContent = 'Ver interactivo';
    acts.appendChild(op);
  }
  bd.appendChild(acts);
  return s;
}

// ── Host Tracker ──────────────────────────────────────────────────────────────
function hostTrackerEl(ht) {
  const s  = section('Host Tracker');
  const hd = s.querySelector('.section-hd');
  const bd = s.querySelector('.section-bd');

  if (ht.error) { bd.innerHTML = `<p class="no-data">${esc(ht.error)}</p>`; return s; }

  // Badge IP resuelta
  if (ht.ip) {
    const ip = el('span', 'badge b-gray');
    ip.style.marginLeft = 'auto';
    ip.textContent = ht.ip;
    hd.appendChild(ip);
  }

  // ── Certificado TLS ──
  const cert = ht.certificate || {};
  {
    label(bd, 'Certificado TLS');
    if (cert.error) {
      const p = el('p', 'no-data'); p.textContent = cert.error; bd.appendChild(p);
    } else if (cert.valid === false) {
      const p = el('p', 'no-data'); p.textContent = cert.error || 'Certificado inválido'; bd.appendChild(p);
    } else {
      const daysLeft = cert.days_remaining;
      const daysColor = daysLeft < 0 ? 'var(--risk-crit)' : daysLeft <= 30 ? 'var(--risk-high)' : 'var(--risk-clean)';
      const daysLabel = daysLeft < 0 ? `Expirado hace ${Math.abs(daysLeft)} días` :
                        daysLeft <= 30 ? `⚠ Expira en ${daysLeft} días` :
                        `Válido — ${daysLeft} días restantes`;

      const statsRow = el('div', 'vt-stats');
      [
        { k: 'Días restantes', v: daysLeft ?? '—', c: daysColor },
        { k: 'TLS',            v: cert.tls_version || '—', c: null },
        { k: 'Cipher',         v: cert.cipher || '—',       c: null },
      ].forEach(i => {
        const c = el('div', 'vt-cell');
        c.innerHTML = `<div class="vl" style="${i.c ? `color:${i.c}` : ''}">${esc(String(i.v))}</div><div class="vk">${i.k}</div>`;
        statsRow.appendChild(c);
      });
      bd.appendChild(statsRow);

      // Barra de expiración visual
      const bar = el('div', '');
      bar.style.cssText = 'margin:-.25rem 0 .75rem;font-size:.75rem';
      bar.innerHTML = `<span style="color:${daysColor}">${esc(daysLabel)}</span>`;
      bd.appendChild(bar);

      bd.appendChild(kvList([
        ['Subject CN',  cert.subject_cn],
        ['Emisor',      cert.issuer_org || cert.issuer_cn],
        ['Válido desde',cert.not_before?.slice(0,10)],
        ['Expira',      cert.not_after?.slice(0,10)],
        ['Serial',      cert.serial],
      ].filter(([,v]) => v)));

      if (cert.sans?.length) {
        const lbl = el('div','sub-label'); lbl.textContent = 'Subject Alternative Names'; bd.appendChild(lbl);
        const tl = el('div','tag-row');
        cert.sans.forEach(san => { const sp = el('span','tag'); sp.textContent = san; tl.appendChild(sp); });
        bd.appendChild(tl);
      }
    }
  }

  // ── Puertos abiertos ──
  const ports = ht.open_ports || [];
  label(bd, `Puertos abiertos — ${ports.length} encontrados`);
  if (!ports.length) {
    const p = el('p','no-data'); p.textContent = 'Ningún puerto responde en el rango escaneado.'; bd.appendChild(p);
  } else {
    const riskPorts = new Set([21,23,25,445,3389,3306,5432,6379,27017,1433]);
    const t = tbl(['Puerto', 'Servicio', 'Riesgo', 'Banner']);
    ports.forEach(p => {
      const isRisk = riskPorts.has(p.port);
      addRow(t, [
        `<strong style="font-family:monospace">${p.port}</strong>`,
        `<span class="badge ${isRisk ? 'b-amber' : 'b-gray'}">${esc(p.service)}</span>`,
        isRisk ? `<span style="color:var(--risk-high);font-size:.72rem">⚠ Expuesto</span>` : `<span style="color:var(--muted);font-size:.72rem">Normal</span>`,
        `<span style="font-size:.72rem;color:var(--muted);font-family:monospace">${esc(p.banner||'—')}</span>`,
      ]);
    });
    bd.appendChild(t);
  }

  // ── Cambios detectados ──
  const chg = ht.domain_changes || {};
  label(bd, 'Cambios detectados');
  if (chg.status === 'no_previous_scan') {
    const p = el('p','no-data'); p.textContent = 'Primer análisis — sin baseline previo para comparar.'; bd.appendChild(p);
  } else if (!chg.changes?.length) {
    const p = el('p',''); p.style.cssText='font-size:.8rem;color:var(--risk-clean)';
    p.textContent = `✓ Sin cambios detectados respecto al análisis anterior (${chg.last_scan?.slice(0,10) || '—'}).`;
    bd.appendChild(p);
  } else {
    const t = tbl(['Campo', 'Tipo', 'Detalle']);
    chg.changes.forEach(c => {
      const typeColor = c.type === 'added' ? 'b-green' : c.type === 'removed' ? 'b-red' : c.type === 'expired' ? 'b-red' : c.type === 'warning' ? 'b-amber' : 'b-gray';
      addRow(t, [
        esc(c.field),
        `<span class="badge ${typeColor}">${esc(c.type)}</span>`,
        esc(c.detail),
      ]);
    });
    bd.appendChild(t);
    const note = el('p',''); note.style.cssText='font-size:.72rem;color:var(--muted);margin-top:.5rem';
    note.textContent = `Comparado con análisis del ${chg.last_scan?.slice(0,10) || '—'}`;
    bd.appendChild(note);
  }

  return s;
}

// ── TIR Report Generator ──────────────────────────────────────────────────────
function downloadReport(p) {
  if (!p) return;
  const risk   = p.risk_summary || {};
  const whois  = p.whois        || {};
  const geo    = p.geolocation  || {};
  const vt     = p.virustotal   || {};
  const us     = p.urlscan      || {};
  const man    = p.mandiant     || {};
  const sr     = p.socradar     || {};
  const intel  = p.threat_intelligence || {};
  const iocs   = p.iocs         || [];
  const now    = new Date().toISOString().slice(0,16).replace('T',' ');
  const scan   = us.latest_scan || us.new_scan || {};
  const vs     = us.verdicts    || {};

  const riskColors = {
    CRITICAL: '#ef4444', HIGH: '#f97316', MEDIUM: '#f59e0b', LOW: '#86efac', CLEAN: '#6ee7b7'
  };
  const rc = riskColors[risk.level] || '#999';

  function h(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function row(k, v) {
    if (!v && v !== 0) return '';
    return `<tr><td class="kk">${h(k)}</td><td>${h(v)}</td></tr>`;
  }
  function badge(text, color) {
    return `<span style="background:${color}22;color:${color};border:1px solid ${color}44;padding:1px 7px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase">${h(text)}</span>`;
  }
  function section(title, content) {
    return `
      <div class="rpt-section">
        <div class="rpt-section-title">${title}</div>
        ${content}
      </div>`;
  }
  function table(headers, rows) {
    if (!rows.length) return '<p class="empty">Sin datos</p>';
    return `<table><thead><tr>${headers.map(h2=>`<th>${h2}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody></table>`;
  }

  // ── IOC table ──
  const iocTypes = {
    critical: '#ef4444', high: '#f97316', medium: '#f59e0b', info: '#888'
  };
  const iocRows = iocs.map(i => `<tr>
    <td><span style="width:7px;height:7px;border-radius:50%;background:${iocTypes[i.risk]||'#888'};display:inline-block;margin-right:4px"></span></td>
    <td><code style="font-size:9px;background:#f0f0f0;padding:1px 4px;border-radius:2px">${h(i.type)}</code></td>
    <td style="font-family:monospace;font-size:10px;word-break:break-all">${h(i.value)}</td>
    <td>${h(i.source)}</td>
    <td>${h(i.context)}</td>
  </tr>`);

  // ── VT detections ──
  const vtRows = (vt.detections||[]).map(d => `<tr>
    <td>${h(d.engine)}</td>
    <td>${h(d.result||'—')}</td>
    <td>${h(d.category)}</td>
  </tr>`);

  // ── OTX pulses ──
  const otxRows = (intel.otx_pulses||[]).map(pp => `<tr>
    <td>${h(pp.name)}</td>
    <td>${h(pp.author)}</td>
    <td>${(pp.malware_families||[]).map(f=>h(f)).join(', ')||'—'}</td>
    <td>${(pp.attack_ids||[]).slice(0,3).join(', ')||'—'}</td>
  </tr>`);

  // ── ThreatFox ──
  const tfRows = (intel.threatfox||[]).map(i => `<tr>
    <td style="font-family:monospace;font-size:9px">${h(i.ioc)}</td>
    <td>${h(i.malware)}</td>
    <td>${i.confidence ?? '—'}%</td>
    <td>${h((i.first_seen||'').slice(0,10))}</td>
  </tr>`);

  // ── URLhaus ──
  const uhRows = (intel.urlhaus||[]).map(u => `<tr>
    <td style="font-family:monospace;font-size:9px;word-break:break-all">${h(u.url)}</td>
    <td>${h(u.url_status)}</td>
    <td>${h(u.threat)}</td>
  </tr>`);

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>TIR — ${h(p.target)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 11px; color: #1a1a1a; background: #fff; line-height: 1.5; }

  .cover { padding: 48px 56px 36px; border-bottom: 3px solid #1a1a1a; }
  .cover-top { display: flex; align-items: flex-start; justify-content: space-between; }
  .cover-brand { font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #888; }
  .cover-date  { font-size: 10px; color: #888; text-align: right; }
  .cover-target { font-size: 26px; font-weight: 700; margin: 20px 0 4px; word-break: break-all; }
  .cover-orig   { font-size: 11px; color: #666; margin-bottom: 20px; word-break: break-all; }

  .risk-badge { display: inline-flex; align-items: center; gap: 12px; padding: 12px 20px; border: 2px solid ${rc}; border-radius: 6px; }
  .risk-score { font-size: 32px; font-weight: 800; color: ${rc}; line-height: 1; }
  .risk-info  { display: flex; flex-direction: column; }
  .risk-level { font-size: 13px; font-weight: 700; color: ${rc}; text-transform: uppercase; letter-spacing: .08em; }
  .risk-label { font-size: 9px; color: #888; text-transform: uppercase; letter-spacing: .08em; }

  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 20px; }
  .sg-cell { background: #f8f8f8; border: 1px solid #e0e0e0; border-radius: 4px; padding: 8px 10px; }
  .sg-val  { font-size: 13px; font-weight: 700; }
  .sg-key  { font-size: 8px; text-transform: uppercase; letter-spacing: .07em; color: #888; margin-top: 2px; }

  .content { padding: 0 56px 56px; }

  .rpt-section { margin-top: 28px; page-break-inside: avoid; }
  .rpt-section-title {
    font-size: 8px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
    color: #888; border-bottom: 1px solid #e0e0e0; padding-bottom: 5px; margin-bottom: 10px;
  }

  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th { text-align: left; font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: #888; padding: 4px 8px; border-bottom: 1px solid #e0e0e0; }
  td { padding: 5px 8px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  tr:last-child td { border-bottom: none; }

  table.kv td.kk { color: #666; width: 160px; flex-shrink: 0; }

  .two-col-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }

  .ioc-section table td { font-size: 10px; }

  .empty { color: #aaa; font-size: 10px; font-style: italic; padding: 6px 0; }

  .flags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .flag  { font-size: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em;
           padding: 2px 8px; border-radius: 2px; background: #f0f0f0; border: 1px solid #ddd; color: #555; }

  .footer { margin-top: 40px; border-top: 1px solid #e0e0e0; padding-top: 12px;
            font-size: 9px; color: #aaa; display: flex; justify-content: space-between; }

  @media print {
    .no-print { display: none !important; }
    body { font-size: 10px; }
    .cover { padding: 32px 40px 24px; }
    .content { padding: 0 40px 40px; }
    .rpt-section { page-break-inside: avoid; }
  }

  .print-bar {
    position: fixed; top: 0; left: 0; right: 0;
    background: #1a1a1a; color: #fff; padding: 10px 20px;
    display: flex; align-items: center; justify-content: space-between;
    font-size: 12px; z-index: 999;
  }
  .print-bar button {
    background: #fff; color: #1a1a1a; border: none; padding: 6px 16px;
    border-radius: 3px; font-size: 11px; font-weight: 600; cursor: pointer;
  }
  body { padding-top: 42px; }
  @media print { body { padding-top: 0; } .print-bar { display: none; } }
</style>
</head>
<body>

<div class="print-bar no-print">
  <span>Threat Intelligence Report — ${h(p.target)}</span>
  <button onclick="window.print()">Imprimir / Guardar PDF</button>
</div>

<!-- COVER -->
<div class="cover">
  <div class="cover-top">
    <div>
      <div class="cover-brand">Threat Intelligence Report (TIR)</div>
    </div>
    <div class="cover-date">
      Generado: ${now}<br>
      Schema: ${h(p.schema_version || '—')}
    </div>
  </div>
  <div class="cover-target">${h(p.target)}</div>
  ${p.original_url && p.original_url !== p.target ? `<div class="cover-orig">URL original: ${h(p.original_url)}</div>` : ''}

  <div class="risk-badge">
    <div class="risk-score">${risk.score ?? '—'}</div>
    <div class="risk-info">
      <span class="risk-label">Risk Score</span>
      <span class="risk-level">${risk.level || '—'}</span>
    </div>
  </div>

  <div class="summary-grid">
    <div class="sg-cell">
      <div class="sg-val">${h(risk.vt_verdict || 'N/A')}</div>
      <div class="sg-key">VirusTotal</div>
    </div>
    <div class="sg-cell">
      <div class="sg-val">${risk.mandiant_mscore != null ? `MScore ${risk.mandiant_mscore}` : h(risk.mandiant_verdict || 'N/A')}</div>
      <div class="sg-key">Mandiant</div>
    </div>
    <div class="sg-cell">
      <div class="sg-val">${risk.urlscan_malicious ? '⚠ MALICIOUS' : 'Clean'}</div>
      <div class="sg-key">URLScan</div>
    </div>
    <div class="sg-cell">
      <div class="sg-val">${risk.otx_pulses ?? 0}</div>
      <div class="sg-key">OTX Pulses</div>
    </div>
    <div class="sg-cell">
      <div class="sg-val">${risk.urlhaus_hits ?? 0}</div>
      <div class="sg-key">URLhaus hits</div>
    </div>
    <div class="sg-cell">
      <div class="sg-val">${risk.threatfox_hits ?? 0}</div>
      <div class="sg-key">ThreatFox IOCs</div>
    </div>
    <div class="sg-cell">
      <div class="sg-val">${iocs.length}</div>
      <div class="sg-key">IOCs totales</div>
    </div>
    <div class="sg-cell">
      <div class="sg-val">${risk.mandiant_actors ?? 0} / ${risk.mandiant_malware ?? 0}</div>
      <div class="sg-key">Actores / Malware</div>
    </div>
  </div>

  ${risk.geo_flags?.length ? `<div class="flags">${risk.geo_flags.map(f=>`<span class="flag">${h(f)}</span>`).join('')}</div>` : ''}
</div>

<!-- CONTENT -->
<div class="content">

  <!-- 1. WHOIS / GEO -->
  ${section('1. Infraestructura — WHOIS &amp; Geolocalización', `
    <div class="two-col-grid">
      <div>
        <table class="kv">
          ${row('Tipo', whois.type)}
          ${row('Registrador', whois.registrar)}
          ${row('Org', whois.registrant_org)}
          ${row('País WHOIS', whois.registrant_country)}
          ${row('Creación', (whois.creation_date||'').slice(0,10))}
          ${row('Expiración', (whois.expiration_date||'').slice(0,10))}
          ${row('ASN', whois.asn)}
          ${row('Red CIDR', whois.network_cidr)}
          ${row('Abuse Contact', whois.abuse_contact)}
          ${(whois.resolved_ips||[]).length ? `<tr><td class="kk">IPs resueltas</td><td style="font-family:monospace;font-size:10px">${whois.resolved_ips.map(i=>h(i)).join('<br>')}</td></tr>` : ''}
        </table>
      </div>
      <div>
        <table class="kv">
          ${row('IP', geo.ip)}
          ${row('País', geo.country ? `${geo.country_code} — ${geo.country}` : null)}
          ${row('Región', geo.region)}
          ${row('Ciudad', geo.city)}
          ${row('Coordenadas', geo.latitude ? `${geo.latitude}, ${geo.longitude}` : null)}
          ${row('ISP', geo.isp)}
          ${row('Org', geo.org)}
          ${row('ASN', geo.asn)}
          ${row('Timezone', geo.timezone)}
        </table>
      </div>
    </div>
  `)}

  <!-- 2. VirusTotal -->
  ${section('2. VirusTotal', vt.found ? `
    <div class="summary-grid" style="grid-template-columns:repeat(5,1fr);margin-bottom:12px">
      <div class="sg-cell"><div class="sg-val" style="color:#ef4444">${vt.malicious??0}</div><div class="sg-key">Malicioso</div></div>
      <div class="sg-cell"><div class="sg-val" style="color:#f97316">${vt.suspicious??0}</div><div class="sg-key">Sospechoso</div></div>
      <div class="sg-cell"><div class="sg-val">${vt.harmless??0}</div><div class="sg-key">Limpio</div></div>
      <div class="sg-cell"><div class="sg-val">${vt.undetected??0}</div><div class="sg-key">No detectado</div></div>
      <div class="sg-cell"><div class="sg-val">${vt.reputation_score??'—'}</div><div class="sg-key">Reputación</div></div>
    </div>
    ${vtRows.length ? table(['Motor AV', 'Resultado', 'Categoría'], vtRows) : '<p class="empty">Sin detecciones</p>'}
  ` : '<p class="empty">No encontrado en VirusTotal</p>')}

  <!-- 3. URLScan.io -->
  ${section('3. URLScan.io', scan.uuid ? `
    <table class="kv" style="margin-bottom:10px">
      ${row('Veredicto', vs.malicious ? '⚠ MALICIOUS' : 'Limpio')}
      ${row('Score', vs.score)}
      ${row('Motores maliciosos', vs.engine_malicious)}
      ${row('URL escaneada', scan.url)}
      ${row('Título', scan.title)}
      ${row('Servidor', scan.server)}
      ${row('IP', scan.ip)}
      ${row('País', scan.country)}
      ${row('TLS Issuer', scan.tls_issuer)}
      ${row('Fecha escaneo', scan.scan_date)}
      ${row('UUID', scan.uuid)}
    </table>
  ` : '<p class="empty">Sin resultados URLScan</p>')}

  <!-- 4. Mandiant -->
  ${section('4. Mandiant Threat Intelligence', man.verdict && man.verdict !== 'NOT_FOUND' ? `
    <table class="kv" style="margin-bottom:10px">
      ${row('Veredicto', man.verdict)}
      ${row('MScore', man.mscore)}
      ${row('Primera detección', (man.first_seen||'').slice(0,10))}
      ${row('Última detección', (man.last_seen||'').slice(0,10))}
    </table>
    ${(man.threat_actors||[]).length ? `
      <div style="margin-top:8px;font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:4px">Actores de Amenaza</div>
      ${table(['Nombre','País','Motivación','Industrias'],
        man.threat_actors.map(a=>`<tr><td>${h(a.name)}</td><td>${h(a.country||'—')}</td><td>${h(a.motivation||'—')}</td><td>${(a.industries||[]).join(', ')||'—'}</td></tr>`)
      )}` : ''}
    ${(man.malware||[]).length ? `
      <div style="margin-top:8px;font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:4px">Familias de Malware</div>
      ${table(['Nombre','Aliases','Capacidades'],
        man.malware.map(m2=>`<tr><td>${h(m2.name)}</td><td>${(m2.aliases||[]).join(', ')||'—'}</td><td>${(m2.capabilities||[]).slice(0,4).join(', ')||'—'}</td></tr>`)
      )}` : ''}
  ` : `<p class="empty">${man.verdict === 'NOT_FOUND' ? 'Indicador no encontrado en Mandiant' : 'Sin datos Mandiant'}</p>`)}

  <!-- 5. Threat Intelligence Feeds -->
  ${section('5. Threat Intelligence Feeds', `
    ${(intel.otx_pulses||[]).length ? `
      <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:4px">AlienVault OTX — ${intel.otx_pulse_count} pulses</div>
      ${table(['Nombre','Autor','Familias malware','ATT&CK'], otxRows)}
    ` : ''}
    ${(intel.threatfox||[]).length ? `
      <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin:10px 0 4px">ThreatFox — ${intel.threatfox.length} IOCs</div>
      ${table(['IOC','Malware','Confianza','Visto'], tfRows)}
    ` : ''}
    ${(intel.urlhaus||[]).length ? `
      <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin:10px 0 4px">URLhaus — ${intel.urlhaus.length} URLs</div>
      ${table(['URL','Estado','Tipo'], uhRows)}
    ` : ''}
    ${!intel.otx_pulses?.length && !intel.threatfox?.length && !intel.urlhaus?.length ? '<p class="empty">Sin detecciones en feeds públicos</p>' : ''}
  `)}

  <!-- 6. IOCs -->
  ${section('6. Indicadores de Compromiso (IOCs)', `
    <div class="ioc-section">
      ${table(['','Tipo','Valor','Fuente','Contexto'], iocRows)}
    </div>
  `)}

  <!-- 7. Graph -->
  ${p.graph_png_url ? section('7. Diagrama de Relaciones', `
    <img src="${h(p.graph_png_url)}" style="width:100%;max-width:700px;border:1px solid #e0e0e0;border-radius:4px;margin-top:4px">
  `) : ''}

  <div class="footer">
    <span>Threat Intelligence Platform — Informe TIR generado automáticamente</span>
    <span>${now}</span>
  </div>
</div>
</body>
</html>`;

  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
}

// ── Error ─────────────────────────────────────────────────────────────────────
function renderError(msg) {
  clearMain();
  const d = el('div','');
  d.style.cssText = 'color:var(--risk-crit);font-size:.85rem;padding:1rem 0';
  d.textContent = 'Error: ' + msg;
  platMain.appendChild(d);
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function clearMain() {
  platMain.innerHTML = '';
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function section(title) {
  const s = el('div', 'section');
  s.innerHTML = `<div class="section-hd"><span class="section-title">${title}</span></div><div class="section-bd"></div>`;
  return s;
}

function kvList(rows) {
  const list = el('div', 'kv-list');
  rows.forEach(([k, v]) => {
    const r = el('div', 'kv-row');
    r.innerHTML = `<span class="kv-k">${k}</span><span class="kv-v">${esc(String(v ?? '—'))}</span>`;
    list.appendChild(r);
  });
  return list;
}

function tbl(headers) {
  const t = el('table', 'tbl');
  t.innerHTML = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody></tbody>`;
  return t;
}

function addRow(table, cells) {
  const tr = el('tr', '');
  tr.innerHTML = cells.map(c => `<td>${c}</td>`).join('');
  table.querySelector('tbody').appendChild(tr);
}

function label(parent, text) {
  const d = el('div', 'sub-label');
  d.textContent = text;
  parent.appendChild(d);
}

function riskColor(level) {
  return { CRITICAL:'#f87171', HIGH:'#fb923c', MEDIUM:'#fbbf24', LOW:'#86efac', CLEAN:'#6ee7b7' }[level] || '#666';
}

function slug(s)       { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
function esc(s)        { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function truncate(s,n) { return s.length > n ? s.slice(0,n) + '…' : s; }
