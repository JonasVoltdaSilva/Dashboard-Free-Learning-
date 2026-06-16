'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let allData = [];
let allHeaders = [];
let cols = { dept: -1, type: -1, obs: -1, date: -1, mode: -1, classified: -1 };
let charts = {};
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
const DEFAULT_VISIBLE  = { dept: true, weekly: true, obs: true, stacked: true, table: true };

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
    obs:  ['observou', 'quem observou', 'observador', 'responsavel', 'responsável', 'nome',
           'funcionario', 'funcionário', 'autor', 'registrado', 'reporter', 'observer',
           'colaborador', 'registrant', 'quem'],
    date: ['data', 'date', 'mes', 'mês', 'periodo', 'período', 'dt_', 'datahora'],
    classified: ['concluiu', 'classificac', 'classificado', 'classificacao', 'classificação', 'status', 'situacao', 'situação', 'pendente'],
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

// Word-boundary mode check: the keyword must appear at start OR after a non-letter
// (e.g. "J26 Observar" → "j26observar" — '6' before 'o' is a digit → matches ✓
//  "Segurança: Observar ou Comunique" → "segurancaobservar..." — 'a' before 'o' is a letter → no match ✓)
const isModeObservar  = v => /(?:^|[^a-z])observ/.test(v);
const isModeComunique = v => /(?:^|[^a-z])(comuniq|comunic)/.test(v);

// Sim/Não classification detection helpers
const isNaoValue = v => /^n[aã]o$/i.test(String(v).trim());
const isSimValue = v => /\bsim\b/i.test(String(v));

const MODE_HEADER_KW = ['titulo', 'title', 'assunto', 'subject', 'tipo_registro', 'categoria_tipo'];

function detectModeCol(headers, rows) {
    // 1. Try header name first ("Título" is the expected column name)
    const normH = headers.map(normalizeStr);
    for (const kw of MODE_HEADER_KW) {
        const i = normH.findIndex(h => h === kw || h.startsWith(kw));
        if (i !== -1) return i;
    }
    // 2. Fall back to value scanning — word-boundary regex handles both
    //    "J26 Observar" (digit prefix → match) and "Segurança: Observar ou..."
    //    (letter prefix → no match), so Tipo column is not accidentally chosen
    let bestIdx = -1, bestScore = 0;
    for (let i = 0; i < headers.length; i++) {
        let matches = 0;
        for (const r of rows) {
            const v = normalizeStr(String(r[i] ?? ''));
            if (isModeObservar(v) || isModeComunique(v)) matches++;
        }
        if (matches > bestScore) { bestScore = matches; bestIdx = i; }
    }
    return bestScore > 0 ? bestIdx : -1;
}

function detectClassifiedCol(headers, rows) {
    // 1. Try header keywords
    const normH = headers.map(normalizeStr);
    const classKw = KEYWORDS.classified.map(normalizeStr);
    for (const kw of classKw) {
        const i = normH.findIndex(h => h.includes(kw));
        if (i !== -1) return i;
    }
    // 2. Value scan: find column where most cells are "sim" or "não"
    let bestIdx = -1, bestScore = 0;
    for (let i = 0; i < headers.length; i++) {
        let matches = 0;
        for (const r of rows) {
            const v = String(r[i] ?? '').trim();
            if (isNaoValue(v) || isSimValue(v)) matches++;
        }
        if (matches > bestScore) { bestScore = matches; bestIdx = i; }
    }
    return bestScore > 0 ? bestIdx : -1;
}

