'use strict';
const http = require('http');
const { ok, sleep } = require('../lib');

async function groupTests(ctx) {
  const { GROUP_COLORS } = require('../../src/tab-groups');
  const w = ctx.openWindow({});
  await sleep(2500);
  const mk = (url = 'w3ir://newtab') => w.createTab(url, { activate: false });
  const order = () => w.tabs.map(t => t.id);
  const t0 = w.tabs[0];
  const a = mk(), b = mk(), c = mk(), d = mk();
  const contiguous = () => {
    for (const g of w.groupList()) {
      const idx = w.tabs.map((t, i) => (t.group === g.id ? i : -1)).filter(i => i >= 0);
      if (idx[idx.length - 1] - idx[0] !== idx.length - 1) return false;
    }
    return true;
  };

  // --- створення та кольори ---
  const g1 = w.newGroup([d.id, b.id]);
  ok(g1 && b.group === g1 && d.group === g1 && order().join() === [t0.id, a.id, b.id, d.id, c.id].join(), 'groups: група створюється на місці першої вкладки й тримає вкладки підряд');
  const g2 = w.newGroup([a.id]);
  ok(w.group(g1).color !== w.group(g2).color && GROUP_COLORS.some(x => x.key === w.group(g2).color), 'groups: нові групи отримують різні кольори');
  ok(w.setGroupName(g1, '  Робота\u0000\u0007' + 'x'.repeat(100)) && w.group(g1).name.length <= 40 && !/[\u0000-\u001f]/.test(w.group(g1).name) && w.group(g1).name.startsWith('Робота'), 'groups: назва очищується від керівних символів і обмежується 40 символами');
  w.setGroupName(g1, 'Робота');
  ok(!w.setGroupColor(g1, '#ff0000') && !w.setGroupColor(g1, 'javascript:1') && w.group(g1).color !== '#ff0000' && w.setGroupColor(g1, 'red') && w.group(g1).color === 'red', 'groups: приймаються лише відомі кольори');
  ok(!w.setGroupName(9999, 'x') && !w.addToGroup(c.id, 9999), 'groups: операції з неіснуючою групою відхиляються');

  // --- додавання / видалення вкладок ---
  ok(w.addToGroup(c.id, g1) && c.group === g1 && contiguous() && w.groupTabs(g1).map(t => t.id).join() === [b.id, d.id, c.id].join(), 'groups: вкладка додається в кінець групи');
  ok(w.removeFromGroup(d.id) && d.group === null && contiguous() && order().indexOf(d.id) > order().indexOf(c.id) - 1, 'groups: вкладка виходить із групи й стає одразу після неї');
  ok(w.groupTabs(g1).map(t => t.id).join() === [b.id, c.id].join(), 'groups: у групі лишилися решта вкладок');

  // --- закріплені вкладки ---
  w.exec('pinTab', b.id);
  ok(b.pinned && b.group === null && w.newGroup([b.id]) === null && order()[0] === b.id, 'groups: закріплена вкладка виходить із групи й не може до неї входити');
  w.exec('pinTab', b.id);

  // --- перетягування ---
  w.addToGroup(b.id, g1);
  const e = mk();
  w.moveTab({ id: e.id, index: w.tabs.indexOf(w.groupTabs(g1)[1]) }); // між першою та другою вкладками групи — усередину
  ok(e.group === g1 && contiguous(), 'groups: вкладка, кинута між двома вкладками групи, приєднується до неї');
  w.moveTab({ id: e.id, index: w.tabs.length });             // у кінець — з групи
  ok(e.group === null && contiguous(), 'groups: вкладка, перетягнута за межі групи, виходить із неї');

  // --- згортання ---
  w.switchTab(t0.id);
  ok(w.setGroupCollapsed(g1, true) && w.visibleTabs().every(t => t.group !== g1) && w.visibleTabs().length === w.tabs.length - w.groupTabs(g1).length, 'groups: згорнута група ховає свої вкладки');
  w.sendState();
  w.exec('nextTab'); const afterNext = w.activeId;
  ok(![b.id, c.id].includes(afterNext), 'groups: Ctrl+Tab пропускає вкладки згорнутої групи');
  w.switchTab(b.id);
  ok(w.group(g1).collapsed === false && w.activeId === b.id, 'groups: перехід на вкладку згорнутої групи розгортає її');
  ok(w.setGroupCollapsed(g1, true) && w.activeId !== b.id && !w.tabs.find(t => t.id === w.activeId).group, 'groups: згортання групи з активною вкладкою переходить на сусідню поза групою');
  w.setGroupCollapsed(g1, false);

  // --- нова вкладка з посилання успадковує групу ---
  const child = w.createTab('w3ir://newtab', { activate: false, opener: c });
  ok(child.group === g1 && w.tabs.indexOf(child) === w.tabs.indexOf(c) + 1 && contiguous(), 'groups: вкладка, відкрита з вкладки групи, потрапляє в ту саму групу одразу після неї');
  w.duplicateTab(c.id);
  const dup = w.tabs[w.tabs.indexOf(c) + 1];
  ok(dup && dup.group === g1 && contiguous(), 'groups: дублікат вкладки лишається в групі');
  w.exec('groupNewTab', g1); await sleep(300);
  ok(w.groupTabs(g1).length >= 5 && w.tabs.find(t => t.id === w.activeId).group === g1, 'groups: «Нова вкладка в групі» додає й активує вкладку в групі');

  // --- меню та палітра ---
  const labels = (t) => w.tabGroupMenuItems(t).map(i => i.label);
  ok(labels(e).includes('Додати до нової групи') && labels(e).includes('Додати до групи') && !labels(e).includes('Видалити з групи'), 'groups: меню вкладки без групи: нова група / додати до групи');
  ok(labels(c).includes('Видалити з групи') && w.tabGroupMenuItems(b.pinned ? b : { pinned: true }).length === 0, 'groups: меню вкладки в групі має «Видалити з групи»; для закріпленої групових пунктів немає');
  const cmds = w.commandList();
  ok(cmds.some(x => x.cmd === 'groupNew') && cmds.some(x => x.cmd === 'groupFocus' && /Робота/.test(x.label)), 'groups: палітра має «Нова група…» і «Перейти до групи «Робота»»');
  ok(w.paletteData('tabs').tabs.some(x => x.title.startsWith('[Робота] ')), 'groups: у пошуку вкладок назва групи вказана в дужках');
  const { withTip } = require('../../src/tips');
  ok(cmds.filter(x => /^group/.test(x.cmd)).every(x => withTip(x).tip), 'groups: команди груп мають підказки');

  // --- інтерфейс рядка вкладок ---
  w.setGroupName(g2, 'Особисте');
  w.setGroupCollapsed(g2, true);
  w.sendState(); await sleep(500);
  const ui = await w.chrome.executeJavaScript(`(() => ({
    chips: [...document.querySelectorAll('.gchip')].map(c => ({ name: c.querySelector('.gname') && c.querySelector('.gname').textContent, count: c.querySelector('.gcount') && c.querySelector('.gcount').textContent, color: c.style.getPropertyValue('--gc'), collapsed: c.classList.contains('collapsed') })),
    tabs: document.querySelectorAll('#tabs .tab').length,
    ingroup: document.querySelectorAll('#tabs .tab.ingroup').length,
  }))()`);
  ok(ui.chips.length === 2 && ui.chips.some(x => x.name === 'Робота' && x.color === '#e5675f' && !x.collapsed) && ui.chips.some(x => x.name === 'Особисте' && x.collapsed && x.count === '1'), 'groups: у рядку вкладок видно кольорові мітки груп (назва, колір, лічильник у згорнутої)');
  ok(ui.tabs === w.visibleTabs().length && ui.ingroup === w.tabs.filter(t => t.group === g1).length, 'groups: вкладки згорнутої групи не малюються, а вкладки відкритої підсвічені кольором');
  await w.chrome.executeJavaScript(`document.querySelector('.gchip.collapsed').click()`);
  await sleep(600);
  ok(w.group(g2).collapsed === false, 'groups: клік по мітці розгортає групу');
  w.chrome.send('group-edit', { id: g1 }); await sleep(400);
  const hasInput = await w.chrome.executeJavaScript(`!!document.querySelector('.gedit')`);
  await w.chrome.executeJavaScript(`(() => { const i = document.querySelector('.gedit'); i.value = 'Проєкт'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(500);
  ok(hasInput && w.group(g1).name === 'Проєкт', 'groups: подвійний клік/перейменування редагує назву прямо на мітці');

  // --- збереження сесії ---
  w.setGroupCollapsed(g2, true);
  const snap = w.snapshot();
  ok(snap.groups.length === 2 && snap.groupOf.length === snap.urls.length && snap.groups.some(x => x.name === 'Проєкт' && x.color === 'red') && snap.groups.some(x => x.name === 'Особисте' && x.collapsed), 'groups: групи входять до знімка сесії');
  const w2 = ctx.openWindow({ urls: snap.urls, groups: snap.groups, groupOf: snap.groupOf, pinned: snap.pinned, activeIndex: snap.activeIndex });
  await sleep(3000);
  const sig = (x) => x.groupList().map(g => `${g.name}|${g.color}|${g.collapsed}|${g.count}`).join(';');
  ok(w2.tabs.length === snap.urls.length && sig(w2) === sig(w) && w2.tabs.map(t => !!t.group).join() === w.tabs.filter(t => { const u = w.tabUrl(t); return u && u !== 'about:blank'; }).map(t => !!t.group).join(), 'groups: після перезапуску групи, кольори, назви й стан згортання відновлюються');
  const bad = ctx.openWindow({ urls: ['w3ir://newtab', 'w3ir://newtab'], groups: [{ name: 'x'.repeat(200), color: 'javascript:1' }], groupOf: [0, 7] });
  await sleep(2500);
  ok(bad.groupList().length === 1 && bad.groupList()[0].name.length <= 40 && GROUP_COLORS.some(x => x.key === bad.groupList()[0].color) && bad.tabs[1].group === null, 'groups: пошкоджені дані сесії (колір, довга назва, неіснуюча група) безпечно обробляються');

  // --- розгрупування й закриття ---
  w.setGroupCollapsed(g2, false);
  w.ungroup(g2);
  ok(!w.group(g2) && a.group === null, 'groups: «Розгрупувати» зберігає вкладки');
  const n = w.tabs.length, members = w.groupTabs(g1).length;
  w.closeGroup(g1); await sleep(300);
  ok(!w.group(g1) && w.tabs.length === n - members, 'groups: «Закрити групу» закриває всі її вкладки');
  w.closeTab(w.groupTabs(-1)[0] ? 0 : w.tabs[w.tabs.length - 1].id);
  const g3 = w.newGroup([w.tabs[0].id, w.tabs[1].id]);
  const solo = w.tabs.filter(t => t.group === g3);
  solo.slice(0, -1).forEach(t => w.closeTab(t.id));
  const last = w.tabs.find(t => t.group === g3);
  ok(w.groupList().find(g => g.id === g3).count === 1, 'groups: лічильник групи відповідає кількості вкладок');
  const other = w.tabs.find(t => !t.group);
  if (other) { w.closeTab(last.id); ok(!w.group(g3), 'groups: порожня група зникає після закриття останньої вкладки'); } else ok(true, 'groups: порожня група (пропущено)');

  w.win.close(); w2.win.close(); bad.win.close();
  await sleep(500);
}

async function siteTests(ctx) {
  const { ASK } = require('../../src/context');
  const ses = ctx.session;
  const origin = 'https://example.org';

  // --- дозволи ---
  ok(ctx.setSitePerm(ses, origin, 'media', false) && ctx.permDecision(ses, origin, 'media') === false && ctx.sitePerms(ses, origin).media === false && ctx.sitePerms(ses, origin).geolocation === null, 'sites: заборона дозволу зберігається, решта лишається «запитувати»');
  ok(ctx.setSitePerm(ses, origin, 'media', true) && ctx.permDecision(ses, origin, 'media') === true, 'sites: дозвіл можна змінити');
  ok(ctx.setSitePerm(ses, origin, 'media', null) && ctx.permDecision(ses, origin, 'media') === null, 'sites: «Запитувати» прибирає збережене рішення');
  ok(!ctx.setSitePerm(ses, origin, 'camera-evil', true) && !ctx.setSitePerm(ses, 'null', 'media', true) && !ctx.setSitePerm(ses, 'javascript:alert(1)', 'media', true) && !ctx.setSitePerm(ses, '', 'media', true), 'sites: невідомі дозволи та некоректні адреси відхиляються');
  const inc = ctx.openWindow({ incognito: true });
  await sleep(2200);
  ctx.setSitePerm(inc.ses, origin, 'geolocation', true);
  ok(ctx.permDecision(inc.ses, origin, 'geolocation') === true && ctx.permDecision(ses, origin, 'geolocation') === null && !('https://example.org|geolocation' in ctx.permsStore.data), 'sites: у приватному вікні дозволи лишаються лише в пам’яті сеансу й не потрапляють у профіль');
  inc.win.close();

  // --- виняток блокувальника ---
  ctx.setAdblockAllowed('www.example.org', true);
  ok(ctx.adblockAllowed('sub.example.org') && ctx.adblockAllowed('example.org') && !ctx.adblockAllowed('example.com') && !ctx.adblockAllowed(''), 'sites: виняток діє для всього сайту (зареєстрований домен), але не для інших');
  ctx.setAdblockAllowed('example.org', false);
  ok(!ctx.adblockAllowed('example.org'), 'sites: виняток можна прибрати');

  // --- панель сайту на справжній сторінці ---
  const http = require('http');
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    res.setHeader('content-type', 'text/html');
    res.end('<title>site</title><img src="https://ad.doubleclick.net/pixel.gif"><p>hello</p>');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const w = [...ctx.windows][0];
  w.exec('newTab'); w.exec('go', base + '/'); await sleep(3500);
  const tab = w.active();
  ctx.setAdblockAllowed('127.0.0.1', false);
  ok(ctx.topHost(tab.view.webContents.id) === '127.0.0.1', 'sites: головний хост вкладки визначається за id вмісту');
  w.exec('reload'); await sleep(3000);
  const blockedOn = tab.blocked;
  ctx.setAdblockAllowed('127.0.0.1', true);
  w.exec('reload'); await sleep(3000);
  const blockedOff = tab.blocked;
  ctx.setAdblockAllowed('127.0.0.1', false);
  ok(blockedOn >= 1 && blockedOff === 0, `sites: на сайті з винятком рекламний запит не блокується (було ${blockedOn}, з винятком ${blockedOff})`);

  // cookie: очищення лише для цього сайту
  await ses.cookies.set({ url: base + '/', name: 'sid', value: '1' });
  await ses.cookies.set({ url: 'https://other-site.example/', name: 'keep', value: '1' });
  let data = await w.sitePanelData();
  ok(data.kind === 'http' && data.host === '127.0.0.1' && Object.keys(data.perms).join() === Object.keys(ASK).join() && data.cookies >= 1 && data.adblock.enabled, 'sites: дані панелі: тип з’єднання, хост, дозволи та кількість cookie');
  const removed = await ctx.clearSiteData(ses, '127.0.0.1');
  const left = await ses.cookies.get({ url: 'https://other-site.example/' });
  ok(removed >= 1 && (await ctx.siteCookies(ses, '127.0.0.1')).length === 0 && left.length === 1, 'sites: очищення видаляє cookie лише цього сайту');
  await ses.cookies.remove('https://other-site.example/', 'keep');

  // --- інтерфейс: замок → панель ---
  await sleep(300);
  const secText = await w.chrome.executeJavaScript(`document.getElementById('sec').textContent`);
  ok(/Не захищено/.test(secText), 'sites: для http-сторінки в адресному рядку показано «Не захищено»');
  await w.chrome.executeJavaScript(`document.getElementById('sec').click()`);
  await sleep(900);
  ok(w.overlayType === 'site', 'sites: клік на значок відкриває панель сайту');
  const dom = await w.overlay.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('.vh').textContent,
    selects: document.querySelectorAll('.site select').length,
    conn: document.querySelector('.sconn').textContent,
    hasAdblock: !!document.querySelector('.site input[type=checkbox]'),
  }))()`);
  ok(dom.title === '127.0.0.1' && dom.selects === Object.keys(ASK).length && /не захищене/.test(dom.conn) && dom.hasAdblock, 'sites: панель показує хост, попередження про http, дозволи й перемикач блокувальника');
  await w.overlay.webContents.executeJavaScript(`(() => { const s = document.querySelector('.site select'); s.value = 'false'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
  ok(ctx.permDecision(ses, base, 'media') === false, 'sites: вибір «Заблокувати» в панелі зберігає рішення для цього сайту');
  ctx.setSitePerm(ses, base, 'media', null);
  await w.overlay.webContents.executeJavaScript(`(() => { const c = document.querySelector('.site input[type=checkbox]'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
  await sleep(1500);
  ok(ctx.adblockAllowed('127.0.0.1'), 'sites: вимкнення перемикача блокувальника додає сайт у винятки');
  ctx.setAdblockAllowed('127.0.0.1', false);
  await ses.cookies.set({ url: base + '/', name: 'sid2', value: '1' });
  await w.refreshSiteOverlay(); await sleep(400);
  await w.overlay.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.site .vbtn')].find(x => /Очистити/.test(x.textContent)); b.click(); b.click(); })()`);
  await sleep(900);
  ok((await ctx.siteCookies(ses, '127.0.0.1')).length === 0, 'sites: кнопка очищення (з підтвердженням другим кліком) видаляє дані сайту');
  w.closeOverlay();

  // внутрішня сторінка
  w.exec('openPage', 'settings'); await sleep(1200);
  const internal = await w.sitePanelData();
  ok(internal.kind === 'internal' && internal.perms === null, 'sites: для внутрішніх сторінок налаштувань сайту немає');

  // --- налаштування: список і скидання ---
  ctx.setSitePerm(ses, 'https://list.example', 'notifications', false);
  ctx.setAdblockAllowed('list.example', true);
  const list = await w.wc().executeJavaScript(`w3ir.invoke('sites:list')`);
  ok(list.perms.some(p => p.origin === 'https://list.example' && p.perm === 'notifications' && p.value === false) && list.adblockAllow.includes('list.example'), 'sites: налаштування показують збережені дозволи й винятки');
  await w.wc().executeJavaScript(`w3ir.invoke('sites:resetPerm', { origin: 'https://list.example', perm: 'notifications' })`);
  await w.wc().executeJavaScript(`w3ir.invoke('sites:adblockRemove', { domain: 'list.example' })`);
  ok(ctx.permDecision(ses, 'https://list.example', 'notifications') === null && !ctx.adblockAllowed('list.example'), 'sites: скидання з налаштувань працює');
  w.exec('openPage', 'history'); await sleep(1200);
  ok(await w.wc().executeJavaScript(`w3ir.invoke('sites:list').then(() => 'allowed', () => 'denied')`) === 'denied', 'sites: інші внутрішні сторінки не мають доступу до керування сайтами');
  srv.close();
}

async function splitTests(ctx) {
  const w = ctx.openWindow({ urls: ['w3ir://newtab'] });
  await sleep(2500);
  w.win.setSize(1200, 800);
  await sleep(500);
  const a = w.tabs[0];
  const b = w.createTab('w3ir://history', { activate: false });
  const c = w.createTab('w3ir://downloads', { activate: false });
  await sleep(1500);
  w.switchTab(a.id);
  const kids = () => w.win.contentView.children;
  ok(w.startSplit(b.id) === true && w.split && w.split.a === a.id && w.split.b === b.id, 'split: розділений екран запускається для активної й вибраної вкладки');
  const [cw] = w.win.getContentSize();
  const ba = a.view.getBounds(), bb = b.view.getBounds();
  ok(ba.x === 0 && bb.x === ba.width + 6 && ba.width + 6 + bb.width === cw && ba.height === bb.height && ba.height > 300, 'split: дві панелі поруч без перекриття (проміжок 6 px)');
  ok(kids().includes(a.view) && kids().includes(b.view), 'split: обидві вкладки на екрані');
  b.view.webContents.focus();
  await sleep(400);
  ok(w.activeId === b.id && kids().includes(a.view) && kids().includes(b.view), 'split: фокус у правій панелі робить її активною, пара лишається');
  w.switchTab(c.id);
  ok(!kids().includes(a.view) && !kids().includes(b.view) && kids().includes(c.view) && w.split, 'split: перехід на сторонню вкладку ховає пару, але пам’ятає її');
  w.switchTab(a.id);
  ok(kids().includes(a.view) && kids().includes(b.view) && !kids().includes(c.view) && b.view.getBounds().width > 0, 'split: повернення до вкладки пари показує обидві');
  w.exec('splitRatio', 0.6);
  const r1 = a.view.getBounds().width / (cw - 6);
  ok(Math.abs(r1 - 0.6) < 0.01, 'split: пропорція 60 / 40');
  // перетягування межі: сторінки ховаються на час перетягування, потім повертаються з новою пропорцією
  await sleep(300);
  const geom = w.splitGeom;
  ok(geom && geom.top === w.chromeHeight && Math.abs(geom.ratio - 0.6) < 0.001 && await w.chrome.executeJavaScript(`!document.getElementById('splitbar').hidden && document.getElementById('splitbar').style.height === '${geom.height}px'`), 'split: у інтерфейсі є межа, яку можна перетягнути (позиція й висота з геометрії)');
  w.exec('splitDragStart');
  ok(!a.view.getVisible() && !b.view.getVisible() && w.splitDrag, 'split: на час перетягування сторінки ховаються (інтерфейс отримує події миші)');
  w.exec('splitDragEnd', 0.7);
  ok(a.view.getVisible() && b.view.getVisible() && !w.splitDrag && Math.abs(a.view.getBounds().width / (cw - 6) - 0.7) < 0.01, 'split: після перетягування сторінки повертаються з новою пропорцією');
  w.exec('splitDragStart'); w.exec('splitDragEnd', 5);
  ok(Math.abs(w.split.ratio - 0.75) < 0.001, 'split: пропорція при перетягуванні обмежена 25–75 %');
  w.exec('splitRatio', 0.6);
  w.exec('splitSwap');
  ok(w.split.a === b.id && w.split.b === a.id && b.view.getBounds().x === 0 && Math.abs(b.view.getBounds().width / (cw - 6) - 0.4) < 0.01, 'split: панелі міняються місцями разом із пропорцією');
  w.exec('splitEnd');
  ok(w.split === null && kids().includes(w.active().view) && !kids().some(k => k !== w.active().view && (k === a.view || k === b.view)) && w.active().view.getBounds().width === cw, 'split: закриття розділення лишає одну панель на всю ширину');
  w.startSplit(w.activeId === a.id ? b.id : a.id);
  w.exec('splitDragStart'); w.exec('splitEnd');
  ok(!w.splitDrag && kids().includes(w.active().view) && w.active().view.getVisible() && w.splitGeom === null, 'split: закриття розділення під час перетягування не лишає сторінки схованими');
  const n0 = w.tabs.length;
  w.exec('splitNew');
  await sleep(600);
  ok(w.tabs.length === n0 + 1 && w.split && w.split.b === w.activeId && kids().filter(k => w.tabs.some(t => t.view === k)).length === 2, 'split: «нова вкладка поруч» відкриває пару й активує нову вкладку');
  w.closeTab(w.split.b);
  await sleep(300);
  ok(w.split === null, 'split: закриття вкладки пари завершує розділення');
  const ag = ctx.openWindow({ incognito: true, agent: true, urls: ['about:blank'] });
  await sleep(1500);
  ok(ag.startSplit(ag.tabs[0].id) === false && ag.splitCommands().length === 0, 'split: у вікні ШІ розділення недоступне');
  ag.win.destroy();
  w.win.destroy();
}

async function fullscreenTests(ctx) {
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><title>fs</title><p>fs</p>'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const w = ctx.openWindow({ urls: [base] });
  await sleep(2800);
  w.win.setSize(1200, 800);
  await sleep(500);
  const wc = () => w.wc();
  const reqFs = () => wc().executeJavaScript(`document.documentElement.requestFullscreen().then(() => 'ok', e => String(e))`, true);
  const key = (k) => { wc().sendInputEvent({ type: 'keyDown', keyCode: k }); wc().sendInputEvent({ type: 'keyUp', keyCode: k }); };
  const normal = () => !w.htmlFullscreen && !w.win.isFullScreen() && w.active().view.getBounds().y === w.chromeHeight;

  await reqFs(); await sleep(1200);
  ok(w.htmlFullscreen && w.win.isFullScreen() && w.active().view.getBounds().y === 0, 'fullscreen: повноекранний режим сайту ховає інтерфейс');
  key('F11'); await sleep(1500);
  ok(normal(), 'fullscreen: F11 під час повного екрана сайту повертає звичайний вигляд з панеллю вкладок (було: лишався без інтерфейсу)');
  ok(await wc().executeJavaScript('String(document.fullscreenElement)') === 'null', 'fullscreen: сайт теж вийшов із повноекранного режиму');

  await reqFs(); await sleep(1200);
  key('Escape'); await sleep(1500);
  ok(normal(), 'fullscreen: Esc виходить із повного екрана сайту');

  await reqFs(); await sleep(1200);
  w.exec('fullscreen'); await sleep(1500);
  ok(normal(), 'fullscreen: пункт меню «На весь екран» під час повного екрана сайту теж повертає інтерфейс');

  // закриття вкладки в повноекранному режимі сайту
  const t2 = w.createTab(base, { activate: true });
  await sleep(1800);
  await reqFs(); await sleep(1200);
  const n = w.tabs.length;
  w.closeTab(t2.id); await sleep(1500);
  ok(w.tabs.length === n - 1 && normal(), 'fullscreen: закриття вкладки в повноекранному режимі сайту повертає інтерфейс');

  // перемикання вкладки
  const t3 = w.createTab(base, { activate: false });
  await sleep(1500);
  await reqFs(); await sleep(1200);
  w.switchTab(t3.id); await sleep(1200);
  ok(normal(), 'fullscreen: перемикання вкладки скидає повний екран сайту');

  // вікно вже на весь екран (F11), потім відео: Esc повертає лише з відео
  w.exec('fullscreen'); await sleep(1300);
  ok(w.win.isFullScreen() && !w.htmlFullscreen, 'fullscreen: звичайний повний екран вікна вмикається');
  await reqFs(); await sleep(1200);
  key('Escape'); await sleep(1500);
  ok(w.win.isFullScreen() && !w.htmlFullscreen && w.active().view.getBounds().y === w.chromeHeight, 'fullscreen: вікно на весь екран + відео: Esc виходить лише з відео, вікно лишається на весь екран, інтерфейс видно');
  w.exec('fullscreen'); await sleep(1300);
  ok(normal(), 'fullscreen: повторне «На весь екран» повертає звичайний вигляд');
  w.exec('closeTab', w.activeId); await sleep(500);
  w.win.destroy();
  srv.close();
}

async function guardTests() {
  const { debugFlag, shouldBlock } = require('../../src/launch-guard');
  ok(['--remote-debugging-port=9222', '--remote-debugging-pipe', '--remote-allow-origins=*', '--inspect=9229', '--inspect-brk', '--remote-debugging-address=0.0.0.0'].every(f => debugFlag(['x.exe', f]) === f), 'guard: параметри налагодження розпізнаються');
  ok(debugFlag(['x.exe', '--user-data-dir=C:\\t', '--disable-gpu', 'https://example.com', '--updated', '/S']) === null && debugFlag(undefined) === null, 'guard: звичайні параметри не вважаються налагодженням');
  ok(shouldBlock({ argv: ['x', '--remote-debugging-port=1'], packaged: true, env: {} }) === true && shouldBlock({ argv: ['x', '--remote-debugging-port=1'], packaged: true, env: { W3IR_ALLOW_DEBUG: '1' } }) === false && shouldBlock({ argv: ['x', '--remote-debugging-port=1'], packaged: false, env: {} }) === false && shouldBlock({ argv: ['x'], packaged: true, env: {} }) === false, 'guard: блокування лише в упакованій збірці без явного дозволу');
}

async function tabCloseTests(ctx) {
  const w = ctx.openWindow({ urls: ['http://127.0.0.1:1/start'] });
  await sleep(2500);
  w.win.setSize(1300, 800);
  await sleep(500);
  for (const u of ['http://127.0.0.1:1/a', 'http://127.0.0.1:1/b', 'http://127.0.0.1:1/c', 'w3ir://history', 'w3ir://downloads']) w.createTab(u, { activate: false });
  await sleep(1500);
  const rect = (sel) => w.chrome.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const slowClick = async (p, hold) => { w.chrome.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y }); w.chrome.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await sleep(hold); w.chrome.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 }); await sleep(700); };
  // «людський» клік: кнопка утримується 150–300 мс, за цей час приходять оновлення стану
  let n = w.tabs.length;
  await slowClick(await rect('.tab:last-of-type .close'), 150);
  ok(w.tabs.length === n - 1, 'вкладки: хрестик неактивної вкладки закриває її при повільному кліку (було: не працював)');
  n = w.tabs.length;
  const activeBefore = w.activeId;
  await slowClick(await rect('.tab:nth-of-type(2) .close'), 300);
  ok(w.tabs.length === n - 1 && w.activeId === activeBefore, 'вкладки: хрестик не перемикає на вкладку, яку закриває, і працює при утриманні 300 мс');
  n = w.tabs.length;
  await slowClick(await rect('.tab.active .close'), 200);
  ok(w.tabs.length === n - 1, 'вкладки: хрестик активної вкладки закриває її при повільному кліку');
  // перемальовування відкладається лише на час натискання й виконується після відпускання
  const before = await w.chrome.executeJavaScript(`document.querySelectorAll('.tab').length`);
  w.chrome.sendInputEvent({ type: 'mouseDown', x: 700, y: 300, button: 'left', clickCount: 1 });
  w.createTab('http://127.0.0.1:1/z', { activate: false });
  await sleep(300);
  const during = await w.chrome.executeJavaScript(`document.querySelectorAll('.tab').length`);
  w.chrome.sendInputEvent({ type: 'mouseUp', x: 700, y: 300, button: 'left', clickCount: 1 });
  await sleep(300);
  const after = await w.chrome.executeJavaScript(`document.querySelectorAll('.tab').length`);
  ok(during === before && after === before + 1, 'вкладки: оновлення панелі відкладається, поки кнопка миші натиснута, і застосовується після відпускання');
  w.win.destroy();
}

