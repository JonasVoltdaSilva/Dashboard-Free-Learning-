'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let allData = [];
let allHeaders = [];
let cols = { dept: -1, type: -1, obs: -1, date: -1, mode: -1 };
let charts = {};
let sparks = {};
let cachedProcessed = null;
let lastRows = [];
let tableSort = { col: -1, dir: 1 };

// ─── Settings (persistidas em localStorage) ────────────────────────────────────
const ACCENTS = {
    blue:   { main: '#3b82f6', soft: 'rgba(59,130,246,0.22)', glow: 'rgba(37,99,235,0.25)' },
    green:  { main: '#10b981', soft: 'rgba(16,185,129,0.22)', glow: 'rgba(16,185,129,0.25)' },
    purple: { main: '#8b5cf6', soft: 'rgba(139,92,246,0.22)', glow: 'rgba(124,58,237,0.25)' },
    amber:  { main: '#f59e0b', soft: 'rgba(245,158,11,0.22)', glow: 'rgba(245,158,11,0.25)' },
};
const DEFAULT_SETTINGS = { theme: 'dark', accent: 'blue', topN: 20, colorblind: false, animations: true, compact: false, contrast: false };
const DEFAULT_VISIBLE  = { dept: true, weekly: true, trend: true, gauge: true, pareto: true, heatmap: true, types: true, obs: true, stacked: true, table: true };

let SETTINGS = { ...DEFAULT_SETTINGS };
let VISIBLE  = { ...DEFAULT_VISIBLE };

function loadPrefs() {
    try { SETTINGS = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('bunge_settings') || '{}') }; }
    catch { SETTINGS = { ...DEFAULT_SETTINGS }; }
    try { VISIBLE = { ...DEFAULT_VISIBLE, ...JSON.parse(localStorage.getItem('bunge_visible') || '{}') }; }
    catch { VISIBLE = { ...DEFAULT_VISIBLE }; }
}
function savePrefs() {
    localStorage.setItem('bunge_settings', JSON.stringify(SETTINGS));
    localStorage.setItem('bunge_visible', JSON.stringify(VISIBLE));
}

const anim = () => (SETTINGS.animations ? { duration: 700 } : false);
const topCount = arr => (SETTINGS.topN > 0 ? arr.slice(0, SETTINGS.topN) : arr);

// ─── Paletas (normal + daltônico) ──────────────────────────────────────────────
const PALETTE_NORMAL = [
    '#60a5fa','#a855f7','#2dd4bf','#4ade80','#818cf8',
    '#34d399','#93c5fd','#c084fc','#5eead4','#86efac',
    '#38bdf8','#a78bfa','#6ee7b7','#67e8f9','#d8b4fe',
    '#f472b6','#fb923c','#facc15','#e879f9','#22d3ee',
];
// Paleta segura para daltônicos (Okabe-Ito + variações)
const PALETTE_CB = [
    '#0072b2','#e69f00','#009e73','#cc79a7','#56b4e9',
    '#d55e00','#f0e442','#999999','#0072b2','#e69f00',
    '#009e73','#cc79a7','#56b4e9','#d55e00','#f0e442',
    '#995500','#332288','#117733','#88ccee','#ddcc77',
];
const RAINBOW_NORMAL = [
    '#ef4444','#f97316','#eab308','#22c55e','#3b82f6',
    '#6366f1','#a855f7','#ec4899','#06b6d4','#84cc16',
    '#f59e0b','#10b981','#8b5cf6','#14b8a6','#f43f5e','#0ea5e9',
];
const palette = () => (SETTINGS.colorblind ? PALETTE_CB : PALETTE_NORMAL);
const rainbow = () => (SETTINGS.colorblind ? PALETTE_CB : RAINBOW_NORMAL);
const gc = i => palette()[i % palette().length];
const gcRainbow = i => rainbow()[i % rainbow().length];

// ─── Column detection ─────────────────────────────────────────────────────────
const KEYWORDS = {
    dept: ['setor', 'departamento', 'area', 'planta', 'unidade', 'local', 'sector', 'dept', 'location'],
    type: ['tipo', 'categoria', 'ocorrencia', 'ocorrência', 'classif', 'classe', 'type', 'category'],
    obs:  ['observador', 'responsavel', 'responsável', 'nome', 'funcionario', 'funcionário', 'autor',
           'registrado', 'reporter', 'observer', 'colaborador', 'registrant'],
    date: ['data', 'date', 'mes', 'mês', 'periodo', 'período', 'dt_', 'datahora'],
};

function normalizeStr(s) {
    return String(s).toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9_]/g, '');
}

function detectCol(headers, keywords) {
    const norm = headers.map(normalizeStr);
    for (const kw of keywords) {
        const nkw = normalizeStr(kw);
        const i = norm.findIndex(h => h.includes(nkw));
        if (i !== -1) return i;
    }
    return -1;
}

function detectModeCol(headers, rows) {
    let bestIdx = -1, bestScore = 0;
    for (let i = 0; i < headers.length; i++) {
        let matches = 0;
        for (const r of rows) {
            const v = normalizeStr(String(r[i] ?? ''));
            if (v === 'observar' || v === 'comunique') matches++;
        }
        if (matches > bestScore) { bestScore = matches; bestIdx = i; }
    }
    return bestScore > 0 ? bestIdx : -1;
}

// ─── Date parsing ─────────────────────────────────────────────────────────────
function parseDate(val) {
    if (val == null || val === '') return null;
    if (typeof val === 'number' && val > 1000) {
        const base = new Date(1899, 11, 30);
        const d = new Date(base.getTime() + val * 86400000);
        return isNaN(d) ? null : d;
    }
    const s = String(val).trim();
    let m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
    if (m) {
        const y = parseInt(m[3]); const mo = parseInt(m[2]) - 1; const d = parseInt(m[1]);
        return new Date(y < 100 ? 2000 + y : y, mo, d);
    }
    m = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
    if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

const MONTHS_SHORT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const WEEKDAYS = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
function monthLabel(d) { return `${MONTHS_SHORT[d.getMonth()]}/${d.getFullYear()}`; }
function monthOrder(s) { const [m, y] = s.split('/'); return parseInt(y) * 100 + MONTHS_SHORT.indexOf(m); }

function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const y = t.getUTCFullYear();
    const w = Math.ceil(((t - new Date(Date.UTC(y, 0, 1))) / 86400000 + 1) / 7);
    return `S${String(w).padStart(2,'0')}/${y}`;
}

