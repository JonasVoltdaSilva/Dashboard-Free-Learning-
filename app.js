'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let allData = [];
let cols = { dept: -1, type: -1, obs: -1, date: -1 };
let charts = {};
let cachedProcessed = null;

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

const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                   'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const MONTHS_SHORT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

function monthLabel(d) { return `${MONTHS_SHORT[d.getMonth()]}/${d.getFullYear()}`; }
function monthSortKey(d) { return d.getFullYear() * 100 + d.getMonth(); }

function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const y = t.getUTCFullYear();
    const w = Math.ceil(((t - new Date(Date.UTC(y, 0, 1))) / 86400000 + 1) / 7);
    return `S${String(w).padStart(2,'0')}/${y}`;
}

// ─── Aggregate data ───────────────────────────────────────────────────────────
function aggregate(rows) {
    const deptCnt = {}, typeCnt = {}, obsCnt = {}, typeByDept = {}, weekBySector = {};
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

        if (date) {
            monthKeys.add(monthLabel(date));

            if (dept) {
                const wk = isoWeek(date);
                if (!weekBySector[dept]) weekBySector[dept] = {};
                weekBySector[dept][wk] = (weekBySector[dept][wk] || 0) + 1;
            }
        }

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
        deptCnt, typeCnt, obsCnt, typeByDept, weekBySector,
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
    '#4ade80','#60a5fa','#f472b6','#fb923c','#facc15',
];
const gc = i => PALETTE[i % PALETTE.length];
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

function destroyChart(key) { if (charts[key]) { charts[key].destroy(); charts[key] = null; } }

// ─── Dept Bar Chart ───────────────────────────────────────────────────────────
function buildDeptChart(deptCnt) {
    const sorted = Object.entries(deptCnt).sort((a,b) => b[1]-a[1]).slice(0, 16);
    const labels = sorted.map(([k]) => k.length > 16 ? k.slice(0,16)+'…' : k);
    const data   = sorted.map(([,v]) => v);
    const colors = data.map((_,i) => gc(i));

    destroyChart('dept');
    const ctx = document.getElementById('dept-chart').getContext('2d');
    charts.dept = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 4, borderSkipped: false }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { ...TOOLTIP_OPTS } },
            scales: {
                x: { ...SCALE_OPTS.x, ticks: { ...SCALE_OPTS.x.ticks, maxRotation: 45 } },
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
    const colors = ['#60a5fa','#a855f7','#2dd4bf','#4ade80','#818cf8','#f472b6'];
    const total  = data.reduce((a,b) => a+b, 0);

    destroyChart('types');
    const ctx = document.getElementById('types-chart').getContext('2d');
    charts.types = new Chart(ctx, {
        type: 'doughnut',
        data: { labels, datasets: [{ data, backgroundColor: colors.slice(0, data.length), borderColor: '#0b0b18', borderWidth: 3, hoverOffset: 10 }] },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '64%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: '#94a3b8', padding: 14, font: { size: 10 }, boxWidth: 10, boxHeight: 10,
                        generateLabels: chart => chart.data.labels.map((label, i) => {
                            const val = chart.data.datasets[0].data[i];
                            const pct = total > 0 ? Math.round(val / total * 100) : 0;
                            const short = label.length > 28 ? label.slice(0,28)+'…' : label;
                            return {
                                text: `${short} (${pct}%)`,
                                fillStyle: chart.data.datasets[0].backgroundColor[i],
                                strokeStyle: 'transparent', lineWidth: 0, hidden: false, index: i,
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

// ─── Top Observers Horizontal Bar ────────────────────────────────────────────
function buildObsChart(obsCnt) {
    const sorted = Object.entries(obsCnt).sort((a,b) => b[1]-a[1]).slice(0, 10);
    const labels = sorted.map(([k]) => k.length > 22 ? k.slice(0,22)+'…' : k);
    const data   = sorted.map(([,v]) => v);
    const colors = data.map((_,i) => gc(i));

    destroyChart('obs');
    const ctx = document.getElementById('obs-chart').getContext('2d');
    charts.obs = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 4, borderSkipped: 'left' }] },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { ...TOOLTIP_OPTS } },
            scales: {
                x: { ...SCALE_OPTS.x },
                y: { ...SCALE_OPTS.y, beginAtZero: undefined, grid: { color: 'transparent' } },
            },
        },
    });
}

