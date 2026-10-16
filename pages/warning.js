'use strict';
const q = new URLSearchParams(location.search);
const kind = q.get('kind') || '';
const listed = q.get('sev') === 'listed';
const host = q.get('host') || '';
const reason = q.get('reason') || '';
const target = q.get('url') || '';
const canTrust = q.get('trust') === '1';
const safeTarget = /^https?:\/\//i.test(target) ? target : '';

const TITLES = {
  phishing: 'Шахрайський (фішинговий) сайт', malware: 'Сайт розповсюджує шкідливі програми',
  lookalike: 'Сайт імітує відомий сервіс', homograph: 'Підозріла назва домену', userinfo: 'Обманлива адреса',
};
document.title = TITLES[kind] || 'Небезпечний сайт';

function highlighted(url, host) {
  const i = host ? url.indexOf(host) : -1;
  if (i < 0) return [url];
  return [url.slice(0, i), h('b', null, host), url.slice(i + host.length)];
}

const back = () => { if (history.length > 1) history.back(); else location.href = 'w3ir://newtab'; };

app.append(
  h('div', { class: 'shield' }, listed ? '⛔' : '⚠️'),
  h('h1', null, TITLES[kind] || 'Небезпечний сайт'),
  h('p', null, reason),
  h('div', { class: 'url' }, ...highlighted(target, host)),
  h('p', null, listed
    ? 'Браузер заблокував цю сторінку, щоб захистити ваші паролі, гроші та гаманець. Не вводьте на ній жодних даних.'
    : 'Це попередження ґрунтується на ознаках підробки, а не на підтвердженому списку. Якщо ви впевнені, що адреса правильна, можете її відкрити.'),
  h('div', { class: 'actions' },
    h('button', { class: 'primary', onclick: back }, '← Повернутися в безпечне місце'),
    canTrust && safeTarget ? h('button', { onclick: async () => {
      const r = await w3ir.invoke('safe:trust', { url: safeTarget });
      if (r.ok) location.href = safeTarget; else alert(r.error || 'Не вдалося');
    } }, 'Я довіряю цьому сайту') : '',
    safeTarget ? h('button', { class: 'danger-link', onclick: async () => {
      if (!confirm(listed ? 'Цей сайт у списку шахрайських або шкідливих. Відкривати його ДУЖЕ небезпечно. Продовжити?' : 'Відкрити сайт один раз попри попередження?')) return;
      const r = await w3ir.invoke('safe:proceed', { url: safeTarget });
      if (r.ok) location.href = safeTarget;
    } }, 'Усе одно відкрити (ризиковано)') : ''),
  h('details', null,
    h('summary', null, 'Що таке фішинг і як себе захистити'),
    h('p', null, 'Шахраї створюють сайти-двійники банків, магазинів, бірж та гаманців, щоб украсти ваші паролі, коди або фразу відновлення. Завжди звіряйте адресу в рядку, не переходьте за посиланнями з листів і повідомлень від незнайомців, нікому й ніколи не вводьте фразу відновлення гаманця.'),
    h('p', null, 'Перевірка виконується на вашому комп’ютері за завантаженими списками (URLhaus, Phishing.Database, MetaMask eth-phishing-detect) та за ознаками підробки адреси; ваші адреси нікуди не надсилаються. Налаштування — у розділі «Налаштування → Приватність».')));