// ─── Aggregate data ───────────────────────────────────────────────────────────
function aggregate(rows) {
    const deptCnt = {}, typeCnt = {}, obsCnt = {}, typeByDept = {}, monthCnt = {};
    const monthKeys = new Set(), sectorSet = new Set();
    const mDepts = {}, mObs = {}, mTypes = {};   // sets por mês (p/ sparklines de distintos)
    const heat = {};                              // heat[weekday][month] = count
    let comunique = 0, observar = 0, outros = 0;

    for (const row of rows) {
        const dept = cols.dept >= 0 ? String(row[cols.dept] ?? '').trim() : '';
        const type = cols.type >= 0 ? String(row[cols.type] ?? '').trim() : '';
        const obs  = cols.obs  >= 0 ? String(row[cols.obs]  ?? '').trim() : '';
        const date = parseDate(cols.date >= 0 ? row[cols.date] : null);

        if (dept) { deptCnt[dept] = (deptCnt[dept] || 0) + 1; sectorSet.add(dept); }
        if (type) { typeCnt[type] = (typeCnt[type] || 0) + 1; }
        if (obs)  { obsCnt[obs]   = (obsCnt[obs]   || 0) + 1; }

        if (date) {
            const ml = monthLabel(date);
            monthKeys.add(ml);
            monthCnt[ml] = (monthCnt[ml] || 0) + 1;
            (mDepts[ml] = mDepts[ml] || new Set()).add(dept);
            (mObs[ml]   = mObs[ml]   || new Set()).add(obs);
            (mTypes[ml] = mTypes[ml] || new Set()).add(type);
            const wd = date.getDay();
            (heat[wd] = heat[wd] || {})[ml] = (heat[wd]?.[ml] || 0) + 1;
        }
        if (dept && type) {
            if (!typeByDept[dept]) typeByDept[dept] = {};
            typeByDept[dept][type] = (typeByDept[dept][type] || 0) + 1;
        }

        if (cols.mode >= 0) {
            const md = normalizeStr(String(row[cols.mode] ?? ''));
            if (md === 'comunique') comunique++;
            else if (md === 'observar') observar++;
            else outros++;
        }
    }

    const months = [...monthKeys].sort((a, b) => monthOrder(a) - monthOrder(b));
    const distinctCount = (map) => months.map(m => (map[m] ? [...map[m]].filter(Boolean).length : 0));

    return {
        deptCnt, typeCnt, obsCnt, typeByDept, monthCnt, heat,
        months,
        sectors: [...sectorSet].sort(),
        total: rows.length,
        totalDepts: Object.keys(deptCnt).length,
        totalObs: Object.keys(obsCnt).length,
        totalTypes: Object.keys(typeCnt).length,
        series: {
            total: months.map(m => monthCnt[m] || 0),
            depts: distinctCount(mDepts),
            obs:   distinctCount(mObs),
            types: distinctCount(mTypes),
        },
        modes: { comunique, observar, outros },
    };
}

// ─── Chart defaults ───────────────────────────────────────────────────────────
const GRID_COLOR = 'rgba(255,255,255,0.05)';
const TOOLTIP_OPTS = {
    backgroundColor: '#0d0d24', titleColor: '#f8fafc', bodyColor: '#94a3b8',
    borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 10, cornerRadius: 8,
};
const SCALE_OPTS = {
    x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: GRID_COLOR }, border: { color: GRID_COLOR } },
    y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: GRID_COLOR }, border: { color: GRID_COLOR }, beginAtZero: true },
};

Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.font.size = 11;

Chart.register({
    id: 'doughnutCenter',
    afterDraw(chart) {
        if (chart.config.type !== 'doughnut' || !chart.config.options.plugins.doughnutCenter) return;
        const { ctx, chartArea } = chart;
        if (!chartArea) return;
        const cx = (chartArea.left + chartArea.right) / 2;
        const cy = (chartArea.top + chartArea.bottom) / 2;
        const total = (chart.data.datasets[0]?.data || []).reduce((a, b) => a + b, 0);
        ctx.save();
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '700 28px Inter, sans-serif';
        ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text') || '#f8fafc';
        ctx.fillText(total.toLocaleString('pt-BR'), cx, cy - 10);
        ctx.font = '400 11px Inter, sans-serif';
        ctx.fillStyle = '#64748b';
        ctx.fillText('registros', cx, cy + 14);
        ctx.restore();
    },
});

function destroyChart(key) { if (charts[key]) { charts[key].destroy(); charts[key] = null; } }

// ─── KPIs inteligentes (delta + sparkline) ────────────────────────────────────
function renderKpi(id, value, series, color) {
    animateValue(document.getElementById('kpi-' + id), value);

    // delta vs mês anterior (últimos 2 meses da série)
    const deltaEl = document.getElementById('d-' + id);
    if (series && series.length >= 2) {
        const cur = series[series.length - 1];
        const prev = series[series.length - 2];
        if (prev > 0 || cur > 0) {
            const pct = prev === 0 ? 100 : Math.round((cur - prev) / prev * 100);
            const up = cur >= prev;
            deltaEl.className = 'kpi-delta ' + (up ? 'kpi-delta--up' : 'kpi-delta--down');
            deltaEl.innerHTML = `${up ? '▲' : '▼'} ${Math.abs(pct)}%`;
            deltaEl.title = `${prev.toLocaleString('pt-BR')} → ${cur.toLocaleString('pt-BR')} (vs. mês anterior)`;
        } else { deltaEl.textContent = ''; deltaEl.className = 'kpi-delta'; }
    } else { deltaEl.textContent = ''; deltaEl.className = 'kpi-delta'; }

    // sparkline
    if (sparks[id]) { sparks[id].destroy(); sparks[id] = null; }
    const el = document.getElementById('spark-' + id);
    if (!el || !series || series.length < 2) return;
    sparks[id] = new Chart(el.getContext('2d'), {
        type: 'line',
        data: { labels: series.map((_, i) => i), datasets: [{
            data: series, borderColor: 'rgba(255,255,255,0.9)',
            backgroundColor: 'rgba(255,255,255,0.18)', fill: true,
            tension: 0.4, borderWidth: 1.5, pointRadius: 0,
        }]},
        options: {
            responsive: true, maintainAspectRatio: false, animation: anim(),
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false } },
        },
    });
}

