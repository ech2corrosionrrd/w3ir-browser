'use strict';
// Панель: картки Bento. Нова картка = нова функція card…() і додавання в render().
const call = (name, arg) => w3ir.invoke(name, arg);
const ago = (t) => {
  if (!t) return 'ще не було';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + ' с тому';
  if (s < 3600) return Math.round(s / 60) + ' хв тому';
  if (s < 86400) return Math.round(s / 3600) + ' год тому';
  return Math.round(s / 86400) + ' дн тому';
};
const clock = (t) => new Date(t).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
let pings = null;

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
        msg.textContent = r.ok ? 'Скопійовано (буфер очиститься за ' + r.cleared + ' с)' : r.error;
      } }, 'Копіювати'), msg));
  }
  const grid = h('div', { class: 'nets' }, st.networks.map((n) => {
    const p = pings && pings.find(x => x.chainId === n.chainId);
    return h('div', { class: 'net', title: p && p.error ? p.error : '' },
      h('span', { class: 'dot ' + (p ? (p.ok ? 'ok' : 'bad') : '') }), n.name,
      h('span', { class: 'ms' }, p ? (p.ok ? p.ms + ' мс' : p.error) : ''));
  }));
  const btn = h('button', { onclick: async () => { btn.disabled = true; btn.textContent = 'Перевірка…'; const r = await call('dashboard:ping'); pings = r.ok ? r.results : null; render(); } }, 'Перевірити вузли');
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
      h('span', { class: 'k' }, 'Спільні вкладки'), h('span', null, a.shares.length ? a.shares.map(x => x.site + (x.mode === 'control' ? ' (керування)' : ' (читання)')).join(', ') : 'немає'),
      h('span', { class: 'k' }, 'Остання дія'), h('span', null, ago(a.lastCall))));
  if (a.error) box.append(h('div', { class: 'merr' }, a.error));
  box.append(h('div', { class: 'actions' },
    h('button', { class: a.enabled ? 'danger' : 'primary', onclick: async () => { await call('dashboard:agent', { on: !a.enabled }); render(); } }, a.enabled ? 'Вимкнути' : 'Увімкнути'),
    a.shares.length ? h('button', { class: 'danger', onclick: async () => { await call('dashboard:unshare'); render(); } }, 'Припинити спільні вкладки') : null,
    h('a', { href: 'w3ir://settings', title: 'Токен і команда підключення Claude Code — у налаштуваннях' }, 'Підключення…')));
  return box;
}

function cardProtection(st) {
  const p = st.protection;
  const row = (k, on) => [h('span', { class: 'k' }, k), h('span', null, h('span', { class: 'dot ' + (on ? 'on' : '') }), ' ', on ? 'увімкнено' : 'вимкнено')];
  return h('div', { class: 'bcard' }, h('h2', null, 'Захист'),
    h('div', { class: 'kv' }, row('Фішинг і шкідливі сайти', p.safe), row('Блокування реклами', p.adblock), row('HTTPS-first', p.https),
      h('span', { class: 'k' }, 'У списках'), h('span', null, (p.lists.malware + p.lists.phishing).toLocaleString('uk-UA') + ' доменів'),
      h('span', { class: 'k' }, 'Оновлено'), h('span', null, ago(p.updated))),
    h('div', { class: 'actions' }, h('a', { href: 'w3ir://settings' }, 'Налаштування приватності')));
}

function cardLog(st) {
  const log = h('div', { class: 'log' });
  if (!st.events.length) log.append(h('div', { class: 'empty' }, 'Подій поки немає: тут з’являться дії ШІ та операції гаманця.'));
  for (const e of st.events) log.append(h('div', { class: 'ln' }, h('span', { class: 't' }, clock(e.t)), h('span', { class: 'src' + (e.src === 'Гаманець' ? ' w' : '') }, e.src), e.text));
  return h('div', { class: 'bcard span2' }, h('h2', null, 'Журнал'), log);
}

async function render() {
  const st = await call('dashboard:state');
  app.textContent = '';
  app.append(
    h('div', { class: 'dash-head' }, h('img', { src: 'brand-favicon.png', alt: '' }), h('h1', null, 'Панель')),
    h('div', { class: 'bento' }, cardNetworks(st), cardAgent(st), cardLog(st), cardProtection(st)));
}

render();
setInterval(() => { if (document.visibilityState === 'visible') render(); }, 5000);
