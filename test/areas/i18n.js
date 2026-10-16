'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { BrowserWindow } = require('electron');
const { ok, sleep } = require('../lib');

const root = path.join(__dirname, '..', '..');
const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort().join();
const markup = (s) => (s.match(/\*\*|`|\]\(w3ir:\/\/[a-z]+\)/g) || []).length;

async function i18nTests() {
  const { I18n, LANGS, fmt } = require('../../src/i18n');
  const i = new I18n();

  // мови: російської немає навмисно; автовибір за мовою системи
  ok(!('ru' in LANGS) && !fs.existsSync(path.join(root, 'locales', 'ru.json')), 'i18n: російської мови немає');
  ok(i.resolve('auto', 'uk-UA') === 'uk' && i.resolve('auto', 'en-US') === 'en' && i.resolve('auto', 'ru-RU') === 'uk' && i.resolve('auto', 'ja-JP') === 'en' && i.resolve('auto', '') === 'en', 'i18n: автовибір мови за системою (ru → українська, невідома → англійська)');
  ok(i.resolve('en', 'uk') === 'en' && i.resolve('xx', 'en') === 'uk' && i.resolve('ru', 'en') === 'uk', 'i18n: явний вибір; невідомий код або ru → українська');
  ok(fmt('Привіт, {0} і {1}', ['A']) === 'Привіт, A і {1}', 'i18n: підстановка {n}, відсутній аргумент лишається як є');

  // усі каталоги: ті самі ключі, однакові підстановки {n} та розмітка, автовибір для кожної мови
  const codes = Object.keys(LANGS).filter(c => c !== 'uk');
  ok(codes.length >= 5 && codes.every(c => fs.existsSync(path.join(root, 'locales', c + '.json'))) && fs.readdirSync(path.join(root, 'locales')).filter(f => /^[a-z]{2}\.json$/.test(f)).length === codes.length, `i18n: мови з каталогами (${codes.join(', ')}), зайвих каталогів немає`);
  let total = 0, badPh = 0, badMk = 0;
  for (const c of codes) {
    const cat = JSON.parse(fs.readFileSync(path.join(root, 'locales', c + '.json'), 'utf8'));
    for (const [k, v] of Object.entries(cat)) { total++; if (placeholders(k) !== placeholders(v)) badPh++; if (markup(k) !== markup(v)) badMk++; }
    ok(i.resolve('auto', c + '-XX') === c && i.resolve(c, 'uk') === c && LANGS[c].name && LANGS[c].locale.startsWith(c), `i18n: ${c} — автовибір, назва й локаль`);
  }
  ok(total > 5000 && badPh === 0 && badMk === 0, `i18n: підстановки {n} і розмітка збігаються з оригіналом у всіх мовах (${total} рядків, розбіжностей ${badPh + badMk})`);
  const r = spawnSync(process.execPath, ['build/i18n-extract.js', '--check'], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  ok(r.status === 0, 'i18n: усі українські рядки коду мають переклад у кожній мові' + (r.status === 0 ? '' : ' :: ' + String(r.stdout).slice(0, 300)));

  // t() у головному процесі
  i.setLang('en', 'uk');
  ok(i.t('Видалити профіль «{0}»?', 'Work') === 'Delete profile “Work”?' && i.t('Невідомий рядок без перекладу') === 'Невідомий рядок без перекладу' && i.locale() === 'en-GB', 'i18n: t() — переклад з підстановкою; без перекладу повертає оригінал');
  const js = i.script();
  ok(js.startsWith('window.__I18N={') && !js.slice(0, js.indexOf('};')).includes('</'), 'i18n: скрипт каталогу для сторінок згенеровано');
  i.setLang('uk', 'en');
  ok(i.map === null && i.t('Видалити профіль «{0}»?', 'Work') === 'Видалити профіль «Work»?', 'i18n: українська — рядки без змін');

  // механізм перекладу DOM (pages/i18n-dom.js) у справжньому вікні
  i.setLang('en', 'uk');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="uk"><head><title>Налаштування</title></head><body><div id="a"></div></body></html>'));
    const res = await win.webContents.executeJavaScript(`(async () => {
      ${i.script()}
      const a = document.getElementById('a');
      a.innerHTML = '<p id="p1">Відкрити</p><input id="i1" placeholder="Пошук в історії"><button id="b1" title="Закрити вкладку (Ctrl+W)">Закрити</button><p id="p2">Версія 1.2.3</p><p id="p3">Кіт з’їв рибу</p><p id="p4" data-notr>Відкрити</p><p id="p5">Сховище заблоковано</p>';
      await new Promise(r => setTimeout(r, 100));
      const d = document.createElement('p'); d.id = 'p6'; d.textContent = '5 хв тому'; a.append(d);
      const m = document.createElement('p'); m.id = 'p7'; m.textContent = '12 хв тому'; a.append(m);
      await new Promise(r => setTimeout(r, 100));
      const g = (id) => document.getElementById(id);
      return { p1: g('p1').textContent, ph: g('i1').placeholder, ti: g('b1').title, b1: g('b1').textContent, p2: g('p2').textContent, p3: g('p3').textContent, p4: g('p4').textContent, p5: g('p5').textContent, p6: g('p6').textContent, p7: g('p7').textContent,
        title: document.title, lang: document.documentElement.lang, t1: t('Видалити профіль «{0}»?', 'X'), loc: LOCALE };
    })()`);
    ok(res.p1 === 'Open' && res.ph === 'Search history' && res.ti === 'Close tab (Ctrl+W)' && res.b1 === 'Close', 'i18n DOM: текст, placeholder і title перекладаються (також динамічно доданий)');
    ok(res.p2 === 'Version 1.2.3' && res.p6 === '5 min ago' && res.p7 === '12 min ago', 'i18n DOM: шаблони з числами ({0}) перекладаються');
    ok(res.p3 === 'Кіт з’їв рибу' && res.p4 === 'Відкрити', 'i18n DOM: рядок без перекладу й елемент data-notr лишаються як є');
    ok(res.title === 'Settings' && res.lang === 'en' && res.t1 === 'Delete profile “X”?' && res.loc === 'en-GB', 'i18n DOM: заголовок, lang, t() і LOCALE');
  } finally { win.destroy(); i.setLang('uk', 'en'); }
  await sleep(50);
}

module.exports = { i18nTests };
