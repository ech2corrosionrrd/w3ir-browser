'use strict';
const q = new URLSearchParams(location.search);
const code = q.get('code') || '';
const desc = q.get('desc') || '';
const target = q.get('url') || '';

const MESSAGES = {
  ERR_NAME_NOT_RESOLVED: ['Не вдалося знайти сервер', 'Перевірте, чи правильно введено адресу, і чи є підключення до інтернету.'],
  ERR_INTERNET_DISCONNECTED: ['Немає підключення до інтернету', 'Перевірте мережевий кабель, Wi-Fi та налаштування мережі.'],
  ERR_CONNECTION_REFUSED: ['Сайт відмовив у з\'єднанні', 'Сервер не приймає підключення.'],
  ERR_CONNECTION_TIMED_OUT: ['Сервер надто довго не відповідає', 'Спробуйте ще раз пізніше.'],
  ERR_CONNECTION_RESET: ['З\'єднання було скинуто', 'Спробуйте оновити сторінку.'],
  ERR_CERT_AUTHORITY_INVALID: ['Сертифікат безпеки не довіряється', 'Не можна гарантувати безпеку з\'єднання з цим сайтом.'],
  ERR_CERT_DATE_INVALID: ['Сертифікат сайту недійсний за датою', 'Перевірте дату й час на комп\'ютері.'],
  ERR_CERT_COMMON_NAME_INVALID: ['Сертифікат не відповідає адресі сайту', 'Сайт може бути підроблений.'],
  ERR_SSL_PROTOCOL_ERROR: ['Помилка протоколу SSL', 'Сайт використовує непідтримуваний протокол безпеки.'],
  ERR_TOO_MANY_REDIRECTS: ['Забагато перенаправлень', 'Спробуйте очистити cookie для цього сайту.'],
  ERR_BLOCKED_BY_CLIENT: ['Запит заблоковано', 'Цей запит заблоковано налаштуваннями браузера.'],
};
const [title, hint] = MESSAGES[desc] || ['Не вдалося відкрити сторінку', 'Сталася помилка під час завантаження.'];
const safe = /^(https?|file):/i.test(target);

app.append(
  h('div', { class: 'ico' }, '⚠️'),
  h('h1', null, title),
  h('p', null, hint),
  safe && h('p', null, h('a', { href: target }, target)),
  h('div', { class: 'code' }, desc + (code ? ' (' + code + ')' : '')),
  safe && h('button', { class: 'primary', onclick: () => { location.href = target; } }, 'Спробувати ще раз'));
document.title = title;
