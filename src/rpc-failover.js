'use strict';
// EVM-провайдер із запасними вузлами RPC: коли вузол недоступний (тайм-аут, мережева помилка, HTTP-помилка, ліміт запитів),
// запит повторюється на наступному. Працюючий вузол стає першим, щоб мертвий не гальмував кожен запит.
// Відповіді вузла у форматі JSON-RPC (помилка виконання, «execution reverted») не вважаються відмовою й не повторюються.
const { JsonRpcProvider, keccak256 } = require('ethers');

// Відповідь JSON-RPC із помилкою самого вузла (внутрішня помилка, ліміт запитів, метод не підтримується, перевантаження) — це відмова вузла,
// а не результат виконання: пробуємо наступний. Детерміновані помилки (revert, nonce too low, insufficient funds) не повторюються.
const NODE_FAULT_CODES = new Set([-32603, -32005, -32601, -32097, -32098, -32099, 429, 503]);
const NODE_FAULT_MESSAGE = /rate.?limit|too many requests|capacity|overload|unavailable|timeout|timed out|internal error|no backend|try again|method .*not (found|supported|available)|does not exist/i;
function nodeFault(res) {
  return Array.isArray(res) && res.some(r => r && r.error && (NODE_FAULT_CODES.has(Number(r.error.code)) || NODE_FAULT_MESSAGE.test(String(r.error.message || ''))));
}

const ALREADY_KNOWN = /already known|known transaction|already imported|already in the mempool/i;

class FailoverProvider extends JsonRpcProvider {
  constructor(urls, network, { timeout = 5000 } = {}) {
    const opts = { staticNetwork: network, batchMaxCount: 1 };
    super(urls[0], network, opts);
    this._nodes = urls.map((u) => ({ url: u, p: new JsonRpcProvider(u, network, opts) }));
    this._timeout = timeout;
  }

  get activeUrl() { return this._nodes[0].url; }

  async _send(payload) {
    let lastError, lastResult;
    for (let i = 0; i < this._nodes.length; i++) {
      const node = this._nodes[i];
      let timer;
      try {
        const res = await Promise.race([
          node.p._send(payload),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('RPC timeout')), this._timeout); }),
        ]);
        if (nodeFault(res)) { lastResult = res; continue; } // помилка вузла: наступний; якщо відмовлять усі — віддамо останню відповідь
        if (i > 0) { this._nodes.splice(i, 1); this._nodes.unshift(node); }
        return this._tolerateRebroadcast(payload, res, i > 0);
      } catch (e) {
        lastError = e;
      } finally { clearTimeout(timer); }
    }
    // усі вузли мовчать чи відмовили: наступна спроба знову почне з першого в черзі
    if (lastResult) return lastResult;
    throw lastError;
  }

  // Перший вузол міг прийняти транзакцію, але не встиг відповісти; запасний тоді скаже «вже відома» — це успіх.
  _tolerateRebroadcast(payload, res, viaFallback) {
    if (!viaFallback || Array.isArray(payload) || !payload || payload.method !== 'eth_sendRawTransaction') return res;
    const r = res && res[0];
    if (r && r.error && ALREADY_KNOWN.test(String(r.error.message || ''))) {
      try { return [{ id: r.id, jsonrpc: '2.0', result: keccak256(payload.params[0]) }]; } catch { return res; }
    }
    return res;
  }
}

module.exports = { FailoverProvider };
