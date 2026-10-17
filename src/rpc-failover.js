'use strict';
// EVM-провайдер із запасними вузлами RPC: коли вузол недоступний (тайм-аут, мережева помилка, HTTP-помилка, ліміт запитів),
// запит повторюється на наступному. Працюючий вузол стає першим, щоб мертвий не гальмував кожен запит.
// Відповіді вузла у форматі JSON-RPC (помилка виконання, «execution reverted») не вважаються відмовою й не повторюються.
const { JsonRpcProvider, keccak256 } = require('ethers');

const ALREADY_KNOWN = /already known|known transaction|already imported|already in the mempool/i;

class FailoverProvider extends JsonRpcProvider {
  constructor(urls, network, { timeout = 10000 } = {}) {
    const opts = { staticNetwork: network, batchMaxCount: 1 };
    super(urls[0], network, opts);
    this._nodes = urls.map((u) => ({ url: u, p: new JsonRpcProvider(u, network, opts) }));
    this._timeout = timeout;
  }

  get activeUrl() { return this._nodes[0].url; }

  async _send(payload) {
    let lastError;
    for (let i = 0; i < this._nodes.length; i++) {
      const node = this._nodes[i];
      let timer;
      try {
        const res = await Promise.race([
          node.p._send(payload),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('RPC timeout')), this._timeout); }),
        ]);
        if (i > 0) { this._nodes.splice(i, 1); this._nodes.unshift(node); }
        return this._tolerateRebroadcast(payload, res, i > 0);
      } catch (e) {
        lastError = e;
      } finally { clearTimeout(timer); }
    }
    // усі вузли мовчать: наступна спроба знову почне з першого в черзі
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
