'use strict';
// Тести безпеки: W3IR_SMOKE=security npx electron .   (області — у test/areas/*.js, помічники — test/lib.js)
const { app } = require('electron');
const { sleep, stats, cleanup } = require('./lib');
const { vaultTests, vaultTests2, syncTests, e2eTests, torrentTests, importTests, profileTests } = require('./areas/storage');
const { githubTests, walletTests } = require('./areas/web3');
const { helpTests, updateTests, threatTests } = require('./areas/updates-threats');
const { groupTests, siteTests, splitTests, fullscreenTests, guardTests, tabCloseTests, tabFeatureTests } = require('./areas/tabs');
const { agentShareTests, agentTests } = require('./areas/ai');
const { auditTests, webauthnTests, ipcPolicyTests, historySearchTests, designTests, brandTests, dashboardTests, rpcListTests } = require('./areas/misc');

module.exports = async function run(ctx) {
  try {
    await sleep(2000);
    await vaultTests().catch(e => { stats.failed++; console.log('[sec] ERROR vault1', e.stack); });
    await vaultTests2();
    await syncTests();
    await e2eTests(ctx);
    await torrentTests(ctx);
    await importTests(ctx);
    await profileTests(ctx);
    await githubTests(ctx);
    await walletTests(ctx);
    await helpTests(ctx);
    await updateTests(ctx);
    await threatTests(ctx);
    await groupTests(ctx);
    await siteTests(ctx);
    await agentTests(ctx);
    await agentShareTests(ctx);
    await rpcListTests();
    await dashboardTests(ctx);
    await brandTests();
    await designTests();
    await guardTests();
    await tabCloseTests(ctx);
    await auditTests(ctx);
    await webauthnTests(ctx);
    await ipcPolicyTests();
    await historySearchTests(ctx);
    await tabFeatureTests(ctx);
    await splitTests(ctx);
    await fullscreenTests(ctx);
  } catch (e) {
    stats.failed++;
    console.log('[sec] ERROR', e.stack || e);
  }
  cleanup();
  console.log(`[sec] RESULT: ${stats.pass} passed, ${stats.failed} failed`);
  app.quit();
};

