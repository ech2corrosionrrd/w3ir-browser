'use strict';
// Тести безпеки: W3IR_SMOKE=security npx electron .   (області — у test/areas/*.js, помічники — test/lib.js)
const { app } = require('electron');
const { sleep, stats, cleanup } = require('./lib');
const { vaultTests, vaultTests2, syncTests, e2eTests, torrentTests, importTests, profileTests } = require('./areas/storage');
const { githubTests } = require('./areas/github');
const { walletTests } = require('./areas/web3');
const { arweaveTests } = require('./areas/arweave');
const { solanaTests } = require('./areas/solana');
const { fuzzTests } = require('./areas/fuzz');
const { qrTests } = require('./areas/qr');
const { injectionTests } = require('./areas/injection');
const { assistantTests } = require('./areas/assistant');
const { placesTests } = require('./areas/places');
const { helpTests, updateTests, threatTests } = require('./areas/updates-threats');
const { containerTests, groupTests, siteTests, splitTests, fullscreenTests, guardTests, tabCloseTests, tabFeatureTests } = require('./areas/tabs');
const { agentShareTests, agentTests } = require('./areas/ai');
const { i18nTests } = require('./areas/i18n');
const { nftTests } = require('./areas/nft');
const { signguardTests } = require('./areas/signguard');
const { approvalsTests } = require('./areas/approvals');
const { portfolioTests } = require('./areas/portfolio');
const { simulateTests } = require('./areas/simulate');
const { solanaExtrasTests } = require('./areas/solana-extras');
const { nftSourcesTests } = require('./areas/nft-sources');
const { pdfTests } = require('./areas/pdf');
const { stabilityTests } = require('./areas/stability');
const { protectionTests } = require('./areas/protection');
const { historyEvmTests } = require('./areas/history-evm');
const { auditTests, webauthnTests, ipcPolicyTests, historySearchTests, designTests, brandTests, dashboardTests, rpcListTests, darkTests, ipfsSchemeTests, ledgerBridgeTests, smallScreenTests, productivityTests } = require('./areas/misc');

// W3IR_ONLY=updateTests,agentTests — запустити лише названі області (швидка перевірка окремих тестів)
const only = process.env.W3IR_ONLY ? new Set(process.env.W3IR_ONLY.split(',')) : null;
// Час кожної області: підсумок «найповільніші області» наприкінці допомагає шукати, що гальмує прогін
// W3IR_SHARD=k/n — виконати лише області з номером за порядком, що дає k за модулем n (паралельні екземпляри, див. build/run-tests.js)
const shard = process.env.W3IR_SHARD ? process.env.W3IR_SHARD.split('/').map(Number) : null;
let stepNo = 0;
const times = [];
const step = async (name, fn) => {
  const no = stepNo++;
  if (only && !only.has(name)) return undefined;
  if (shard && no % shard[1] !== shard[0]) return undefined;
  const t0 = Date.now();
  try { return await fn(); } finally { times.push([name, Date.now() - t0]); }
};

module.exports = async function run(ctx) {
  try {
    await sleep(2000);
    // наскрізні тести клікають по справжньому вікну: виводимо його вперед, щоб інші застосунки його не перекривали
    for (const w of ctx.windows) { try { w.win.setAlwaysOnTop(true); w.win.show(); w.win.focus(); w.win.moveTop(); } catch { /* ignore */ } }
    if (!shard || shard[0] === 0) await vaultTests().catch(e => { stats.failed++; console.log('[sec] ERROR vault1', e.stack); });
    await step('vaultTests2', () => vaultTests2());
    await step('syncTests', () => syncTests());
    await step('e2eTests', () => e2eTests(ctx));
    await step('torrentTests', () => torrentTests(ctx));
    await step('importTests', () => importTests(ctx));
    await step('profileTests', () => profileTests(ctx));
    await step('githubTests', () => githubTests(ctx));
    await step('walletTests', () => walletTests(ctx));
    await step('arweaveTests', () => arweaveTests(ctx));
    await step('solanaTests', () => solanaTests(ctx));
    await step('fuzzTests', () => fuzzTests());
    await step('nftTests', () => nftTests());
    await step('signguardTests', () => signguardTests());
    await step('approvalsTests', () => approvalsTests());
    await step('portfolioTests', () => portfolioTests());
    await step('simulateTests', () => simulateTests());
    await step('solanaExtrasTests', () => solanaExtrasTests());
    await step('nftSourcesTests', () => nftSourcesTests());
    await step('historyEvmTests', () => historyEvmTests());
    await step('pdfTests', () => pdfTests(ctx));
    await step('stabilityTests', () => stabilityTests(ctx));
    await step('protectionTests', () => protectionTests(ctx));
    await step('qrTests', () => qrTests());
    await step('placesTests', () => placesTests(ctx));
    await step('helpTests', () => helpTests(ctx));
    await step('updateTests', () => updateTests(ctx));
    await step('threatTests', () => threatTests(ctx));
    await step('groupTests', () => groupTests(ctx));
    await step('siteTests', () => siteTests(ctx));
    await step('containerTests', () => containerTests(ctx));
    await step('agentTests', () => agentTests(ctx));
    await step('agentShareTests', () => agentShareTests(ctx));
    await step('injectionTests', () => injectionTests(ctx));
    await step('assistantTests', () => assistantTests(ctx));
    await step('rpcListTests', () => rpcListTests());
    await step('dashboardTests', () => dashboardTests(ctx));
    await step('darkTests', () => darkTests(ctx));
    await step('ipfsSchemeTests', () => ipfsSchemeTests(ctx));
    await step('ledgerBridgeTests', () => ledgerBridgeTests(ctx));
    await step('smallScreenTests', () => smallScreenTests(ctx));
    await step('productivityTests', () => productivityTests(ctx));
    await step('brandTests', () => brandTests());
    await step('designTests', () => designTests());
    await step('guardTests', () => guardTests());
    await step('tabCloseTests', () => tabCloseTests(ctx));
    await step('auditTests', () => auditTests(ctx));
    await step('webauthnTests', () => webauthnTests(ctx));
    await step('ipcPolicyTests', () => ipcPolicyTests());
    await step('historySearchTests', () => historySearchTests(ctx));
    await step('i18nTests', () => i18nTests());
    await step('tabFeatureTests', () => tabFeatureTests(ctx));
    await step('splitTests', () => splitTests(ctx));
    await step('fullscreenTests', () => fullscreenTests(ctx));
  } catch (e) {
    stats.failed++;
    console.log('[sec] ERROR', e.stack || e);
  }
  cleanup();
  for (const [n, ms] of times.sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`[sec] TIME ${n} ${(ms / 1000).toFixed(1)} с`);
  console.log(`[sec] RESULT: ${stats.pass} passed, ${stats.failed} failed`);
  app.quit();
};

