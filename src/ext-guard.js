'use strict';
// Захист розширень Chrome, які користувач додає з папки: опис дозволів для підтвердження і хеш вмісту теки.
// Хеш рахується при додаванні й звіряється при кожному запуску: змінене ззовні розширення (підміна скрипта, оновлення «в обхід»)
// не завантажується, доки користувач знову його не додасть і не підтвердить дозволи.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILES = 5000;
const MAX_BYTES = 64 * 1024 * 1024;
// дозволи, що дають розширенню особливо широкі можливості
const RISKY = ['<all_urls>', 'webRequest', 'webRequestBlocking', 'cookies', 'debugger', 'nativeMessaging', 'history', 'tabs', 'management', 'proxy', 'clipboardRead', 'downloads', 'declarativeNetRequest'];
const BROAD_HOST = /^(\*|https?):\/\/\*\/|^<all_urls>$/;

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) { out.push({ rel, link: fs.readlinkSync(full) }); continue; } // посилання не розкриваємо: хешується лише ціль-рядок
    if (st.isDirectory()) { walk(full, base, out); continue; }
    if (st.isFile()) out.push({ rel, full, size: st.size });
    if (out.length > MAX_FILES) throw new Error('Забагато файлів у розширенні.');
  }
}

// SHA-256 за впорядкованим списком «відносний шлях + вміст»; змінюється при будь-якій зміні, додаванні чи видаленні файлу
function hashDir(dir) {
  const files = [];
  walk(dir, dir, files);
  const h = crypto.createHash('sha256');
  let total = 0;
  for (const f of files) {
    h.update(`${f.rel}\0`);
    if (f.link !== undefined) { h.update(`link:${f.link}\0`); continue; }
    total += f.size;
    if (total > MAX_BYTES) throw new Error('Розширення завелике.');
    h.update(fs.readFileSync(f.full));
    h.update('\0');
  }
  return h.digest('hex');
}

function readManifest(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (!m || typeof m !== 'object') throw new Error('manifest.json пошкоджено.');
  return m;
}

// Дані для діалогу підтвердження
function summarize(m) {
  const str = (a) => (Array.isArray(a) ? a.filter(x => typeof x === 'string') : []);
  const perms = [...new Set([...str(m.permissions), ...str(m.host_permissions)])];
  for (const cs of Array.isArray(m.content_scripts) ? m.content_scripts : []) for (const x of str(cs && cs.matches)) if (!perms.includes(x)) perms.push(x);
  const risky = perms.filter(p => RISKY.includes(p) || BROAD_HOST.test(p));
  return {
    name: String(m.name || '').slice(0, 80),
    version: String(m.version || '').slice(0, 30),
    manifestVersion: Number(m.manifest_version) || 0,
    perms,
    risky,
    background: !!(m.background && (m.background.service_worker || m.background.scripts || m.background.page)),
  };
}

module.exports = { hashDir, readManifest, summarize, RISKY };
