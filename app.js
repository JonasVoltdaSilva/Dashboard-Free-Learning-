'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let allData = [];
let cols = { dept: -1, type: -1, obs: -1, date: -1, mode: -1 };
let charts = {};
let cachedProcessed = null;
let lastRows = [];

// ─── Settings (persistidas em localStorage) ────────────────────────────────────
const ACCENTS = {
    blue:   { main: '#3b82f6', soft: 'rgba(59,130,246,0.22)', glow: 'rgba(37,99,235,0.25)' },
    green:  { main: '#10b981', soft: 'rgba(16,185,129,0.22)', glow: 'rgba(16,185,129,0.25)' },
    purple: { main: '#8b5cf6', soft: 'rgba(139,92,246,0.22)', glow: 'rgba(124,58,237,0.25)' },
    amber:  { main: '#f59e0b', soft: 'rgba(245,158,11,0.22)', glow: 'rgba(245,158,11,0.25)' },
};
const DEFAULT_SETTINGS = { accent: 'blue', topN: 20, animations: true, compact: false, contrast: false };
const DEFAULT_VISIBLE  = { dept: true, weekly: true, trend: true, types: true, obs: true, stacked: true };

let SETTINGS = { ...DEFAULT_SETTINGS };
let VISIBLE  = { ...DEFAULT_VISIBLE };

function loadPrefs() {
    try {
        const s = JSON.parse(localStorage.getItem('bunge_settings') || '{}');
        SETTINGS = { ...DEFAULT_SETTINGS, ...s };
    } catch { SETTINGS = { ...DEFAULT_SETTINGS }; }
    try {
        const v = JSON.parse(localStorage.getItem('bunge_visible') || '{}');
        VISIBLE = { ...DEFAULT_VISIBLE, ...v };
    } catch { VISIBLE = { ...DEFAULT_VISIBLE }; }
}
function savePrefs() {
    localStorage.setItem('bunge_settings', JSON.stringify(SETTINGS));
    localStorage.setItem('bunge_visible', JSON.stringify(VISIBLE));
}

// animation helper para os gráficos (respeita a configuração)
const anim = () => (SETTINGS.animations ? { duration: 700 } : false);
// quantos itens nos rankings (0 = todos)
const topCount = arr => (SETTINGS.topN > 0 ? arr.slice(0, SETTINGS.topN) : arr);

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

// Detecta coluna Observar/Comunique pelos valores (não pelo nome).
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
function monthLabel(d) { return `${MONTHS_SHORT[d.getMonth()]}/${d.getFullYear()}`; }

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

    for (const row of rows) {
        const dept = cols.dept >= 0 ? String(row[cols.dept] ?? '').trim() : '';
        const type = cols.type >= 0 ? String(row[cols.type] ?? '').trim() : '';
        const obs  = cols.obs  >= 0 ? String(row[cols.obs]  ?? '').trim() : '';
        const raw  = cols.date >= 0 ? row[cols.date] : null;
        const date = parseDate(raw);

        if (dept) { deptCnt[dept] = (deptCnt[dept] || 0) + 1; sectorSet.add(dept); }
        if (type) { typeCnt[type] = (typeCnt[type] || 0) + 1; }
        if (obs)  { obsCnt[obs]   = (obsCnt[obs]   || 0) + 1; }
        if (date) { const ml = monthLabel(date); monthKeys.add(ml); monthCnt[ml] = (monthCnt[ml] || 0) + 1; }
        if (dept && type) {
            if (!typeByDept[dept]) typeByDept[dept] = {};
            typeByDept[dept][type] = (typeByDept[dept][type] || 0) + 1;
        }
    }

    const sortedMonths = [...monthKeys].sort((a, b) => {
        const parse = s => { const [m, y] = s.split('/'); return parseInt(y) * 100 + MONTHS_SHORT.indexOf(m); };
        return parse(a) - parse(b);
    });

    return {
        deptCnt, typeCnt, obsCnt, typeByDept, monthCnt,
        months: sortedMonths,
        sectors: [...sectorSet].sort(),
        total: rows.length,
        totalDepts: Object.keys(deptCnt).length,
        totalObs: Object.keys(obsCnt).length,
        totalTypes: Object.keys(typeCnt).length,
    };
}

