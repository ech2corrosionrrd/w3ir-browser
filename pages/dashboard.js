'use strict';
// Панель (w3ir://dashboard): верхня частина — живі показники роботи браузера (оновлюються кожні 2 с без перемальовування сторінки),
// нижня — картки Bento: мережі й гаманець, ШІ, захист, журнал (оновлюються кожні 5 с). Нова картка = нова функція card…() і додавання в renderStatic().
const call = (name, arg) => w3ir.invoke(name, arg);
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs, ...kids) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  for (const c of kids) if (c) e.append(c);
  return e;
};
const ago = (t0) => {
  if (!t0) return t('ще не було');
  const s = Math.max(0, Math.round((Date.now() - t0) / 1000));
  if (s < 60) return t('{0} с тому', s);
  if (s < 3600) return t('{0} хв тому', Math.round(s / 60));
  if (s < 86400) return t('{0} год тому', Math.round(s / 3600));
  return t('{0} дн тому', Math.round(s / 86400));
};
const clock = (ts) => new Date(ts).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const num = (n) => Number(n || 0).toLocaleString(LOCALE);
const mbText = (mb) => (mb >= 1024 ? t('{0} ГБ', (mb / 1024).toFixed(1)) : t('{0} МБ', Math.round(mb)));
const upText = (sec) => {
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return t('{0} дн {1} год', d, hh);
  if (hh) return t('{0} год {1} хв', hh, m);
  return t('{0} хв', Math.max(1, m));
};
let pings = null;

// ---------- живі показники ----------
const HIST = 90; // 3 хвилини по 2 с
const hist = { mem: [], cpu: [], tabs: [], guard: [] };
const push = (arr, v) => { arr.push(v); if (arr.length > HIST) arr.shift(); };

// Спарклайн: площа + лінія 2 px, маркер останнього значення; наведення показує значення в рядку під плиткою
function sparkline(read) {
  const W = 120, H = 40;
  const area = svg('path', { class: 'sp-area' });
  const line = svg('path', { class: 'sp-line', fill: 'none', 'vector-effect': 'non-scaling-stroke' });
  const cross = svg('line', { class: 'sp-cross', y1: 0, y2: H, 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
  const box = svg('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-hidden': 'true' }, area, line, cross);
  const dot = h('span', { class: 'sp-dot' });
  const wrap = h('div', { class: 'spark-wrap' }, box, dot);
  let data = [];
  // шкала: від lo до hi з відступом, щоб малі зміни було видно (спарклайн показує форму, точні значення — у підказці при наведенні)
  const xy = (i, v, lo, hi) => [data.length < 2 ? W : (i / (data.length - 1)) * W, H - 3 - ((v - lo) / (hi - lo)) * (H - 8)];
  wrap.addEventListener('pointermove', (ev) => {
    if (data.length < 2) return;
    const r = wrap.getBoundingClientRect();
    const i = Math.max(0, Math.min(data.length - 1, Math.round(((ev.clientX - r.left) / r.width) * (data.length - 1))));
    cross.setAttribute('x1', (i / (data.length - 1)) * W); cross.setAttribute('x2', (i / (data.length - 1)) * W);
    cross.setAttribute('visibility', 'visible');
    read(i, data[i]);
  });
  wrap.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); read(-1); });
  return {
    el: wrap,
    set(values, floorMax = 0) {
      data = values;
      let lo = Math.min(...values), hi = Math.max(...values);
      if (floorMax) { lo = 0; hi = Math.max(hi, floorMax); } // CPU: від нуля, мінімальна висота шкали
      else { const span = Math.max(hi - lo, hi * 0.04, 1); lo -= span * 0.3; hi += span * 0.3; }
      if (hi <= lo) hi = lo + 1;
      if (values.length < 2) { line.removeAttribute('d'); area.removeAttribute('d'); dot.style.opacity = '0'; return; }
      const pts = values.map((v, i) => xy(i, v, lo, hi));
      const d = pts.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2)).join(' ');
      line.setAttribute('d', d);
      area.setAttribute('d', d + ` L${W} ${H} L0 ${H} Z`);
      const [lx, ly] = pts[pts.length - 1];
      dot.style.opacity = '1'; dot.style.left = (lx / W * 100) + '%'; dot.style.top = (ly / H * 100) + '%';
    },
  };
}

