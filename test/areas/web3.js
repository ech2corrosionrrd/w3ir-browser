'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Vault } = require('../../src/vault');
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
  ok(/google\.com\/search\?q=so%20far/.test(ctx.resolveInput('so far so good')), 'keywords: звичайні запити («so …») не перехоплюються');
  const prevKw = ctx.cfg().keywords;
  ctx.cfg().keywords = 'rust = https://doc.rust-lang.org/std/?search=%s\nbad = javascript:alert(%s)';
  ok(ctx.resolveInput('rust vec push') === 'https://doc.rust-lang.org/std/?search=vec%20push', 'keywords: власне ключове слово');
  ok(!/^javascript:/.test(ctx.resolveInput('bad x')), 'keywords: небезпечні шаблони (javascript:) ігноруються');
  ctx.cfg().keywords = prevKw;
}

async function walletTests(ctx) {
  const E = require('ethers');
  const { Wallet: W, describeCall, isSafeRpc } = require('../../src/wallet');
  const { Store } = require('../../src/store');
  const MASTER = 'Wallet-Master-Pass-55!';

  // --- модульні перевірки ---
  const MAX = E.MaxUint256;
  const iface = new E.Interface(['function approve(address,uint256)', 'function setApprovalForAll(address,bool)']);
  const spender = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  ok(describeCall(iface.encodeFunctionData('approve', [spender, MAX])).warnings.some(w => /Необмежений/.test(w)), 'wallet: необмежений approve розпізнається й має попередження');
  ok(!describeCall(iface.encodeFunctionData('approve', [spender, 1000n])).warnings.length, 'wallet: обмежений approve без тривоги');
  ok(describeCall(iface.encodeFunctionData('setApprovalForAll', [spender, true])).warnings.some(w => /ВСІ/.test(w)), 'wallet: setApprovalForAll(true) — попередження про ВСІ NFT');
  ok(describeCall('0xdeadbeef00').warnings.length === 1, 'wallet: невідомий виклик контракту має попередження');
  ok(isSafeRpc('https://rpc.example') && isSafeRpc('http://127.0.0.1:8545') && !isSafeRpc('http://evil.example') && !isSafeRpc('javascript:alert(1)'), 'wallet: безпечні/небезпечні RPC-адреси');

  // --- ізоляція від реальних даних користувача ---
  const real = { vault: ctx.vault, wallet: ctx.wallet, settings: ctx.settingsStore };
  ctx.settingsStore = new Store('t-wallet-settings', JSON.parse(JSON.stringify(real.settings.data)), tmp('wset'));
  ctx.vault = new Vault({ dir: tmp('wvault'), onChange: () => { ctx.pushAll(); ctx.wallet.onVaultChange(); } });
  ctx.wallet = new W(ctx, { allowInsecureRpc: true });
  const wal = ctx.wallet;
  await ctx.vault.create(MASTER);
  ok(!wal.exists(), 'wallet: до створення гаманця немає');
  let bad = ''; try { wal.importPhrase('not a valid phrase at all'); } catch (e) { bad = e.message; }
  ok(/Некоректна фраза/.test(bad), 'wallet: некоректна фраза відхилена');
  const phrase = wal.create();
  const addr0 = wal.section().addresses[0];
  const priv0 = wal._derive(phrase, 0).privateKey;
  ok(phrase.split(' ').length === 12 && E.isAddress(addr0) && wal.exists(), 'wallet: створення (12 слів, адреса)');
  const raw = require('fs').readFileSync(path.join(ctx.vault.dir, 'vault.bin'), 'utf8');
  ok(!raw.includes(phrase.split(' ')[0] + ' ') && !raw.includes(addr0), 'wallet: у файлі сховища немає відкритих даних гаманця');

  // --- мок RPC ---
  const rawTxs = [];
  const rpc = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const one = (j) => {
        const r = (result) => ({ jsonrpc: '2.0', id: j.id, result });
        switch (j.method) {
          case 'eth_chainId': return r('0x7a69');
          case 'net_version': return r('31337');
          case 'eth_getBalance': return r('0x56bc75e2d63100000');
          case 'eth_blockNumber': return r('0x10');
          case 'eth_getBlockByNumber': return r({ number: '0x10', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), timestamp: '0x65000000', nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0', miner: '0x' + '00'.repeat(20), extraData: '0x', baseFeePerGas: '0x3b9aca00', transactions: [], mixHash: '0x' + '00'.repeat(32), sha3Uncles: '0x' + '00'.repeat(32), logsBloom: '0x' + '00'.repeat(256), stateRoot: '0x' + '00'.repeat(32), receiptsRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32), size: '0x100', uncles: [] });
          case 'eth_maxPriorityFeePerGas': return r('0x59682f00');
          case 'eth_gasPrice': return r('0x3b9aca00');
          case 'eth_getTransactionCount': return r('0x5');
          case 'eth_estimateGas': return r('0x5208');
          case 'eth_call': return r('0x');
          case 'eth_sendRawTransaction': rawTxs.push(j.params[0]); return r(E.keccak256(j.params[0]));
          default: return { jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'no ' + j.method } };
        }
      };
      let json; try { json = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(json) ? json.map(one) : one(json)));
    });
  });
  await new Promise(r => rpc.listen(0, '127.0.0.1', r));
  const section = wal.section();
  section.networks.push({ chainId: 31337, name: 'Test', symbol: 'TST', rpc: `http://127.0.0.1:${rpc.address().port}`, explorer: '' });
  section.activeChain = 31337;
  ctx.vault.persist();
  ctx.cfg().walletChain = 31337;

  // --- сайти-dApp: A без CSP-обмежень, B із суворим CSP ---
  const html = '<html><head><title>dapp</title></head><body>dapp</body></html>';
  const mkSite = async (csp) => {
    const s = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); if (csp) res.setHeader('content-security-policy', csp); res.end(html); });
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    return { s, url: `http://127.0.0.1:${s.address().port}/` , origin: `http://127.0.0.1:${s.address().port}` };
  };
  const A = await mkSite(null);
  const B = await mkSite("default-src 'none'; script-src 'none'");

  const w = [...ctx.windows][0];
  const waitApproval = async () => { for (let i = 0; i < 60 && !w.approval; i++) await sleep(100); return w.approval; };
  const leaks = [];
  const scan = (x) => { const s = JSON.stringify(x); if (s.includes(priv0) || s.includes(phrase.split(' ').slice(0, 3).join(' '))) leaks.push(s.slice(0, 80)); };
  const call = (wc, method, params) => wc.executeJavaScript(`ethereum.request(${JSON.stringify({ method, params })}).then(r => ({ ok: r }), e => ({ err: e.code, msg: String(e.message) }))`);
  const decide = async (approve, master) => { const a = w.approval; scan(a.spec); const r = await w.decide(a.id, approve, master); return r; };

  w.exec('newTab'); w.exec('go', A.url); await sleep(1800);
  const wcA = w.wc();
  ok(await wcA.executeJavaScript('typeof window.ethereum') === 'object' && await wcA.executeJavaScript('window.ethereum.isW3IR === true'), 'wallet: провайдер window.ethereum доступний сторінці');
  ok(await wcA.executeJavaScript(`new Promise(r => { addEventListener('eip6963:announceProvider', e => r(e.detail.info.rdns)); dispatchEvent(new Event('eip6963:requestProvider')); })`) === 'app.w3ir.wallet', 'wallet: EIP-6963 анонсує гаманець');
  ok((await wcA.executeJavaScript(`Object.keys(window).filter(k => k.startsWith('__w3ir')).length`)) === 0, 'wallet: внутрішній міст не лишається у глобальному об\u2019єкті сторінки');
  ok((await call(wcA, 'eth_chainId')).ok === '0x7a69' && (await call(wcA, 'eth_accounts')).ok.length === 0, 'wallet: chainId доступний, рахунків до підключення немає');

  // підключення
  let pr = call(wcA, 'eth_requestAccounts');
  const ap = await waitApproval();
  ok(ap && ap.spec.kind === 'connect' && ap.spec.origin === A.origin, 'wallet: запит підключення показано з коректним origin (визначає браузер)');
  ok(w.overlayType === 'approve', 'wallet: підтвердження показується довіреним оверлеєм');
  await decide(true, MASTER);
  let res = await pr;
  ok(Array.isArray(res.ok) && res.ok[0] === addr0, 'wallet: після підтвердження сайт бачить лише адресу');
  scan(res);
  ok((await call(wcA, 'eth_accounts')).ok[0] === addr0, 'wallet: eth_accounts для підключеного сайту');
  ok((await call(wcA, 'eth_getBalance', [addr0, 'latest'])).ok === '0x56bc75e2d63100000', 'wallet: читання балансу проксується до RPC');
  ok((await call(wcA, 'eth_subscribe', ['newHeads'])).err === 4200 && (await call(wcA, 'eth_sign', [addr0, '0x00'])).err === 4200, 'wallet: eth_sign та невідомі методи заборонені');
  ok((await call(wcA, 'eth_sendRawTransaction', ['0x00'])).err === 4200, 'wallet: пряма відправка сирих транзакцій з сайту заборонена');

  // підпис повідомлення
  pr = call(wcA, 'personal_sign', [E.hexlify(E.toUtf8Bytes('hello w3ir')), addr0]);
  const ap2 = await waitApproval();
  ok(ap2.spec.lines.some(l => l[1] === 'hello w3ir'), 'wallet: текст повідомлення показано користувачу');
  await decide(true, MASTER);
  res = await pr;
  ok(E.verifyMessage('hello w3ir', res.ok) === addr0, 'wallet: підпис повідомлення коректний');

  // транзакція
  const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  pr = call(wcA, 'eth_sendTransaction', [{ from: addr0, to, value: '0xde0b6b3a7640000' }]);
  const ap3 = await waitApproval();
  ok(ap3.spec.lines.some(l => l[0] === 'Кому' && l[1] === to) && ap3.spec.lines.some(l => l[0] === 'Сума' && /^1\.0 TST/.test(l[1])), 'wallet: у підтвердженні транзакції — отримувач і сума');
  await decide(true, MASTER);
  res = await pr;
  const sent = rawTxs[rawTxs.length - 1];
  const tx = sent && E.Transaction.from(sent);
  ok(res.ok && tx && tx.from === addr0 && tx.to === to && tx.value === 10n ** 18n && tx.chainId === 31337n && res.ok === E.keccak256(sent), 'wallet: транзакцію підписано ключем гаманця та надіслано в мережу');

  // небезпечні виклики: попередження + відхилення
  const token = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
  pr = call(wcA, 'eth_sendTransaction', [{ from: addr0, to: token, data: iface.encodeFunctionData('approve', [spender, MAX]) }]);
  const ap4 = await waitApproval();
  ok(ap4.spec.warnings.some(x => /Необмежений/.test(x)) && ap4.spec.danger === true, 'wallet: необмежений approve — червоне попередження');
  await decide(false);
  res = await pr;
  ok(res.err === 4001 && rawTxs.length === 1, 'wallet: відхилення → код 4001, нічого не надіслано');
  pr = call(wcA, 'eth_sendTransaction', [{ from: addr0, to: token, data: iface.encodeFunctionData('setApprovalForAll', [spender, true]) }]);
  const ap5 = await waitApproval();
  ok(ap5.spec.warnings.some(x => /ВСІ/.test(x)), 'wallet: setApprovalForAll — попередження про ВСІ NFT');
  await decide(false);
  await pr;

  // типізовані дані
  const td = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Mail: [{ name: 'to', type: 'string' }] }, primaryType: 'Mail', domain: { name: 'T', chainId: 1 }, message: { to: 'bob' } };
  res = await call(wcA, 'eth_signTypedData_v4', [addr0, JSON.stringify(td)]);
  ok(res.err === -32602 && !w.approval, 'wallet: підпис для іншого chainId відхилено без запиту');
  td.domain.chainId = 31337;
  pr = call(wcA, 'eth_signTypedData_v4', [addr0, JSON.stringify(td)]);
  await waitApproval();
  await decide(true, MASTER);
  res = await pr;
  const tt = { ...td.types };
  delete tt.EIP712Domain;
  ok(E.verifyTypedData(td.domain, tt, td.message, res.ok) === addr0, 'wallet: підпис EIP-712 коректний');

  // зміна та додавання мереж
  res = await call(wcA, 'wallet_switchEthereumChain', [{ chainId: '0x539' }]);
  ok(res.err === 4902, 'wallet: невідома мережа → 4902');
  res = await call(wcA, 'wallet_addEthereumChain', [{ chainId: '0x539', chainName: 'X', rpcUrls: ['javascript:alert(1)'], nativeCurrency: { symbol: 'X' } }]);
  ok(res.err === -32602, 'wallet: додавання мережі з небезпечним RPC відхилено');

  // інший сайт (B, суворий CSP): без підключення нічого не підписує
  w.exec('newTab'); w.exec('go', B.url); await sleep(1800);
  const wcB = w.wc();
  ok(await wcB.executeJavaScript('typeof window.ethereum') === 'object', 'wallet: провайдер працює навіть на сторінці з суворим CSP');
  ok((await call(wcB, 'eth_accounts')).ok.length === 0, 'wallet: інший origin не бачить підключення сайту A');
  for (const [m, p] of [['eth_sendTransaction', [{ from: addr0, to, value: '0x1' }]], ['personal_sign', ['0x00', addr0]], ['eth_signTypedData_v4', [addr0, JSON.stringify(td)]]]) {
    res = await call(wcB, m, p);
    ok(res.err === 4100 && !w.approval, `wallet: ${m} без підключення → 4100, вікно підтвердження не відкривається`);
  }

  // блокування сховища
  ctx.vault.lock();
  await sleep(200);
  w.exec('switchTab', w.tabs.find(t => t.view.webContents === wcA).id);
  ok((await call(wcA, 'eth_accounts')).ok.length === 0, 'wallet: при блокуванні сховища сайти не бачать рахунків');
  res = await call(wcA, 'eth_sendTransaction', [{ from: addr0, to, value: '0x1' }]);
  ok(res.err === 4100 && rawTxs.length === 1, 'wallet: заблокований гаманець нічого не підписує');
  pr = call(wcA, 'eth_requestAccounts');
  const ap6 = await waitApproval();
  ok(ap6.spec.kind === 'connect' && w.approvalPayload(ap6).needsUnlock === true, 'wallet: запит при заблокованому сховищі вимагає майстер-пароль');
  const wrong = await w.decide(ap6.id, true, 'wrong-master-password');
  ok(!wrong.ok && w.approval, 'wallet: хибний майстер-пароль не підтверджує запит');
  ctx.vault.nextAllowed = 0;
  const right = await w.decide(ap6.id, true, MASTER);
  res = await pr;
  ok(right.ok && res.ok && res.ok[0] === addr0, 'wallet: правильний пароль розблоковує та підтверджує');

  // таймаут/закриття
  pr = call(wcA, 'personal_sign', [E.hexlify(E.toUtf8Bytes('x')), addr0]);
  await waitApproval();
  w.closeOverlay();
  res = await pr;
  ok(res.err === 4001, 'wallet: закриття вікна підтвердження = відхилення');

  // інкогніто не отримує провайдера; сторінки з w3ir:// не мають доступу до гаманця крім wallet
  const inc = ctx.openWindow({ incognito: true });
  await sleep(2200);
  inc.exec('go', A.url);
  await sleep(1800);
  ok(await inc.wc().executeJavaScript('typeof window.ethereum') === 'undefined', 'wallet: у вікні інкогніто провайдер недоступний');
  inc.win.close();
  w.exec('openPage', 'settings'); await sleep(1200);
  ok(await w.wc().executeJavaScript(`w3ir.invoke('wallet:status').then(() => 'allowed', () => 'denied')`) === 'denied', 'wallet: сторінка налаштувань не має доступу до API гаманця');
  w.exec('openPage', 'wallet'); await sleep(1200);
  const st = await w.wc().executeJavaScript(`w3ir.invoke('wallet:status')`);
  scan(st);
  ok(st.ok && st.exists && st.info && st.info.accounts[0] === addr0, 'wallet: сторінка гаманця отримує стан (без секретів)');
  ok(st.info.log.length >= 3 && st.info.connections.length >= 1, 'wallet: журнал дій і підключені сайти ведуться');
  ok(leaks.length === 0, 'wallet: приватний ключ і фраза не потрапили в жодне повідомлення/відповідь');

  // відключення сайту
  wal.disconnectSite(A.origin);
  ok((await call(wcA, 'eth_accounts')).ok.length === 0, 'wallet: після відключення сайт знову нічого не бачить');

  A.s.close(); B.s.close(); rpc.close();
  ctx.settingsStore.flush();
  Object.assign(ctx, { vault: real.vault, wallet: real.wallet, settingsStore: real.settings });
}

module.exports = { githubTests, walletTests };