// ─── Chart defaults ───────────────────────────────────────────────────────────
const PALETTE = [
    '#60a5fa','#a855f7','#2dd4bf','#4ade80','#818cf8',
    '#34d399','#93c5fd','#c084fc','#5eead4','#86efac',
    '#38bdf8','#a78bfa','#6ee7b7','#67e8f9','#d8b4fe',
    '#f472b6','#fb923c','#facc15','#e879f9','#22d3ee',
];
const gc = i => PALETTE[i % PALETTE.length];

// Arco-íris para departamento
const RAINBOW = [
    '#ef4444','#f97316','#eab308','#22c55e','#3b82f6',
    '#6366f1','#a855f7','#ec4899','#06b6d4','#84cc16',
    '#f59e0b','#10b981','#8b5cf6','#14b8a6','#f43f5e',
    '#0ea5e9',
];
const gcRainbow = i => RAINBOW[i % RAINBOW.length];

const GRID_COLOR = 'rgba(255,255,255,0.05)';
const TOOLTIP_OPTS = {
    backgroundColor: '#0d0d24',
    titleColor: '#f8fafc',
    bodyColor: '#94a3b8',
    borderColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8,
};
const SCALE_OPTS = {
    x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: GRID_COLOR }, border: { color: GRID_COLOR } },
    y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: GRID_COLOR }, border: { color: GRID_COLOR }, beginAtZero: true },
};

Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.font.size = 11;

// Plugin: texto central no donut
Chart.register({
    id: 'doughnutCenter',
    afterDraw(chart) {
        if (chart.config.type !== 'doughnut') return;
        const { ctx, chartArea } = chart;
        if (!chartArea) return;
        const cx = (chartArea.left + chartArea.right) / 2;
        const cy = (chartArea.top + chartArea.bottom) / 2;
        const total = (chart.data.datasets[0]?.data || []).reduce((a, b) => a + b, 0);
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '700 28px Inter, sans-serif';
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(total.toLocaleString('pt-BR'), cx, cy - 10);
        ctx.font = '400 11px Inter, sans-serif';
        ctx.fillStyle = '#64748b';
        ctx.fillText('registros', cx, cy + 14);
        ctx.restore();
    },
});

function destroyChart(key) { if (charts[key]) { charts[key].destroy(); charts[key] = null; } }

// ─── Dept Bar Chart ───────────────────────────────────────────────────────────
function buildDeptChart(deptCnt) {
    const sorted = topCount(Object.entries(deptCnt).sort((a,b) => b[1]-a[1]));
    const labels = sorted.map(([k]) => k.length > 18 ? k.slice(0,18)+'…' : k);
    const data   = sorted.map(([,v]) => v);
    const colors = data.map((_,i) => gcRainbow(i));

    destroyChart('dept');
    const ctx = document.getElementById('dept-chart').getContext('2d');
    charts.dept = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 6, borderSkipped: false, borderWidth: 0 }] },
        options: {
            responsive: true, maintainAspectRatio: false, animation: anim(),
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
    const colors = ['#60a5fa','#a855f7','#2dd4bf','#4ade80','#818cf8','#f472b6','#fb923c','#facc15','#34d399','#67e8f9'];
    const total  = data.reduce((a,b) => a+b, 0);

    destroyChart('types');
    const ctx = document.getElementById('types-chart').getContext('2d');
    charts.types = new Chart(ctx, {
        type: 'doughnut',
        data: { labels, datasets: [{
            data,
            backgroundColor: colors.slice(0, data.length),
            borderColor: 'rgba(255,255,255,0.15)',
            borderWidth: 2,
            hoverOffset: 12,
            spacing: 3,
            borderRadius: 6,
        }]},
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '68%', animation: anim(),
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#e2e8f0',
                        padding: 16,
                        font: { size: 11, weight: '500' },
                        usePointStyle: true,
                        pointStyle: 'circle',
                        boxWidth: 8,
                        boxHeight: 8,
                        generateLabels: chart => chart.data.labels.map((label, i) => {
                            const val = chart.data.datasets[0].data[i];
                            const pct = total > 0 ? Math.round(val / total * 100) : 0;
                            const short = label.length > 20 ? label.slice(0,20)+'…' : label;
                            return {
                                text: `${short}  ${pct}%`,
                                fillStyle: chart.data.datasets[0].backgroundColor[i],
                                strokeStyle: chart.data.datasets[0].backgroundColor[i],
                                fontColor: '#e2e8f0',
                                color: '#e2e8f0',
                                pointStyle: 'circle',
                                lineWidth: 0, hidden: false, index: i,
                            };
                        }),
                    },
                },
                tooltip: {
                    ...TOOLTIP_OPTS,
                    callbacks: { label: ctx2 => {
                        const pct = total > 0 ? Math.round(ctx2.parsed / total * 100) : 0;
                        return ` ${ctx2.label}: ${ctx2.parsed.toLocaleString('pt-BR')} (${pct}%)`;
                    }},
                },
            },
        },
    });
}

