'use strict';
// Побудова кешу рушія блокувальника в окремому процесі (utilityProcess, див. adblock.js).
// Побудова зі списків піднімає RSS процесу на ≈160 МБ, і цю пам'ять система не повертає навіть після звільнення рушія,
// тож головний процес не будує рушій сам, а лише завантажує готовий файл (≈10 МБ). Процес завершується одразу після запису.
const fs = require('fs');

(async () => {
  const out = process.env.W3IR_ADBLOCK_OUT;
  const reply = (m) => { try { process.parentPort.postMessage(m); } catch { /* батьківський процес уже завершився */ } };
  try {
    if (!out) throw new Error('output file is not set');
    // @ghostery/adblocker — залежність @ghostery/adblocker-electron; шукаємо відносно неї
    const core = require(require.resolve('@ghostery/adblocker', { paths: [require.resolve('@ghostery/adblocker-electron')] }));
    const engine = await core.FiltersEngine.fromPrebuiltAdsAndTracking(fetch);
    const tmp = out + '.tmp';
    fs.writeFileSync(tmp, engine.serialize());
    fs.renameSync(tmp, out);
    reply({ ok: true });
  } catch (e) {
    reply({ ok: false, error: String(e && e.message || e).slice(0, 200) });
  }
  setTimeout(() => process.exit(0), 100);
})();
