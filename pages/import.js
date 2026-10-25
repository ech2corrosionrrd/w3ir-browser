'use strict';

async function main() {
  app.append(h('h1', null, 'Імпорт даних з інших браузерів'));

  // ---------- закладки та історія ----------
  const sources = await w3ir.invoke('import:detect');
  const box = h('div', { class: 'list' });
  if (!sources.length) {
    box.append(h('div', { class: 'row' }, 'Профілі Chrome, Edge, Brave, Vivaldi, Opera, Firefox та інших підтримуваних браузерів не знайдено на цьому комп’ютері.'));
  }
  for (const s of sources) {
    const bm = h('input', { type: 'checkbox', checked: true });
    const hist = h('input', { type: 'checkbox', checked: true });
    const res = h('div', { class: 'd' });
    const btn = h('button', { class: 'primary', onclick: async () => {
      if (!bm.checked && !hist.checked) { res.textContent = 'Виберіть, що імпортувати.'; return; }
      btn.disabled = true;
      res.textContent = 'Імпортуємо…';
      const r = await w3ir.invoke('import:run', { id: s.id, bookmarks: bm.checked, history: hist.checked });
      btn.disabled = false;
      const parts = [];
      if (r.bookmarks) parts.push(`закладок: +${r.bookmarks.added}${r.bookmarks.skipped ? ` (вже були: ${r.bookmarks.skipped})` : ''}`);
      if (r.history) parts.push(`записів історії: +${r.history.added}`);
      res.textContent = (r.ok ? 'Готово — ' : `Помилка: ${r.error}${parts.length ? '. Частково: ' : ''}`) + parts.join(', ');
    } }, 'Імпортувати');
    box.append(h('div', { class: 'row' },
      h('div', null,
        h('div', null, `${s.browser} — ${s.name}`),
        h('div', { class: 'd' }, h('label', null, bm, ' Закладки'), ' ', h('label', null, hist, ' Історія')),
        res),
      btn));
  }
  app.append(
    h('h2', null, 'Закладки та історія'),
    box,
    h('p', { class: 'note' }, 'Дані читаються з копії файлів профілю — оригінальний браузер не змінюється. Якщо з’являється помилка про заблокований файл, закрийте той браузер і повторіть. Повторний імпорт не створює дублікатів.'));

  // ---------- паролі ----------
  const status = await w3ir.invoke('vault:status');
  const out = h('div', { class: 'd' });
  const pickBtn = h('button', { class: 'primary', onclick: async () => {
    out.textContent = '';
    const r = await w3ir.invoke('vault:importCsv');
    if (r.ok) out.textContent = `Імпортовано: ${r.added}, пропущено: ${r.skipped}.` + (r.deleted ? ' CSV-файл видалено.' : ' Не забудьте видалити CSV-файл!');
    else if (r.error) out.textContent = r.error;
  } }, 'Вибрати CSV-файл…');
  const need = status.status === 'unlocked' ? null
    : status.status === 'none' ? 'Спершу створіть сховище паролів.' : 'Спершу розблокуйте сховище паролів.';

  app.append(
    h('h2', null, 'Паролі'),
    h('div', { class: 'card', style: 'max-width:none;margin:0 0 10px' },
      h('p', { style: 'margin-top:0' }, 'Браузери шифрують паролі ключами, прив’язаними саме до них (у новому Chrome — App-Bound Encryption), тому безпечно й надійно імпортувати їх можна лише через CSV-файл, який ви експортуєте самі:'),
      h('ol', null,
        h('li', null, h('b', null, 'Chrome / Edge / Brave: '), 'відкрийте ', h('code', null, 'chrome://password-manager/settings'), ' (в Edge — ', h('code', null, 'edge://wallet/passwords'), '), натисніть «Експортувати паролі» і збережіть файл.'),
        h('li', null, h('b', null, 'Firefox: '), 'відкрийте ', h('code', null, 'about:logins'), ', меню «⋯» → «Експортувати логіни…».'),
        h('li', null, 'Натисніть кнопку нижче й виберіть збережений файл. Після імпорту браузер запропонує безпечно видалити його.')),
      need ? h('div', { class: 'merr' }, need + ' ', h('a', { href: 'w3ir://passwords' }, 'Відкрити менеджер паролів')) : '',
      pickBtn, out));
  pickBtn.disabled = !!need;
}
main();
