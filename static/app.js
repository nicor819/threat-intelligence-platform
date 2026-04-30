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

document.getElementById('btn-clear-history')?.addEventListener('click', clearAllHistory);

// Cargar historial del servidor al arrancar
loadServerHistory();

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

  // Agregar botón eliminar al completarse
  const item = document.querySelector(`.h-item[data-id="${jobId}"]`);
  if (item && !item.querySelector('.h-del')) {
    const btn = el('button', 'h-del');
    btn.title = 'Eliminar';
    btn.textContent = '×';
    btn.addEventListener('click', e => { e.stopPropagation(); deleteHistoryEntry(jobId); });
    item.appendChild(btn);
  }
  updateHistoryCount();
}

function selectJob(jobId) {
  document.querySelectorAll('.h-item').forEach(i => i.classList.remove('active'));
  document.querySelector(`.h-item[data-id="${jobId}"]`)?.classList.add('active');
  S.activeId = jobId;
  if (S.jobs[jobId]) renderProfile(S.jobs[jobId]);
}

// ── Historial persistente (servidor) ─────────────────────────────────────────

async function loadServerHistory() {
  try {
    const res     = await fetch('/history');
    const entries = await res.json();
    if (!Array.isArray(entries) || !entries.length) return;

    // Pre-cargar sidebar con análisis previos
    entries.forEach(e => addServerHistoryItem(e));
    updateHistoryCount();

    // Si no hay análisis activos en sesión, mostrar la plataforma
    if (!S.activeId) switchToPlatform();
  } catch (_) { /* sin historial disponible */ }
}

function addServerHistoryItem(entry) {
  if (document.querySelector(`.h-item[data-id="${entry.id}"]`)) return;

  const color = riskColor(entry.risk_level);
  const date  = (() => {
    try {
      return new Date(entry.analyzed_at).toLocaleString('es-CO', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    } catch (_) { return entry.analyzed_at?.slice(0, 16) || ''; }
  })();

  const item = el('div', 'h-item');
  item.dataset.id = entry.id;
  item.innerHTML = `
    <div class="h-dot" style="background:${color}"></div>
    <div class="h-info">
      <span class="h-target">${esc(entry.target)}</span>
      <span class="h-original">${esc(truncate(entry.original_url || entry.target, 30))}</span>
      <span class="h-score" style="color:${color}">${entry.risk_level} · ${entry.risk_score}/100</span>
      <span class="h-date">${date} &middot; ${entry.ioc_count} IOCs</span>
    </div>
    <button class="h-del" title="Eliminar">&times;</button>`;

  item.querySelector('.h-del').addEventListener('click', e => {
    e.stopPropagation();
    deleteHistoryEntry(entry.id);
  });
  item.addEventListener('click', () => selectServerJob(entry.id));
  historyList.appendChild(item);
}

async function selectServerJob(entryId) {
  document.querySelectorAll('.h-item').forEach(i => i.classList.remove('active'));
  document.querySelector(`.h-item[data-id="${entryId}"]`)?.classList.add('active');
  S.activeId = entryId;

  if (S.jobs[entryId]) { renderProfile(S.jobs[entryId]); return; }

  switchToPlatform();
  platMain.innerHTML = '<div style="color:var(--muted);font-size:.85rem;padding:2rem 0;text-align:center">Cargando análisis…</div>';
  try {
    const res = await fetch(`/history/${entryId}`);
    if (!res.ok) throw new Error('No encontrado');
    const profile     = await res.json();
    S.jobs[entryId]   = profile;
    renderProfile(profile);
  } catch (e) {
    renderError('No se pudo cargar el análisis: ' + e.message);
  }
}

async function deleteHistoryEntry(entryId) {
  await fetch(`/history/${entryId}`, { method: 'DELETE' });
  const item = document.querySelector(`.h-item[data-id="${entryId}"]`);
  if (item) item.remove();
  if (S.activeId === entryId) { S.activeId = null; clearMain(); }
  delete S.jobs[entryId];
  updateHistoryCount();
}

async function clearAllHistory() {
  if (!confirm('¿Eliminar todo el historial de análisis? Esta acción no se puede deshacer.')) return;
  await fetch('/history', { method: 'DELETE' });
  historyList.innerHTML = '';
  S.activeId = null;
  S.jobs     = {};
  clearMain();
  updateHistoryCount();
}

function updateHistoryCount() {
  const count = document.querySelectorAll('.h-item').length;
  const el2   = document.getElementById('history-count');
  if (el2) el2.textContent = count || '';
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
  { name: 'Fortra',          icon: '○' },
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

  // ⑨  Fortra
  if (p.phishlabs) platMain.appendChild(phishlabsEl(p.phishlabs));

  // ⑩  Graph
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
    <div class="risk-actions">
      <button class="btn-ai-analyze" id="btn-ai-main" onclick="generateAIAnalysis(window._currentProfile)" title="Generar análisis con IA (Gemini)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="flex-shrink:0"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        Análisis IA
      </button>
      <button class="btn-reanalyze" onclick="reanalyzeTarget(window._currentProfile)" title="Volver a analizar este indicador">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="flex-shrink:0"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        Reanalizar
      </button>
      <button class="btn-report-open" onclick="openReportModal(window._currentProfile)" title="Reportar esta URL a plataformas de seguridad">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        Reportar URL
      </button>
      <a class="btn-whatsapp" href="https://wa.me/573008876817?text=${encodeURIComponent('Hola, quisiera más información sobre este sitio analizado: ' + (p.original_url || p.target))}" target="_blank" title="Consultar con Mensaje Sospechoso">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
        Mensaje Sospechoso
      </a>
    </div>`;
  return d;
}

// ── Stats grid ────────────────────────────────────────────────────────────────
function statsGridEl(p) {
  const geo   = p.geolocation || {};
  const whois = p.whois || {};
  const vt    = p.virustotal || {};
  const pl    = p.phishlabs  || {};

  const plCases   = pl.cases || [];
  const plFound   = plCases.length;
  const plStatuses = [...new Set(plCases.map(c => c.case_status).filter(Boolean))];
  const plValue   = pl.error ? 'Error' : plFound > 0 ? `${plFound} caso${plFound > 1 ? 's' : ''}` : 'Sin casos';
  const plSub     = pl.error ? pl.error.slice(0,40) : plFound > 0 ? plStatuses.join(' · ') : `${pl.total_searched || 0} registros revisados`;

  const items = [
    { l: 'País',         v: geo.country    ? `${geo.country_code} — ${geo.country}` : '—' },
    { l: 'Ciudad',       v: geo.city       || '—' },
    { l: 'ISP',          v: geo.isp        || '—' },
    { l: 'ASN',          v: (whois.asn || geo.asn || '—') },
    { l: 'Registrador',  v: whois.registrar || '—' },
    { l: 'Creación',     v: whois.creation_date ? whois.creation_date.slice(0,10) : '—' },
    { l: 'VT Malicioso', v: vt.malicious ?? '—', s: vt.malicious > 0 ? 'motores detectan amenaza' : '' },
    { l: 'Fortra',       v: plValue, s: plSub, c: plFound > 0 ? 'var(--risk-high)' : null },
  ];

  const g = el('div', 'stat-grid');
  items.forEach(i => {
    const c = el('div', 'stat-cell');
    c.innerHTML = `<div class="sc-label">${i.l}</div>
                   <div class="sc-value"${i.c ? ` style="color:${i.c}"` : ''}>${esc(String(i.v))}</div>
                   ${i.s ? `<div class="sc-sub">${esc(String(i.s))}</div>` : ''}`;
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

    bd.appendChild(acts);

    if (us.screenshot_url) {
      label(bd, 'Screenshot');
      const wrap = el('div', 'urlscan-screenshot-wrap');
      const img  = document.createElement('img');
      img.src    = us.screenshot_url;
      img.alt    = 'URLScan screenshot';
      img.className = 'urlscan-screenshot';
      img.loading = 'lazy';
      img.onclick = () => window.open(us.screenshot_url, '_blank');
      wrap.appendChild(img);
      bd.appendChild(wrap);
    }
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

// ── Fortra ────────────────────────────────────────────────────────────────────
function phishlabsEl(pl) {
  const s  = section('Fortra');
  const bd = s.querySelector('.section-bd');

  if (pl.error) {
    bd.innerHTML = `<p class="no-data">Error: ${esc(pl.error)}</p>`;
    return s;
  }

  const cases = pl.cases || [];
  const scanned = pl.total_searched || 0;

  // Resumen
  const statsRow = el('div', 'vt-stats');
  [
    { k: 'Casos encontrados', v: cases.length,  c: cases.length > 0 ? 'var(--risk-crit)' : 'var(--risk-clean)' },
    { k: 'Registros buscados', v: scanned,       c: null },
  ].forEach(i => {
    const c = el('div', 'vt-cell');
    c.innerHTML = `<div class="vl" style="${i.c ? `color:${i.c}` : ''}">${i.v}</div><div class="vk">${i.k}</div>`;
    statsRow.appendChild(c);
  });
  bd.appendChild(statsRow);

  if (!cases.length) {
    const note = el('p', 'no-data');
    note.textContent = `Sin casos existentes en Fortra para este indicador (revisados ${scanned} casos recientes).`;
    bd.appendChild(note);
    return s;
  }

  // Tabla de casos
  label(bd, `${cases.length} caso(s) encontrado(s)`);
  const t = tbl(['#', 'Título', 'Tipo', 'Estado', 'Marca', 'Fecha']);
  cases.forEach(c => {
    const statusCls = { New:'risk-dot-high', Assigned:'risk-dot-high', Closed:'risk-dot-clean',
                        Rejected:'risk-dot-info', Duplicate:'risk-dot-medium' }[c.case_status] || 'risk-dot-info';
    const caseUrl = `https://platform.fortra.com/drp/pages/incidents/search`;
    addRow(t, [
      `<a href="${caseUrl}" target="_blank" style="color:var(--text-2);font-size:.75rem">${c.case_number || '—'}</a>`,
      `<span style="font-size:.78rem">${esc((c.title||'').slice(0,60))}${c.title?.length>60?'…':''}</span>`,
      esc(c.case_type || '—'),
      `<span class="risk-dot ${statusCls}"></span> ${esc(c.case_status || '—')}`,
      esc(c.brand || '—'),
      esc((c.date_created||'').slice(0,10)),
    ]);

    // Attack sources dentro del caso
    const sources = c.attack_sources || [];
    sources.forEach(src => {
      if (src.screenshot) {
        label(bd, `Screenshot – Caso #${c.case_number}`);
        const wrap = el('div', 'urlscan-screenshot-wrap'); wrap.style.marginBottom = '.75rem';
        const img  = document.createElement('img');
        img.src = src.screenshot; img.alt = 'Fortra screenshot';
        img.className = 'urlscan-screenshot'; img.loading = 'lazy';
        img.onclick = () => window.open(src.screenshot, '_blank');
        wrap.appendChild(img);
        bd.appendChild(wrap);
      }
    });
  });
  bd.appendChild(t);

  return s;
}