// ─── Trend Line Chart (tendência mensal) ──────────────────────────────────────
function buildTrendChart(months, monthCnt) {
    const empty  = document.getElementById('trend-empty');
    const canvas = document.getElementById('trend-chart');
    destroyChart('trend');

    if (!months || months.length === 0) {
        canvas.style.display = 'none';
        empty.style.display  = 'flex';
        return;
    }
    canvas.style.display = 'block';
    empty.style.display  = 'none';

    const data = months.map(m => monthCnt[m] || 0);
    const accent = ACCENTS[SETTINGS.accent]?.main || '#3b82f6';

    const ctx = canvas.getContext('2d');
    charts.trend = new Chart(ctx, {
        type: 'line',
        data: { labels: months, datasets: [{
            label: 'Ocorrências',
            data,
            borderColor: accent,
            backgroundColor: ctx2 => {
                const { chartArea, ctx: c } = ctx2.chart;
                if (!chartArea) return 'rgba(59,130,246,0.12)';
                const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                g.addColorStop(0, accent + '55');
                g.addColorStop(1, accent + '05');
                return g;
            },
            fill: true,
            tension: 0.35,
            borderWidth: 2.5,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: accent,
            pointBorderColor: '#0b0b1f',
            pointBorderWidth: 2,
        }]},
        options: {
            responsive: true, maintainAspectRatio: false, animation: anim(),
            plugins: {
                legend: { display: false },
                tooltip: { ...TOOLTIP_OPTS, callbacks: { label: c => ` ${c.parsed.y.toLocaleString('pt-BR')} ocorrências` } },
            },
            scales: { x: { ...SCALE_OPTS.x }, y: { ...SCALE_OPTS.y } },
        },
    });
}

// ─── Top Observers (todos, scroll, filtros setor + modo) ──────────────────────
function buildObsChart(sectorFilter, modeFilter) {
    let rows = allData;

    if (sectorFilter && cols.dept >= 0) {
        rows = rows.filter(r => String(r[cols.dept] ?? '').trim() === sectorFilter);
    }
    if (modeFilter && cols.mode >= 0) {
        const mf = normalizeStr(modeFilter);
        rows = rows.filter(r => normalizeStr(String(r[cols.mode] ?? '')) === mf);
    }

    const obsCnt = {};
    for (const row of rows) {
        const obs = cols.obs >= 0 ? String(row[cols.obs] ?? '').trim() : '';
        if (obs) obsCnt[obs] = (obsCnt[obs] || 0) + 1;
    }

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
            msg.textContent = cols.obs < 0
                ? 'Coluna de observadores não detectada na planilha'
                : 'Nenhum observador encontrado para os filtros selecionados';
            wrap.appendChild(msg);
        }
        return;
    }
    wrap.querySelector('.obs-empty')?.remove();
    inner.style.display = 'block';

    const barHeight = 36;
    inner.style.height = Math.max(sorted.length * barHeight + 24, 80) + 'px';

    const ctx = canvas.getContext('2d');
    charts.obs = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 5, borderSkipped: 'left', borderWidth: 0 }] },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            animation: anim(),
            plugins: { legend: { display: false }, tooltip: { ...TOOLTIP_OPTS } },
            scales: {
                x: { ...SCALE_OPTS.x, ticks: { ...SCALE_OPTS.x.ticks, maxTicksLimit: 6 } },
                y: {
                    grid: { color: 'transparent' },
                    border: { color: 'transparent' },
                    ticks: { color: '#e2e8f0', font: { size: 12, weight: '500' }, padding: 8 },
                },
            },
        },
    });
}