// ─── Dept Bar Chart (com drill-down por clique) ───────────────────────────────
function buildDeptChart(deptCnt) {
    const sorted = topCount(Object.entries(deptCnt).sort((a,b) => b[1]-a[1]));
    const names  = sorted.map(([k]) => k);
    const labels = names.map(k => k.length > 18 ? k.slice(0,18)+'…' : k);
    const data   = sorted.map(([,v]) => v);
    const colors = data.map((_,i) => gcRainbow(i));

    destroyChart('dept');
    const ctx = document.getElementById('dept-chart').getContext('2d');
    charts.dept = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 6, borderSkipped: false }] },
        options: {
            responsive: true, maintainAspectRatio: false, animation: anim(),
            onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
            onClick: (e, els) => { if (els.length) drillToSector(names[els[0].index]); },
            plugins: { legend: { display: false }, tooltip: { ...TOOLTIP_OPTS } },
            scales: {
                x: { ...SCALE_OPTS.x, ticks: { ...SCALE_OPTS.x.ticks, maxRotation: 40 } },
                y: { ...SCALE_OPTS.y },
            },
        },
    });
}

// ─── Types Donut ──────────────────────────────────────────────────────────────
function buildTypesChart(typeCnt) {
    const sorted = Object.entries(typeCnt).sort((a,b) => b[1]-a[1]);
    const labels = sorted.map(([k]) => k);
    const data   = sorted.map(([,v]) => v);
    const colors = labels.map((_,i) => gc(i));
    const total  = data.reduce((a,b) => a+b, 0);

    destroyChart('types');
    const ctx = document.getElementById('types-chart').getContext('2d');
    charts.types = new Chart(ctx, {
        type: 'doughnut',
        data: { labels, datasets: [{
            data, backgroundColor: colors, borderColor: 'rgba(255,255,255,0.15)',
            borderWidth: 2, hoverOffset: 12, spacing: 3, borderRadius: 6,
        }]},
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '68%', animation: anim(),
            plugins: {
                doughnutCenter: true,
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#e2e8f0', padding: 16, font: { size: 11, weight: '500' },
                        usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8,
                        generateLabels: chart => chart.data.labels.map((label, i) => {
                            const val = chart.data.datasets[0].data[i];
                            const pct = total > 0 ? Math.round(val / total * 100) : 0;
                            const short = label.length > 20 ? label.slice(0,20)+'…' : label;
                            return {
                                text: `${short}  ${pct}%`,
                                fillStyle: chart.data.datasets[0].backgroundColor[i],
                                strokeStyle: chart.data.datasets[0].backgroundColor[i],
                                fontColor: '#e2e8f0', color: '#e2e8f0',
                                pointStyle: 'circle', lineWidth: 0, hidden: false, index: i,
                            };
                        }),
                    },
                },
                tooltip: {
                    ...TOOLTIP_OPTS,
                    callbacks: { label: c => {
                        const pct = total > 0 ? Math.round(c.parsed / total * 100) : 0;
                        return ` ${c.label}: ${c.parsed.toLocaleString('pt-BR')} (${pct}%)`;
                    }},
                },
            },
        },
    });
}

// ─── Trend Line Chart ─────────────────────────────────────────────────────────
function buildTrendChart(months, monthCnt) {
    const empty  = document.getElementById('trend-empty');
    const canvas = document.getElementById('trend-chart');
    destroyChart('trend');
    if (!months || months.length === 0) { canvas.style.display = 'none'; empty.style.display = 'flex'; return; }
    canvas.style.display = 'block'; empty.style.display = 'none';

    const data = months.map(m => monthCnt[m] || 0);
    const accent = ACCENTS[SETTINGS.accent]?.main || '#3b82f6';
    const ctx = canvas.getContext('2d');
    charts.trend = new Chart(ctx, {
        type: 'line',
        data: { labels: months, datasets: [{
            label: 'Ocorrências', data, borderColor: accent,
            backgroundColor: c => {
                const { chartArea, ctx: cc } = c.chart;
                if (!chartArea) return accent + '20';
                const g = cc.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                g.addColorStop(0, accent + '55'); g.addColorStop(1, accent + '05');
                return g;
            },
            fill: true, tension: 0.35, borderWidth: 2.5,
            pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: accent,
            pointBorderColor: '#0b0b1f', pointBorderWidth: 2,
        }]},
        options: {
            responsive: true, maintainAspectRatio: false, animation: anim(),
            plugins: { legend: { display: false },
                tooltip: { ...TOOLTIP_OPTS, callbacks: { label: c => ` ${c.parsed.y.toLocaleString('pt-BR')} ocorrências` } } },
            scales: { x: { ...SCALE_OPTS.x }, y: { ...SCALE_OPTS.y } },
        },
    });
}

