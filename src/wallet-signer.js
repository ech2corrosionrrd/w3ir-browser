'use strict';
// Процес-підписувач гаманця: запускається з головного процесу через utilityProcess.fork (wallet-signer-client.js).
// Уся логіка — у wallet-signer-core.js; тут лише транспорт повідомлень.
const { createCore } = require('./wallet-signer-core');

const core = createCore();
const reply = (m) => { try { process.parentPort.postMessage(m); } catch { /* батьківський процес уже завершився */ } };

process.parentPort.on('message', async (e) => { reply(await core.handle(e.data)); });