// ─── Weekly Bar Chart (filtro setor + mês) ────────────────────────────────────
function buildWeeklyChart(sector, month) {
    const canvas = document.getElementById('weekly-chart');
    const empty  = document.getElementById('weekly-empty');

    if (!sector) {
        destroyChart('weekly');
        canvas.style.display = 'none';
        empty.style.display  = 'flex';
        return;
    }

    let rows = allData;
    if (cols.dept >= 0) {
        rows = rows.filter(r => String(r[cols.dept] ?? '').trim() === sector);
    }

    let weekKeyFn, orderWeeks;
    if (month && cols.date >= 0) {
        rows = rows.filter(r => {
            const d = parseDate(r[cols.date]);
            return d && monthLabel(d) === month;
        });
        weekKeyFn  = d => `Semana ${Math.min(Math.ceil(d.getDate() / 7), 5)}`;
        orderWeeks = present => ['Semana 1','Semana 2','Semana 3','Semana 4','Semana 5'].filter(k => present.has(k));
    } else {
        weekKeyFn  = d => isoWeek(d);
        orderWeeks = present => [...present].sort();
    }

    const counts = {};
    const present = new Set();
    for (const row of rows) {
        const d = parseDate(cols.date >= 0 ? row[cols.date] : null);
        if (!d) continue;
        const wk = weekKeyFn(d);
        present.add(wk);
        if (!counts[wk]) counts[wk] = { comunique: 0, observar: 0, outros: 0 };
        const mode = cols.mode >= 0 ? normalizeStr(String(row[cols.mode] ?? '')) : '';
        if (mode === 'comunique')      counts[wk].comunique++;
        else if (mode === 'observar')  counts[wk].observar++;
        else                           counts[wk].outros++;
    }

    const labels = orderWeeks(present);

    if (labels.length === 0) {
        destroyChart('weekly');
        canvas.style.display = 'none';
        empty.style.display  = 'flex';
        return;
    }

    canvas.style.display = 'block';
    empty.style.display  = 'none';

    const datasets = [
        { label: 'Comunique', data: labels.map(w => counts[w].comunique), backgroundColor: '#3b82f6', borderRadius: 6, borderSkipped: false },
        { label: 'Observar',  data: labels.map(w => counts[w].observar),  backgroundColor: '#10b981', borderRadius: 6, borderSkipped: false },
        { label: 'Outros',    data: labels.map(w => counts[w].outros),    backgroundColor: '#f59e0b', borderRadius: 6, borderSkipped: false },
    ];

    destroyChart('weekly');
    const ctx = canvas.getContext('2d');
    charts.weekly = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true, maintainAspectRatio: false, animation: anim(),
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: '#cbd5e1', font: { size: 11 },
                        usePointStyle: true, pointStyle: 'circle',
                        boxWidth: 8, boxHeight: 8, padding: 14,
                    },
                },
                tooltip: { ...TOOLTIP_OPTS, mode: 'index', intersect: false },
            },
            scales: {
                x: { ...SCALE_OPTS.x },
                y: { ...SCALE_OPTS.y },
            },
        },
    });
}