// ─── Gauge: Comunique vs Observar (meia-rosca) ────────────────────────────────
function buildGaugeChart(modes) {
    const empty  = document.getElementById('gauge-empty');
    const canvas = document.getElementById('gauge-chart');
    const center = document.getElementById('gauge-center');
    const legend = document.getElementById('gauge-legend');
    destroyChart('gauge');

    if (cols.mode < 0 || (modes.comunique + modes.observar + modes.outros) === 0) {
        canvas.style.display = 'none'; center.textContent = ''; legend.innerHTML = '';
        empty.style.display = 'flex'; return;
    }
    canvas.style.display = 'block'; empty.style.display = 'none';

    const c = modes.comunique, o = modes.observar, ot = modes.outros;
    const tot = c + o + ot;
    const pctC = Math.round(c / tot * 100);
    const cor = SETTINGS.colorblind ? ['#0072b2','#e69f00','#999999'] : ['#3b82f6','#10b981','#f59e0b'];

    charts.gauge = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: { labels: ['Comunique','Observar','Outros'], datasets: [{
            data: [c, o, ot], backgroundColor: cor, borderColor: 'transparent',
            borderRadius: 4, spacing: 2,
        }]},
        options: {
            responsive: true, maintainAspectRatio: false, animation: anim(),
            rotation: -90, circumference: 180, cutout: '70%',
            plugins: { legend: { display: false },
                tooltip: { ...TOOLTIP_OPTS, callbacks: { label: x => ` ${x.label}: ${x.parsed.toLocaleString('pt-BR')} (${Math.round(x.parsed/tot*100)}%)` } } },
        },
    });
    center.innerHTML = `<span class="gauge-big">${pctC}%</span><span class="gauge-sub">Comunique</span>`;
    legend.innerHTML = ['Comunique','Observar','Outros'].map((l,i) =>
        `<span class="gl"><i style="background:${cor[i]}"></i>${l} · ${[c,o,ot][i].toLocaleString('pt-BR')}</span>`).join('');
}