async function tabFeatureTests(ctx) {
  const srvT = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end('<!doctype html><title>t</title><p>t</p>'); });
  await new Promise(r => srvT.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srvT.address().port}/`;
  const { stripCtl, cleanStrict, isWebUrl } = require('../../src/util');
  ok(stripCtl('a\u0000b\u007fc\u0085d\ne') === 'a b c d e' && stripCtl('x'.repeat(300), 10) === 'x'.repeat(10) && stripCtl(null) === '', 'util: stripCtl замінює керівні символи й обрізає');
  ok(cleanStrict('  a\u200b  b\u202ec \t d ') === 'a b c d' && isWebUrl('https://a') && isWebUrl('HTTP://a') && !isWebUrl('w3ir://a') && !isWebUrl(undefined), 'util: cleanStrict (невидимі й двонаправлені символи, пробіли), isWebUrl');

  const w = ctx.openWindow({ urls: [base + 'a', base + 'b', base + 'c', base + 'd'] });
  await sleep(3000);
  w.win.setSize(1200, 800);
  await sleep(400);
  const [t1, t2, t3, t4] = w.tabs;

  // --- закрити інші в групі ---
  const gid = w.newGroup([t1.id, t2.id, t3.id]);
  ok(gid && w.groupTabs(gid).length === 3, 'tabs: група з трьох вкладок створена');
  w.exec('closeOthersInGroup', t2.id);
  await sleep(500);
  ok(w.tabs.includes(t2) && !w.tabs.includes(t1) && !w.tabs.includes(t3) && w.tabs.includes(t4) && w.activeId === t2.id, 'tabs: «закрити інші в групі» лишає цю вкладку й вкладки поза групою, активує вибрану');
  w.exec('closeOthersInGroup', t4.id);
  ok(w.tabs.length === 2, 'tabs: для вкладки поза групою команда нічого не закриває');
  const labels = (() => { const items = w.tabGroupMenuItems(t2).map(i => i.label); return items; })();
  ok(labels.includes('Закрити інші вкладки групи'), 'tabs: пункт «Закрити інші вкладки групи» є в меню вкладки групи');

  // --- вкладка в нове вікно ---
  const t5 = w.createTab(base + 'e', { activate: false });
  await sleep(600);
  const wins0 = ctx.windows.size;
  const n0 = w.tabs.length;
  w.exec('tabToWindow', { id: t5.id });
  await sleep(2500);
  const nw = [...ctx.windows].find(x => x !== w && !x.incognito && x.tabs.some(t => /\/e$/.test(t.view.webContents.getURL())));
  ok(ctx.windows.size === wins0 + 1 && nw && w.tabs.length === n0 - 1 && !w.tabs.includes(t5), 'tabs: вкладку можна перенести в нове вікно (сторінка відкрилась у новому, у старому закрита)');
  if (nw) nw.win.destroy();
  const last = ctx.openWindow({ urls: [base + 'only'] });
  await sleep(2200);
  const wins1 = ctx.windows.size;
  last.exec('tabToWindow', { id: last.tabs[0].id });
  await sleep(500);
  ok(ctx.windows.size === wins1 && last.tabs.length === 1, 'tabs: єдину вкладку вікна в нове вікно не переносимо');
  last.win.destroy();
  const inc = ctx.openWindow({ incognito: true, urls: [base + 'p', base + 'q'] });
  await sleep(2500);
  const wins2 = ctx.windows.size;
  inc.exec('tabToWindow', { id: inc.tabs[0].id });
  await sleep(500);
  ok(ctx.windows.size === wins2 && inc.tabs.length === 2, 'tabs: у приватному вікні перенесення вимкнено (інакше зникли б входи тимчасового сеансу)');
  inc.win.destroy();

  // перетягування за межі панелі: подія dragend із координатами поза панеллю
  const wins3 = ctx.windows.size;
  const nb = w.tabs.length;
  await w.chrome.executeJavaScript(`(() => { const tab = document.querySelector('.tab:last-of-type'); const dt = new DataTransfer(); tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, clientX: 600, clientY: 400, dataTransfer: dt })); })()`);
  await sleep(2500);
  ok(ctx.windows.size === wins3 + 1 && w.tabs.length === nb - 1, 'tabs: вкладка, відпущена за межами панелі вкладок, виноситься в нове вікно');
  for (const x of [...ctx.windows]) if (x !== w && !x.incognito && x.tabs.length === 1 && x.tabs[0].view.webContents.getURL().startsWith(base)) x.win.destroy();
  w.createTab(base + 'f', { activate: false }); await sleep(800);
  await w.chrome.executeJavaScript(`(() => { const tab = document.querySelector('.tab'); const dt = new DataTransfer(); tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, clientX: 0, clientY: 0, dataTransfer: dt })); })()`);
  await sleep(600);
  ok(ctx.windows.size === wins3, 'tabs: скасоване перетягування (Esc, координати 0,0) вкладку не виносить');

  // --- пара розділеного екрана зберігається в сеансі ---
  const s = ctx.openWindow({ urls: [base + 's1', base + 's2', base + 's3'] });
  await sleep(3000);
  s.win.setSize(1200, 800);
  s.switchTab(s.tabs[0].id);
  s.startSplit(s.tabs[2].id);
  s.exec('splitRatio', 0.6);
  const snap = s.snapshot();
  ok(snap.split && snap.split.a === 0 && snap.split.b === 2 && Math.abs(snap.split.ratio - 0.6) < 0.001, 'session: пара розділеного екрана потрапляє в знімок сеансу (індекси й пропорція)', snap.split);
  const r = ctx.openWindow({ ...snap, urls: snap.urls });
  await sleep(3500);
  const kids = () => r.win.contentView.children;
  ok(r.split && r.split.a === r.tabs[0].id && r.split.b === r.tabs[2].id && Math.abs(r.split.ratio - 0.6) < 0.001 && kids().includes(r.tabs[0].view) && kids().includes(r.tabs[2].view), 'session: розділений екран відновлюється з сеансу (та сама пара й пропорція)');
  const bad = [{ a: 0, b: 0, ratio: 0.5 }, { a: 5, b: 1, ratio: 0.5 }, { a: 'x', b: 1 }, { a: -1, b: 1 }, null];
  let bad0 = true;
  for (const sp of bad) {
    const rb = ctx.openWindow({ urls: [base + 'b1', base + 'b2'], split: sp });
    await sleep(2200);
    if (rb.split) bad0 = false;
    rb.win.destroy();
  }
  ok(bad0, 'session: пошкоджені дані розділеного екрана (однакові/неіснуючі індекси, не числа) ігноруються');
  const rr = ctx.openWindow({ urls: [base + 'b1', base + 'b2'], split: { a: 0, b: 1, ratio: 99 } });
  await sleep(2500);
  ok(rr.split && rr.split.ratio === 0.75, 'session: пропорція з сеансу обмежується діапазоном 25–75 %');
  rr.win.destroy(); r.win.destroy(); s.win.destroy(); w.win.destroy();
  srvT.close();
}

module.exports = { groupTests, siteTests, splitTests, fullscreenTests, guardTests, tabCloseTests, tabFeatureTests };
