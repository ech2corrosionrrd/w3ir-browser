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
  const S = require('../../src/solana');
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
  ok(describeCall('0x095ea7b3' + 'ff'.repeat(32) + '00'.repeat(32)).warnings.some(w => /спотворені/.test(w)) && describeCall('0xa9059cbb' + 'ab'.repeat(40)).lines.length > 0, 'wallet: спотворені дані виклику (ненульові старші байти адреси) — попередження, а не збій');
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
  let mockNonce = '0x5';
  let allowanceValue = 5_000_000n;
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
          case 'eth_getTransactionCount': return r(mockNonce);
          case 'eth_estimateGas': return r('0x5208');
          case 'eth_call': {
            const c = j.params[0];
            if (String(c.to).toLowerCase() !== '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512') return r('0x');
            const coder = E.AbiCoder.defaultAbiCoder();
            const sel = String(c.data).slice(0, 10);
            if (sel === '0x313ce567') return r(coder.encode(['uint8'], [6]));
            if (sel === '0x95d89b41') return r(coder.encode(['string'], ['TKN\u202E']));
            if (sel === '0x06fdde03') return r(coder.encode(['string'], ['Test Token']));
            if (sel === '0x70a08231') return r(coder.encode(['uint256'], [1_234_500_000n]));
            if (sel === '0xdd62ed3e') return r(coder.encode(['uint256'], [allowanceValue]));
            return r('0x');
          }
          case 'eth_getCode': return r(['0x5fbdb2315678afecb367f032d93f642f64180aa3', '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512'].includes(String(j.params[0]).toLowerCase()) ? '0x6080604052' : '0x');
          case 'eth_getTransactionReceipt': {
            const known = rawTxs.find(t => E.keccak256(t) === j.params[0]);
            return r(known ? { transactionHash: j.params[0], transactionIndex: '0x0', blockNumber: '0x10', blockHash: '0x' + '11'.repeat(32), from: addr0, to: E.Transaction.from(known).to, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256), status: '0x1', effectiveGasPrice: '0x3b9aca00', type: '0x2' } : null);
          }
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

  // ---------- імена рахунків і переказ зі сторінки гаманця ----------
  ok(wal.rename(0, '  Основний\u202E\u200B ') === 'Основний' && wal.info().names[0] === 'Основний', 'wallet: ім\u2019я рахунку очищається від керівних символів і зберігається');
  ok(wal.rename(0, 'x'.repeat(100)).length === 32 && wal.rename(0, '') === '' && wal.info().names[0] === '', 'wallet: ім\u2019я обмежене 32 символами; порожнє повертає типове');
  let badIdx = ''; try { wal.rename(7, 'x'); } catch (e) { badIdx = e.message; }
  ok(/Невідомий рахунок/.test(badIdx), 'wallet: перейменувати неіснуючий рахунок не можна');
  const startSend = (p) => wal.sendNative(w, () => true, p);
  const sendErr = async (p) => { try { await wal.sendNative(w, () => true, p); return ''; } catch (e) { return e.message; } };
  const rcpt = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
  const sendBefore = rawTxs.length;
  const badInputs = [{ index: 0, to: 'не адреса', amount: '1' }, { index: 0, to: '0x90F79bf6EB2c4f870365E785982E1f101E93B906', amount: '1' },
    { index: 0, to: rcpt, amount: '0' }, { index: 0, to: rcpt, amount: '-1' }, { index: 0, to: rcpt, amount: '1e5' }, { index: 0, to: rcpt, amount: '0.0000000000000000001' }, { index: 0, to: rcpt, amount: 5 }, { index: 9, to: rcpt, amount: '1' }];
  const badRes = await Promise.all(badInputs.map(sendErr));
  ok(badRes.every(m => m.length > 0) && !w.approval && rawTxs.length === sendBefore, 'wallet: некоректні адреси (також із хибною контрольною сумою), суми й рахунок відхиляються до будь-якого підтвердження');

  let sp = startSend({ index: 0, to: rcpt, amount: '0.5' });
  const apSend = await waitApproval();
  ok(apSend.spec.lines.some(l => l[0] === 'Кому' && l[1] === rcpt) && apSend.spec.lines.some(l => l[0] === 'Сума' && /^0\.5 TST/.test(l[1])) && apSend.spec.origin === 'w3ir://wallet', 'wallet: переказ зі сторінки — отримувач і сума у довіреному підтвердженні');
  ok(apSend.spec.warnings.some(x => /ще не надсилали/.test(x)) && !apSend.spec.danger, 'wallet: нова адреса отримувача — попередження без тривоги');
  await decide(true, MASTER);
  const sentHash = await sp;
  const sentTx = E.Transaction.from(rawTxs[rawTxs.length - 1]);
  ok(sentTx.to === rcpt && sentTx.value === 5n * 10n ** 17n && sentTx.from === addr0 && sentHash === E.keccak256(rawTxs[rawTxs.length - 1]), 'wallet: переказ підписано ключем рахунку й надіслано, адреса та сума збігаються');
  sp = startSend({ index: 0, to: rcpt, amount: '0.1' });
  const apAgain = await waitApproval();
  ok(!apAgain.spec.warnings.some(x => /ще не надсилали/.test(x)), 'wallet: адресу, на яку вже надсилали, запам\u2019ятовано');
  await decide(false);
  ok(await sp.then(() => 'sent', (e) => e.code) === 4001, 'wallet: відхилення переказу → 4001');

  const poison = (addr0.slice(0, 6) + 'a'.repeat(32) + addr0.slice(-4)).toLowerCase();
  ok(E.isAddress(poison) && poison.length === 42 && poison !== addr0.toLowerCase(), 'wallet: тестова «схожа» адреса коректна, але інша');
  sp = startSend({ index: 0, to: poison, amount: '0.1' });
  const apPoison = await waitApproval();
  ok(apPoison.spec.danger === true && apPoison.spec.warnings.some(x => /address poisoning/.test(x)), 'wallet: адреса, схожа на власну (початок і кінець), — червоне попередження про підміну');
  await decide(false); await sp.catch(() => {});
  sp = startSend({ index: 0, to: addr0, amount: '0.1' });
  const apSelf = await waitApproval();
  ok(apSelf.spec.warnings.some(x => /власних рахунків/.test(x)), 'wallet: переказ на власний рахунок позначено');
  await decide(false); await sp.catch(() => {});
  sp = startSend({ index: 0, to: '0x5FbDB2315678afecb367f032d93F642f64180aa3', amount: '0.1' });
  const apCode = await waitApproval();
  ok(apCode.spec.warnings.some(x => /смарт-контракт/.test(x)), 'wallet: отримувач — контракт: попередження');
  await decide(false); await sp.catch(() => {});

  // ---------- токени ERC-20 ----------
  const TOKEN = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
  const empty = await wal.evmTokens(0);
  ok(empty.tokens.length === 0 && empty.chainId === 31337, 'tokens: у мережі без вбудованих токенів і без доданих список порожній');
  let notToken = ''; try { await wal.addToken(rcpt); } catch (e) { notToken = e.message; }
  let badAddr = ''; try { await wal.addToken('0x123'); } catch (e) { badAddr = e.message; }
  ok(/не схоже на токен/.test(notToken) && /Некоректна адреса/.test(badAddr), 'tokens: адреса без контракту ERC-20 й некоректна адреса не додаються');
  const added = await wal.addToken(TOKEN);
  ok(added.symbol === 'TKN' && added.decimals === 6 && added.name === 'Test Token', 'tokens: символ і decimals читаються з контракту, керівні символи в символі прибрано');
  await wal.addToken(TOKEN.toLowerCase());
  const list1 = await wal.evmTokens(0);
  ok(list1.tokens.length === 1 && list1.tokens[0].amount === '1234.5' && list1.tokens[0].raw === '1234500000' && list1.tokens[0].custom, 'tokens: баланс ERC-20 з урахуванням decimals; повторне додавання не дублює');
  const tokErr = async (p) => { try { await wal.sendToken(w, () => true, p); return ''; } catch (e) { return e.message; } };
  const tokBefore = rawTxs.length;
  const tokBad = await Promise.all([
    { index: 0, token: TOKEN, to: '0x0000000000000000000000000000000000000000', amount: '1' }, { index: 0, token: TOKEN, to: TOKEN, amount: '1' },
    { index: 0, token: TOKEN, to: rcpt, amount: '1.1234567' }, { index: 0, token: TOKEN, to: rcpt, amount: '0' }, { index: 0, token: TOKEN, to: rcpt, amount: '99999999' },
    { index: 0, token: rcpt, to: rcpt, amount: '1' }, { index: 0, token: TOKEN, to: 'не адреса', amount: '1' }, { index: 5, token: TOKEN, to: rcpt, amount: '1' }, { index: 0, token: TOKEN, to: rcpt, amount: 1 },
  ].map(tokErr));
  ok(tokBad.every(m => m.length > 0) && !w.approval && rawTxs.length === tokBefore, 'tokens: нульова адреса, сам контракт, зайві знаки, нуль, більше за баланс, не токен — відхиляються до підтвердження');
  let tp = wal.sendToken(w, () => true, { index: 0, token: TOKEN, to: rcpt, amount: '12.5' });
  const apTok = await waitApproval();
  ok(apTok.spec.lines.some(l => l[0] === 'Токен' && l[1].startsWith('TKN — Test Token') && l[1].includes(TOKEN)) && apTok.spec.lines.some(l => l[0] === 'Кількість' && l[1] === '12.5 TKN') && apTok.spec.lines.some(l => l[0] === 'Отримувач' && l[1] === rcpt), 'tokens: у підтвердженні — токен (з адресою контракту), кількість у людському вигляді, отримувач');
  await decide(true, MASTER);
  const tokHash = await tp;
  const tokTx = E.Transaction.from(rawTxs[rawTxs.length - 1]);
  const decoded = new E.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', tokTx.data);
  ok(tokTx.to === TOKEN && tokTx.value === 0n && decoded[0] === rcpt && decoded[1] === 12_500_000n && tokHash === E.keccak256(rawTxs[rawTxs.length - 1]), 'tokens: надіслано transfer(отримувач, 12 500 000) на контракт токена, без ETH');
  // dApp просить approve на токен — суми у людському вигляді
  const iface2 = new E.Interface(['function approve(address,uint256)']);
  let apr = call(wcA, 'eth_sendTransaction', [{ from: addr0, to: TOKEN, data: iface2.encodeFunctionData('approve', [spender, 3_000_000n]) }]);
  const apApprove = await waitApproval();
  ok(apApprove.spec.lines.some(l => l[0] === 'Сума дозволу' && l[1] === '3.0 TKN') && apApprove.spec.lines.some(l => l[0] === 'Токен' && /^TKN/.test(l[1])), 'tokens: approve від dApp — сума дозволу у людському вигляді й назва токена');
  await decide(false); await apr;
  apr = call(wcA, 'eth_sendTransaction', [{ from: addr0, to: TOKEN, data: iface2.encodeFunctionData('approve', [spender, MAX]) }]);
  const apUnl = await waitApproval();
  ok(apUnl.spec.lines.some(l => l[0] === 'Сума дозволу' && l[1] === 'НЕОБМЕЖЕНО') && apUnl.spec.danger === true, 'tokens: необмежений approve лишається червоним попередженням');
  await decide(false); await apr;
  // ---------- швидкість комісії, прискорення, скасування ----------
  const sendFee = async (speed) => {
    const p = wal.sendNative(w, () => true, { index: 0, to: rcpt, amount: '0.01', speed });
    const a = await waitApproval();
    const speedLine = a.spec.lines.find(l => l[0] === 'Швидкість комісії');
    await decide(true, MASTER);
    const h = await p;
    const t = E.Transaction.from(rawTxs[rawTxs.length - 1]);
    return { h, t, speedLine };
  };
  const fStd = await sendFee(undefined), fFast = await sendFee('fast'), fLow = await sendFee('low');
  ok(fFast.t.maxFeePerGas === fStd.t.maxFeePerGas * 150n / 100n && fLow.t.maxFeePerGas === fStd.t.maxFeePerGas * 85n / 100n && fFast.t.maxPriorityFeePerGas > fStd.t.maxPriorityFeePerGas && fLow.t.maxPriorityFeePerGas < fStd.t.maxPriorityFeePerGas, 'wallet: швидкість комісії — fast ×1.5, low ×0.85 від стандартної (обидва поля EIP-1559)');
  ok(!fStd.speedLine && /швидко/.test(fFast.speedLine[1]) && /повільно/.test(fLow.speedLine[1]), 'wallet: у підтвердженні вказано рівень швидкості, якщо він не стандартний');
  let badSpeed = ''; try { await wal.sendNative(w, () => true, { index: 0, to: rcpt, amount: '0.01', speed: 'warp' }); } catch (e) { badSpeed = e.message; }
  ok(/Невідомий рівень/.test(badSpeed) && !w.approval, 'wallet: невідомий рівень швидкості відхиляється до підтвердження');

  const pend1 = await wal.evmPending();
  ok(pend1.some(x => x.hash === fLow.h && x.nonce === 5), 'wallet: надіслані транзакції відстежуються як очікувані');
  let sp1 = wal.replacePending(w, () => true, { hash: fLow.h, mode: 'speedup' });
  const apSp = await waitApproval();
  ok(apSp.spec.lines.some(l => l[0] === 'Дія' && /Прискорення/.test(l[1])) && apSp.spec.lines.some(l => l[0] === 'Початкова транзакція' && l[1] === fLow.h) && apSp.spec.lines.some(l => l[0] === 'Nonce' && l[1] === '5'), 'wallet: прискорення — у підтвердженні початкова транзакція, nonce й нова комісія');
  await decide(true, MASTER);
  const spHash = await sp1;
  const spTx = E.Transaction.from(rawTxs[rawTxs.length - 1]);
  ok(spTx.nonce === 5 && spTx.to === rcpt && spTx.value === fLow.t.value && spTx.maxFeePerGas >= fLow.t.maxFeePerGas * 11n / 10n && spTx.maxPriorityFeePerGas >= fLow.t.maxPriorityFeePerGas * 11n / 10n && spHash === E.keccak256(rawTxs[rawTxs.length - 1]), 'wallet: прискорена транзакція — той самий nonce, отримувач і сума, комісія вища щонайменше на 10 %');
  const pend2 = await wal.evmPending();
  ok(pend2.some(x => x.hash === spHash) && !pend2.some(x => x.hash === fLow.h), 'wallet: замінену транзакцію прибрано з очікуваних, нова додана');
  let cp = wal.replacePending(w, () => true, { hash: spHash, mode: 'cancel' });
  const apCancel = await waitApproval();
  ok(apCancel.spec.lines.some(l => l[0] === 'Дія' && /Скасування/.test(l[1])) && apCancel.spec.warnings.some(x => /не гарантоване/.test(x)), 'wallet: скасування — попередження, що воно не гарантоване');
  await decide(true, MASTER);
  const cHash = await cp;
  const cTx = E.Transaction.from(rawTxs[rawTxs.length - 1]);
  ok(cTx.nonce === 5 && cTx.to === addr0 && cTx.value === 0n && cTx.data === '0x' && cTx.gasLimit === 21000n && cTx.maxFeePerGas > spTx.maxFeePerGas && cHash === E.keccak256(rawTxs[rawTxs.length - 1]), 'wallet: скасування — нульовий переказ собі з тим самим nonce, комісія вища, газ 21000');
  const errReplace = async (p) => { try { await wal.replacePending(w, () => true, p); return ''; } catch (e) { return e.message; } };
  ok(/не знайдено/.test(await errReplace({ hash: '0x' + '12'.repeat(32), mode: 'speedup' })) && /Невідома дія/.test(await errReplace({ hash: cHash, mode: 'steal' })) && !w.approval, 'wallet: невідома транзакція чи дія відхиляються без підтвердження');
  mockNonce = '0x6';
  await sleep(400); // ethers кешує eth_getTransactionCount на 250 мс: без паузи відповідь могла бути старою (нестабільний тест)
  ok(/вже підтверджена/.test(await errReplace({ hash: cHash, mode: 'speedup' })) && !(await wal.evmPending()).some(x => x.hash === cHash) && !w.approval, 'wallet: якщо nonce уже використано — заміна відхиляється й запис очищається');
  mockNonce = '0x5';

  // ---------- скасування дозволу токена ----------
  await wal.addToken(TOKEN);
  const revokeErr = async (p) => { try { await wal.revokeAllowance(w, () => true, p); return ''; } catch (e) { return e.message; } };
  ok((await revokeErr({ index: 0, token: 'x', spender })).length > 0 && (await revokeErr({ index: 9, token: TOKEN, spender })).length > 0 && (await revokeErr({ index: 0, token: rcpt, spender })).length > 0 && !w.approval, 'wallet: скасування дозволу — хибні дані відхиляються до підтвердження');
  let rv = wal.revokeAllowance(w, () => true, { index: 0, token: TOKEN, spender });
  const apRev = await waitApproval();
  ok(apRev.spec.lines.some(l => l[0] === 'Поточний дозвіл' && l[1] === '5.0 TKN') && apRev.spec.lines.some(l => l[0] === 'Кому видано дозвіл' && l[1] === spender), 'wallet: скасування дозволу — поточний дозвіл у людському вигляді й кому видано');
  await decide(true, MASTER);
  await rv;
  const rvTx = E.Transaction.from(rawTxs[rawTxs.length - 1]);
  const rvData = iface2.decodeFunctionData('approve', rvTx.data);
  ok(rvTx.to === TOKEN && rvData[0] === spender && rvData[1] === 0n && rvTx.value === 0n, 'wallet: надіслано approve(spender, 0) на контракт токена');
  allowanceValue = MAX;
  rv = wal.revokeAllowance(w, () => true, { index: 0, token: TOKEN, spender });
  const apRev2 = await waitApproval();
  ok(apRev2.spec.lines.some(l => l[0] === 'Поточний дозвіл' && l[1] === 'НЕОБМЕЖЕНО'), 'wallet: необмежений дозвіл показано як НЕОБМЕЖЕНО');
  await decide(false); await rv.catch(() => {});
  allowanceValue = 0n;
  ok(/уже нульовий/.test(await revokeErr({ index: 0, token: TOKEN, spender })) && !w.approval, 'wallet: нульовий дозвіл скасовувати не потрібно (без підтвердження)');
  allowanceValue = 5_000_000n;

  // ---------- адресна книга й ENS ----------
  const SOLADDR = S.b58encode(Buffer.alloc(32, 44));
  const c1 = wal.addContact('  Аліса\u202E \u200B', rcpt.toLowerCase());
  ok(c1.name === 'Аліса' && c1.chain === 'evm' && c1.address === rcpt, 'wallet: контакт — ім\u2019я очищено від керівних символів, адреса EVM з контрольною сумою');
  ok(wal.addContact('Боб', SOLADDR).chain === 'sol' && wal.addContact('Аліса 2', rcpt).name === 'Аліса 2' && wal.contacts().length === 2, 'wallet: контакт Solana; повторна адреса оновлює ім\u2019я, а не дублює');
  const contactErr = (n, a) => { try { wal.addContact(n, a); return ''; } catch (e) { return e.message; } };
  ok(contactErr('', rcpt).length > 0 && contactErr('Х', 'не адреса').length > 0 && contactErr('Х', '0x90F79bf6EB2c4f870365E785982E1f101E93B906').length > 0, 'wallet: порожнє ім\u2019я, некоректна адреса, хибна контрольна сума — відхиляються');
  for (let i = 0; i < 98; i++) wal.addContact('К' + i, E.Wallet.createRandom().address);
  ok(wal.contacts().length === 100 && /Не більше 100/.test(contactErr('Зайвий', E.Wallet.createRandom().address)), 'wallet: ліміт 100 контактів');
  ok(wal.removeContact(rcpt) === true && wal.removeContact(rcpt) === false && wal.contacts().length === 99, 'wallet: контакт видаляється');
  wal.addContact('Одержувач', '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65');
  let spc = wal.sendNative(w, () => true, { index: 0, to: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', amount: '0.01' });
  const apContact = await waitApproval();
  ok(!apContact.spec.warnings.some(x => /ще не надсилали/.test(x)), 'wallet: адреса з адресної книги не вважається новою');
  await decide(false); await spc.catch(() => {});
  wal.ensResolver = async (n) => (n === 'alice.eth' ? rcpt.toLowerCase() : n === 'ghost.eth' ? null : 'нісенітниця');
  ok(await wal.resolveName('  ALICE.eth ') === rcpt, 'wallet: ENS — ім\u2019я приводиться до нижнього регістру, результат з контрольною сумою');
  const ensErr = async (n) => { try { await wal.resolveName(n); return ''; } catch (e) { return e.message; } };
  const ensBad = await Promise.all(['vitalіk.eth', 'a..eth', 'foo.com', '.eth', 'x'.repeat(70) + '.eth', 'alice.eth\u202E', 'ghost.eth', 'junk.eth', 'ａlice.eth', ''].map(ensErr));
  ok(ensBad.every(m => m.length > 0) && /ASCII/.test(ensBad[0]) && /не зареєстровано/.test(ensBad[6]), 'wallet: ENS — імена з кирилицею й схожими символами, хибні та порожні відхиляються; невідоме ім\u2019я — зрозуміла відмова');
  wal.ensResolver = null;
  // розв'язання напряму через реєстр ENS (запити перехоплено): resolver(node) -> addr(node)
  const origCall = wal._ethCall;
  const RES = '0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41';
  const enc = (v) => E.AbiCoder.defaultAbiCoder().encode(['address'], [v]);
  const ensCalls = [];
  let ensMode = 'ok';
  wal._ethCall = async (chain, to, data) => {
    ensCalls.push({ chain, to, sel: data.slice(0, 10) });
    if (to === '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e') return enc(ensMode === 'noresolver' ? E.ZeroAddress : RES);
    if (to === RES) return enc(ensMode === 'noaddr' ? E.ZeroAddress : rcpt);
    throw new Error('неочікуваний виклик');
  };
  ok(await wal.resolveName('Alice.ETH') === rcpt && ensCalls.length === 2 && ensCalls.every(c => c.chain === 1) && ensCalls[0].sel === '0x0178b8bf' && ensCalls[1].sel === '0x3b3b57de', 'wallet: ENS — запити resolver(node) і addr(node) до мережі Ethereum, ім’я приведено до нижнього регістру');
  ensMode = 'noresolver';
  ok(/не зареєстровано/.test(await ensErr('ghost.eth')), 'wallet: ENS — немає резолвера → ім’я не зареєстровано');
  ensMode = 'noaddr';
  ok(/не зареєстровано|не вказує/.test(await ensErr('empty.eth')), 'wallet: ENS — резолвер без адреси → зрозуміла відмова');
  wal._ethCall = origCall;

  // ---------- імпорт рахунку EVM за приватним ключем ----------
  const impWallet = E.Wallet.createRandom();
  const impHex = impWallet.privateKey.slice(2);
  const impErr = (k, n) => { try { wal.importKey(k, n); return ''; } catch (e) { return e.message; } };
  const badKeys = ['', '   ', '0x' + '00'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32), 'x'.repeat(600), '0x' + 'ff'.repeat(32), '[1,2,3]', 'не ключ', S.b58encode(Buffer.alloc(32, 7)), S.b58encode(Buffer.alloc(63, 7))];
  const impBadRes = badKeys.map(k => impErr(k, 'x'));
  ok(impBadRes.every(m => m.length > 0) && wal.importedAccounts().length === 0, 'import: порожні, нульові, завеликі, нерозпізнані ключі, а також адреса Solana замість ключа відхиляються');
  ok(/адресу/.test(impBadRes[9]) && /Некоректний приватний ключ EVM/.test(impBadRes[2]), 'import: адресу Solana (32 байти) не приймають за ключ; нульовий ключ EVM відхилено зрозуміло');
  ok(/уже є в гаманці/.test(impErr(priv0, 'дубль')) && wal.importedAccounts().length === 0, 'import: ключ власного похідного рахунку не імпортується вдруге');
  const a1 = wal.importKey('0X' + impHex.toUpperCase(), '  Робочий\u202E \u200B ');
  ok(a1.id === 1000 && a1.chain === 'evm' && a1.address === impWallet.address && a1.name === 'Робочий' && !JSON.stringify(a1).includes(impHex), 'import: ключ EVM (будь-який регістр, з 0x) приймається, ім\u2019я очищено, ключ у відповіді відсутній');
  ok(/уже є в гаманці/.test(impErr(impHex, 'дубль')) && wal.info().imported.length === 1 && wal.info().imported[0].address === impWallet.address && !JSON.stringify(wal.info()).includes(impHex), 'import: повторний імпорт відхилено; info() показує адресу без секрету');
  ok(wal.evmAccount(1000) === impWallet.address && wal.ownEvm().includes(impWallet.address) && wal.isOwnEvm(impWallet.address) && !wal.isOwnSol(impWallet.address), 'import: рахунок визнається власним у EVM');
  let evmWrong = ''; try { wal.solAccount(1000); } catch (e) { evmWrong = e.message; }
  ok(/Невідомий рахунок/.test(evmWrong), 'import: рахунок EVM не підміняє адресу Solana');
  const impBal = (await wal.balances()).find(b => b.address === impWallet.address);
  ok(impBal && impBal.balance !== null, 'import: баланс імпортованого рахунку читається');
  let ip = wal.sendNative(w, () => true, { index: 1000, to: rcpt, amount: '0.02' });
  const apImp = await waitApproval();
  ok(apImp.spec.lines.some(l => l[0] === 'Від' && l[1] === impWallet.address), 'import: у підтвердженні відправник — імпортований рахунок');
  await decide(true, MASTER);
  await ip;
  const impTx = E.Transaction.from(rawTxs[rawTxs.length - 1]);
  ok(impTx.from === impWallet.address && impTx.to === rcpt && impTx.value === 2n * 10n ** 16n, 'import: транзакцію підписано імпортованим ключем (відправник збігається)');
  ok((await wal.evmTokens(1000)).chainId === 31337, 'import: токени імпортованого рахунку доступні');
  ok(wal.rename(1000, 'Мій імпорт') === 'Мій імпорт' && wal.info().imported[0].name === 'Мій імпорт', 'import: імпортований рахунок перейменовується');
  ok(wal.revealKey(1000) === '0x' + impHex.toLowerCase() && (() => { try { wal.revealKey(1500); return false; } catch { return true; } })(), 'import: ключ можна показати (для резервної копії) у форматі, який приймає імпорт');
  const qrImp = wal.qrFor(impWallet.address);
  ok(qrImp.size >= 21 && qrImp.rows.length === qrImp.size, 'qr: для адреси власного рахунку матрицю побудовано');
  let qrBad = ''; try { wal.qrFor('https://evil.example/' + 'x'.repeat(30)); } catch (e) { qrBad = e.message; }
  ok(/лише для адреси/.test(qrBad) && wal.qrFor(wal.section().addresses[0]).size >= 21, 'qr: довільний текст кодувати не можна, лише власні адреси й контакти');
  ok(wal.removeImported(1000) === true && wal.importedAccounts().length === 0 && (() => { try { wal.evmAccount(1000); return false; } catch { return true; } })() && !wal.isOwnEvm(impWallet.address), 'import: видалення стирає рахунок і ключ');
  let afterRemove = ''; try { await wal.sendNative(w, () => true, { index: 1000, to: rcpt, amount: '0.01' }); } catch (e) { afterRemove = e.message; }
  ok(/Невідомий рахунок/.test(afterRemove) && !w.approval, 'import: після видалення переказ із цього рахунку неможливий');
  ok(!JSON.stringify(wal.section()).includes(impHex), 'import: після видалення ключа немає в даних гаманця');

  ok(wal.removeToken(TOKEN) === true && (await wal.evmTokens(0)).tokens.length === 0 && wal.removeToken(TOKEN) === false, 'tokens: токен можна прибрати зі списку');
  const evmSt = await wal.txStatuses([{ hash: tokHash, chainId: 31337 }, { hash: '0x' + 'ab'.repeat(32), chainId: 31337 }, { hash: 'не хеш', chainId: 31337 }, { hash: tokHash, chainId: 999999 }]);
  ok(evmSt[tokHash] === 'confirmed' && evmSt['0x' + 'ab'.repeat(32)] === 'pending' && Object.keys(evmSt).length === 2, 'tokens: статуси транзакцій EVM (підтверджено / очікує); хибні записи ігноруються');

  // небезпечні виклики: попередження + відхилення
  const token = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
  pr = call(wcA, 'eth_sendTransaction', [{ from: addr0, to: token, data: iface.encodeFunctionData('approve', [spender, MAX]) }]);
  const ap4 = await waitApproval();
  ok(ap4.spec.warnings.some(x => /Необмежений/.test(x)) && ap4.spec.danger === true, 'wallet: необмежений approve — червоне попередження');
  await decide(false);
  res = await pr;
  ok(res.err === 4001 && rawTxs.length === 10, 'wallet: відхилення → код 4001, нічого не надіслано');
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
  ok(res.err === 4100 && rawTxs.length === 10, 'wallet: заблокований гаманець нічого не підписує');
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

  // ---------- рахунок для сайтів (dApp): типовий і окремий для кожного сайту ----------
  const dk = E.Wallet.createRandom();
  const dkAcc = wal.importKey(dk.privateKey, 'Для сайтів');
  const dappErr = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
  ok(wal.dappIndex('evm') === 0 && /Невідома мережа/.test(dappErr(() => wal.setDappAccount('btc', 0))) && /Невідомий рахунок/.test(dappErr(() => wal.setDappAccount('evm', 77))) && /Невідомий рахунок/.test(dappErr(() => wal.setDappAccount('sol', dkAcc.id))), 'dapp: типовий рахунок 0; хибна мережа, неіснуючий рахунок і рахунок іншої мережі відхиляються');
  wal.setDappAccount('evm', dkAcc.id);
  ok(wal.dappIndex('evm') === dkAcc.id && wal.info().dapp.evm === dkAcc.id, 'dapp: імпортований рахунок можна зробити типовим для сайтів');
  let prd = call(wcA, 'eth_requestAccounts');
  const apD = await waitApproval();
  ok(apD.spec.choice && apD.spec.choice.value === String(dkAcc.id) && apD.spec.choice.options.some(o => o.value === String(dkAcc.id)), 'dapp: у запиті підключення типовим обрано імпортований рахунок');
  await decide(true, MASTER);
  ok((await prd).ok[0] === dk.address && (await call(wcA, 'eth_accounts')).ok[0] === dk.address, 'dapp: сайт отримав адресу імпортованого рахунку, а не основного');
  prd = call(wcA, 'personal_sign', [E.hexlify(E.toUtf8Bytes('від імпортованого')), dk.address]);
  await waitApproval(); await decide(true, MASTER);
  ok(E.verifyMessage('від імпортованого', (await prd).ok) === dk.address, 'dapp: підпис повідомлення зроблено ключем імпортованого рахунку');
  prd = call(wcA, 'personal_sign', [E.hexlify(E.toUtf8Bytes('чужий')), addr0]);
  ok((await prd).err === 4100 && !w.approval, 'dapp: рахунок, не підключений до сайту (основний), підписати не може');
  prd = call(wcA, 'eth_sendTransaction', [{ from: dk.address, to: rcpt, value: '0x1' }]);
  await waitApproval(); await decide(true, MASTER);
  await prd;
  ok(E.Transaction.from(rawTxs[rawTxs.length - 1]).from === dk.address, 'dapp: транзакцію від імені сайту підписано імпортованим ключем');
  await wcA.executeJavaScript(`window.__acc = []; ethereum.on('accountsChanged', a => window.__acc.push(a)); 0`);
  ok(wal.setSiteAccount(A.origin, 'evm', 0) === addr0, 'dapp: рахунок підключеного сайту можна змінити окремо');
  await sleep(300);
  ok(JSON.stringify(await wcA.executeJavaScript('window.__acc')) === JSON.stringify([[addr0]]) && (await call(wcA, 'eth_accounts')).ok[0] === addr0, 'dapp: сайт отримує accountsChanged, eth_accounts повертає новий рахунок');
  ok(/не підключено/.test(dappErr(() => wal.setSiteAccount('http://unknown.example', 'evm', 0))) && /Невідомий рахунок/.test(dappErr(() => wal.setSiteAccount(A.origin, 'evm', 99))) && wal.info().connections.find(c => c.origin === A.origin).accounts[0] === addr0, 'dapp: непідключений сайт і неіснуючий рахунок відхиляються, стан не змінюється');
  wal.setSiteAccount(A.origin, 'evm', dkAcc.id);
  await sleep(200);
  wal.removeImported(dkAcc.id);
  await sleep(300);
  ok((await call(wcA, 'eth_accounts')).ok.length === 0 && wal.dappIndex('evm') === 0 && !wal.info().connections.some(c => c.origin === A.origin) && JSON.stringify(await wcA.executeJavaScript('window.__acc')).endsWith('[]]'), 'dapp: видалення імпортованого рахунку відключає сайти, що ним користувались, і скидає типовий рахунок');

  // --- рахунки лише для перегляду (watch-only) ---
  const watchEvm = E.getAddress('0x00000000000000000000000000000000000000d4');
  const watchSol = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const werr = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
  const wE = wal.addWatch(watchEvm.toLowerCase(), 'Чужий‮ гаманець');
  const wS = wal.addWatch(watchSol, '');
  ok(wE.chain === 'evm' && wE.address === watchEvm && wE.id >= 5000 && !/‮/.test(wE.name) && wS.chain === 'sol' && wS.address === watchSol, 'watch: адреси EVM (приводиться до контрольної суми) і Solana додаються, з імені прибрано керівні символи');
  ok(/вже додано/.test(werr(() => wal.addWatch(watchEvm))) && /власного рахунку/.test(werr(() => wal.addWatch(addr0))) && /Некоректна адреса/.test(werr(() => wal.addWatch('0x123'))) && /Нульова/.test(werr(() => wal.addWatch(E.ZeroAddress))) && /Некоректна адреса/.test(werr(() => wal.addWatch(''))), 'watch: дублікат, власна адреса, сміття й нульова адреса відхиляються');
  ok(wal.info().watch.length === 2 && !wal.ownEvm().includes(watchEvm) && !wal.ownSol().includes(watchSol) && !wal.isOwnEvm(watchEvm), 'watch: рахунки для перегляду видно в інформації, але вони не «власні» (підписувати з них не можна)');
  ok((await wal.balances()).some(b => b.address === watchEvm && b.balance !== null) && (await wal.evmTokens(wE.id)).tokens !== undefined && wal.evmView(wE.id) === watchEvm, 'watch: баланс і токени рахунку для перегляду читаються');
  ok(/Невідомий рахунок/.test(werr(() => wal.evmAccount(wE.id))) && /Невідомий рахунок/.test(werr(() => wal.solAccount(wS.id))), 'watch: як рахунок для підпису (evmAccount/solAccount) такі адреси недоступні');
  const watchSendErr = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };
  ok(/Невідомий рахунок/.test(await watchSendErr(() => wal.sendNative(w, () => true, { index: wE.id, to: addr0, amount: '0.01' }))) && /Невідомий рахунок/.test(await watchSendErr(() => wal.sendToken(w, () => true, { index: wE.id, token: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512', to: addr0, amount: '1' }))) && /Невідомий рахунок/.test(await watchSendErr(() => wal.sendNft(w, () => true, { index: wE.id, contract: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512', tokenId: '1', to: addr0 }))) && !w.approval, 'watch: переказ коштів, токенів і NFT з рахунку для перегляду неможливий і не доходить до підтвердження');
  ok(/Невідомий рахунок/.test(werr(() => wal.setDappAccount('evm', wE.id))) && !wal.dappChoices('evm').some(o => o.value === String(wE.id)) && !wal.dappChoices('sol').some(o => o.value === String(wS.id)), 'watch: рахунок для перегляду не можна дати сайту (ні типовим, ні у виборі підключення)');
  ok((await call(wcA, 'personal_sign', [E.hexlify(E.toUtf8Bytes('x')), watchEvm])).err === 4100 && !w.approval, 'watch: сайт не може підписати від адреси рахунку для перегляду');
  ok(wal.rename(wE.id, 'Біржа') === 'Біржа' && wal.watchAccounts().find(a => a.id === wE.id).name === 'Біржа' && wal.qrFor(watchEvm).size > 0, 'watch: перейменування й QR працюють');
  ok(wal.removeWatch(wS.id) === true && wal.removeWatch(wE.id) === true && wal.watchAccounts().length === 0 && /Невідомий рахунок/.test(werr(() => wal.removeWatch(5000))), 'watch: видалення рахунків для перегляду');

  // --- вибір рахунку під час підключення сайту ---
  if (wal.info().accounts.length < 2) wal.addAccount();
  const pickPr = call(wcA, 'eth_requestAccounts');
  const apPick = await waitApproval();
  ok(apPick && apPick.spec.choice && apPick.spec.choice.options.length >= 2 && apPick.spec.choice.value === '0' && !apPick.spec.lines.some(l => l[0] === 'Рахунок'), 'dapp: у запиті підключення є вибір рахунку, коли їх кілька');
  const badPick = await w.decide(apPick.id, true, MASTER, '777');
  ok(badPick.ok === false && /вибір/i.test(badPick.error) && w.approval && w.approval.id === apPick.id, 'dapp: рахунок, якого не пропонували, відхиляється, запит лишається відкритим');
  const goodPick = await w.decide(apPick.id, true, MASTER, '1');
  const pickRes = await pickPr;
  ok(goodPick.ok && pickRes.ok && pickRes.ok[0] === wal.section().addresses[1] && pickRes.ok[0] !== addr0, 'dapp: сайт підключено саме до вибраного рахунку');
  ok(wal.info().connections.find(c => c.origin === A.origin).accounts[0] === wal.section().addresses[1], 'dapp: вибраний рахунок збережено для сайту');
  // --- розбір підписів і захист: SIWE, permit, EIP-7702, буфер обміну (у підключеного сайту) ---
  const acc1 = wal.section().addresses[1];
  const siweMsg = `evil.example wants you to sign in with your Ethereum account:\n${acc1}\n\nSign in.\n\nURI: https://evil.example/\nVersion: 1\nChain ID: 31337\nNonce: abcdef123456\nIssued At: ${new Date().toISOString()}`;
  let spg = call(wcA, 'personal_sign', [E.hexlify(E.toUtf8Bytes(siweMsg)), acc1]);
  const apSiwe = await waitApproval();
  ok(apSiwe && apSiwe.spec.danger === true && apSiwe.spec.lines.some(l => l[0] === 'Домен у повідомленні' && l[1] === 'evil.example') && apSiwe.spec.warnings.some(x => /НЕ збігається з сайтом/.test(x)), 'dapp: вхід SIWE з чужим доменом показано як небезпечний із доменом у повідомленні');
  await decide(false);
  ok((await spg).err === 4001, 'dapp: відхилений вхід SIWE повертає помилку користувача');
  const typedPermit = JSON.stringify({ domain: { name: 'T', chainId: 31337, verifyingContract: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' }, primaryType: 'Permit', types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, message: { owner: acc1, spender: '0x00000000000000000000000000000000000000c3', value: (2n ** 256n - 1n).toString(), nonce: 0, deadline: (2n ** 256n - 1n).toString() } });
  spg = call(wcA, 'eth_signTypedData_v4', [acc1, typedPermit]);
  const apPermit = await waitApproval();
  ok(apPermit && apPermit.spec.danger === true && apPermit.spec.lines.some(l => l[0] === 'Отримувач дозволу') && apPermit.spec.lines.some(l => l[1] === 'НЕОБМЕЖЕНО') && apPermit.spec.warnings.some(x => /звичайний рахунок, а не контракт/.test(x)), 'dapp: permit показує отримувача, необмежену суму й попередження про отримувача-не-контракт');
  await decide(false);
  await spg;
  const r7702 = await call(wcA, 'wallet_sendCalls', [{ calls: [] }]);
  const r7702b = await call(wcA, 'eth_sendTransaction', [{ from: acc1, to: addr0, value: '0x1', authorizationList: [{ chainId: '0x1', address: addr0, nonce: '0x0' }] }]);
  const r7702c = await call(wcA, 'wallet_signAuthorization', [{}]);
  ok(r7702.err === 4200 && /EIP-5792/.test(r7702.msg) && r7702b.err === 4200 && /EIP-7702/.test(r7702b.msg) && r7702c.err === 4200 && !w.approval, 'dapp: пакетні виклики, транзакція з делегуванням і підпис делегування відхиляються без підтвердження');
  ok((await call(wcA, 'wallet_getCapabilities', [acc1])).ok !== undefined, 'dapp: wallet_getCapabilities відповідає порожніми можливостями');
  // буфер обміну: скопійована в браузері адреса відрізняється від отримувача
  const copied = '0x1111111111111111111111111111111111111111', target = '0x2222222222222222222222222222222222222222';
  ctx.clipGuard.clear(); ctx.clipGuard.note(copied);
  const sendP = wal.sendNative(w, () => true, { index: 0, to: target, amount: '0.01' }).catch(e => e);
  const apClip = await waitApproval();
  ok(apClip && apClip.spec.warnings.some(x => x.includes(copied) && x.includes(target) && /скопіювали в браузері/.test(x)), 'clip: у підтвердженні переказу є попередження, що скопійована адреса не збігається з отримувачем');
  await decide(false);
  await sendP;
  ctx.clipGuard.note(target);
  const sendP2 = wal.sendNative(w, () => true, { index: 0, to: target, amount: '0.01' }).catch(e => e);
  const apClip2 = await waitApproval();
  ok(apClip2 && !apClip2.spec.warnings.some(x => /скопіювали в браузері/.test(x)), 'clip: якщо отримувач збігається зі скопійованою адресою, попередження немає');
  await decide(false);
  await sendP2;
  ctx.clipGuard.clear();
  wal.disconnectSite(A.origin);

  A.s.close(); B.s.close(); rpc.close();
  ctx.settingsStore.flush();
  Object.assign(ctx, { vault: real.vault, wallet: real.wallet, settingsStore: real.settings });
}

module.exports = { githubTests, walletTests };
