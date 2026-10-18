'use strict';
// Спостерігач за результатом транзакцій: після відправки (EVM і Solana, зі сторінки гаманця чи від сайту) раз на кілька секунд перевіряє
// квитанцію й показує сповіщення «підтверджено» або «не вдалася». Опитування лише поки є транзакції в очікуванні; спостереження живе в
// пам'яті (після перезапуску незавершені транзакції лишаються в списку очікуваних на сторінці гаманця).
const { t: tr } = require('./i18n');

const EVERY_MS = 10000;
const MAX_WATCH = 40;
const EVM_GIVE_UP_MS = 3 * 3600 * 1000; // транзакція, що не з'явилась за 3 години, більше не опитується (її видно у списку очікуваних)
const SOL_GIVE_UP_MS = 3 * 60 * 1000; // blockhash Solana діє ≈1–2 хвилини
const short = (h) => (String(h).length > 14 ? `${String(h).slice(0, 8)}…${String(h).slice(-6)}` : String(h));

function install(Wallet) {
  const proto = Wallet.prototype;
  const timed = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  // e: запис журналу { hash, chainId } (chainId — число для EVM або назва кластера для Solana)
  proto.watchTx = function (e) {
    if (!e || typeof e.hash !== 'string' || !e.hash || e.chainId === undefined) return;
    this._txWatch = this._txWatch || new Map();
    if (this._txWatch.has(e.hash)) return;
    this._txWatch.set(e.hash, { hash: e.hash, chainId: e.chainId, t: Date.now() });
    while (this._txWatch.size > MAX_WATCH) this._txWatch.delete(this._txWatch.keys().next().value);
    this._startWatch();
  };

  proto._startWatch = function () {
    // у режимі автотестів фонове опитування вимкнено (перевірки викликають _pollWatch напряму), якщо тест не ввімкнув його свідомо
    const auto = this._txWatchAuto !== undefined ? this._txWatchAuto : !process.env.W3IR_SMOKE;
    if (this._txWatchTimer || !auto) return;
    this._txWatchTimer = setInterval(() => { this._pollWatch().catch(() => {}); }, EVERY_MS);
    if (this._txWatchTimer.unref) this._txWatchTimer.unref();
  };
  proto._stopWatch = function () { clearInterval(this._txWatchTimer); this._txWatchTimer = null; };

  proto._notifyTx = function (ok, e) {
    const net = typeof e.chainId === 'number' ? ((this.network(e.chainId) || {}).name || String(e.chainId)) : String(e.chainId);
    const text = ok ? tr('Транзакцію підтверджено: {0}', `${net} · ${short(e.hash)}`) : tr('Транзакція не вдалася: {0}', `${net} · ${short(e.hash)}`);
    try {
      const win = [...this.ctx.windows].find(w => !w.incognito && !w.agent);
      if (win) win.toast(text);
      // коли вікно браузера не в фокусі, показуємо й сповіщення Windows (у тестах вимкнено)
      const { Notification, BrowserWindow } = require('electron');
      if (!process.env.W3IR_SMOKE && Notification && Notification.isSupported() && !BrowserWindow.getFocusedWindow()) new Notification({ title: 'W3IR Browser', body: text }).show();
    } catch { /* сповіщення необов'язкове */ }
  };

  // Одна перевірка всіх очікуваних; повертає кількість завершених (для тестів)
  proto._pollWatch = async function () {
    if (!this._txWatch || !this._txWatch.size) { this._stopWatch(); return 0; }
    if (this._txWatchBusy) return 0;
    if (!this.unlocked() || this.hidden()) return 0; // заблоковане чи приховане: не опитуємо й не сповіщаємо, спостереження зберігається
    this._txWatchBusy = true;
    let done = 0;
    try {
      const now = Date.now();
      for (const e of [...this._txWatch.values()]) {
        const isSol = typeof e.chainId === 'string';
        if (now - e.t > (isSol ? SOL_GIVE_UP_MS : EVM_GIVE_UP_MS)) { this._txWatch.delete(e.hash); continue; }
        try {
          if (isSol) {
            const r = await this.solRpc(e.chainId, 'getSignatureStatuses', [[e.hash]], 8000, { fallbackOnError: true });
            const st = r && r.value && r.value[0];
            if (!st) continue;
            if (st.err) { this._txWatch.delete(e.hash); this._notifyTx(false, e); done++; }
            else if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') { this._txWatch.delete(e.hash); this._notifyTx(true, e); done++; }
          } else {
            const rc = await timed(this.provider(e.chainId).getTransactionReceipt(e.hash), 8000);
            if (!rc) continue;
            this._txWatch.delete(e.hash);
            this._notifyTx(rc.status === 1, e);
            done++;
          }
        } catch { /* вузол недоступний: спробуємо наступного разу */ }
      }
    } finally { this._txWatchBusy = false; }
    if (!this._txWatch.size) this._stopWatch();
    return done;
  };
}

module.exports = { install, EVERY_MS };