// ─── Stacked Bar Chart ────────────────────────────────────────────────────────
function buildStackedChart(typeByDept, typeCnt) {
    const depts = topCount(Object.keys(typeByDept)
        .sort((a, b) => {
            const sa = Object.values(typeByDept[a]).reduce((x,y) => x+y, 0);
            const sb = Object.values(typeByDept[b]).reduce((x,y) => x+y, 0);
            return sb - sa;
        }));

    const types  = Object.keys(typeCnt).sort((a,b) => typeCnt[b] - typeCnt[a]);
    const colors = ['#60a5fa','#a855f7','#2dd4bf','#4ade80','#818cf8','#f472b6','#fb923c','#facc15','#34d399','#67e8f9'];
    const labels = depts.map(d => d.length > 16 ? d.slice(0,16)+'…' : d);

    const datasets = types.map((type, i) => ({
        label: type.length > 32 ? type.slice(0,32)+'…' : type,
        data: depts.map(d => typeByDept[d]?.[type] || 0),
        backgroundColor: colors[i % colors.length],
        borderWidth: 0,
        borderRadius: 3,
    }));

    destroyChart('stacked');
    const ctx = document.getElementById('stacked-chart').getContext('2d');
    charts.stacked = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true, maintainAspectRatio: false, animation: anim(),
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: '#cbd5e1',
                        font: { size: 10 },
                        usePointStyle: true,
                        pointStyle: 'circle',
                        boxWidth: 8, boxHeight: 8, padding: 14,
                    },
                },
                tooltip: { ...TOOLTIP_OPTS, mode: 'index', intersect: false },
            },
            scales: {
                x: { stacked: true, ...SCALE_OPTS.x, ticks: { ...SCALE_OPTS.x.ticks, maxRotation: 40 } },
                y: { stacked: true, ...SCALE_OPTS.y },
            },
        },
    });
}

// ─── KPI counter animation ────────────────────────────────────────────────────
function animateValue(el, target) {
    if (!SETTINGS.animations) { el.textContent = target.toLocaleString('pt-BR'); return; }
    const duration = 600;
    const start = performance.now();
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

    animateValue(document.getElementById('kpi-total'),   d.total);
    animateValue(document.getElementById('kpi-depts'),   d.totalDepts);
    animateValue(document.getElementById('kpi-obs'),     d.totalObs);
    animateValue(document.getElementById('kpi-types'),   d.totalTypes);

    buildDeptChart(d.deptCnt);
    buildTypesChart(d.typeCnt);
    buildStackedChart(d.typeByDept, d.typeCnt);
    buildTrendChart(d.months, d.monthCnt);

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

    allData = rows;
    const initial = aggregate(rows);

    const fMonth  = document.getElementById('filter-month');
    const fSector = document.getElementById('filter-sector');
    [fMonth, fSector].forEach(el => { while (el.options.length > 1) el.remove(1); });
    initial.months.forEach(m => fMonth.add(new Option(m, m)));
    initial.sectors.forEach(s => fSector.add(new Option(s, s)));

    const obsSec = document.getElementById('obs-sector');
    if (obsSec) {
        while (obsSec.options.length > 1) obsSec.remove(1);
        initial.sectors.forEach(s => obsSec.add(new Option(s, s)));
    }

    const wSector = document.getElementById('weekly-sector');
    const wMonth  = document.getElementById('weekly-month');
    if (wSector) { while (wSector.options.length > 1) wSector.remove(1); }
    if (wMonth)  { while (wMonth.options.length  > 1) wMonth.remove(1); }
    initial.sectors.forEach(s => wSector?.add(new Option(s, s)));
    initial.months.forEach(m => wMonth?.add(new Option(m, m)));

    const now = new Date();
    document.getElementById('update-time').textContent =
        'Atualizado: ' + now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    renderDashboard(rows);

    document.getElementById('upload-screen').classList.add('hidden');
    document.getElementById('dashboard-screen').classList.remove('hidden');
}