// ─── Weekly Line Chart ────────────────────────────────────────────────────────
function buildWeeklyChart(weekBySector, sector) {
    const canvas = document.getElementById('weekly-chart');
    const empty  = document.getElementById('weekly-empty');

    if (!sector || !weekBySector || !weekBySector[sector]) {
        destroyChart('weekly');
        canvas.style.display = 'none';
        empty.style.display  = 'flex';
        return;
    }

    canvas.style.display = 'block';
    empty.style.display  = 'none';

    const weekData = weekBySector[sector];
    const weeks = Object.keys(weekData).sort();
    const data  = weeks.map(w => weekData[w]);

    destroyChart('weekly');
    const ctx = canvas.getContext('2d');
    charts.weekly = new Chart(ctx, {
        type: 'line',
        data: {
            labels: weeks,
            datasets: [{
                label: sector, data,
                borderColor: '#60a5fa',
                backgroundColor: 'rgba(96,165,250,0.12)',
                pointBackgroundColor: '#93c5fd',
                pointBorderColor: '#0b0b18',
                pointBorderWidth: 2,
                pointRadius: 5, pointHoverRadius: 7,
                fill: true, tension: 0.35,
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { ...TOOLTIP_OPTS } },
            scales: {
                x: { ...SCALE_OPTS.x, ticks: { ...SCALE_OPTS.x.ticks, maxRotation: 45 } },
                y: { ...SCALE_OPTS.y },
            },
        },
    });
}

// ─── Stacked Bar Chart ────────────────────────────────────────────────────────
function buildStackedChart(typeByDept, typeCnt) {
    const depts = Object.keys(typeByDept)
        .sort((a, b) => {
            const sa = Object.values(typeByDept[a]).reduce((x,y) => x+y, 0);
            const sb = Object.values(typeByDept[b]).reduce((x,y) => x+y, 0);
            return sb - sa;
        }).slice(0, 20);

    const types  = Object.keys(typeCnt).sort((a,b) => typeCnt[b] - typeCnt[a]);
    const colors = ['#60a5fa','#a855f7','#2dd4bf','#4ade80','#818cf8','#f472b6'];
    const labels = depts.map(d => d.length > 16 ? d.slice(0,16)+'…' : d);

    const datasets = types.map((type, i) => ({
        label: type.length > 32 ? type.slice(0,32)+'…' : type,
        data: depts.map(d => typeByDept[d]?.[type] || 0),
        backgroundColor: colors[i % colors.length],
        borderRadius: 2,
    }));

    destroyChart('stacked');
    const ctx = document.getElementById('stacked-chart').getContext('2d');
    charts.stacked = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top', labels: { color: '#94a3b8', font: { size: 10 }, boxWidth: 10, boxHeight: 10, padding: 12 } },
                tooltip: { ...TOOLTIP_OPTS, mode: 'index', intersect: false },
            },
            scales: {
                x: { stacked: true, ...SCALE_OPTS.x, ticks: { ...SCALE_OPTS.x.ticks, maxRotation: 45 } },
                y: { stacked: true, ...SCALE_OPTS.y },
            },
        },
    });
}

// ─── KPI counter animation ────────────────────────────────────────────────────
function animateValue(el, target) {
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
    const d = aggregate(rows);
    cachedProcessed = d;

    animateValue(document.getElementById('kpi-total'),   d.total);
    animateValue(document.getElementById('kpi-depts'),   d.totalDepts);
    animateValue(document.getElementById('kpi-obs'),     d.totalObs);
    animateValue(document.getElementById('kpi-types'),   d.totalTypes);

    buildDeptChart(d.deptCnt);
    buildTypesChart(d.typeCnt);
    buildObsChart(d.obsCnt);
    buildStackedChart(d.typeByDept, d.typeCnt);

    const weeklySel = document.getElementById('weekly-sector');
    buildWeeklyChart(d.weekBySector, weeklySel.value);
}

// ─── Init from file ────────────────────────────────────────────────────────────
function initDashboard(rows, headers) {
    cols.dept = detectCol(headers, KEYWORDS.dept);
    cols.type = detectCol(headers, KEYWORDS.type);
    cols.obs  = detectCol(headers, KEYWORDS.obs);
    cols.date = detectCol(headers, KEYWORDS.date);

    allData = rows;

    const initial = aggregate(rows);

    const fMonth = document.getElementById('filter-month');
    const fSector = document.getElementById('filter-sector');
    const wSector = document.getElementById('weekly-sector');

    [fMonth, fSector, wSector].forEach(el => {
        while (el.options.length > 1) el.remove(1);
    });

    initial.months.forEach(m => fMonth.add(new Option(m, m)));
    initial.sectors.forEach(s => {
        fSector.add(new Option(s, s));
        wSector.add(new Option(s, s));
    });

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
            const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: false });
            const ws = wb.Sheets[wb.SheetNames[0]];
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

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const fileInput   = document.getElementById('file-input');
    const dropZone    = document.getElementById('drop-zone');
    const selectBtn   = document.getElementById('select-btn');
    const uploadNewBtn= document.getElementById('upload-new-btn');
    const fMonth      = document.getElementById('filter-month');
    const fSector     = document.getElementById('filter-sector');
    const clearBtn    = document.getElementById('clear-btn');
    const wSector     = document.getElementById('weekly-sector');

    selectBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => { handleFile(e.target.files[0]); fileInput.value = ''; });

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
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
    clearBtn.addEventListener('click', () => {
        fMonth.value = ''; fSector.value = '';
        renderDashboard(allData);
    });

    wSector.addEventListener('change', () => {
        if (cachedProcessed) buildWeeklyChart(cachedProcessed.weekBySector, wSector.value);
    });
});
