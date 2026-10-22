'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { ok, sleep, tmp } = require('../lib');

async function githubTests(ctx) {
  const { GitHub, htmlFromApi, githubRepo } = require('../../src/github');
  const calls = [];
  const notif = [
    { id: '11', reason: 'review_requested', updated_at: '2026-01-01T00:00:00Z', subject: { title: 'Fix <b>bug</b>', type: 'PullRequest', url: 'https://api.github.com/repos/o/r/pulls/5' }, repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' } },
    { id: '12', reason: 'mention', updated_at: '2026-01-02T00:00:00Z', subject: { title: 'Evil', type: 'Issue', url: 'https://evil.example/repos/o/r/issues/9' }, repository: { full_name: 'o/r', html_url: 'https://evil.example/o/r' } },
    { id: '13', reason: 'subscribed', updated_at: '2026-01-03T00:00:00Z', subject: { title: 'Release', type: 'Release', url: 'https://api.github.com/repos/o/r/releases/77' }, repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' } },
  ];
  const srv = http.createServer((req, res) => {
    calls.push(req.method + ' ' + req.url + ' auth=' + (req.headers.authorization || ''));
    const send = (code, body, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bearer ghp_validtoken1234567890abcdef') return send(401, { message: 'Bad credentials' });
    if (req.url === '/user') return send(200, { login: 'octo' });
    if (req.url.startsWith('/notifications?')) {
      if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304); return res.end(); }
      return send(200, notif, { etag: '"v1"', 'x-poll-interval': '60' });
    }
    if (req.url.startsWith('/search/issues')) return send(200, { items: [
      { title: 'Review me', number: 7, html_url: 'https://github.com/o/r/pull/7', repository_url: 'https://api.github.com/repos/o/r', updated_at: '2026-01-04T00:00:00Z' },
      { title: 'Phish', number: 8, html_url: 'https://github.com.evil.example/o/r/pull/8', repository_url: 'https://api.github.com/repos/o/r', updated_at: '2026-01-04T00:00:00Z' },
    ] });
    if (req.method === 'PATCH' || req.method === 'PUT') { res.writeHead(205); return res.end(); }
    send(404, {});
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const dir = tmp('gh');
  const g = new GitHub({ dir, apiBase: `http://127.0.0.1:${srv.address().port}`, allowInsecure: true });

  let bad = ''; try { await g.connect('ghp_wrongtoken1234567890abcdef'); } catch (e) { bad = e.message; }
  ok(/відхилив/.test(bad) && !g.connected(), 'github: недійсний токен відхилено');
  let fmt = false; try { await g.connect('x y"z'); } catch { fmt = true; }
  ok(fmt, 'github: токен некоректного формату відхилено');

  const token = 'ghp_validtoken1234567890abcdef';
  const st = await g.connect(token);
  await sleep(600);
  ok(st.login === 'octo' && g.connected(), 'github: підключення, логін отримано');
  ok(!fs.readFileSync(path.join(dir, 'github.token')).toString('latin1').includes(token), 'github: токен на диску зашифрований (DPAPI)');
  ok(g.state.notifications.length === 2 && g.state.notifications.every(n => /^https:\/\/github\.com\//.test(n.url)), 'github: сповіщення з коректними html-адресами, підроблений домен відкинуто');
  ok(g.state.notifications.find(n => n.id === '11').url === 'https://github.com/o/r/pull/5' && g.state.notifications.find(n => n.id === '13').url === 'https://github.com/o/r/releases', 'github: API-адреси перетворено на сторінки (pull, releases)');
  ok(g.state.reviews.length === 1 && g.state.reviews[0].number === 7, 'github: запити на рев\u2019ю (фішинговий домен відкинуто)');
  ok(g.count() === 3, 'github: лічильник для значка');
  const json = JSON.stringify(g.panel());
  ok(!json.includes(token), 'github: токен не потрапляє у дані для інтерфейсу');
  await g.refresh();
  ok(calls.some(c => c.startsWith('GET /notifications')) && g.interval === 60000, 'github: інтервал опитування з X-Poll-Interval');
  await g.markRead('11');
  ok(g.state.notifications.length === 1, 'github: сповіщення позначено прочитаним');
  await g.markAllRead();
  ok(g.state.notifications.length === 0, 'github: усе позначено прочитаним');
  let insecure = false; const g2 = new GitHub({ dir: tmp('gh2'), apiBase: 'http://example.com' }); g2.token = token;
  try { await g2._api('GET', '/user'); } catch { insecure = true; }
  ok(insecure, 'github: http API-адресу без дозволу заборонено (токен не піде відкритим текстом)');
  g.disconnect();
  ok(!g.connected() && !fs.existsSync(path.join(dir, 'github.token')), 'github: відключення видаляє токен');
  srv.close();

  ok(htmlFromApi('https://api.github.com/repos/a/b/issues/3', null) === 'https://github.com/a/b/issues/3', 'github: htmlFromApi issues');
  ok(htmlFromApi('https://evil.example/repos/a/b/issues/3', 'https://evil.example/a/b') === null, 'github: htmlFromApi відкидає чужі домени');
  const gr = githubRepo('https://github.com/microsoft/vscode/blob/main/src/a.ts');
  ok(gr && gr.owner === 'microsoft' && gr.kind === 'blob' && gr.rest[0] === 'main', 'github: розбір адреси репозиторію');
  ok(githubRepo('https://github.com/settings/profile') === null && githubRepo('https://github.com.evil.example/a/b') === null && githubRepo('http://github.com/a/b') === null, 'github: службові сторінки та підроблені домени не розпізнаються');

  // ключові слова адресного рядка
  ok(ctx.resolveInput('gh microsoft/vscode') === 'https://github.com/microsoft/vscode', 'keywords: gh owner/repo');
  ok(ctx.resolveInput('ghi microsoft/vscode') === 'https://github.com/microsoft/vscode/issues', 'keywords: ghi');
  ok(/github\.com\/search\?q=hello%20world&type=repositories/.test(ctx.resolveInput('gh hello world')), 'keywords: gh пошук репозиторіїв');
  ok(ctx.resolveInput('npm react') === 'https://www.npmjs.com/search?q=react', 'keywords: npm');
  ok(ctx.resolveInput('ghp microsoft/vscode') === 'https://github.com/microsoft/vscode/pulls', 'keywords: ghp');
  ok(ctx.resolveInput('gha microsoft/vscode') === 'https://github.com/microsoft/vscode/actions', 'keywords: gha');
  ok(ctx.resolveInput('ghc microsoft/vscode') === 'https://github.com/microsoft/vscode/commits', 'keywords: ghc');
}

module.exports = { githubTests };