// ─── Filters ──────────────────────────────────────────────────────────────────
function applyFilters() {
    const month  = document.getElementById('filter-month').value;
    const sector = document.getElementById('filter-sector').value;
    let filtered = allData;
    if (month && cols.date >= 0) {
        filtered = filtered.filter(row => {
            const d = parseDate(row[cols.date]);
            return d && monthLabel(d) === month;
        });
    }
    if (sector && cols.dept >= 0) {
        filtered = filtered.filter(row => String(row[cols.dept] ?? '').trim() === sector);
    }
    renderDashboard(filtered);
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
            if (raw.length < 2) { alert('Planilha sem dados suficientes.'); return; }
            const headers = raw[0].map(h => String(h));
            const rows    = raw.slice(1).filter(r => r.some(c => c !== '' && c != null));
            initDashboard(rows, headers);
        } catch (err) {
            console.error(err);
            alert('Erro ao processar o arquivo. Verifique se é um Excel (.xlsx/.xls) ou CSV válido.');
        }
    };
    reader.readAsArrayBuffer(file);
}

// ─── Chart visibility (painel Gráficos) ───────────────────────────────────────
const CARD_OF = { dept:'card-dept', weekly:'card-weekly', trend:'card-trend', types:'card-types', obs:'card-obs', stacked:'card-stacked' };

function applyChartVisibility() {
    for (const key in CARD_OF) {
        const card = document.getElementById(CARD_OF[key]);
        if (card) card.style.display = VISIBLE[key] ? '' : 'none';
    }
    // linhas full-width: esconde a linha se o card estiver oculto
    [['dept','row-dept'],['weekly','row-weekly'],['trend','row-trend'],['stacked','row-stacked']].forEach(([k, rid]) => {
        const row = document.getElementById(rid);
        if (row) row.style.display = VISIBLE[k] ? '' : 'none';
    });
    // linha donut+obs: ajusta o layout quando só um dos dois está visível
    const row = document.getElementById('row-donut-obs');
    if (row) {
        const both = VISIBLE.types && VISIBLE.obs;
        const any  = VISIBLE.types || VISIBLE.obs;
        row.style.display = any ? '' : 'none';
        row.classList.toggle('chart-row--donut-obs', both);
        row.classList.toggle('chart-row--full', !both);
    }
    // sincroniza os checkboxes do modal
    document.querySelectorAll('#charts-toggle-list input[data-chart]').forEach(cb => {
        cb.checked = !!VISIBLE[cb.dataset.chart];
    });
}

// ─── Settings (painel Configurações) ──────────────────────────────────────────
function applySettings(rerender = false) {
    const root = document.documentElement;
    const acc = ACCENTS[SETTINGS.accent] || ACCENTS.blue;
    root.style.setProperty('--accent', acc.main);
    root.style.setProperty('--accent-soft', acc.soft);
    root.style.setProperty('--accent-glow', acc.glow);

    document.body.classList.toggle('compact', SETTINGS.compact);
    document.body.classList.toggle('high-contrast', SETTINGS.contrast);

    // reflete na UI dos controles
    document.querySelectorAll('#accent-swatches .swatch').forEach(s =>
        s.classList.toggle('swatch--active', s.dataset.accent === SETTINGS.accent));
    const topnSel = document.getElementById('set-topn');
    if (topnSel) topnSel.value = String(SETTINGS.topN);
    const a = document.getElementById('set-animations'); if (a) a.checked = SETTINGS.animations;
    const c = document.getElementById('set-compact');    if (c) c.checked = SETTINGS.compact;
    const h = document.getElementById('set-contrast');   if (h) h.checked = SETTINGS.contrast;

    if (rerender && lastRows.length) renderDashboard(lastRows);
}

