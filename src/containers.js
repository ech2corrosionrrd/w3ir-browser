'use strict';
// Контейнери вкладок: кожен має власні cookie, localStorage і кеш (окрема постійна сесія Electron), тож вхід в один
// контейнер не видно в інших. Набір фіксований: вкладка поза контейнером працює в основній сесії профілю.
const CONTAINERS = [
  { id: 'work', name: 'Робота', color: '#2f7de1' },
  { id: 'social', name: 'Соцмережі', color: '#d6409f' },
  { id: 'shopping', name: 'Покупки', color: '#e8943a' },
  { id: 'finance', name: 'Фінанси', color: '#2e9e6b' },
];

const byId = new Map(CONTAINERS.map(c => [c.id, c]));
const info = (id) => byId.get(id) || null;
const valid = (id) => byId.has(id);

module.exports = { CONTAINERS, info, valid };
