'use strict';
// Безпечна публікація релізу на GitHub: чернетка → вивантаження файлів → latest.yml останнім → перевірка → публікація → контроль публічної адреси.
// Клієнти бачать реліз (і latest.yml) лише тоді, коли всі файли вже на місці та перевірені.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function gh(args, opts = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', ...opts });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

async function publishDraft({ repo, tag, dir, title, notes, prerelease = false, manifest = 'latest.yml', log = console.log }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Вкажіть репозиторій у форматі owner/repo');
  const names = fs.readdirSync(dir);
  if (!names.includes(manifest)) throw new Error(`У теці релізу немає ${manifest}`);
  const others = names.filter(n => n !== manifest).map(n => path.join(dir, n));
  const ymlPath = path.join(dir, manifest);

  if (gh(['release', 'view', tag, '--repo', repo]).ok) {
    throw new Error(`Реліз ${tag} уже існує. Опублікований реліз змінювати не можна (хеші, підписи та маніфест winget вже використані) — збільште версію.`);
  }

  log(`1/6 Створюємо чернетку ${tag} і вивантажуємо ${others.length} файл(и)…`);
  const create = gh(['release', 'create', tag, ...others, '--repo', repo, '--title', title, '--notes', notes, '--draft', ...(prerelease ? ['--prerelease'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (!create.ok) throw new Error('Не вдалося створити чернетку: ' + create.err);

  const abort = (msg) => { throw new Error(msg + `\nЧернетка ${tag} лишилася неопублікованою (клієнти її не бачать). Видалити: gh release delete ${tag} --repo ${repo} --cleanup-tag --yes`); };

  log(`2/6 Вивантажуємо ${manifest} (останнім)…`);
  const up = gh(['release', 'upload', tag, ymlPath, '--repo', repo]);
  if (!up.ok) abort(`Не вдалося вивантажити ${manifest}: ` + up.err);

  log('3/6 Перевіряємо, що всі файли на місці й розміри збігаються…');
  const view = gh(['release', 'view', tag, '--repo', repo, '--json', 'assets,isDraft']);
  if (!view.ok) abort('Не вдалося прочитати чернетку: ' + view.err);
  const info = JSON.parse(view.out);
  if (!info.isDraft) abort('Реліз несподівано не є чернеткою.');
  const remote = new Map(info.assets.map(a => [a.name, a.size]));
  for (const n of names) {
    const size = fs.statSync(path.join(dir, n)).size;
    if (remote.get(n.replace(/ /g, '.')) !== size && remote.get(n) !== size) abort(`Файл ${n} відсутній або має інший розмір на GitHub.`);
  }

  log('4/6 Публікуємо реліз…');
  const pub = gh(['release', 'edit', tag, '--repo', repo, '--draft=false']);
  if (!pub.ok) abort('Не вдалося опублікувати: ' + pub.err);

  log('5/6 Контрольна перевірка публічної адреси…');
  const url = `https://github.com/${repo}/releases/download/${tag}/${manifest}`;
  let ok = false, reason = '';
  for (let i = 0; i < 6 && !ok; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      ok = res.ok && text === fs.readFileSync(ymlPath, 'utf8');
      if (!ok) reason = `HTTP ${res.status}${res.ok ? ', вміст відрізняється' : ''}`;
    } catch (e) { reason = e.message; }
    if (!ok) await new Promise(r => setTimeout(r, 3000));
  }
  if (!ok) {
    gh(['release', 'edit', tag, '--repo', repo, '--draft=true']); // повертаємо в чернетку, щоб клієнти не побачили зламаний реліз
    throw new Error('Публічна перевірка ' + manifest + ' не пройшла (' + reason + '). Реліз повернуто в чернетку.');
  }
  // GitHub кешує адресу «останнього релізу» ще кілька хвилин: чекаємо, поки клієнти почнуть бачити нову версію (не критично)
  if (!prerelease) {
    log('6/6 Чекаємо, поки GitHub почне віддавати реліз як «останній» (клієнти побачать його одразу після цього)…');
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      try {
        const r = await fetch(`https://github.com/${repo}/releases/latest`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
        seen = r.ok && (await r.json()).tag_name === tag;
      } catch { /* ще не готово */ }
      if (!seen) await new Promise(r => setTimeout(r, 6000));
    }
    log(seen ? 'Реліз видно як останній — оновлення доступні клієнтам.' : 'Увага: GitHub ще віддає попередню версію як «останню» (кеш). Оновлення з’являться за кілька хвилин.');
  }
  return `https://github.com/${repo}/releases/tag/${tag}`;
}

module.exports = { publishDraft };