// ─── Date parsing ─────────────────────────────────────────────────────────────
function parseDate(val) {
    if (val == null || val === '') return null;
    // SheetJS cellDates:true returns UTC-midnight Date objects; use UTC accessors
    // to avoid timezone shift (e.g. June 1 UTC = May 31 21:00 in BRT)
    if (val instanceof Date) {
        if (isNaN(val.getTime())) return null;
        return new Date(val.getUTCFullYear(), val.getUTCMonth(), val.getUTCDate());
    }
    if (typeof val === 'number' && val > 1000) {
        // Excel serial date; Math.floor strips time fraction from DateTime cells
        const base = new Date(1899, 11, 30);
        const d = new Date(base.getTime() + Math.floor(val) * 86400000);
        if (isNaN(d.getTime())) return null;
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
    const s = String(val).trim();
    // DD/MM/YYYY (Brazilian) — no $ so "DD/MM/YYYY HH:MM:SS" also matches
    let m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
    if (m) {
        const y = parseInt(m[3]); const mo = parseInt(m[2]) - 1; const d = parseInt(m[1]);
        return new Date(y < 100 ? 2000 + y : y, mo, d);
    }
    // YYYY-MM-DD (ISO)
    m = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
    if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    // Avoid new Date(s) fallback — misinterprets DD/MM/YYYY as MM/DD/YYYY in en-US locales
    return null;
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
    let comunique = 0, observar = 0, outros = 0, unclassified = 0;

    for (const row of rows) {
        const dept = cols.dept >= 0 ? String(row[cols.dept] ?? '').trim() : '';
        const type = cols.type >= 0 ? String(row[cols.type] ?? '').trim() : '';
        const obs  = cols.obs  >= 0 ? String(row[cols.obs]  ?? '').trim() : '';
        const date = parseDate(cols.date >= 0 ? row[cols.date] : null);

        if (dept) { deptCnt[dept] = (deptCnt[dept] || 0) + 1; sectorSet.add(dept); }
        if (type) { typeCnt[type] = (typeCnt[type] || 0) + 1; }
        if (cols.classified >= 0) {
            const cls = String(row[cols.classified] ?? '').trim();
            if (isNaoValue(cls)) unclassified++;
        } else if (cols.type >= 0 && !type) {
            unclassified++;
        }
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
            if (isModeComunique(md)) comunique++;
            else if (isModeObservar(md)) observar++;
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
        unclassified,
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
function renderKpi(id, value) {
    animateValue(document.getElementById('kpi-' + id), value);
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

// ─── Top Observers ────────────────────────────────────────────────────────────

function mergePartialNames(cnt) {
    const norm = s => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
    const isPrefix = (short, long) => short.length >= 3 && (long === short || long.startsWith(short + ' '));
    const entries = Object.entries(cnt).sort((a, b) => norm(b[0]).length - norm(a[0]).length);
    const canonicals = [];
    for (const [name, count] of entries) {
        const n = norm(name);
        const match = canonicals.find(c => isPrefix(n, c.norm) || isPrefix(c.norm, n));
        if (match) {
            match.count += count;
            if (n.length > match.norm.length) { match.name = name; match.norm = n; }
        } else {
            canonicals.push({ norm: n, name, count });
        }
    }
    const result = {};
    for (const c of canonicals) result[c.name] = c.count;
    return result;
}
function buildObsChart(sectorFilter, modeFilter, monthFilter) {
    let rows = lastRows.length ? lastRows : allData;
    if (monthFilter && cols.date >= 0) rows = rows.filter(r => { const d = parseDate(r[cols.date]); return d && monthLabel(d) === monthFilter; });
    if (sectorFilter && cols.dept >= 0) rows = rows.filter(r => String(r[cols.dept] ?? '').trim() === sectorFilter);
    if (modeFilter && cols.mode >= 0) {
        const mf = normalizeStr(modeFilter);
        rows = rows.filter(r => {
            const v = normalizeStr(String(r[cols.mode] ?? ''));
            if (isModeComunique(mf)) return isModeComunique(v);
            if (isModeObservar(mf))  return isModeObservar(v);
            return false;
        });
    }

    const rawCnt = {};
    for (const row of rows) { const obs = cols.obs >= 0 ? String(row[cols.obs] ?? '').trim() : ''; if (obs) rawCnt[obs] = (rawCnt[obs] || 0) + 1; }
    const obsCnt = mergePartialNames(rawCnt);

    const BAR_ROW = 38;
    const isDPA   = sectorFilter && normalizeStr(sectorFilter).includes('dpa');
    let labels, data, colors, zeroNames, VISIBLE;

    if (isDPA && cols.obs >= 0) {
        // Show all 29 DPA team members; grey out those with 0 records
        const dpaEntries = DPA_TEAM.map(m => {
            const count = Object.entries(obsCnt)
                .filter(([name]) => matchesDpaMember(normalizeStr(name), m))
                .reduce((sum, [, cnt]) => sum + cnt, 0);
            return { display: m.display, count };
        }).sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));

        labels    = dpaEntries.map(e => e.display);
        data      = dpaEntries.map(e => e.count);
        zeroNames = new Set(dpaEntries.filter(e => e.count === 0).map(e => e.display));
        let ci = 0;
        colors  = dpaEntries.map(e => e.count > 0 ? gc(ci++) : 'rgba(71,85,105,0.35)');
        VISIBLE = dpaEntries.length;

        const active = dpaEntries.filter(e => e.count > 0).length;
        const sub = document.querySelector('#card-obs .chart-subtitle');
        if (sub) sub.textContent = `${active} de ${DPA_TEAM.length} colaboradores com registros`;
    } else {
        const all = Object.entries(obsCnt).sort((a, b) => b[1] - a[1]);
        labels    = all.map(([k]) => k.length > 30 ? k.slice(0, 30) + '…' : k);
        data      = all.map(([, v]) => v);
        colors    = data.map((_, i) => gc(i));
        zeroNames = new Set();
        VISIBLE   = 10;
        const total = all.length;
        const sub = document.querySelector('#card-obs .chart-subtitle');
        if (sub) sub.textContent = total > VISIBLE
            ? `Top ${VISIBLE} visíveis de ${total} — role para ver mais`
            : `${total} observador${total !== 1 ? 'es' : ''}`;
    }

    destroyChart('obs');
    const canvas = document.getElementById('obs-chart');
    const wrap   = document.getElementById('obs-chart-wrap');
    const inner  = document.getElementById('obs-chart-inner');

    if (labels.length === 0) {
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

    const canvasH = labels.length * BAR_ROW + 24;
    const wrapH   = Math.min(labels.length, VISIBLE) * BAR_ROW + 24;
    inner.style.display = 'block';
    inner.style.height  = canvasH + 'px';
    wrap.style.height   = wrapH + 'px';

    canvas.style.width = '';
    canvas.style.height = '';
    void inner.offsetHeight;

    charts.obs = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 5,
                                     borderSkipped: 'left', maxBarThickness: BAR_ROW - 10 }] },
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: anim(),
            plugins: { legend: { display: false }, tooltip: { ...TOOLTIP_OPTS } },
            scales: {
                x: { ...SCALE_OPTS.x, ticks: { ...SCALE_OPTS.x.ticks, maxTicksLimit: 6 } },
                y: { grid: { color: 'transparent' }, border: { color: 'transparent' },
                     ticks: { color: ctx => zeroNames.has(ctx.tick.label) ? 'rgba(100,116,139,0.45)' : '#e2e8f0',
                              font: { size: 12, weight: '500' }, padding: 8 } },
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
        weekKeyFn  = d => `Semana ${Math.min(Math.ceil(d.getDate() / 7), 4)}`;
        orderWeeks = p => ['Semana 1','Semana 2','Semana 3','Semana 4'].filter(k => p.has(k));
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
        if (isModeComunique(mode)) counts[wk].comunique++;
        else if (isModeObservar(mode)) counts[wk].observar++;
        else counts[wk].outros++;
    }

    const labels = orderWeeks(present);
    if (labels.length === 0) { destroyChart('weekly'); canvas.style.display = 'none'; empty.style.display = 'flex'; return; }
    canvas.style.display = 'block'; empty.style.display = 'none';

    // Update subtitle with real matched-record totals so user can cross-check with spreadsheet
    const wSub = document.querySelector('#card-weekly .chart-subtitle');
    if (wSub && month) {
        const totC = rows.filter(r => cols.mode >= 0 && isModeComunique(normalizeStr(String(r[cols.mode] ?? '')))).length;
        const totO = rows.filter(r => cols.mode >= 0 && isModeObservar(normalizeStr(String(r[cols.mode] ?? '')))).length;
        wSub.textContent = `${rows.length} registros — ${totC} Comunique / ${totO} Observar`;
    }

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

function formatDateCell(val) {
    if (!val) return '—';
    const d = parseDate(val);
    return d ? d.toLocaleDateString('pt-BR') : escapeHtml(String(val));
}

// ─── Classificação Pendente ───────────────────────────────────────────────────
function isPendingRow(row) {
    if (cols.classified >= 0) {
        const cls = String(row[cols.classified] ?? '').trim();
        return isNaoValue(cls);
    }
    return cols.type >= 0 && !String(row[cols.type] ?? '').trim();
}

function buildPendingTable(rows) {
    const colHeaders = [], colFns = [], colCls = [];
    if (cols.date >= 0) { colHeaders.push('Data');       colFns.push(r => formatDateCell(r[cols.date]));              colCls.push('col-date'); }
    if (cols.obs  >= 0) { colHeaders.push('Observador'); colFns.push(r => escapeHtml(String(r[cols.obs]  ?? '')));   colCls.push('col-obs');  }
    if (cols.mode >= 0) { colHeaders.push('Título');     colFns.push(r => escapeHtml(String(r[cols.mode] ?? '')));   colCls.push('col-mode'); }
    if (!colHeaders.length) return '<p class="pending-placeholder">Nenhuma coluna adicional disponível.</p>';
    return `<div class="pending-table-scroll">
        <table class="pending-table">
            <colgroup>${colCls.map(c => `<col class="${c}">`).join('')}</colgroup>
            <thead><tr>${colHeaders.map((h, i) => `<th class="${colCls[i]}">${h}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(row => `<tr>${colFns.map((fn, i) => `<td class="${colCls[i]}">${fn(row)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
    </div>`;
}

function buildPendingPanel(rows, sectorFilter) {
    const rowEl = document.getElementById('row-pending');
    if (!rowEl) return;

    if (cols.classified < 0 && cols.type < 0) { rowEl.classList.add('hidden'); return; }
    rowEl.classList.remove('hidden');

    const allPending = rows.filter(isPendingRow);
    const subtitle = document.getElementById('pending-subtitle');
    const body = document.getElementById('pending-body');
    if (!body) return;

    // Group by sector across ALL pending rows (for select population and counts)
    const bySector = {};
    for (const row of allPending) {
        const dept = cols.dept >= 0 ? (String(row[cols.dept] ?? '').trim() || '(sem setor)') : '(sem setor)';
        if (!bySector[dept]) bySector[dept] = [];
        bySector[dept].push(row);
    }

    // No sector selected → placeholder
    if (!sectorFilter) {
        const n = allPending.length, s = Object.keys(bySector).length;
        if (subtitle) subtitle.textContent = n > 0
            ? `${n} registro${n !== 1 ? 's' : ''} pendente${n !== 1 ? 's' : ''} — selecione um setor para ver detalhes`
            : 'Selecione um setor para ver os registros pendentes';
        body.innerHTML = allPending.length === 0
            ? `<div class="pending-ok"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Você concluiu as classificações de incidente de risco</div>`
            : `<div class="pending-placeholder">Selecione um setor no filtro acima para ver os registros pendentes de classificação.</div>`;
        return;
    }

    // All sectors → grouped view
    if (sectorFilter === 'ALL') {
        if (allPending.length === 0) {
            if (subtitle) subtitle.textContent = 'Todos os registros estão classificados';
            body.innerHTML = '<div class="pending-ok"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Você concluiu as classificações de incidente de risco</div>';
            return;
        }
        const sectorEntries = Object.entries(bySector).sort((a, b) => b[1].length - a[1].length);
        const n = allPending.length, s = sectorEntries.length;
        if (subtitle) subtitle.textContent = `${n} registro${n !== 1 ? 's' : ''} pendente${n !== 1 ? 's' : ''} em ${s} setor${s !== 1 ? 'es' : ''}`;
        body.innerHTML = `<div class="pending-all-view">${sectorEntries.map(([sName, sRows]) => `
            <div class="pending-sector-group">
                <div class="pending-sector-header">
                    <span class="pending-group-name">${escapeHtml(sName)}</span>
                    <span class="pending-sector-count">${sRows.length} pendente${sRows.length !== 1 ? 's' : ''}</span>
                </div>
                ${buildPendingTable(sRows)}
            </div>`).join('')}
        </div>`;
        return;
    }

    // Specific sector
    const sectorRows = bySector[sectorFilter] || [];
    if (sectorRows.length === 0) {
        if (subtitle) subtitle.textContent = `Setor ${sectorFilter} — nenhuma classificação pendente`;
        body.innerHTML = '<div class="pending-ok"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Você concluiu as classificações de incidente de risco</div>';
        return;
    }
    const n = sectorRows.length;
    if (subtitle) subtitle.textContent = `${escapeHtml(sectorFilter)} — ${n} registro${n !== 1 ? 's' : ''} pendente${n !== 1 ? 's' : ''} de classificação`;
    body.innerHTML = buildPendingTable(sectorRows);
}

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

// ─── Equipe DPA ───────────────────────────────────────────────────────────────
// Casamento por PRIMEIRO NOME: se o primeiro nome do colaborador for a 1ª
// palavra do nome na planilha → entra. Os sobrenomes (surnames) servem só de
// desempate quando dois colaboradores compartilham o mesmo primeiro nome.
const DPA_TEAM = [
    { display: 'Adeir Junior',       first: 'adeir',     surnames: ['junior', 'aragao', 'nicacio'] },
    { display: 'Alexandre Souza',    first: 'alexandre', surnames: ['silva', 'souza'] },
    { display: 'Andrey Amorim',      first: 'andrey',    surnames: ['amorim'] },
    { display: 'Bruno dos Anjos',    first: 'bruno',     surnames: ['anjos', 'ferreira'] },
    { display: 'Carlos Henrique',    first: 'carlos',    surnames: ['henrique', 'ribeiro'] },
    { display: 'Danilo Rodrigues',   first: 'danilo',    surnames: ['rodrigues'] },
    { display: 'David Menezes',      first: 'david',     surnames: ['menezes', 'souza'] },
    { display: 'Diogenes Soares',    first: 'diogenes',  surnames: ['almeida', 'soares'] },
    { display: 'Edson Galvão',       first: 'edson',     surnames: ['lopes', 'galvao'] },
    { display: 'Fabiana Gomes',      first: 'fabiana',   surnames: ['gomes'] },
    { display: 'Fabricio Castro',    first: 'fabricio',  surnames: ['gomes', 'castro'] },
    { display: 'Heitor Brito',       first: 'heitor',    surnames: ['brito', 'santos'] },
    { display: 'Hercules Oliveira',  first: 'hercules',  surnames: ['oliveira'] },
    { display: 'Jhonny Rodrigues',   first: 'jhonny',    surnames: ['deividy', 'rodrigues'] },
    { display: 'Joacir Miranda',     first: 'joacir',    surnames: ['miranda'] },
    { display: 'Jose Natalino',      first: 'jose',      alt: ['natalino'], surnames: ['natalino'] },
    { display: 'Jucimar Lima',       first: 'jucimar',   surnames: ['lima', 'souza'] },
    { display: 'Kauan Racis',        first: 'kauan',     surnames: ['racis'] },
    { display: 'Leonardo Teixeira',  first: 'leonardo',  surnames: ['santana', 'teixeira'] },
    { display: 'Luis Carlos Bomfim', first: 'luis',      surnames: ['bomfim'] },
    { display: 'Maicon Cavalcante',  first: 'maicon',    surnames: ['cavalcante'] },
    { display: 'Marcos Antonio',     first: 'marcos',    surnames: ['antonio'] },
    { display: 'Mesaque Lima',       first: 'mesaque',   surnames: ['lima'] },
    { display: 'Renan Franco',       first: 'renan',     surnames: ['franco'] },
    { display: 'Reginaldo Salvador', first: 'reginaldo', surnames: ['salvador'] },
    { display: 'Renato Novaes',      first: 'renato',    surnames: ['novaes'] },
    { display: 'Rogerio Oliveira',   first: 'rogerio',   surnames: ['bruno', 'oliveira'] },
    { display: 'Thalles Furmigone',  first: 'thalles',   surnames: ['furmigone'] },
    { display: 'Wilson Deiro',       first: 'wilson',    surnames: ['deiro'] },
];

// normaliza preservando espaços, p/ separar em palavras
function nameWords(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function matchesDpaMember(name, member) {
    const words = nameWords(name);
    if (!words.length) return false;
    const keys = [member.first, ...(member.alt || [])];
    // 1) qualquer chave é a 1ª palavra → entra (ex: "Natalino Jose" ou "Jose Natalino")
    if (keys.some(k => words[0] === k)) return true;
    // 2) qualquer chave aparece em qualquer posição + algum sobrenome bate → entra
    if (keys.some(k => words.includes(k)) && member.surnames.some(s => words.includes(s))) return true;
    return false;
}

// ─── Render dashboard ─────────────────────────────────────────────────────────
function renderDashboard(rows) {
    lastRows = rows;
    const d = aggregate(rows);
    cachedProcessed = d;

    renderKpi('total', d.total);
    renderKpi('depts', d.totalDepts);
    renderKpi('obs',   d.totalObs);
    renderKpi('types', d.totalTypes);
    renderKpi('unclassified', d.unclassified);

    buildPendingPanel(rows, document.getElementById('pending-sector')?.value || '');
    buildDeptChart(d.deptCnt);
    buildStackedChart(d.typeByDept, d.typeCnt);
    buildTable(rows);

    const obsSec  = document.getElementById('obs-sector')?.value  || '';
    const obsMode = document.getElementById('obs-mode')?.value    || '';
    const obsMon  = document.getElementById('obs-month')?.value   || '';
    buildObsChart(obsSec, obsMode, obsMon);

    const wSec = document.getElementById('weekly-sector')?.value || '';
    const wMon = document.getElementById('weekly-month')?.value  || '';
    buildWeeklyChart(wSec, wMon);
}

// ─── Init from file ────────────────────────────────────────────────────────────
function initDashboard(rows, headers) {
    cols.dept       = detectCol(headers, KEYWORDS.dept);
    cols.type       = detectCol(headers, KEYWORDS.type);
    cols.obs        = detectCol(headers, KEYWORDS.obs);
    cols.date       = detectCol(headers, KEYWORDS.date);
    cols.mode       = detectModeCol(headers, rows);
    cols.classified = detectClassifiedCol(headers, rows);

    allData = rows; allHeaders = headers;
    const initial = aggregate(rows);

    const fSector = document.getElementById('filter-sector');
    while (fSector.options.length > 1) fSector.remove(1);
    initial.sectors.forEach(s => fSector.add(new Option(s, s)));

    const obsSec = document.getElementById('obs-sector');
    if (obsSec) { while (obsSec.options.length > 1) obsSec.remove(1); initial.sectors.forEach(s => obsSec.add(new Option(s, s))); }
    const obsMon = document.getElementById('obs-month');
    if (obsMon) { while (obsMon.options.length > 1) obsMon.remove(1); initial.months.forEach(m => obsMon.add(new Option(m, m))); }

    const wSector = document.getElementById('weekly-sector');
    const wMonth  = document.getElementById('weekly-month');
    if (wSector) { while (wSector.options.length > 1) wSector.remove(1); }
    if (wMonth)  { while (wMonth.options.length  > 1) wMonth.remove(1); }
    initial.sectors.forEach(s => wSector?.add(new Option(s, s)));
    initial.months.forEach(m => wMonth?.add(new Option(m, m)));

    const pendingSec = document.getElementById('pending-sector');
    if (pendingSec) {
        while (pendingSec.options.length > 2) pendingSec.remove(2);
        pendingSec.value = '';
        initial.sectors.forEach(s => pendingSec.add(new Option(s, s)));
    }

    document.getElementById('update-time').textContent =
        'Atualizado: ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    tableSort = { col: -1, dir: 1 };
    renderDashboard(rows);

    document.getElementById('upload-screen').classList.add('hidden');
    document.getElementById('dashboard-screen').classList.remove('hidden');
}

// ─── Filters (setor) ──────────────────────────────────────────────────────────
function applyFilters() {
    const sector = document.getElementById('filter-sector').value;
    let filtered = allData;
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
            // cellDates:true → date cells come back as UTC-midnight JS Date objects
            // (handled by parseDate's instanceof Date branch using getUTC* methods)
            const wb  = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
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
    const bgColor = document.body.classList.contains('light') ? '#f0f4fb' : '#060614';
    const canvas = await html2canvas(node, {
        backgroundColor: bgColor,
        scale: 2,
        useCORS: true,
        allowTaint: false,
        logging: false,
        windowWidth: node.scrollWidth,
        windowHeight: node.scrollHeight,
    });
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
const CARD_OF = { dept:'card-dept', weekly:'card-weekly', obs:'card-obs', stacked:'card-stacked', table:'card-table' };
const ROW_FULL = { dept:'row-dept', weekly:'row-weekly', obs:'row-obs', stacked:'row-stacked', table:'row-table' };

function applyChartVisibility() {
    for (const key in CARD_OF) { const c = document.getElementById(CARD_OF[key]); if (c) c.style.display = VISIBLE[key] ? '' : 'none'; }
    for (const key in ROW_FULL) { const r = document.getElementById(ROW_FULL[key]); if (r) r.style.display = VISIBLE[key] ? '' : 'none'; }
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
    document.getElementById('filter-sector').addEventListener('change', applyFilters);
    document.getElementById('pending-sector')?.addEventListener('change', () =>
        buildPendingPanel(lastRows, document.getElementById('pending-sector').value));
    document.getElementById('clear-btn').addEventListener('click', () => {
        document.getElementById('filter-sector').value = '';
        renderDashboard(allData);
    });

    // tabela: busca
    document.getElementById('table-search').addEventListener('input', () => buildTable(lastRows));

    // obs + weekly
    const reObs = () => buildObsChart(
        document.getElementById('obs-sector').value,
        document.getElementById('obs-mode').value,
        document.getElementById('obs-month').value
    );
    document.getElementById('obs-sector')?.addEventListener('change', reObs);
    document.getElementById('obs-mode')?.addEventListener('change', reObs);
    document.getElementById('obs-month')?.addEventListener('change', reObs);
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