// Картка показника (клас kpi; .tile вже зайнято сторінкою нової вкладки): назва, велике число з одиницею, спарклайн, рядок пояснення
function kpi(cls, label, { spark = true } = {}) {
  const val = h('span', { class: 'val' }), unit = h('span', { class: 'unit' });
  const sub = h('div', { class: 'tsub' });
  let base = '';
  const sp = spark ? sparkline((i, v) => { sub.textContent = i < 0 ? base : (sp.fmt ? sp.fmt(v, i) : String(v)); }) : null;
  const el = h('section', { class: 'kpi ' + cls }, h('div', { class: 'tlabel' }, label), h('div', { class: 'tnum' }, val, unit), sp ? sp.el : null, sub);
  return {
    el, sp,
    set(v, u, s, series, floorMax, fmt) {
      val.textContent = v; unit.textContent = u || ''; base = s; sub.textContent = s;
      if (sp) { sp.fmt = fmt; sp.set(series || [], floorMax); }
    },
  };
}

const live = {
  mem: kpi('t-mem', 'Пам’ять браузера'),
  cpu: kpi('t-cpu', 'Процесор'),
  tabs: kpi('t-tabs', 'Вкладки', { spark: false }),
  guard: kpi('t-guard', 'Захист за сеанс', { spark: false }),
};
const tabsBar = h('div', { class: 'seg', role: 'img' });
live.tabs.el.insertBefore(tabsBar, live.tabs.el.querySelector('.tsub'));
const guardRows = h('div', { class: 'gstats' });
live.guard.el.insertBefore(guardRows, live.guard.el.querySelector('.tsub'));

// Порядок і кольори груп процесів фіксовані (колір належить сутності, а не її місцю в рейтингу)
const GROUPS = [['tabs', 'Вкладки', 's1'], ['main', 'Головний процес', 's2'], ['gpu', 'Графіка (GPU)', 's3'], ['utility', 'Мережа та служби', 's4'], ['other', 'Інше', 's5']];
const procBody = h('div');
const tabsBody = h('div');
const sysBody = h('div');
const heroChips = h('div', { class: 'chips' });
const heroNotes = h('div', { class: 'notes' });

const chip = (cls, icon, text, title) => h('span', { class: 'chip ' + cls, title: title || text }, h('span', { class: 'ico', 'aria-hidden': 'true' }, icon), text);
const MODES = { standard: 'Стандартний', strict: 'Суворий', maximum: 'Максимальний' };