// ── Report Panel ──────────────────────────────────────────────────────────────
function reportPanelEl(targetUrl) {
  const s  = section('Reportar URL');
  const bd = s.querySelector('.section-bd');

  // Descripción
  const desc = el('p', 'no-data');
  desc.style.cssText = 'margin-bottom:.75rem;color:var(--text-2);font-size:.8rem';
  desc.textContent = 'Reporta esta URL como maliciosa a múltiples plataformas de seguridad para acelerar su bloqueo.';
  bd.appendChild(desc);

  // ── Botones de reporte rápido ────────────────────────────────────────────
  const services = [
    { id: 'google_sb',   label: 'Google Safe Browsing', icon: '🔵' },
    { id: 'netcraft',    label: 'Netcraft',              icon: '🟠' },
    { id: 'urlhaus',     label: 'URLhaus',               icon: '🟣' },
    { id: 'smartscreen', label: 'Microsoft SmartScreen', icon: '🔷' },
    { id: 'phishreport', label: 'Phish Report',          icon: '🔴' },
  ];

  label(bd, 'Reporte rápido');
  const btnRow = el('div', 'report-btn-row');
  services.forEach(svc => {
    const btn = el('button', 'btn-report');
    btn.dataset.service = svc.id;
    btn.innerHTML = `<span class="report-icon">${svc.icon}</span><span class="report-label">${svc.label}</span>`;
    const statusDot = el('span', 'report-status');
    btn.appendChild(statusDot);

    btn.onclick = async () => {
      btn.disabled = true;
      statusDot.className = 'report-status spinning';
      statusDot.title = '';
      try {
        const r = await fetch('/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service: svc.id, url: targetUrl }),
        });
        const data = await r.json();
        statusDot.className = `report-status ${data.ok ? 'ok' : 'fail'}`;
        statusDot.title = data.message;
        btn.title = data.message;
      } catch(e) {
        statusDot.className = 'report-status fail';
        statusDot.title = e.message;
      }
      btn.disabled = false;
    };
    btnRow.appendChild(btn);
  });
  bd.appendChild(btnRow);

  // ── Crear caso en Fortra ─────────────────────────────────────────────────
  label(bd, 'Crear caso en Fortra');

  // Cargar opciones del servidor
  fetch('/report/config').then(r => r.json()).then(cfg => {
    const form = el('div', 'phishlabs-case-form');

    // Selector de marca
    const brandSel = document.createElement('select');
    brandSel.className = 'pl-select';
    cfg.brands.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b; opt.textContent = b;
      brandSel.appendChild(opt);
    });

    // Selector de tipo
    const typeSel = document.createElement('select');
    typeSel.className = 'pl-select';
    cfg.case_types.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = t;
      typeSel.appendChild(opt);
    });

    // Botón crear
    const createBtn = el('button', 'btn-report btn-report-create');
    createBtn.innerHTML = `<span class="report-icon">🚨</span><span class="report-label">Crear caso</span>`;
    const createStatus = el('span', 'report-status');
    createBtn.appendChild(createStatus);

    const resultMsg = el('div', 'pl-result-msg');

    createBtn.onclick = async () => {
      createBtn.disabled = true;
      createStatus.className = 'report-status spinning';
      resultMsg.textContent = '';
      try {
        const r = await fetch('/report/phishlabs_case', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url:       targetUrl,
            brand:     brandSel.value,
            case_type: typeSel.value,
          }),
        });
        const data = await r.json();
        createStatus.className = `report-status ${data.ok ? 'ok' : 'fail'}`;
        resultMsg.textContent  = data.message;
        resultMsg.style.color  = data.ok ? 'var(--risk-clean)' : 'var(--risk-crit)';
      } catch(e) {
        createStatus.className = 'report-status fail';
        resultMsg.textContent  = e.message;
      }
      createBtn.disabled = false;
    };

    const selRow = el('div', 'report-btn-row');
    selRow.style.flexWrap = 'wrap';
    selRow.appendChild(brandSel);
    selRow.appendChild(typeSel);
    selRow.appendChild(createBtn);

    form.appendChild(selRow);
    form.appendChild(resultMsg);
    bd.appendChild(form);
  });

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
async function downloadReport(p) {
  if (!p) return;
  const btn = document.getElementById('btn-tir-main');
  if (btn) { btn.disabled = true; btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0;animation:spin .7s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> Generando…'; }

  const risk   = p.risk_summary || {};
  const whois  = p.whois        || {};
  const geo    = p.geolocation  || {};
  const vt     = p.virustotal   || {};
  const us     = p.urlscan      || {};
  const man    = p.mandiant     || {};
  const intel  = p.threat_intelligence || {};
  const iocs   = p.iocs         || [];
  const ht     = p.host_tracker || {};
  const now    = new Date().toISOString().slice(0,16).replace('T',' ');
  const scan   = us.latest_scan || us.new_scan || {};
  const vs     = us.verdicts    || {};

  // ── helpers ──
  const RC = { CRITICAL:'#c0392b', HIGH:'#d35400', MEDIUM:'#d4ac0d', LOW:'#27ae60', CLEAN:'#1e8449' };
  const rc = RC[risk.level] || '#555';
  const tlpColor = { CRITICAL:'#c0392b', HIGH:'#c0392b', MEDIUM:'#f39c12', LOW:'#27ae60', CLEAN:'#27ae60' }[risk.level] || '#555';

  function h(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function kv(k,v) { if(!v && v!==0) return ''; return `<tr><td class="k">${h(k)}</td><td class="v">${h(v)}</td></tr>`; }
  function sec(num, title, body) {
    return `<div class="sec"><div class="sec-hd"><span class="sec-num">${num}</span><span class="sec-title">${title}</span></div><div class="sec-bd">${body}</div></div>`;
  }
  function tbl(heads, rows) {
    if(!rows.length) return '<p class="nil">Sin datos registrados.</p>';
    return `<table><thead><tr>${heads.map(h2=>`<th>${h2}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }
  function chip(text, color) {
    return `<span style="display:inline-block;background:${color}18;color:${color};border:1px solid ${color}55;padding:1px 6px;border-radius:2px;font-size:8.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap">${h(text)}</span>`;
  }
  function sublabel(t) { return `<p class="sl">${t}</p>`; }

  // ── build finding bullets for executive summary ──
  const findings = [];
  if (vt.malicious > 0)        findings.push(`VirusTotal detecta el indicador como <strong>MALICIOUS</strong> en ${vt.malicious} motores AV (${vt.suspicious} sospechosos, ${vt.harmless} limpios).`);
  if (vs.malicious)            findings.push(`URLScan.io clasifica el sitio como <strong>MALICIOUS</strong> con score ${vs.score}/100.`);
  if (man.mscore != null && man.mscore >= 50) findings.push(`Mandiant Threat Intelligence asigna un MScore de <strong>${man.mscore}/100</strong> (${man.verdict}).`);
  if (risk.otx_pulses > 0)    findings.push(`Presente en <strong>${risk.otx_pulses} pulses</strong> de AlienVault OTX.`);
  if (risk.threatfox_hits > 0) findings.push(`Registrado en <strong>${risk.threatfox_hits} IOC(s)</strong> de ThreatFox.`);
  if (risk.urlhaus_hits > 0)   findings.push(`Detectado en <strong>${risk.urlhaus_hits} URL(s)</strong> de URLhaus.`);
  if (risk.mandiant_actors > 0) findings.push(`Asociado a <strong>${risk.mandiant_actors} actor(es)</strong> de amenaza en Mandiant.`);
  if (ht.certificate?.expired) findings.push(`Certificado TLS <strong>expirado</strong>.`);
  if (ht.certificate?.expiring_soon) findings.push(`Certificado TLS próximo a vencer: <strong>${ht.certificate.days_remaining} días</strong>.`);
  const riskFlags = risk.geo_flags || [];

  // ── recommendations ──
  const recs = [];
  if (vt.malicious > 0 || vs.malicious) recs.push('Bloquear el indicador en firewalls, proxies y listas negras DNS de la organización.');
  if (iocs.filter(i=>i.type==='ip').length) recs.push('Agregar las IPs identificadas a las reglas de bloqueo en el SIEM/EDR.');
  if (iocs.filter(i=>i.type==='url'||i.type==='domain').length) recs.push('Bloquear dominios y URLs maliciosas en el proxy web y DNS filtering.');
  if (riskFlags.includes('PROXY/VPN')) recs.push('El tráfico proviene de una infraestructura VPN/Proxy — considerar políticas de acceso condicional.');
  if (riskFlags.includes('HOSTING/DATACENTER')) recs.push('Infraestructura en datacenter — revisar si hay otros activos expuestos en el mismo ASN.');
  if (ht.open_ports?.some(pp => [21,23,445,3389].includes(pp.port))) recs.push('Se detectaron puertos de alto riesgo abiertos (FTP/Telnet/RDP/SMB) — revisar exposición.');
  if (!recs.length) recs.push('Continuar monitoreo pasivo. No se requieren acciones de bloqueo inmediatas.');

  // ── IOC rows by risk level ──
  const iocRisk = { critical:'#c0392b', high:'#d35400', medium:'#d4ac0d', info:'#888' };
  const iocRows = iocs.map(i => `<tr>
    <td style="width:8px;padding-right:0"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${iocRisk[i.risk]||'#aaa'}"></span></td>
    <td>${chip(i.type, iocRisk[i.risk]||'#888')}</td>
    <td style="font-family:'Courier New',monospace;font-size:9px;word-break:break-all">${h(i.value)}</td>
    <td style="white-space:nowrap">${h(i.source)}</td>
    <td>${h(i.context)}</td>
  </tr>`);

  const vtRows  = (vt.detections||[]).map(d=>`<tr><td>${h(d.engine)}</td><td style="font-family:monospace;font-size:9px">${h(d.result||'—')}</td><td>${chip(d.category, d.category==='malicious'?'#c0392b':'#d35400')}</td></tr>`);
  const otxRows = (intel.otx_pulses||[]).map(pp=>`<tr><td>${h(pp.name)}</td><td>${h(pp.author)}</td><td>${(pp.malware_families||[]).map(f=>chip(f,'#c0392b')).join(' ')||'—'}</td><td style="font-size:9px">${(pp.attack_ids||[]).slice(0,3).join(', ')||'—'}</td></tr>`);
  const tfRows  = (intel.threatfox||[]).map(i=>`<tr><td style="font-family:monospace;font-size:9px;word-break:break-all">${h(i.ioc)}</td><td>${chip(i.malware,'#c0392b')}</td><td>${i.confidence??'—'}%</td><td>${h((i.first_seen||'').slice(0,10))}</td></tr>`);
  const uhRows  = (intel.urlhaus||[]).map(u=>`<tr><td style="font-family:monospace;font-size:9px;word-break:break-all">${h(u.url)}</td><td>${chip(u.url_status, u.url_status==='online'?'#c0392b':'#555')}</td><td>${h(u.threat||'—')}</td></tr>`);
  const portRows= (ht.open_ports||[]).map(pp=>{const risk2=[21,23,445,3389,3306,5432,6379,27017,1433].includes(pp.port);return`<tr><td style="font-family:monospace;font-weight:700">${pp.port}</td><td>${chip(pp.service, risk2?'#d35400':'#555')}</td><td style="font-size:9px;color:#888">${h(pp.banner||'—')}</td><td>${risk2?chip('alto riesgo','#c0392b'):chip('normal','#27ae60')}</td></tr>`;});

  // ── screenshot proxied ──
  const screenshotUrl = us.screenshot_url
    ? `/proxy/img?url=${encodeURIComponent(us.screenshot_url)}`
    : null;

  const tlpLabel = risk.level === 'CLEAN' || risk.level === 'LOW' ? 'GREEN' : risk.level === 'MEDIUM' ? 'AMBER' : 'RED';

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>TIR — ${h(p.target)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Helvetica Neue",Arial,sans-serif;font-size:10px;color:#1a1a2e;background:#fff;line-height:1.6;width:816px}

/* ── COVER ── */
.cover{width:816px;min-height:1056px;background:#0d1117;display:flex;flex-direction:column;page-break-after:always;position:relative}
.cover-accent{position:absolute;top:0;left:0;right:0;height:5px;background:linear-gradient(90deg,${rc} 0%,${rc}cc 50%,#00bcd4 100%)}
.cover-stripe{position:absolute;top:5px;left:0;right:0;height:1px;background:${rc}30}
.cover-top{display:flex;justify-content:space-between;align-items:flex-start;padding:36px 52px 0;position:relative;z-index:1}
.cover-logo{display:flex;flex-direction:column;gap:5px}
.cover-logo-mark{font-size:17px;font-weight:900;color:#e8eaed;letter-spacing:-.02em}
.cover-logo-sub{font-size:7px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:#3d4f63}
.cover-classification{display:flex;flex-direction:column;align-items:flex-end;gap:7px}
.tlp{font-size:8px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;padding:5px 14px;border-radius:3px;color:#fff;background:${tlpColor}}
.doc-type{font-size:7px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#3d4f63}
.cover-divider{margin:30px 52px 0;height:1px;background:linear-gradient(90deg,#e5393520,#e5393580,#e5393520);position:relative;z-index:1}
.cover-body{flex:1;padding:32px 52px 0;position:relative;z-index:1}
.cover-eyebrow{font-size:7px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#4a90e2;margin-bottom:10px}
.cover-target{font-size:28px;font-weight:800;color:#e8eaed;word-break:break-all;line-height:1.2;margin-bottom:6px;font-family:"Courier New",monospace}
.cover-orig{font-size:8.5px;color:#4a5568;margin-bottom:30px;word-break:break-all;font-family:monospace}
.cover-risk-band{display:flex;align-items:stretch;gap:0;margin-bottom:28px;border:1px solid #1e293b;border-radius:6px;overflow:hidden}
.risk-score-box{background:${rc}15;border-right:1px solid #1e293b;padding:20px 28px;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;min-width:100px}
.risk-score-num{font-size:36px;font-weight:900;color:${rc};line-height:1;font-family:"Courier New",monospace}
.risk-score-den{font-size:8px;color:${rc};opacity:.6;letter-spacing:.1em}
.risk-score-label{font-size:7px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#4a5568;margin-top:4px}
.risk-detail{padding:18px 22px;flex:1}
.risk-level-badge{display:inline-flex;align-items:center;gap:6px;margin-bottom:8px}
.risk-level-dot{width:8px;height:8px;border-radius:50%;background:${rc};flex-shrink:0}
.risk-level-text{font-size:15px;font-weight:900;color:${rc};text-transform:uppercase;letter-spacing:.08em}
.risk-desc{font-size:9px;color:#8892a4;line-height:1.6;max-width:420px}
.sc-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:20px}
.sc-cell{background:#111827;border:1px solid #1e293b;border-radius:5px;padding:12px 14px}
.sc-cell.alert{border-color:${rc}60;background:${rc}0d}
.sc-val{font-size:14px;font-weight:800;color:#e8eaed;font-family:"Courier New",monospace}
.sc-cell.alert .sc-val{color:${rc}}
.sc-key{font-size:7px;text-transform:uppercase;letter-spacing:.1em;color:#4a5568;margin-top:4px}
.flags{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:18px}
.flag-chip{font-size:7px;font-weight:700;text-transform:uppercase;padding:3px 9px;border-radius:2px;background:#ffd60012;border:1px solid #ffd60040;color:#ffd600}
.cover-screenshot-wrap{border-radius:5px;overflow:hidden;border:1px solid #e74c3c40;max-height:130px}
.cover-screenshot-wrap img{display:block;width:100%;height:130px;object-fit:cover;object-position:top}
.cover-screenshot-label{font-size:6.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#4a5568;margin-bottom:6px;display:flex;align-items:center;gap:5px}
.cover-screenshot-label::before{content:"⚠";color:#e74c3c;font-size:8px}
.cover-footer{padding:24px 52px 28px;position:relative;z-index:1;border-top:1px solid #1e293b;margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end}
.cover-footer-meta{font-size:7px;color:#2d3748;line-height:2}
.cover-footer-pg{font-size:9px;color:#2d3748;font-family:monospace}

/* ── PAGE HEADER (content pages) ── */
.pg-header{display:flex;justify-content:space-between;align-items:center;padding:20px 52px 14px;background:#0d1117;border-bottom:1px solid #1e293b}
.pg-logo-sm{font-size:11px;font-weight:900;color:#e8eaed;letter-spacing:-.01em}
.pg-center{font-size:6.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#4a5568;font-family:monospace;max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-tlp-sm{font-size:6.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;background:${tlpColor};color:#fff;padding:2px 8px;border-radius:2px}

/* ── CONTENT ── */
.content{padding:22px 52px 56px;background:#fff}

/* ── SECTION ── */
.sec{margin-top:22px;page-break-inside:avoid}
.sec-hd{display:flex;align-items:center;gap:10px;margin-bottom:12px;padding-bottom:7px;border-bottom:2px solid #0d1117}
.sec-num{font-size:7.5px;font-weight:800;letter-spacing:.12em;color:#4a90e2;font-family:monospace;min-width:22px}
.sec-title{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:#0d1117}
.sec-bd{padding-left:32px}
.sl{font-size:6.5px;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:#94a3b8;margin:12px 0 5px;padding-bottom:3px;border-bottom:1px solid #f1f5f9}
.sl:first-child{margin-top:0}

/* ── TABLE ── */
table{width:100%;border-collapse:collapse;font-size:9px;margin-bottom:4px}
th{text-align:left;font-size:6.5px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;padding:5px 8px;border-bottom:2px solid #e2e8f0;background:#f8fafc}
td{padding:5px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top;color:#1e293b}
tr:hover td{background:#f8fafc}
tr:last-child td{border-bottom:none}
table.kv td.k{color:#64748b;width:150px;white-space:nowrap;font-size:8.5px}
table.kv td.v{color:#0f172a;word-break:break-all}

/* ── LISTS ── */
.finding-list{list-style:none;padding:0}
.finding-list li{padding:6px 0 6px 18px;border-bottom:1px solid #f1f5f9;font-size:9.5px;position:relative;color:#1e293b}
.finding-list li::before{content:"▶";position:absolute;left:0;color:${rc};font-size:7px;top:8px}
.finding-list li:last-child{border-bottom:none}
.rec-list{list-style:none;padding:0;counter-reset:rec}
.rec-list li{padding:7px 0 7px 26px;border-bottom:1px solid #f1f5f9;font-size:9.5px;position:relative;counter-increment:rec;color:#1e293b}
.rec-list li::before{content:counter(rec);position:absolute;left:0;background:#0d1117;color:#4a90e2;font-size:7px;font-weight:800;width:16px;height:16px;border-radius:3px;display:flex;align-items:center;justify-content:center;top:8px;font-family:monospace}
.rec-list li:last-child{border-bottom:none}

/* ── MISC ── */
.cert-bar{height:4px;border-radius:2px;background:#e2e8f0;margin:5px 0 2px;overflow:hidden}
.cert-fill{height:100%;border-radius:2px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.nil{font-size:9px;color:#cbd5e1;font-style:italic;padding:4px 0}
.divider{border:none;border-top:1px solid #e2e8f0;margin:20px 0}
.page-break{page-break-before:always}
.report-footer{display:flex;justify-content:space-between;font-size:7px;color:#94a3b8;padding-top:10px;border-top:1px solid #e2e8f0;margin-top:10px}
.mono{font-family:"Courier New",monospace;font-size:9px}
</style>
</head>
<body>

<!-- ════════════════ COVER ════════════════ -->
<div class="cover">
  <div class="cover-accent"></div>
  <div class="cover-stripe"></div>

  <div class="cover-top">
    <div class="cover-logo">
      <div class="cover-logo-mark">&#9672; VSAS Ciberinteligencia</div>
      <div class="cover-logo-sub">Threat Intelligence Platform</div>
    </div>
    <div class="cover-classification">
      <span class="tlp">TLP:${tlpLabel} &nbsp;&#8226;&nbsp; CONFIDENCIAL</span>
      <span class="doc-type">Threat Intelligence Report</span>
    </div>
  </div>

  <div class="cover-divider"></div>

  <div class="cover-body">
    <div class="cover-eyebrow">Indicador analizado</div>
    <div class="cover-target">${h(p.target)}</div>
    ${p.original_url && p.original_url !== p.target
      ? `<div class="cover-orig">${h(p.original_url)}</div>`
      : '<div style="height:14px"></div>'}

    <div class="cover-risk-band">
      <div class="risk-score-box">
        <div class="risk-score-num">${risk.score??'—'}</div>
        <div class="risk-score-den">/100</div>
        <div class="risk-score-label">Risk Score</div>
      </div>
      <div class="risk-detail">
        <div class="risk-level-badge">
          <span class="risk-level-dot"></span>
          <span class="risk-level-text">${risk.level||'—'}</span>
        </div>
        <div class="risk-desc">${
          risk.level==='CRITICAL' ? 'Indicador activamente malicioso confirmado por múltiples fuentes de inteligencia. Se requiere acción de bloqueo inmediata.' :
          risk.level==='HIGH'     ? 'Alta probabilidad de actividad maliciosa detectada. Se recomienda bloqueo preventivo y revisión de logs.' :
          risk.level==='MEDIUM'   ? 'Actividad sospechosa detectada en una o más fuentes. Monitoreo activo recomendado.' :
          risk.level==='LOW'      ? 'Riesgo bajo. Sin detecciones significativas en las fuentes de inteligencia consultadas.' :
                                    'Sin detecciones en las fuentes de inteligencia consultadas. Sin indicios de actividad maliciosa.'
        }</div>
      </div>
    </div>

    <div class="sc-grid">
      <div class="sc-cell${vt.malicious>0?' alert':''}"><div class="sc-val">${h(risk.vt_verdict||'N/A')}</div><div class="sc-key">VirusTotal</div></div>
      <div class="sc-cell${man.mscore>=50?' alert':''}"><div class="sc-val">${man.mscore!=null?man.mscore+'pts':h(risk.mandiant_verdict||'N/A')}</div><div class="sc-key">Mandiant</div></div>
      <div class="sc-cell${vs.malicious?' alert':''}"><div class="sc-val">${vs.malicious?'MALICIOUS':vs.score!=null?vs.score+'/100':'Clean'}</div><div class="sc-key">URLScan.io</div></div>
      <div class="sc-cell${risk.otx_pulses>0?' alert':''}"><div class="sc-val">${risk.otx_pulses??0}</div><div class="sc-key">OTX Pulses</div></div>
      <div class="sc-cell${risk.threatfox_hits>0?' alert':''}"><div class="sc-val">${risk.threatfox_hits??0}</div><div class="sc-key">ThreatFox IOCs</div></div>
      <div class="sc-cell${risk.urlhaus_hits>0?' alert':''}"><div class="sc-val">${risk.urlhaus_hits??0}</div><div class="sc-key">URLhaus hits</div></div>
    </div>

    ${riskFlags.length ? `<div class="flags">${riskFlags.map(f=>`<span class="flag-chip">${h(f)}</span>`).join('')}</div>` : ''}

    ${screenshotUrl ? `
    <div class="cover-screenshot-label">Captura del sitio analizado</div>
    <div class="cover-screenshot-wrap"><img src="${screenshotUrl}" alt="Screenshot"></div>` : ''}
  </div>

  <div class="cover-footer">
    <div class="cover-footer-meta">
      <div>Generado: ${now}</div>
      <div>Plataforma: VSAS Threat Intelligence Platform</div>
      <div style="margin-top:3px;color:#1e293b">Clasificaci&#243;n: TLP:${tlpLabel} &mdash; Solo uso interno</div>
    </div>
    <div style="text-align:right">
      <div class="cover-footer-pg">01</div>
      <div style="font-size:6.5px;color:#1e293b;margin-top:3px;font-family:monospace">ID: TIR-${h(p.target).replace(/[^a-z0-9]/gi,'').toUpperCase().slice(0,8)}</div>
    </div>
  </div>
</div>

<!-- ════════════════ CONTENT ════════════════ -->
<div class="pg-header">
  <span class="pg-logo-sm">&#9672; VSAS Ciberinteligencia</span>
  <span class="pg-center">${h(p.target)}</span>
  <span class="pg-tlp-sm">TLP:${tlpLabel}</span>
</div>
<div class="content">

<!-- 1. RESUMEN EJECUTIVO -->
${sec('01', 'Resumen Ejecutivo', `
  <p style="font-size:10.5px;line-height:1.7;margin-bottom:12px">
    El presente informe documenta el análisis de inteligencia sobre el indicador <strong>${h(p.target)}</strong>,
    analizado el ${now}. La evaluación integral de ${iocs.length} indicadores de compromiso
    y la consulta a ${[vt.found,vs.malicious!=null,man.verdict,intel.otx_pulse_count>0,intel.threatfox?.length>0,intel.urlhaus?.length>0].filter(Boolean).length} fuentes
    de inteligencia determina un nivel de riesgo <strong style="color:${rc}">${risk.level}</strong>
    con puntuación <strong style="color:${rc}">${risk.score}/100</strong>.
  </p>
  ${findings.length ? `
  <p class="sl">Hallazgos clave</p>
  <ul class="finding-list">${findings.map(f=>`<li>${f}</li>`).join('')}</ul>` : ''}
`)}

<!-- 2. EVALUACIÓN DE AMENAZA -->
${sec('02', 'Evaluación de Amenaza', `
  <div class="two-col">
    <div>
      <p class="sl">VirusTotal</p>
      ${vt.found ? `
        <table class="kv">
          ${kv('Veredicto', risk.vt_verdict)}
          ${kv('Motores maliciosos', vt.malicious)}
          ${kv('Motores sospechosos', vt.suspicious)}
          ${kv('Motores limpios', vt.harmless)}
          ${kv('Reputación', vt.reputation_score)}
          ${kv('Tags', (vt.tags||[]).join(', '))}
        </table>` : '<p class="nil">No encontrado en VirusTotal.</p>'}
    </div>
    <div>
      <p class="sl">URLScan.io</p>
      ${scan.uuid ? `
        <table class="kv">
          ${kv('Veredicto', vs.malicious ? '⚠ MALICIOUS' : 'Limpio')}
          ${kv('Score', vs.score != null ? vs.score + ' / 100' : null)}
          ${kv('Motores maliciosos', vs.engine_malicious)}
          ${kv('Servidor', scan.server)}
          ${kv('Título de página', scan.title)}
          ${kv('TLS Issuer', scan.tls_issuer)}
          ${kv('Fecha escaneo', scan.scan_date)}
        </table>
        ${screenshotUrl ? `
        <p class="sl" style="margin-top:10px">Captura del sitio analizado</p>
        <div style="border:1px solid ${vs.malicious?'#c0392b55':'#e2e8f0'};border-radius:4px;overflow:hidden;max-height:200px;margin-top:4px">
          <img src="${screenshotUrl}" alt="Captura URLScan" style="display:block;width:100%;height:200px;object-fit:cover;object-position:top">
        </div>` : ''}
      ` : '<p class="nil">Sin resultados de URLScan.</p>'}
    </div>
  </div>
  ${vtRows.length ? `<p class="sl">Detecciones VirusTotal (${vtRows.length} motores)</p>${tbl(['Motor AV','Firma detectada','Categoría'], vtRows)}` : ''}
`)}

<!-- 3. INTELIGENCIA DE AMENAZAS -->
${sec('03', 'Inteligencia de Amenazas', `
  <div class="two-col" style="margin-bottom:14px">
    <div>
      <p class="sl">Mandiant Threat Intelligence</p>
      ${man.verdict && man.verdict !== 'NOT_FOUND' ? `
        <table class="kv">
          ${kv('Veredicto', man.verdict)}
          ${kv('MScore', man.mscore != null ? `${man.mscore} / 100` : null)}
          ${kv('Primera detección', (man.first_seen||'').slice(0,10))}
          ${kv('Última detección',  (man.last_seen||'').slice(0,10))}
          ${kv('Actores asociados', man.threat_actors?.length || 0)}
          ${kv('Familias malware',  man.malware?.length || 0)}
        </table>
        ${(man.threat_actors||[]).length ? tbl(['Actor','País','Motivación','Sectores'], man.threat_actors.map(a=>`<tr><td><strong>${h(a.name)}</strong></td><td>${h(a.country||'—')}</td><td>${h(a.motivation||'—')}</td><td style="font-size:8.5px">${(a.industries||[]).join(', ')||'—'}</td></tr>`)) : ''}
        ${(man.malware||[]).length ? tbl(['Malware','Aliases','Capacidades'], man.malware.map(m2=>`<tr><td>${chip(m2.name,'#c0392b')}</td><td style="font-size:8.5px">${(m2.aliases||[]).join(', ')||'—'}</td><td style="font-size:8.5px">${(m2.capabilities||[]).slice(0,4).join(', ')||'—'}</td></tr>`)) : ''}
      ` : '<p class="nil">Indicador no encontrado en Mandiant Threat Intelligence.</p>'}
    </div>
    <div>
      <p class="sl">AlienVault OTX</p>
      ${intel.otx_pulse_count > 0 ? `
        <table class="kv">
          ${kv('Pulses totales', intel.otx_pulse_count)}
          ${kv('Reputación OTX', intel.otx_reputation)}
          ${kv('Muestras malware', intel.otx_malware_count)}
        </table>` : '<p class="nil">Sin pulses OTX.</p>'}
    </div>
  </div>
  ${otxRows.length ? `<p class="sl">Pulses OTX</p>${tbl(['Nombre','Autor','Familias','ATT&CK'], otxRows)}` : ''}
  ${tfRows.length ? `<p class="sl">ThreatFox — ${tfRows.length} IOC(s)</p>${tbl(['IOC','Malware','Confianza','Primer registro'], tfRows)}` : ''}
  ${uhRows.length ? `<p class="sl">URLhaus — ${uhRows.length} URL(s)</p>${tbl(['URL','Estado','Tipo amenaza'], uhRows)}` : ''}
  ${!otxRows.length && !tfRows.length && !uhRows.length ? '<p class="nil">Sin detecciones en feeds de inteligencia pública.</p>' : ''}
`)}

<!-- 4. INFRAESTRUCTURA -->
${sec('04', 'Análisis de Infraestructura', `
  <div class="two-col">
    <div>
      <p class="sl">WHOIS / DNS</p>
      <table class="kv">
        ${kv('Tipo', whois.type)}
        ${kv('Registrador', whois.registrar)}
        ${kv('Organización', whois.registrant_org)}
        ${kv('País registrante', whois.registrant_country)}
        ${kv('Fecha creación', (whois.creation_date||'').slice(0,10))}
        ${kv('Fecha expiración', (whois.expiration_date||'').slice(0,10))}
        ${kv('ASN', whois.asn)}
        ${kv('Red CIDR', whois.network_cidr)}
        ${kv('Contacto de abuso', whois.abuse_contact)}
        ${(whois.resolved_ips||[]).length ? `<tr><td class="k">IPs resueltas</td><td class="v" style="font-family:monospace;font-size:9px">${whois.resolved_ips.map(i=>h(i)).join('<br>')}</td></tr>` : ''}
      </table>
    </div>
    <div>
      <p class="sl">Geolocalización</p>
      <table class="kv">
        ${kv('IP analizada', geo.ip)}
        ${kv('País', geo.country ? `${geo.country_code} — ${geo.country}` : null)}
        ${kv('Región / Ciudad', geo.region ? `${geo.region}, ${geo.city||''}` : null)}
        ${kv('ISP', geo.isp)}
        ${kv('Organización', geo.org)}
        ${kv('ASN', geo.asn)}
        ${kv('Coordenadas', geo.latitude ? `${geo.latitude}, ${geo.longitude}` : null)}
        ${kv('Zona horaria', geo.timezone)}
      </table>
      ${riskFlags.length ? `<div class="flags" style="margin-top:8px">${riskFlags.map(f=>`<span class="flag-chip">${h(f)}</span>`).join('')}</div>` : ''}
    </div>
  </div>
`)}

<!-- 5. HOST TRACKER -->
${sec('05', 'Estado del Host', `
  <div class="two-col">
    <div>
      <p class="sl">Certificado TLS</p>
      ${ht.certificate && !ht.certificate.error ? `
        ${(() => {
          const d = ht.certificate.days_remaining;
          const pct = Math.max(0, Math.min(100, d / 365 * 100));
          const barColor = d < 0 ? '#c0392b' : d <= 30 ? '#d35400' : '#27ae60';
          return `
          <div style="margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;font-size:9px;margin-bottom:2px">
              <span>Días restantes</span>
              <strong style="color:${barColor}">${d < 0 ? 'EXPIRADO' : d + ' días'}</strong>
            </div>
            <div class="cert-bar"><div class="cert-fill" style="width:${pct}%;background:${barColor}"></div></div>
          </div>`;
        })()}
        <table class="kv">
          ${kv('Estado', ht.certificate.expired ? '❌ Expirado' : ht.certificate.expiring_soon ? '⚠ Próximo a vencer' : '✓ Válido')}
          ${kv('Subject CN', ht.certificate.subject_cn)}
          ${kv('Emisor', ht.certificate.issuer_org || ht.certificate.issuer_cn)}
          ${kv('Válido desde', ht.certificate.not_before?.slice(0,10))}
          ${kv('Expira', ht.certificate.not_after?.slice(0,10))}
          ${kv('Versión TLS', ht.certificate.tls_version)}
          ${kv('Cipher', ht.certificate.cipher)}
        </table>
        ${(ht.certificate.sans||[]).length ? `<p style="font-size:8.5px;color:#888;margin-top:6px">SANs: ${ht.certificate.sans.map(s=>h(s)).join(', ')}</p>` : ''}
      ` : `<p class="nil">${h(ht.certificate?.error || 'No disponible')}</p>`}
    </div>
    <div>
      <p class="sl">Puertos abiertos (${(ht.open_ports||[]).length} detectados)</p>
      ${portRows.length ? tbl(['Puerto','Servicio','Banner','Riesgo'], portRows) : '<p class="nil">Sin puertos abiertos en el rango escaneado.</p>'}
    </div>
  </div>
`)}

<!-- 6. IOCs -->
${sec('06', `Indicadores de Compromiso (IOCs) — ${iocs.length} indicadores`, `
  ${iocRows.length ? tbl(['','Tipo','Valor / Hash','Fuente','Contexto'], iocRows) : '<p class="nil">Sin IOCs registrados.</p>'}
`)}

<!-- 7. RELACIONES -->
${p.graph_png_url ? sec('07', 'Diagrama de Relaciones', `
  <img src="${h(p.graph_png_url)}" style="width:100%;max-width:760px;border:1px solid #ddd;border-radius:4px;margin-top:6px;display:block">
`) : ''}

<!-- 8. RECOMENDACIONES -->
${sec(p.graph_png_url ? '08' : '07', 'Recomendaciones', `
  <ol class="rec-list">${recs.map(r=>`<li>${r}</li>`).join('')}</ol>
`)}

<hr class="divider">
<div class="report-footer">
  <span>Threat Intelligence Report · Clasificación: TLP:${tlpLabel} · Generado automáticamente</span>
  <span>${now}</span>
</div>
</div>
</body>
</html>`;

  // Overlay oscuro que cubre la UI mientras se genera el PDF
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:#0d1117dd;z-index:9997;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = '<div style="color:#4a90e2;font-size:13px;font-family:monospace;letter-spacing:.08em;text-align:center">Generando PDF…<br><span style="font-size:9px;color:#4a5568;margin-top:4px;display:block">Esto puede tomar unos segundos</span></div>';
  document.body.appendChild(overlay);

  // iframe fuera de pantalla (izquierda) con altura suficiente para renderizar todo el contenido
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;top:0;left:-900px;width:816px;height:20000px;border:none;z-index:9998;background:#fff';
  document.body.appendChild(iframe);
  try {
    iframe.contentDocument.open();
    iframe.contentDocument.write(html);
    iframe.contentDocument.close();
    // Esperar imágenes y fonts
    await new Promise(r => setTimeout(r, 1400));
    const body = iframe.contentDocument.body;
    const docEl = iframe.contentDocument.documentElement;
    const contentH = Math.max(body.scrollHeight, docEl.scrollHeight, 1056);
    iframe.style.height = contentH + 'px';
    body.style.cssText = 'width:816px;min-width:816px;overflow-x:hidden';
    await new Promise(r => setTimeout(r, 200));
    await html2pdf().set({
      margin: 0,
      filename: `TIR-${p.target.replace(/[^a-z0-9]/gi,'_')}.pdf`,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        windowWidth: 816,
        scrollX: 0,
        scrollY: 0,
        width: 816,
        imageTimeout: 20000,
      },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], before: '.page-break', avoid: ['.sec', 'tr'] },
    }).from(body).save();
  } finally {
    document.body.removeChild(iframe);
    document.body.removeChild(overlay);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="flex-shrink:0"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Descargar TIR';
    }
  }
}

// ── Análisis IA (Gemini) ──────────────────────────────────────────────────────
async function generateAIAnalysis(p) {
  if (!p) return;
  const btn = document.getElementById('btn-ai-main');

  // Si ya fue generado, descargar PDF directamente
  if (p._ai_analysis) {
    await downloadAIReport(p, p._ai_analysis);
    return;
  }

  if (btn) { btn.disabled = true; btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin .7s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> Generando…`; }

  // Insertar sección placeholder
  let aiSec = document.getElementById('ai-section');
  if (!aiSec) {
    aiSec = aiSectionEl();
    platMain.insertBefore(aiSec, platMain.firstChild.nextSibling);
  }
  const aiBody = aiSec.querySelector('.ai-body');
  aiBody.innerHTML = `<div class="ai-loading"><div class="spinner" style="width:18px;height:18px;border-width:2px"></div><span>Analizando con Gemini 2.0 Flash…</span></div>`;

  try {
    const res  = await fetch('/ai/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: p }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Error desconocido');

    p._ai_analysis = data.analysis;
    renderAIAnalysis(aiBody, data.analysis);
    if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> Análisis IA`; }

    // Descargar PDF con el informe generado por IA
    await downloadAIReport(p, data.analysis);
  } catch (e) {
    aiBody.innerHTML = `<p style="color:var(--risk-crit);font-size:.82rem;padding:.5rem 0">${esc(e.message)}</p>`;
    if (btn) { btn.disabled = false; btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> Análisis IA`; }
  }
}

// ── Descarga PDF generado por IA ──────────────────────────────────────────────
async function downloadAIReport(p, aiMarkdown) {
  const risk   = p.risk_summary || {};
  const whois  = p.whois        || {};
  const geo    = p.geolocation  || {};
  const vt     = p.virustotal   || {};
  const us     = p.urlscan      || {};
  const iocs   = p.iocs         || [];
  const ht     = p.host_tracker || {};
  const intel  = p.threat_intelligence || {};
  const now    = new Date().toISOString().slice(0,16).replace('T',' ');
  const scan   = us.latest_scan || us.new_scan || {};
  const vs     = us.verdicts    || {};

  const RC = { CRITICAL:'#c0392b', HIGH:'#d35400', MEDIUM:'#d4ac0d', LOW:'#27ae60', CLEAN:'#1e8449' };
  const rc = RC[risk.level] || '#555';
  const tlpColor = { CRITICAL:'#c0392b', HIGH:'#c0392b', MEDIUM:'#f39c12', LOW:'#27ae60', CLEAN:'#27ae60' }[risk.level] || '#555';
  const tlpLabel = risk.level === 'CLEAN' || risk.level === 'LOW' ? 'GREEN' : risk.level === 'MEDIUM' ? 'AMBER' : 'RED';

  function h(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function kv(k,v) { if(!v && v!==0) return ''; return `<tr><td class="k">${h(k)}</td><td class="v">${h(v)}</td></tr>`; }
  function chip(text, color) {
    return `<span style="display:inline-block;background:${color}18;color:${color};border:1px solid ${color}55;padding:1px 6px;border-radius:2px;font-size:8.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap">${h(text)}</span>`;
  }
  function tbl(heads, rows) {
    if(!rows.length) return '<p class="nil">Sin datos registrados.</p>';
    return `<table><thead><tr>${heads.map(h2=>`<th>${h2}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  // Convertir markdown IA a HTML
  const aiHtml = aiMarkdown
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h4 class="ai-h4">$1</h4>')
    .replace(/^## (.+)$/gm,  '<h3 class="ai-h3">$1</h3>')
    .replace(/^# (.+)$/gm,   '<h2 class="ai-h2">$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,   '<em>$1</em>')
    .replace(/`(.+?)`/g,     '<code>$1</code>')
    .replace(/^- (.+)$/gm,   '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul class="ai-ul">${m}</ul>`)
    .replace(/\n\n+/g, '</p><p class="ai-p">')
    .replace(/^(?!<[hul])(.+)$/gm, '<p class="ai-p">$1</p>')
    .replace(/<p class="ai-p"><\/p>/g, '');

  // Tablas de soporte (apéndice)
  const iocRisk = { critical:'#c0392b', high:'#d35400', medium:'#d4ac0d', info:'#888' };
  const iocRows = iocs.map(i => `<tr>
    <td style="width:8px;padding-right:0"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${iocRisk[i.risk]||'#aaa'}"></span></td>
    <td>${chip(i.type, iocRisk[i.risk]||'#888')}</td>
    <td style="font-family:'Courier New',monospace;font-size:9px;word-break:break-all">${h(i.value)}</td>
    <td style="white-space:nowrap">${h(i.source)}</td>
    <td>${h(i.context)}</td>
  </tr>`);

  const vtRows  = (vt.detections||[]).map(d=>`<tr><td>${h(d.engine)}</td><td style="font-family:monospace;font-size:9px">${h(d.result||'—')}</td><td>${chip(d.category, d.category==='malicious'?'#c0392b':'#d35400')}</td></tr>`);
  const portRows= (ht.open_ports||[]).map(pp=>{const r2=[21,23,445,3389,3306,5432,6379,27017,1433].includes(pp.port);return`<tr><td style="font-family:monospace;font-weight:700">${pp.port}</td><td>${chip(pp.service,r2?'#d35400':'#555')}</td><td style="font-size:9px;color:#888">${h(pp.banner||'—')}</td><td>${r2?chip('alto riesgo','#c0392b'):chip('normal','#27ae60')}</td></tr>`;});
  const screenshotUrl = us.screenshot_url ? `/proxy/img?url=${encodeURIComponent(us.screenshot_url)}` : null;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>TIR-IA — ${h(p.target)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Helvetica Neue",Arial,sans-serif;font-size:10px;color:#1a1a2e;background:#fff;line-height:1.6;width:816px}

/* ── COVER ── */
.cover{width:816px;min-height:1056px;background:#0d1117;display:flex;flex-direction:column;page-break-after:always;position:relative}
.cover-accent{position:absolute;top:0;left:0;right:0;height:5px;background:linear-gradient(90deg,${rc} 0%,${rc}cc 50%,#7c3aed 100%)}
.cover-stripe{position:absolute;top:5px;left:0;right:0;height:1px;background:${rc}30}
.cover-top{display:flex;justify-content:space-between;align-items:flex-start;padding:36px 52px 0;position:relative;z-index:1}
.cover-logo{display:flex;flex-direction:column;gap:5px}
.cover-logo-mark{font-size:17px;font-weight:900;color:#e8eaed;letter-spacing:-.02em}
.cover-logo-sub{font-size:7px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:#3d4f63}
.cover-classification{display:flex;flex-direction:column;align-items:flex-end;gap:7px}
.tlp{font-size:8px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;padding:5px 14px;border-radius:3px;color:#fff;background:${tlpColor}}
.doc-type{font-size:7px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#3d4f63}
.ai-badge-cover{font-size:7px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;padding:4px 12px;border-radius:3px;color:#fff;background:linear-gradient(135deg,#7c3aed,#5b21b6);border:1px solid #7c3aed60}
.cover-divider{margin:30px 52px 0;height:1px;background:linear-gradient(90deg,#7c3aed20,#7c3aed80,#7c3aed20);position:relative;z-index:1}
.cover-body{flex:1;padding:32px 52px 0;position:relative;z-index:1}
.cover-eyebrow{font-size:7px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#7c3aed;margin-bottom:10px}
.cover-target{font-size:28px;font-weight:800;color:#e8eaed;word-break:break-all;line-height:1.2;margin-bottom:6px;font-family:"Courier New",monospace}
.cover-orig{font-size:8.5px;color:#4a5568;margin-bottom:30px;word-break:break-all;font-family:monospace}
.cover-risk-band{display:flex;align-items:stretch;gap:0;margin-bottom:28px;border:1px solid #1e293b;border-radius:6px;overflow:hidden}
.risk-score-box{background:${rc}15;border-right:1px solid #1e293b;padding:20px 28px;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;min-width:100px}
.risk-score-num{font-size:36px;font-weight:900;color:${rc};line-height:1;font-family:"Courier New",monospace}
.risk-score-den{font-size:8px;color:${rc};opacity:.6;letter-spacing:.1em}
.risk-score-label{font-size:7px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#4a5568;margin-top:4px}
.risk-detail{padding:18px 22px;flex:1}
.risk-level-badge{display:inline-flex;align-items:center;gap:6px;margin-bottom:8px}
.risk-level-dot{width:8px;height:8px;border-radius:50%;background:${rc};flex-shrink:0}
.risk-level-text{font-size:15px;font-weight:900;color:${rc};text-transform:uppercase;letter-spacing:.08em}
.risk-desc{font-size:9px;color:#8892a4;line-height:1.6;max-width:420px}
.sc-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:20px}
.sc-cell{background:#111827;border:1px solid #1e293b;border-radius:5px;padding:12px 14px}
.sc-cell.alert{border-color:${rc}60;background:${rc}0d}
.sc-val{font-size:14px;font-weight:800;color:#e8eaed;font-family:"Courier New",monospace}
.sc-cell.alert .sc-val{color:${rc}}
.sc-key{font-size:7px;text-transform:uppercase;letter-spacing:.1em;color:#4a5568;margin-top:4px}
.cover-footer{padding:24px 52px 28px;position:relative;z-index:1;border-top:1px solid #1e293b;margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end}
.cover-footer-meta{font-size:7px;color:#2d3748;line-height:2}

/* ── PAGE HEADER ── */
.pg-header{display:flex;justify-content:space-between;align-items:center;padding:20px 52px 14px;background:#0d1117;border-bottom:1px solid #1e293b}
.pg-logo-sm{font-size:11px;font-weight:900;color:#e8eaed;letter-spacing:-.01em}
.pg-center{font-size:6.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#4a5568;font-family:monospace;max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-tlp-sm{font-size:6.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;background:${tlpColor};color:#fff;padding:2px 8px;border-radius:2px}

/* ── CONTENT ── */
.content{padding:28px 52px 56px;background:#fff}

/* ── AI NARRATIVE ── */
.ai-intro{background:#f8f4ff;border:1px solid #7c3aed30;border-radius:6px;padding:16px 20px;margin-bottom:24px;display:flex;align-items:flex-start;gap:12px}
.ai-intro-icon{font-size:18px;flex-shrink:0;margin-top:1px}
.ai-intro-text{font-size:9px;color:#4a5568;line-height:1.7}
.ai-intro-text strong{color:#7c3aed}
.ai-narrative{font-size:10.5px;color:#1e293b;line-height:1.75}
.ai-h2{font-size:13px;font-weight:800;color:#0d1117;margin:20px 0 8px;padding-bottom:5px;border-bottom:2px solid #0d1117;text-transform:uppercase;letter-spacing:.05em}
.ai-h3{font-size:11px;font-weight:700;color:#1e293b;margin:16px 0 6px;padding-left:10px;border-left:3px solid #7c3aed}
.ai-h4{font-size:10px;font-weight:700;color:#374151;margin:12px 0 5px;text-transform:uppercase;letter-spacing:.06em}
.ai-p{font-size:10px;color:#374151;line-height:1.75;margin-bottom:8px}
.ai-ul{padding-left:18px;margin:6px 0 10px}
.ai-ul li{font-size:10px;color:#374151;line-height:1.7;margin-bottom:3px;list-style:disc}
code{font-family:"Courier New",monospace;font-size:9px;background:#f1f5f9;padding:1px 4px;border-radius:2px;color:#7c3aed}

/* ── APPENDIX ── */
.appendix-title{font-size:8px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#94a3b8;margin:28px 0 14px;padding-top:16px;border-top:1px solid #e2e8f0}
.sec{margin-top:18px;page-break-inside:avoid}
.sec-hd{display:flex;align-items:center;gap:10px;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #0d1117}
.sec-num{font-size:7.5px;font-weight:800;letter-spacing:.12em;color:#7c3aed;font-family:monospace;min-width:22px}
.sec-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:#0d1117}
.sec-bd{padding-left:32px}
table{width:100%;border-collapse:collapse;font-size:9px;margin-bottom:4px}
th{text-align:left;font-size:6.5px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;padding:5px 8px;border-bottom:2px solid #e2e8f0;background:#f8fafc}
td{padding:5px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top;color:#1e293b}
tr:last-child td{border-bottom:none}
table.kv td.k{color:#64748b;width:150px;white-space:nowrap;font-size:8.5px}
table.kv td.v{color:#0f172a;word-break:break-all}
.nil{font-size:9px;color:#cbd5e1;font-style:italic;padding:4px 0}
.divider{border:none;border-top:1px solid #e2e8f0;margin:20px 0}
.page-break{page-break-before:always}
.report-footer{display:flex;justify-content:space-between;font-size:7px;color:#94a3b8;padding-top:10px;border-top:1px solid #e2e8f0;margin-top:10px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.sl{font-size:6.5px;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:#94a3b8;margin:12px 0 5px;padding-bottom:3px;border-bottom:1px solid #f1f5f9}
</style>
</head>
<body>

<!-- COVER -->
<div class="cover">
  <div class="cover-accent"></div>
  <div class="cover-stripe"></div>
  <div class="cover-top">
    <div class="cover-logo">
      <div class="cover-logo-mark">&#9672; VSAS Ciberinteligencia</div>
      <div class="cover-logo-sub">Threat Intelligence Platform</div>
    </div>
    <div class="cover-classification">
      <span class="tlp">TLP:${tlpLabel} &nbsp;&#8226;&nbsp; CONFIDENCIAL</span>
      <span class="ai-badge-cover">&#9670; Informe Generado por IA</span>
      <span class="doc-type">Threat Intelligence Report</span>
    </div>
  </div>
  <div class="cover-divider"></div>
  <div class="cover-body">
    <div class="cover-eyebrow">Indicador analizado · Análisis IA (Gemini 2.0 Flash)</div>
    <div class="cover-target">${h(p.target)}</div>
    ${p.original_url && p.original_url !== p.target
      ? `<div class="cover-orig">${h(p.original_url)}</div>`
      : '<div style="height:14px"></div>'}
    <div class="cover-risk-band">
      <div class="risk-score-box">
        <div class="risk-score-num">${risk.score??'—'}</div>
        <div class="risk-score-den">/100</div>
        <div class="risk-score-label">Risk Score</div>
      </div>
      <div class="risk-detail">
        <div class="risk-level-badge">
          <span class="risk-level-dot"></span>
          <span class="risk-level-text">${risk.level||'—'}</span>
        </div>
        <div class="risk-desc">${
          risk.level==='CRITICAL' ? 'Indicador activamente malicioso confirmado por múltiples fuentes de inteligencia. Se requiere acción de bloqueo inmediata.' :
          risk.level==='HIGH'     ? 'Alta probabilidad de actividad maliciosa detectada. Se recomienda bloqueo preventivo y revisión de logs.' :
          risk.level==='MEDIUM'   ? 'Actividad sospechosa detectada en una o más fuentes. Monitoreo activo recomendado.' :
          risk.level==='LOW'      ? 'Riesgo bajo. Sin detecciones significativas en las fuentes de inteligencia consultadas.' :
                                    'Sin detecciones en las fuentes de inteligencia consultadas. Sin indicios de actividad maliciosa.'
        }</div>
      </div>
    </div>
    <div class="sc-grid">
      <div class="sc-cell${vt.malicious>0?' alert':''}"><div class="sc-val">${h(risk.vt_verdict||'N/A')}</div><div class="sc-key">VirusTotal</div></div>
      <div class="sc-cell${(p.mandiant||{}).mscore>=50?' alert':''}"><div class="sc-val">${(p.mandiant||{}).mscore!=null?(p.mandiant.mscore)+'pts':h(risk.mandiant_verdict||'N/A')}</div><div class="sc-key">Mandiant</div></div>
      <div class="sc-cell${vs.malicious?' alert':''}"><div class="sc-val">${vs.malicious?'MALICIOUS':vs.score!=null?vs.score+'/100':'Clean'}</div><div class="sc-key">URLScan.io</div></div>
      <div class="sc-cell${risk.otx_pulses>0?' alert':''}"><div class="sc-val">${risk.otx_pulses??0}</div><div class="sc-key">OTX Pulses</div></div>
      <div class="sc-cell${risk.threatfox_hits>0?' alert':''}"><div class="sc-val">${risk.threatfox_hits??0}</div><div class="sc-key">ThreatFox IOCs</div></div>
      <div class="sc-cell${risk.urlhaus_hits>0?' alert':''}"><div class="sc-val">${risk.urlhaus_hits??0}</div><div class="sc-key">URLhaus hits</div></div>
    </div>
  </div>
  <div class="cover-footer">
    <div class="cover-footer-meta">
      <div>Generado: ${now} · Modelo: Gemini 2.0 Flash</div>
      <div>Plataforma: VSAS Threat Intelligence Platform</div>
      <div style="margin-top:3px;color:#1e293b">Clasificación: TLP:${tlpLabel} — Solo uso interno</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:9px;color:#2d3748;font-family:monospace">01</div>
      <div style="font-size:6.5px;color:#1e293b;margin-top:3px;font-family:monospace">ID: TIR-IA-${h(p.target).replace(/[^a-z0-9]/gi,'').toUpperCase().slice(0,8)}</div>
    </div>
  </div>
</div>

<!-- CONTENT -->
<div class="pg-header">
  <span class="pg-logo-sm">&#9672; VSAS Ciberinteligencia</span>
  <span class="pg-center">${h(p.target)}</span>
  <span class="pg-tlp-sm">TLP:${tlpLabel}</span>
</div>
<div class="content">

  <!-- AI intro banner -->
  <div class="ai-intro">
    <div class="ai-intro-icon">&#9670;</div>
    <div class="ai-intro-text">
      El presente informe fue <strong>redactado y analizado por Gemini 2.0 Flash</strong>, modelo de inteligencia artificial de Google,
      a partir de los datos recopilados por la plataforma VSAS Ciberinteligencia el ${now}.
      El análisis integra hallazgos de VirusTotal, URLScan, Mandiant, AlienVault OTX, ThreatFox, URLhaus y datos WHOIS/Geo.
      <strong>Clasificación: TLP:${tlpLabel} — Solo uso interno.</strong>
    </div>
  </div>

  <!-- AI Narrative -->
  <div class="ai-narrative">
    ${aiHtml}
  </div>

  <!-- Appendix -->
  ${(iocRows.length || vtRows.length || portRows.length) ? `
  <div class="appendix-title">&#9472;&#9472; Apéndice técnico — Datos de soporte</div>

  ${iocRows.length ? `
  <div class="sec">
    <div class="sec-hd"><span class="sec-num">A.1</span><span class="sec-title">Indicadores de Compromiso (${iocRows.length} IOCs)</span></div>
    <div class="sec-bd">${tbl(['','Tipo','Valor / Hash','Fuente','Contexto'], iocRows)}</div>
  </div>` : ''}

  ${vtRows.length ? `
  <div class="sec page-break">
    <div class="sec-hd"><span class="sec-num">A.2</span><span class="sec-title">Detecciones VirusTotal (${vtRows.length} motores)</span></div>
    <div class="sec-bd">${tbl(['Motor AV','Firma detectada','Categoría'], vtRows)}</div>
  </div>` : ''}

  ${portRows.length ? `
  <div class="sec">
    <div class="sec-hd"><span class="sec-num">A.3</span><span class="sec-title">Puertos abiertos (${portRows.length} detectados)</span></div>
    <div class="sec-bd">${tbl(['Puerto','Servicio','Banner','Riesgo'], portRows)}</div>
  </div>` : ''}

  ${screenshotUrl ? `
  <div class="sec">
    <div class="sec-hd"><span class="sec-num">A.4</span><span class="sec-title">Captura del sitio analizado</span></div>
    <div class="sec-bd">
      <div style="border:1px solid #e2e8f0;border-radius:4px;overflow:hidden;max-height:220px">
        <img src="${screenshotUrl}" alt="Captura URLScan" style="display:block;width:100%;height:220px;object-fit:cover;object-position:top">
      </div>
    </div>
  </div>` : ''}
  ` : ''}

  <hr class="divider">
  <div class="report-footer">
    <span>Threat Intelligence Report (IA) · TLP:${tlpLabel} · Generado con Gemini 2.0 Flash</span>
    <span>${now}</span>
  </div>
</div>
</body>
</html>`;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:#0d1117dd;z-index:9997;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = '<div style="color:#7c3aed;font-size:13px;font-family:monospace;letter-spacing:.08em;text-align:center">Generando informe IA…<br><span style="font-size:9px;color:#4a5568;margin-top:4px;display:block">Diseñado por Gemini 2.0 Flash</span></div>';
  document.body.appendChild(overlay);

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;top:0;left:-900px;width:816px;height:20000px;border:none;z-index:9998;background:#fff';
  document.body.appendChild(iframe);
  try {
    iframe.contentDocument.open();
    iframe.contentDocument.write(html);
    iframe.contentDocument.close();
    await new Promise(r => setTimeout(r, 1400));
    const body = iframe.contentDocument.body;
    const docEl = iframe.contentDocument.documentElement;
    const contentH = Math.max(body.scrollHeight, docEl.scrollHeight, 1056);
    iframe.style.height = contentH + 'px';
    body.style.cssText = 'width:816px;min-width:816px;overflow-x:hidden';
    await new Promise(r => setTimeout(r, 200));
    await html2pdf().set({
      margin: 0,
      filename: `TIR-IA-${p.target.replace(/[^a-z0-9]/gi,'_')}.pdf`,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        windowWidth: 816,
        scrollX: 0,
        scrollY: 0,
        width: 816,
        imageTimeout: 20000,
      },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], before: '.page-break', avoid: ['.sec', 'tr'] },
    }).from(body).save();
  } finally {
    document.body.removeChild(iframe);
    document.body.removeChild(overlay);
  }
}

function aiSectionEl() {
  const wrap = el('div', 'ai-section fade-in');
  wrap.id = 'ai-section';
  wrap.innerHTML = `
    <div class="ai-header">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      <span>Análisis de Inteligencia — Gemini 2.0 Flash</span>
      <span class="ai-badge">IA</span>
    </div>
    <div class="ai-body"></div>`;
  return wrap;
}

function renderAIAnalysis(container, markdown) {
  // Convertir Markdown básico a HTML
  const html = markdown
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h4 class="ai-h4">$1</h4>')
    .replace(/^## (.+)$/gm,  '<h3 class="ai-h3">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,   '<em>$1</em>')
    .replace(/^- (.+)$/gm,   '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul class="ai-list">${m}</ul>`)
    .replace(/\n\n/g, '</p><p class="ai-p">')
    .replace(/^(?!<[hul])(.+)$/gm, '<p class="ai-p">$1</p>')
    .replace(/<p class="ai-p"><\/p>/g, '');
  container.innerHTML = `<div class="ai-content">${html}</div>`;
}

// ── Reanalizar ────────────────────────────────────────────────────────────────
function reanalyzeTarget(p) {
  if (!p) return;
  const target = p.original_url || p.target;
  submitTarget(target);
}

// ── Modal de reporte ──────────────────────────────────────────────────────────
function openReportModal(p) {
  if (!p) return;
  const targetUrl = p.original_url || p.target;

  // Overlay
  const overlay = el('div', 'modal-overlay');
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  const box = el('div', 'modal-box');

  // Header
  const hdr = el('div', 'modal-hdr');
  hdr.innerHTML = `
    <div class="modal-hdr-left">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <span>Reportar URL</span>
    </div>
    <div class="modal-url">${esc(truncate(targetUrl, 60))}</div>
    <button class="modal-close" title="Cerrar">&times;</button>`;
  hdr.querySelector('.modal-close').addEventListener('click', closeModal);

  // Body
  const body = el('div', 'modal-body');

  // ── Reporte rápido ──
  const secRapido = el('div', 'modal-section');
  secRapido.innerHTML = `<div class="modal-sec-label">Reporte rápido</div>`;
  const services = [
    { id: 'google_sb',   label: 'Google Safe Browsing', icon: '🔵' },
    { id: 'netcraft',    label: 'Netcraft',              icon: '🟠' },
    { id: 'urlhaus',     label: 'URLhaus',               icon: '🟣' },
    { id: 'smartscreen', label: 'Microsoft SmartScreen', icon: '🔷' },
    { id: 'phishreport', label: 'Phish Report',          icon: '🔴' },
  ];
  const btnGrid = el('div', 'modal-btn-grid');
  services.forEach(svc => {
    const btn = el('button', 'modal-report-btn');
    const dot = el('span', 'report-status');
    btn.innerHTML = `<span class="report-icon">${svc.icon}</span><span>${svc.label}</span>`;
    btn.appendChild(dot);
    btn.onclick = async () => {
      btn.disabled = true;
      dot.className = 'report-status spinning';
      try {
        const r    = await fetch('/report', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ service: svc.id, url: targetUrl }) });
        const data = await r.json();
        dot.className = `report-status ${data.ok ? 'ok' : 'fail'}`;
        dot.title     = data.message;
        btn.title     = data.message;
        if (data.ok) btn.classList.add('reported');
      } catch(e) {
        dot.className = 'report-status fail';
        dot.title = e.message;
      }
      btn.disabled = false;
    };
    btnGrid.appendChild(btn);
  });
  secRapido.appendChild(btnGrid);
  body.appendChild(secRapido);

  // ── Crear caso Fortra ──
  const secFortra = el('div', 'modal-section');
  secFortra.innerHTML = `<div class="modal-sec-label">Crear caso en Fortra</div>`;

  fetch('/report/config').then(r => r.json()).then(cfg => {
    const row = el('div', 'modal-fortra-row');

    const brandSel = document.createElement('select');
    brandSel.className = 'pl-select';
    cfg.brands.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b; opt.textContent = b;
      brandSel.appendChild(opt);
    });

    const typeSel = document.createElement('select');
    typeSel.className = 'pl-select';
    cfg.case_types.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = t;
      typeSel.appendChild(opt);
    });

    const createBtn = el('button', 'btn-report btn-report-create');
    createBtn.innerHTML = `<span class="report-icon">🚨</span><span>Crear caso</span>`;
    const createDot = el('span', 'report-status');
    createBtn.appendChild(createDot);

    const msg = el('div', 'pl-result-msg');
    msg.style.marginTop = '.5rem';

    createBtn.onclick = async () => {
      createBtn.disabled = true;
      createDot.className = 'report-status spinning';
      msg.textContent = '';
      try {
        const r    = await fetch('/report/phishlabs_case', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: targetUrl, brand: brandSel.value, case_type: typeSel.value }) });
        const data = await r.json();
        createDot.className = `report-status ${data.ok ? 'ok' : 'fail'}`;
        msg.textContent     = data.message;
        msg.style.color     = data.ok ? 'var(--risk-clean)' : 'var(--risk-crit)';
        if (data.ok) createBtn.classList.add('reported');
      } catch(e) {
        createDot.className = 'report-status fail';
        msg.textContent = e.message;
      }
      createBtn.disabled = false;
    };

    row.appendChild(brandSel);
    row.appendChild(typeSel);
    row.appendChild(createBtn);
    secFortra.appendChild(row);
    secFortra.appendChild(msg);
  });
  body.appendChild(secFortra);

  box.appendChild(hdr);
  box.appendChild(body);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => overlay.classList.add('visible'));

  function closeModal() {
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  }
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