// ─── Modals ───────────────────────────────────────────────────────────────────
function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
}
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

    const fileInput    = document.getElementById('file-input');
    const dropZone     = document.getElementById('drop-zone');
    const selectBtn    = document.getElementById('select-btn');
    const uploadNewBtn = document.getElementById('upload-new-btn');
    const fMonth       = document.getElementById('filter-month');
    const fSector      = document.getElementById('filter-sector');
    const clearBtn     = document.getElementById('clear-btn');

    selectBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => { handleFile(e.target.files[0]); fileInput.value = ''; });

    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', e => { if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over'); });
    dropZone.addEventListener('drop', e => {
        e.preventDefault(); dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

    uploadNewBtn.addEventListener('click', () => {
        document.getElementById('dashboard-screen').classList.add('hidden');
        document.getElementById('upload-screen').classList.remove('hidden');
    });

    fMonth.addEventListener('change',  applyFilters);
    fSector.addEventListener('change', applyFilters);
    clearBtn.addEventListener('click', () => { fMonth.value = ''; fSector.value = ''; renderDashboard(allData); });

    // Filtros do Top Observadores
    document.getElementById('obs-sector')?.addEventListener('change', () => {
        buildObsChart(document.getElementById('obs-sector').value, document.getElementById('obs-mode').value);
    });
    document.getElementById('obs-mode')?.addEventListener('change', () => {
        buildObsChart(document.getElementById('obs-sector').value, document.getElementById('obs-mode').value);
    });

    // Filtros do gráfico semanal
    document.getElementById('weekly-sector')?.addEventListener('change', () => {
        buildWeeklyChart(document.getElementById('weekly-sector').value, document.getElementById('weekly-month').value);
    });
    document.getElementById('weekly-month')?.addEventListener('change', () => {
        buildWeeklyChart(document.getElementById('weekly-sector').value, document.getElementById('weekly-month').value);
    });

    // ── Navegação lateral ──
    document.getElementById('nav-dashboard-btn')?.addEventListener('click', closeModals);
    document.getElementById('nav-charts-btn')?.addEventListener('click', () => {
        closeModals();
        document.getElementById('nav-dashboard-btn')?.classList.remove('snav-btn--active');
        document.getElementById('nav-charts-btn')?.classList.add('snav-btn--active');
        openModal('charts-modal');
    });
    document.getElementById('nav-settings-btn')?.addEventListener('click', () => {
        closeModals();
        document.getElementById('nav-dashboard-btn')?.classList.remove('snav-btn--active');
        document.getElementById('nav-settings-btn')?.classList.add('snav-btn--active');
        openModal('settings-modal');
    });

    // Fechar modais (botão X, clique no overlay, Esc)
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModals));
    document.querySelectorAll('.modal-overlay').forEach(ov => {
        ov.addEventListener('click', e => { if (e.target === ov) closeModals(); });
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });

    // ── Painel Gráficos: toggles ──
    document.querySelectorAll('#charts-toggle-list input[data-chart]').forEach(cb => {
        cb.addEventListener('change', () => {
            VISIBLE[cb.dataset.chart] = cb.checked;
            applyChartVisibility();
            savePrefs();
        });
    });

    // ── Painel Configurações: controles ──
    document.querySelectorAll('#accent-swatches .swatch').forEach(s => {
        s.addEventListener('click', () => { SETTINGS.accent = s.dataset.accent; applySettings(true); savePrefs(); });
    });
    document.getElementById('set-topn')?.addEventListener('change', e => {
        SETTINGS.topN = parseInt(e.target.value, 10) || 0; applySettings(true); savePrefs();
    });
    document.getElementById('set-animations')?.addEventListener('change', e => {
        SETTINGS.animations = e.target.checked; applySettings(true); savePrefs();
    });
    document.getElementById('set-compact')?.addEventListener('change', e => {
        SETTINGS.compact = e.target.checked; applySettings(false); savePrefs();
    });
    document.getElementById('set-contrast')?.addEventListener('change', e => {
        SETTINGS.contrast = e.target.checked; applySettings(false); savePrefs();
    });
    document.getElementById('set-reset')?.addEventListener('click', () => {
        SETTINGS = { ...DEFAULT_SETTINGS };
        VISIBLE  = { ...DEFAULT_VISIBLE };
        applySettings(true);
        applyChartVisibility();
        savePrefs();
    });
});