function paintLive(m, st) {
  push(hist.mem, m.memory.privMb); push(hist.cpu, m.cpu);
  const at = (arr, i) => { const back = arr.length - 1 - i; return clock(m.now - back * 2000); };
  live.mem.set(m.memory.privMb >= 1024 ? (m.memory.privMb / 1024).toFixed(2) : String(m.memory.privMb), m.memory.privMb >= 1024 ? t('ГБ') : t('МБ'),
    t('робочий набір {0} · на ПК {1}', mbText(m.memory.wsMb), t('{0} ГБ', m.memory.totalGb)), hist.mem, 0, (v, i) => `${at(hist.mem, i)} · ${mbText(v)}`);
  live.cpu.set(m.cpu.toFixed(1), '%', t('процесів: {0}', m.groups.reduce((a, g) => a + g.n, 0)), hist.cpu, 5, (v, i) => `${at(hist.cpu, i)} · ${v.toFixed(1)} %`);

  const tb = m.tabs;
  live.tabs.set(String(tb.total), '', t('вікон: {0} · закріплено: {1} · зі звуком: {2}', tb.windows, tb.pinned, tb.playing));
  tabsBar.textContent = '';
  const awake = tb.total - tb.sleeping;
  tabsBar.setAttribute('aria-label', t('Активних: {0}, сплячих: {1}', awake, tb.sleeping));
  for (const [cls, n, name] of [['awake', awake, t('Активні')], ['asleep', tb.sleeping, t('Сплячі')]]) {
    if (!n) continue;
    const s = h('span', { class: 'seg-' + cls, title: `${name}: ${n}` }, `${name} ${n}`);
    s.style.flexGrow = String(n);
    tabsBar.append(s);
  }

  const s = m.stats;
  const total = s.blocked + s.cookies + s.https + s.threats;
  live.guard.set(num(total), '', t('з початку сеансу ({0})', ago(s.since)));
  guardRows.textContent = '';
  for (const [k, v] of [['Реклама й трекери', s.blocked], ['Сторонні cookie', s.cookies], ['Оновлено до HTTPS', s.https], ['Небезпечні сайти', s.threats]]) {
    guardRows.append(h('span', { class: 'k' }, k), h('span', { class: 'v' }, num(v)));
  }

  // процеси: смуга з відступом 2 px між сегментами + таблиця (текстова версія графіка)
  const order = GROUPS.map(([key]) => m.groups.find(g => g.key === key)).filter(Boolean);
  const sum = order.reduce((a, g) => a + g.privMb, 0) || 1;
  const bar = h('div', { class: 'stackbar', role: 'img', 'aria-label': t('Розподіл приватної пам’яті за типами процесів') });
  for (const g of order) {
    const seg = h('span', { class: 'sb ' + GROUPS.find(x => x[0] === g.key)[2], title: `${t(GROUPS.find(x => x[0] === g.key)[1])}: ${mbText(g.privMb)}` });
    seg.style.flexGrow = String(Math.max(g.privMb, 1));
    bar.append(seg);
  }
  const table = h('table', { class: 'ptable' }, h('thead', null, h('tr', null, h('th', null, 'Тип'), h('th', { class: 'r' }, 'Процесів'), h('th', { class: 'r' }, 'Пам’ять'), h('th', { class: 'r' }, 'Частка'), h('th', { class: 'r' }, 'CPU'))),
    h('tbody', null, order.map(g => {
      const meta = GROUPS.find(x => x[0] === g.key);
      return h('tr', null, h('td', null, h('span', { class: 'sw ' + meta[2], 'aria-hidden': 'true' }), t(meta[1])), h('td', { class: 'r' }, g.n), h('td', { class: 'r' }, mbText(g.privMb)), h('td', { class: 'r' }, Math.round(g.privMb / sum * 100) + ' %'), h('td', { class: 'r' }, g.cpu.toFixed(1) + ' %'));
    })));
  procBody.textContent = '';
  procBody.append(bar, table, h('div', { class: 'foot' }, 'Показано виділену приватну пам’ять процесів (Private Bytes): вона не збігається зі стовпцем «Пам’ять» у Диспетчері завдань, але зручна для порівняння між запусками.'));

  // вкладки за пам’яттю
  const maxMb = Math.max(1, ...tb.rows.map(r => r.mb));
  tabsBody.textContent = '';
  if (!tb.rows.length) tabsBody.append(h('div', { class: 'empty' }, 'Відкритих вкладок звичайних вікон немає.'));
  for (const r of tb.rows) {
    const fill = h('span', { class: 'mf' });
    fill.style.width = Math.max(2, Math.round(r.mb / maxMb * 100)) + '%';
    tabsBody.append(h('div', { class: 'trow' + (r.sleeping ? ' zz' : '') },
      h('div', { class: 'thost', title: r.host }, r.host),
      h('div', { class: 'tmeta' }, r.pinned ? chip('mute', '📌', t('закріплена')) : null, r.playing ? chip('mute', '♪', t('звук')) : null, r.sleeping ? chip('mute', '☾', t('спить')) : null, r.blocked ? chip('mute', '⛨', t('заблоковано: {0}', r.blocked)) : null),
      h('div', { class: 'tmem' }, r.sleeping ? '—' : mbText(r.mb)),
      h('div', { class: 'mbar' }, fill)));
  }

  // система й оновлення
  const up = m.update;
  const upTxt = !up ? t('недоступно') : ({ idle: t('актуальна версія'), checking: t('перевірка…'), downloading: t('завантаження {0} %', up.percent || 0), ready: t('готова {0}: натисніть ⬆ у верхній панелі', up.version || ''), error: t('помилка перевірки') }[up.state] || up.state);
  const mode = m.protection.mode;
  sysBody.textContent = '';
  sysBody.append(h('div', { class: 'kv' },
    h('span', { class: 'k' }, 'Версія'), h('span', null, m.versions.app),
    h('span', { class: 'k' }, 'Оновлення'), h('span', null, upTxt),
    h('span', { class: 'k' }, 'Працює'), h('span', null, upText(m.uptimeSec)),
    h('span', { class: 'k' }, 'Рушій'), h('span', null, `Chromium ${m.versions.chrome.split('.')[0]} · Electron ${m.versions.electron.split('.')[0]}`),
    h('span', { class: 'k' }, 'Режим захисту'), h('span', null, t(MODES[mode] || MODES.standard)),
    h('span', { class: 'k' }, 'Блокувальник реклами'), h('span', null, m.protection.engine ? t('рушій завантажено') : t('рушій завантажується або вимкнений')),
    h('span', { class: 'k' }, 'Списки загроз'), h('span', null, t('{0} доменів · оновлено {1}', num(m.protection.lists.malware + m.protection.lists.phishing), ago(m.protection.listsUpdated)))),
    h('div', { class: 'actions' }, h('a', { href: 'w3ir://settings' }, 'Налаштування'), h('a', { href: 'w3ir://downloads' }, 'Завантаження')));

  // загальний стан: ✓ усе працює / ⚠ є зауваження (текст і значок, а не лише колір)
  const notes = [];
  if (up && up.state === 'ready') notes.push(t('Оновлення {0} готове до встановлення.', up.version || ''));
  if (up && up.state === 'error') notes.push(t('Не вдалося перевірити оновлення.'));
  if (st && !st.protection.safe) notes.push(t('Захист від шахрайських сайтів вимкнено.'));
  if (st && !st.protection.adblock) notes.push(t('Блокування реклами вимкнено.'));
  if (st && st.protection.adblock && !m.protection.engine) notes.push(t('Рушій блокувальника ще завантажується.'));
  heroChips.textContent = '';
  heroChips.append(
    notes.length ? chip('warn', '⚠', t('Є зауваження'), notes.join(' ')) : chip('good', '✓', t('Усе працює')),
    chip('mute', '⛨', t('Режим захисту: {0}', t(MODES[mode] || MODES.standard))),
    chip('mute', '◷', t('Працює {0}', upText(m.uptimeSec))),
    chip('mute', 'v', m.versions.app));
  heroNotes.textContent = '';
  for (const n of notes) heroNotes.append(h('div', { class: 'note-line' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚠'), n));
}

// ---------- картки Bento (оновлюються рідше) ----------
function cardNetworks(st) {
  const w = st.wallet;
  const box = h('div', { class: 'bcard span2' }, h('h2', null, 'Мережі та гаманець'));
  if (!w.exists) {
    box.append(h('div', { class: 'sub' }, 'Гаманець Web3 ще не створено.'), h('div', { class: 'actions' }, h('a', { href: 'w3ir://wallet' }, 'Налаштувати гаманець')));
  } else if (!w.unlocked) {
    box.append(h('div', { class: 'sub' }, 'Сховище заблоковано: розблокуйте його на сторінці паролів чи гаманця, щоб побачити адресу.'));
  } else {
    box.append(h('div', { class: 'big' }, w.chain ? w.chain.name : 'Мережа не вибрана'));
    const addr = w.accounts[0] || '';
    const msg = h('span', { class: 'sub' });
    box.append(h('div', { class: 'addr' }, h('code', { title: addr }, addr || '—'),
      h('button', { class: 'primary', disabled: !addr, onclick: async () => {
        const r = await call('dashboard:copy', { address: addr });
        msg.textContent = r.ok ? t('Скопійовано (буфер очиститься за {0} с)', r.cleared) : r.error;
      } }, 'Копіювати'), msg));
  }
  const grid = h('div', { class: 'nets' }, st.networks.map((n) => {
    const p = pings && pings.find(x => x.chainId === n.chainId);
    return h('div', { class: 'net', title: p && p.error ? p.error : '' },
      h('span', { class: 'dot ' + (p ? (p.ok ? 'ok' : 'bad') : '') }), n.name,
      h('span', { class: 'ms' }, p ? (p.ok ? t('{0} мс', p.ms) : p.error) : ''));
  }));
  const btn = h('button', { onclick: async () => { btn.disabled = true; btn.textContent = t('Перевірка…'); const r = await call('dashboard:ping'); pings = r.ok ? r.results : null; renderStatic(); } }, 'Перевірити мережі');
  box.append(grid, h('div', { class: 'actions' }, btn, h('span', { class: 'sub' }, 'Запит eth_chainId лише до RPC ваших мереж, за натисканням')));
  return box;
}

function cardAgent(st) {
  const a = st.agent;
  const box = h('div', { class: 'bcard' }, h('h2', null, 'Керування браузером ШІ'));
  if (!a) { box.append(h('div', { class: 'sub' }, 'Недоступно.')); return box; }
  box.append(h('div', { class: 'big' }, h('span', { class: 'dot ' + (a.running ? 'on' : '') }), ' ', a.running ? 'Сервер працює' : (a.enabled ? 'Не запущений' : 'Вимкнено')),
    h('div', { class: 'kv' },
      h('span', { class: 'k' }, 'Порт'), h('span', null, String(a.port)),
      h('span', { class: 'k' }, 'Вікно ШІ'), h('span', null, a.windowOpen ? 'відкрите' : 'закрите'),
      h('span', { class: 'k' }, 'Сайтів дозволено'), h('span', null, String(a.sites)),
      h('span', { class: 'k' }, 'Клієнт'), h('span', null, a.client ? `${a.client.name} ${a.client.version || ''} · ${ago(a.client.at)}` : 'ще не підключався'),
      h('span', { class: 'k' }, 'Спільні вкладки'), h('span', null, a.shares.length ? a.shares.map(x => x.site + (x.mode === 'control' ? t(' (керування)') : t(' (читання)'))).join(', ') : 'немає'),
      h('span', { class: 'k' }, 'Остання дія'), h('span', null, ago(a.lastCall))));
  if (a.error) box.append(h('div', { class: 'merr' }, a.error));
  box.append(h('div', { class: 'actions' },
    h('button', { class: a.enabled ? 'danger' : 'primary', onclick: async () => { await call('dashboard:agent', { on: !a.enabled }); renderStatic(); } }, a.enabled ? 'Вимкнути' : 'Увімкнути'),
    a.enabled ? h('button', { onclick: async (ev) => { const b = ev.target; b.disabled = true; b.textContent = t('Перевірка…'); const r = await call('dashboard:agentTest'); b.disabled = false; b.textContent = r.ok ? t('Перевірку пройдено ✓') : (r.error || t('Збій')); } }, 'Перевірити') : null,
    a.shares.length ? h('button', { class: 'danger', onclick: async () => { await call('dashboard:unshare'); renderStatic(); } }, 'Припинити спільні вкладки') : null,
    h('a', { href: 'w3ir://settings', title: 'Токен і команда підключення Claude Code — у налаштуваннях' }, 'Підключення…')));
  return box;
}

function cardLog(st) {
  const log = h('div', { class: 'log' });
  if (!st.events.length) log.append(h('div', { class: 'empty' }, 'Подій поки немає: тут з’являться дії ШІ та операції гаманця.'));
  for (const e of st.events) log.append(h('div', { class: 'ln' }, h('span', { class: 't' }, clock(e.t)), h('span', { class: 'src' + (e.src === 'Гаманець' ? ' w' : '') }, t(e.src)), e.text));
  return h('div', { class: 'bcard span2' }, h('h2', null, 'Журнал'), log);
}

// ---------- сховище профілю ----------
const sizeText = (b) => (b >= 1048576 ? mbText(b / 1048576) : t('{0} КБ', Math.round(b / 1024)));
const storageBody = h('div');
async function paintStorage(freedNow) {
  const r = await call('dashboard:storage');
  storageBody.textContent = '';
  if (!r || !r.ok) { storageBody.append(h('div', { class: 'empty' }, 'Дані недоступні.')); return; }
  const msg = h('span', { class: 'sub' }, freedNow === undefined ? '' : t('Звільнено {0}', sizeText(freedNow)));
  const btn = h('button', { onclick: async () => {
    btn.disabled = true; btn.textContent = t('Очищення…');
    const c = await call('dashboard:cacheClear');
    await paintStorage(c && c.ok ? c.freed : 0);
  } }, 'Очистити кеш');
  storageBody.append(
    h('div', { class: 'kv' },
      h('span', { class: 'k' }, 'Кеш сторінок і коду'), h('span', null, sizeText(r.cacheBytes)),
      h('span', { class: 'k' }, 'Дані сайтів'), h('span', null, sizeText(r.siteBytes))),
    h('div', { class: 'actions' }, btn, msg, h('a', { href: 'w3ir://settings' }, 'Керування даними сайтів')),
    h('div', { class: 'foot' }, 'Очищується лише кеш: паролі, cookie та збережені дані сайтів не чіпаються.'));
  if (r.log.length) {
    const log = h('div', { class: 'log' });
    for (const e of r.log) log.append(h('div', { class: 'ln' }, h('span', { class: 't' }, clock(e.t)), t('Звільнено {0}', sizeText(e.freed))));
    storageBody.append(h('h3', { class: 'csub' }, 'Журнал очищення'), log);
  }
}

const statics = h('div', { class: 'bento' });
let lastState = null;
async function renderStatic() {
  const st = await call('dashboard:state');
  lastState = st;
  statics.textContent = '';
  statics.append(...(st.wallet.hidden ? [] : [cardNetworks(st)]), cardAgent(st), cardLog(st));
}

async function tick() {
  if (document.visibilityState !== 'visible') return;
  const m = await call('dashboard:metrics');
  if (m && m.ok) paintLive(m, lastState);
}

function cardOf(title, body, cls = '', sub = '') {
  return h('section', { class: 'bcard ' + cls }, h('h2', null, title), sub ? h('div', { class: 'sub csub' }, sub) : null, body);
}

app.append(
  h('header', { class: 'hero' },
    h('img', { src: 'brand-mark.png', alt: '', class: 'hero-mark' }),
    h('div', { class: 'hero-text' }, h('h1', null, 'Панель'), h('p', null, 'Стан браузера в реальному часі: ресурси, вкладки, захист і оновлення.'), heroChips, heroNotes)),
  h('div', { class: 'kpis' }, live.mem.el, live.cpu.el, live.tabs.el, live.guard.el),
  h('div', { class: 'bento' },
    cardOf('Процеси браузера', procBody, 'span2', 'Приватна пам’ять за типами процесів'),
    cardOf('Вкладки за пам’яттю', tabsBody, '', 'Найважчі вкладки звичайних вікон'),
    cardOf('Система та оновлення', sysBody, 'span3'),
    cardOf('Сховище профілю', storageBody, 'span3', 'Основний профіль: кеш і дані сайтів')),
  statics);

renderStatic().then(tick);
paintStorage();
setInterval(() => { if (document.visibilityState === 'visible') paintStorage(); }, 30000);
setInterval(tick, 2000);
setInterval(() => { if (document.visibilityState === 'visible') renderStatic(); }, 5000);