// ─── Pareto: barras + linha cumulativa ────────────────────────────────────────
function buildParetoChart(typeCnt) {
    const sorted = Object.entries(typeCnt).sort((a,b) => b[1]-a[1]).slice(0, 12);
    const labels = sorted.map(([k]) => k.length > 14 ? k.slice(0,14)+'…' : k);
    const data   = sorted.map(([,v]) => v);
    const total  = data.reduce((a,b) => a+b, 0) || 1;
    let acc = 0;
    const cum = data.map(v => { acc += v; return Math.round(acc / total * 100); });
    const accent = ACCENTS[SETTINGS.accent]?.main || '#3b82f6';

    destroyChart('pareto');
    charts.pareto = new Chart(document.getElementById('pareto-chart').getContext('2d'), {
        data: {
            labels,
            datasets: [
                { type: 'bar', label: 'Ocorrências', data, backgroundColor: data.map((_,i)=>gc(i)),
                  borderRadius: 5, borderSkipped: false, yAxisID: 'y', order: 2 },
                { type: 'line', label: '% acumulado', data: cum, borderColor: accent,
                  backgroundColor: accent, tension: 0.3, borderWidth: 2.5, pointRadius: 3,
                  pointBackgroundColor: accent, yAxisID: 'y1', order: 1 },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: anim(),
            plugins: {
                legend: { position: 'top', labels: { color: '#cbd5e1', font: { size: 10 }, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, padding: 12 } },
                tooltip: { ...TOOLTIP_OPTS, callbacks: { label: c => c.dataset.yAxisID === 'y1' ? ` ${c.parsed.y}% acumulado` : ` ${c.parsed.y.toLocaleString('pt-BR')} ocorrências` } },
            },
            scales: {
                x: { ...SCALE_OPTS.x, ticks: { ...SCALE_OPTS.x.ticks, maxRotation: 40 } },
                y: { ...SCALE_OPTS.y, position: 'left' },
                y1: { position: 'right', beginAtZero: true, max: 100,
                      ticks: { color: '#94a3b8', font: { size: 10 }, callback: v => v + '%' },
                      grid: { drawOnChartArea: false } },
            },
        },
    });
}

// ─── Mapa de calor (HTML/CSS) ─────────────────────────────────────────────────
function buildHeatmap(months, heat) {
    const wrap  = document.getElementById('heatmap');
    const empty = document.getElementById('heatmap-empty');
    if (!months || months.length === 0) { wrap.style.display = 'none'; empty.style.display = 'flex'; return; }
    wrap.style.display = 'grid'; empty.style.display = 'none';

    // máximo p/ normalizar intensidade
    let max = 0;
    for (let wd = 0; wd < 7; wd++) for (const m of months) max = Math.max(max, heat[wd]?.[m] || 0);
    max = max || 1;
    const accent = ACCENTS[SETTINGS.accent]?.main || '#3b82f6';

    wrap.style.gridTemplateColumns = `48px repeat(${months.length}, 1fr)`;
    let html = '<div class="hm-corner"></div>';
    for (const m of months) html += `<div class="hm-colh">${m}</div>`;
    for (let wd = 1; wd <= 7; wd++) {           // começa na Segunda
        const d = wd % 7;                        // 1..6,0
        html += `<div class="hm-rowh">${WEEKDAYS[d]}</div>`;
        for (const m of months) {
            const v = heat[d]?.[m] || 0;
            const a = v === 0 ? 0 : 0.12 + 0.88 * (v / max);
            html += `<div class="hm-cell" style="background:${hexA(accent, a)}" title="${WEEKDAYS[d]} · ${m}: ${v}">${v > 0 ? v : ''}</div>`;
        }
    }
    wrap.innerHTML = html;
}
function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a.toFixed(3)})`;
}

// ─── Top Observers ────────────────────────────────────────────────────────────
function buildObsChart(sectorFilter, modeFilter) {
    let rows = lastRows.length ? lastRows : allData;
    if (sectorFilter && cols.dept >= 0) rows = rows.filter(r => String(r[cols.dept] ?? '').trim() === sectorFilter);
    if (modeFilter && cols.mode >= 0) { const mf = normalizeStr(modeFilter); rows = rows.filter(r => normalizeStr(String(r[cols.mode] ?? '')) === mf); }

    const obsCnt = {};
    for (const row of rows) { const obs = cols.obs >= 0 ? String(row[cols.obs] ?? '').trim() : ''; if (obs) obsCnt[obs] = (obsCnt[obs] || 0) + 1; }

    const sorted = Object.entries(obsCnt).sort((a,b) => b[1]-a[1]);
    const labels = sorted.map(([k]) => k.length > 30 ? k.slice(0,30)+'…' : k);
    const data   = sorted.map(([,v]) => v);
    const colors = data.map((_,i) => gc(i));

    destroyChart('obs');
    const canvas = document.getElementById('obs-chart');
    const wrap   = document.getElementById('obs-chart-wrap');
    const inner  = document.getElementById('obs-chart-inner');

    if (sorted.length === 0) {
        inner.style.display = 'none';
        if (!wrap.querySelector('.obs-empty')) {
            const msg = document.createElement('div');
            msg.className = 'obs-empty weekly-empty';
            msg.textContent = cols.obs < 0 ? 'Coluna de observadores não detectada na planilha'
                : 'Nenhum observador encontrado para os filtros selecionados';
            wrap.appendChild(msg);
        }
        return;
    }
    wrap.querySelector('.obs-empty')?.remove();
    inner.style.display = 'block';
    inner.style.height = Math.max(sorted.length * 36 + 24, 80) + 'px';

    charts.obs = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 5, borderSkipped: 'left' }] },
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: anim(),
            plugins: { legend: { display: false }, tooltip: { ...TOOLTIP_OPTS } },
            scales: {
                x: { ...SCALE_OPTS.x, ticks: { ...SCALE_OPTS.x.ticks, maxTicksLimit: 6 } },
                y: { grid: { color: 'transparent' }, border: { color: 'transparent' },
                     ticks: { color: '#e2e8f0', font: { size: 12, weight: '500' }, padding: 8 } },
            },
        },
    });
}

// ─── Weekly Bar Chart ─────────────────────────────────────────────────────────
function buildWeeklyChart(sector, month) {
    const canvas = document.getElementById('weekly-chart');
    const empty  = document.getElementById('weekly-empty');
    if (!sector) { destroyChart('weekly'); canvas.style.display = 'none'; empty.style.display = 'flex'; return; }

    let rows = allData;
    if (cols.dept >= 0) rows = rows.filter(r => String(r[cols.dept] ?? '').trim() === sector);

    let weekKeyFn, orderWeeks;
    if (month && cols.date >= 0) {
        rows = rows.filter(r => { const d = parseDate(r[cols.date]); return d && monthLabel(d) === month; });
        weekKeyFn  = d => `Semana ${Math.min(Math.ceil(d.getDate() / 7), 5)}`;
        orderWeeks = p => ['Semana 1','Semana 2','Semana 3','Semana 4','Semana 5'].filter(k => p.has(k));
    } else {
        weekKeyFn  = d => isoWeek(d);
        orderWeeks = p => [...p].sort();
    }

    const counts = {}; const present = new Set();
    for (const row of rows) {
        const d = parseDate(cols.date >= 0 ? row[cols.date] : null);
        if (!d) continue;
        const wk = weekKeyFn(d); present.add(wk);
        if (!counts[wk]) counts[wk] = { comunique: 0, observar: 0, outros: 0 };
        const mode = cols.mode >= 0 ? normalizeStr(String(row[cols.mode] ?? '')) : '';
        if (mode === 'comunique') counts[wk].comunique++;
        else if (mode === 'observar') counts[wk].observar++;
        else counts[wk].outros++;
    }

    const labels = orderWeeks(present);
    if (labels.length === 0) { destroyChart('weekly'); canvas.style.display = 'none'; empty.style.display = 'flex'; return; }
    canvas.style.display = 'block'; empty.style.display = 'none';

    const cor = SETTINGS.colorblind ? ['#0072b2','#e69f00','#999999'] : ['#3b82f6','#10b981','#f59e0b'];
    const datasets = [
        { label: 'Comunique', data: labels.map(w => counts[w].comunique), backgroundColor: cor[0], borderRadius: 6, borderSkipped: false },
        { label: 'Observar',  data: labels.map(w => counts[w].observar),  backgroundColor: cor[1], borderRadius: 6, borderSkipped: false },
        { label: 'Outros',    data: labels.map(w => counts[w].outros),    backgroundColor: cor[2], borderRadius: 6, borderSkipped: false },
    ];

    destroyChart('weekly');
    charts.weekly = new Chart(canvas.getContext('2d'), {
        type: 'bar', data: { labels, datasets },
        options: {
            responsive: true, maintainAspectRatio: false, animation: anim(),
            plugins: {
                legend: { position: 'top', labels: { color: '#cbd5e1', font: { size: 11 }, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 14 } },
                tooltip: { ...TOOLTIP_OPTS, mode: 'index', intersect: false },
            },
            scales: { x: { ...SCALE_OPTS.x }, y: { ...SCALE_OPTS.y } },
        },
    });
}

// ─── Stacked Bar Chart ────────────────────────────────────────────────────────
function buildStackedChart(typeByDept, typeCnt) {
    const depts = topCount(Object.keys(typeByDept).sort((a, b) => {
        const sa = Object.values(typeByDept[a]).reduce((x,y) => x+y, 0);
        const sb = Object.values(typeByDept[b]).reduce((x,y) => x+y, 0);
        return sb - sa;
    }));
    const types  = Object.keys(typeCnt).sort((a,b) => typeCnt[b] - typeCnt[a]);
    const labels = depts.map(d => d.length > 16 ? d.slice(0,16)+'…' : d);

    const datasets = types.map((type, i) => ({
        label: type.length > 32 ? type.slice(0,32)+'…' : type,
        data: depts.map(d => typeByDept[d]?.[type] || 0),
        backgroundColor: gc(i), borderWidth: 0, borderRadius: 3,
    }));

    destroyChart('stacked');
    charts.stacked = new Chart(document.getElementById('stacked-chart').getContext('2d'), {
        type: 'bar', data: { labels, datasets },
        options: {
            responsive: true, maintainAspectRatio: false, animation: anim(),
            onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
            onClick: (e, els) => { if (els.length) drillToSector(depts[els[0].index]); },
            plugins: {
                legend: { position: 'top', labels: { color: '#cbd5e1', font: { size: 10 }, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 14 } },
                tooltip: { ...TOOLTIP_OPTS, mode: 'index', intersect: false },
            },
            scales: {
                x: { stacked: true, ...SCALE_OPTS.x, ticks: { ...SCALE_OPTS.x.ticks, maxRotation: 40 } },
                y: { stacked: true, ...SCALE_OPTS.y },
            },
        },
    });
}

// ─── Tabela de dados ──────────────────────────────────────────────────────────
function buildTable(rows) {
    const thead = document.getElementById('data-thead');
    const tbody = document.getElementById('data-tbody');
    const count = document.getElementById('table-count');
    const search = (document.getElementById('table-search').value || '').toLowerCase().trim();

    let filtered = rows;
    if (search) filtered = rows.filter(r => r.some(c => String(c ?? '').toLowerCase().includes(search)));

    if (tableSort.col >= 0) {
        const ci = tableSort.col, dir = tableSort.dir;
        filtered = [...filtered].sort((a, b) => {
            const x = a[ci] ?? '', y = b[ci] ?? '';
            const nx = parseFloat(x), ny = parseFloat(y);
            if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * dir;
            return String(x).localeCompare(String(y), 'pt-BR') * dir;
        });
    }

    thead.innerHTML = '<tr>' + allHeaders.map((h, i) => {
        const arrow = tableSort.col === i ? (tableSort.dir === 1 ? ' ▲' : ' ▼') : '';
        return `<th data-col="${i}">${escapeHtml(h)}${arrow}</th>`;
    }).join('') + '</tr>';

    const LIMIT = 300;
    const shown = filtered.slice(0, LIMIT);
    tbody.innerHTML = shown.map(r =>
        '<tr>' + allHeaders.map((_, i) => `<td>${escapeHtml(String(r[i] ?? ''))}</td>`).join('') + '</tr>'
    ).join('');

    count.textContent = `${filtered.length.toLocaleString('pt-BR')} registro(s)` +
        (filtered.length > LIMIT ? ` (exibindo ${LIMIT})` : '') + ' — clique no cabeçalho para ordenar';

    thead.querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
        const ci = parseInt(th.dataset.col, 10);
        if (tableSort.col === ci) tableSort.dir *= -1; else { tableSort.col = ci; tableSort.dir = 1; }
        buildTable(lastRows);
    }));
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

// ─── KPI counter animation ────────────────────────────────────────────────────
function animateValue(el, target) {
    if (!SETTINGS.animations) { el.textContent = target.toLocaleString('pt-BR'); return; }
    const duration = 600; const start = performance.now();
    const from = parseInt(el.textContent.replace(/\D/g, '')) || 0;
    function step(now) {
        const t = Math.min((now - start) / duration, 1);
        const ease = 1 - Math.pow(1 - t, 3);
        el.textContent = Math.round(from + (target - from) * ease).toLocaleString('pt-BR');
        if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

// ─── Render dashboard ─────────────────────────────────────────────────────────
function renderDashboard(rows) {
    lastRows = rows;
    const d = aggregate(rows);
    cachedProcessed = d;

    renderKpi('total', d.total,      d.series.total);
    renderKpi('depts', d.totalDepts, d.series.depts);
    renderKpi('obs',   d.totalObs,   d.series.obs);
    renderKpi('types', d.totalTypes, d.series.types);

    buildDeptChart(d.deptCnt);
    buildTypesChart(d.typeCnt);
    buildStackedChart(d.typeByDept, d.typeCnt);
    buildTrendChart(d.months, d.monthCnt);
    buildGaugeChart(d.modes);
    buildParetoChart(d.typeCnt);
    buildHeatmap(d.months, d.heat);
    buildTable(rows);

    const obsSec  = document.getElementById('obs-sector')?.value  || '';
    const obsMode = document.getElementById('obs-mode')?.value    || '';
    buildObsChart(obsSec, obsMode);

    const wSec = document.getElementById('weekly-sector')?.value || '';
    const wMon = document.getElementById('weekly-month')?.value  || '';
    buildWeeklyChart(wSec, wMon);
}

// ─── Init from file ────────────────────────────────────────────────────────────
function initDashboard(rows, headers) {
    cols.dept = detectCol(headers, KEYWORDS.dept);
    cols.type = detectCol(headers, KEYWORDS.type);
    cols.obs  = detectCol(headers, KEYWORDS.obs);
    cols.date = detectCol(headers, KEYWORDS.date);
    cols.mode = detectModeCol(headers, rows);

    allData = rows; allHeaders = headers;
    const initial = aggregate(rows);

    const fFrom = document.getElementById('filter-from');
    const fTo   = document.getElementById('filter-to');
    const fSector = document.getElementById('filter-sector');
    [fFrom, fTo, fSector].forEach(el => { while (el.options.length > 1) el.remove(1); });
    initial.months.forEach(m => { fFrom.add(new Option(m, m)); fTo.add(new Option(m, m)); });
    initial.sectors.forEach(s => fSector.add(new Option(s, s)));

    const obsSec = document.getElementById('obs-sector');
    if (obsSec) { while (obsSec.options.length > 1) obsSec.remove(1); initial.sectors.forEach(s => obsSec.add(new Option(s, s))); }

    const wSector = document.getElementById('weekly-sector');
    const wMonth  = document.getElementById('weekly-month');
    if (wSector) { while (wSector.options.length > 1) wSector.remove(1); }
    if (wMonth)  { while (wMonth.options.length  > 1) wMonth.remove(1); }
    initial.sectors.forEach(s => wSector?.add(new Option(s, s)));
    initial.months.forEach(m => wMonth?.add(new Option(m, m)));

    document.getElementById('update-time').textContent =
        'Atualizado: ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    tableSort = { col: -1, dir: 1 };
    renderDashboard(rows);

    document.getElementById('upload-screen').classList.add('hidden');
    document.getElementById('dashboard-screen').classList.remove('hidden');
}

// ─── Filters (intervalo de meses + setor) ─────────────────────────────────────
function applyFilters() {
    const from = document.getElementById('filter-from').value;
    const to   = document.getElementById('filter-to').value;
    const sector = document.getElementById('filter-sector').value;
    let filtered = allData;

    if ((from || to) && cols.date >= 0) {
        const lo = from ? monthOrder(from) : -Infinity;
        const hi = to   ? monthOrder(to)   :  Infinity;
        filtered = filtered.filter(row => {
            const d = parseDate(row[cols.date]); if (!d) return false;
            const mo = monthOrder(monthLabel(d));
            return mo >= lo && mo <= hi;
        });
    }
    if (sector && cols.dept >= 0) filtered = filtered.filter(row => String(row[cols.dept] ?? '').trim() === sector);
    renderDashboard(filtered);
}

// drill-down: clicar num setor preenche o filtro e re-renderiza
function drillToSector(name) {
    const sel = document.getElementById('filter-sector');
    if (!sel) return;
    sel.value = name;
    if (sel.value !== name) return;   // setor não existe no select
    applyFilters();
    showToast(`Filtrado por setor: ${name}`, 'info');
}

// ─── File parsing ─────────────────────────────────────────────────────────────
function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const wb  = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: false });
            const ws  = wb.Sheets[wb.SheetNames[0]];
            const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            if (raw.length < 2) { showToast('Planilha sem dados suficientes.', 'error'); return; }
            const headers = raw[0].map(h => String(h));
            const rows    = raw.slice(1).filter(r => r.some(c => c !== '' && c != null));
            initDashboard(rows, headers);
            showToast(`${rows.length.toLocaleString('pt-BR')} registros carregados`, 'success');
        } catch (err) {
            console.error(err);
            showToast('Erro ao processar o arquivo. Verifique se é Excel ou CSV válido.', 'error');
        }
    };
    reader.readAsArrayBuffer(file);
}

// ─── Toasts ───────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
    const wrap = document.getElementById('toast-wrap');
    if (!wrap) return;
    const t = document.createElement('div');
    t.className = 'toast toast--' + type;
    t.textContent = msg;
    wrap.appendChild(t);
    requestAnimationFrame(() => t.classList.add('toast--in'));
    setTimeout(() => { t.classList.remove('toast--in'); setTimeout(() => t.remove(), 300); }, 3200);
}

// ─── Export ───────────────────────────────────────────────────────────────────
function exportExcel() {
    if (typeof XLSX === 'undefined' || !XLSX.utils) { showToast('Biblioteca de planilha indisponível.', 'error'); return; }
    const aoa = [allHeaders, ...lastRows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dados');
    XLSX.writeFile(wb, 'bunge-dashboard.xlsx');
    showToast('Planilha exportada', 'success');
}
async function exportImage(asPdf) {
    if (typeof html2canvas === 'undefined') { showToast('Biblioteca de imagem indisponível.', 'error'); return; }
    showToast('Gerando ' + (asPdf ? 'PDF' : 'imagem') + '…', 'info');
    const node = document.getElementById('dash-main');
    const canvas = await html2canvas(node, { backgroundColor: getComputedStyle(document.body).backgroundColor || '#090915', scale: 2 });
    if (asPdf) {
        const jspdf = window.jspdf || window.jsPDF;
        const JsPDF = jspdf?.jsPDF || jspdf;
        if (!JsPDF) { showToast('Biblioteca de PDF indisponível.', 'error'); return; }
        const img = canvas.toDataURL('image/png');
        const pdf = new JsPDF({ orientation: 'p', unit: 'pt', format: 'a4' });
        const w = pdf.internal.pageSize.getWidth();
        const h = canvas.height * w / canvas.width;
        pdf.addImage(img, 'PNG', 0, 0, w, h);
        pdf.save('bunge-dashboard.pdf');
    } else {
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png'); a.download = 'bunge-dashboard.png'; a.click();
    }
    showToast((asPdf ? 'PDF' : 'Imagem') + ' exportado', 'success');
}

// ─── Visibilidade de blocos (painel Gráficos) ─────────────────────────────────
const CARD_OF = { dept:'card-dept', weekly:'card-weekly', trend:'card-trend', gauge:'card-gauge', pareto:'card-pareto', heatmap:'card-heatmap', types:'card-types', obs:'card-obs', stacked:'card-stacked', table:'card-table' };
const ROW_FULL = { dept:'row-dept', weekly:'row-weekly', trend:'row-trend', heatmap:'row-heatmap', stacked:'row-stacked', table:'row-table' };

function applyChartVisibility() {
    for (const key in CARD_OF) { const c = document.getElementById(CARD_OF[key]); if (c) c.style.display = VISIBLE[key] ? '' : 'none'; }
    for (const key in ROW_FULL) { const r = document.getElementById(ROW_FULL[key]); if (r) r.style.display = VISIBLE[key] ? '' : 'none'; }

    // linha medidor + pareto
    const gp = document.getElementById('row-gauge-pareto');
    if (gp) {
        const both = VISIBLE.gauge && VISIBLE.pareto, any = VISIBLE.gauge || VISIBLE.pareto;
        gp.style.display = any ? '' : 'none';
        gp.classList.toggle('chart-row--gauge-pareto', both);
        gp.classList.toggle('chart-row--full', !both);
    }
    // linha donut + obs
    const dobs = document.getElementById('row-donut-obs');
    if (dobs) {
        const both = VISIBLE.types && VISIBLE.obs, any = VISIBLE.types || VISIBLE.obs;
        dobs.style.display = any ? '' : 'none';
        dobs.classList.toggle('chart-row--donut-obs', both);
        dobs.classList.toggle('chart-row--full', !both);
    }
    document.querySelectorAll('#charts-toggle-list input[data-chart]').forEach(cb => { cb.checked = !!VISIBLE[cb.dataset.chart]; });
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function applySettings(rerender = false) {
    const root = document.documentElement;
    const acc = ACCENTS[SETTINGS.accent] || ACCENTS.blue;
    root.style.setProperty('--accent', acc.main);
    root.style.setProperty('--accent-soft', acc.soft);
    root.style.setProperty('--accent-glow', acc.glow);

    document.body.classList.toggle('light', SETTINGS.theme === 'light');
    document.body.classList.toggle('compact', SETTINGS.compact);
    document.body.classList.toggle('high-contrast', SETTINGS.contrast);

    document.querySelectorAll('#theme-seg .seg-btn').forEach(b => b.classList.toggle('seg-btn--active', b.dataset.theme === SETTINGS.theme));
    document.querySelectorAll('#accent-swatches .swatch').forEach(s => s.classList.toggle('swatch--active', s.dataset.accent === SETTINGS.accent));
    const topnSel = document.getElementById('set-topn'); if (topnSel) topnSel.value = String(SETTINGS.topN);
    const setChk = (id, v) => { const e = document.getElementById(id); if (e) e.checked = v; };
    setChk('set-colorblind', SETTINGS.colorblind);
    setChk('set-animations', SETTINGS.animations);
    setChk('set-compact', SETTINGS.compact);
    setChk('set-contrast', SETTINGS.contrast);

    if (rerender && lastRows.length) renderDashboard(lastRows);
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
    document.getElementById('nav-charts-btn')?.classList.remove('snav-btn--active');
    document.getElementById('nav-settings-btn')?.classList.remove('snav-btn--active');
    document.getElementById('nav-dashboard-btn')?.classList.add('snav-btn--active');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadPrefs();
    applySettings(false);
    applyChartVisibility();

    const fileInput = document.getElementById('file-input');
    const dropZone  = document.getElementById('drop-zone');
    const selectBtn = document.getElementById('select-btn');

    selectBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => { handleFile(e.target.files[0]); fileInput.value = ''; });
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', e => { if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over'); });
    dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

    document.getElementById('upload-new-btn').addEventListener('click', () => {
        document.getElementById('dashboard-screen').classList.add('hidden');
        document.getElementById('upload-screen').classList.remove('hidden');
    });

    // filtros
    document.getElementById('filter-from').addEventListener('change', applyFilters);
    document.getElementById('filter-to').addEventListener('change', applyFilters);
    document.getElementById('filter-sector').addEventListener('change', applyFilters);
    document.getElementById('clear-btn').addEventListener('click', () => {
        document.getElementById('filter-from').value = '';
        document.getElementById('filter-to').value = '';
        document.getElementById('filter-sector').value = '';
        renderDashboard(allData);
    });

    // tabela: busca
    document.getElementById('table-search').addEventListener('input', () => buildTable(lastRows));

    // obs + weekly
    const reObs = () => buildObsChart(document.getElementById('obs-sector').value, document.getElementById('obs-mode').value);
    document.getElementById('obs-sector')?.addEventListener('change', reObs);
    document.getElementById('obs-mode')?.addEventListener('change', reObs);
    const reWeekly = () => buildWeeklyChart(document.getElementById('weekly-sector').value, document.getElementById('weekly-month').value);
    document.getElementById('weekly-sector')?.addEventListener('change', reWeekly);
    document.getElementById('weekly-month')?.addEventListener('change', reWeekly);

    // navegação lateral
    document.getElementById('nav-dashboard-btn')?.addEventListener('click', closeModals);
    document.getElementById('nav-charts-btn')?.addEventListener('click', () => {
        closeModals(); document.getElementById('nav-dashboard-btn')?.classList.remove('snav-btn--active');
        document.getElementById('nav-charts-btn')?.classList.add('snav-btn--active'); openModal('charts-modal');
    });
    document.getElementById('nav-settings-btn')?.addEventListener('click', () => {
        closeModals(); document.getElementById('nav-dashboard-btn')?.classList.remove('snav-btn--active');
        document.getElementById('nav-settings-btn')?.classList.add('snav-btn--active'); openModal('settings-modal');
    });

    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModals));
    document.querySelectorAll('.modal-overlay').forEach(ov => ov.addEventListener('click', e => { if (e.target === ov) closeModals(); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });

    // export menu
    const exportBtn = document.getElementById('export-btn');
    const exportMenu = document.getElementById('export-menu');
    exportBtn.addEventListener('click', e => { e.stopPropagation(); exportMenu.classList.toggle('hidden'); });
    document.addEventListener('click', () => exportMenu.classList.add('hidden'));
    exportMenu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        exportMenu.classList.add('hidden');
        const k = b.dataset.export;
        if (k === 'excel') exportExcel();
        else if (k === 'png') exportImage(false);
        else if (k === 'pdf') exportImage(true);
    }));

    // painel Gráficos
    document.querySelectorAll('#charts-toggle-list input[data-chart]').forEach(cb => {
        cb.addEventListener('change', () => { VISIBLE[cb.dataset.chart] = cb.checked; applyChartVisibility(); savePrefs(); });
    });

    // painel Configurações
    document.querySelectorAll('#theme-seg .seg-btn').forEach(b => b.addEventListener('click', () => { SETTINGS.theme = b.dataset.theme; applySettings(true); savePrefs(); }));
    document.querySelectorAll('#accent-swatches .swatch').forEach(s => s.addEventListener('click', () => { SETTINGS.accent = s.dataset.accent; applySettings(true); savePrefs(); }));
    document.getElementById('set-topn')?.addEventListener('change', e => { SETTINGS.topN = parseInt(e.target.value, 10) || 0; applySettings(true); savePrefs(); });
    document.getElementById('set-colorblind')?.addEventListener('change', e => { SETTINGS.colorblind = e.target.checked; applySettings(true); savePrefs(); });
    document.getElementById('set-animations')?.addEventListener('change', e => { SETTINGS.animations = e.target.checked; applySettings(true); savePrefs(); });
    document.getElementById('set-compact')?.addEventListener('change', e => { SETTINGS.compact = e.target.checked; applySettings(false); savePrefs(); });
    document.getElementById('set-contrast')?.addEventListener('change', e => { SETTINGS.contrast = e.target.checked; applySettings(false); savePrefs(); });
    document.getElementById('set-reset')?.addEventListener('click', () => {
        SETTINGS = { ...DEFAULT_SETTINGS }; VISIBLE = { ...DEFAULT_VISIBLE };
        applySettings(true); applyChartVisibility(); savePrefs(); showToast('Padrões restaurados', 'success');
    });
});
