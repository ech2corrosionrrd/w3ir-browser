'use strict';
// Сторінка «Панель» (w3ir://dashboard): зведений стан браузера в Bento-картках.
// Логіка в головному процесі: сторінка отримує лише готові дані (без токенів, ключів і мнемоніки).
const { isSafeRpc } = require('./wallet');

const PING_TIMEOUT = 6000;
const PING_MIN_INTERVAL = 10000;
const CLIP_CLEAR_MS = 20000;
const { stripCtl } = require('./util');
const clean = (s, n = 160) => stripCtl(s, n);

// Пінг eth_chainId на RPC кожної мережі: зелений лише якщо відповів правильний chainId
async function pingNetworks(networks, { timeout = PING_TIMEOUT, fetchFn = fetch } = {}) {
  return Promise.all(networks.map(async (n) => {
    const base = { chainId: n.chainId, name: clean(n.name, 60) };
    if (!isSafeRpc(n.rpc)) return { ...base, ok: false, error: 'небезпечна адреса RPC' };
    // мережа «зелена», якщо відповідає основний вузол або будь-який із запасних (гаманець переходить на запасний сам)
    const urls = [n.rpc, ...(Array.isArray(n.rpcFallback) ? n.rpcFallback : [])].filter(u => isSafeRpc(u));
    let last = { ...base, ok: false, error: 'немає відповіді' };
    for (let i = 0; i < urls.length; i++) {
      const t0 = Date.now();
      try {
        const res = await fetchFn(urls[i], {
          method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) { last = { ...base, ok: false, error: 'HTTP ' + res.status }; continue; }
        const j = await res.json();
        const ok = !!j && j.result === '0x' + Number(n.chainId).toString(16);
        if (ok) return { ...base, ok, ms: Date.now() - t0, error: '', ...(i > 0 ? { fallback: true } : {}) };
        last = { ...base, ok: false, error: 'інший chainId' };
      } catch (e) { last = { ...base, ok: false, error: e && e.name === 'TimeoutError' ? 'тайм-аут' : 'немає відповіді' }; }
    }
    return last;
  }));
}

function state(ctx) {
  const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
  const a = base.agent ? base.agent.status() : null;
  const w = ctx.wallet;
  const unlocked = !!w && w.exists() && ctx.vault.status() === 'unlocked';
  const info = unlocked ? w.info() : null;
  const nets = w ? w.networks() : [];
  const active = info ? nets.find(n => n.chainId === info.activeChain) : null;
  const events = [];
  if (a) for (const l of a.log) events.push({ t: Date.parse(l.t) || 0, src: 'ШІ', text: clean(l.tool + ' ' + l.detail) });
  if (info) for (const l of info.log.slice(0, 30)) events.push({ t: l.t, src: 'Гаманець', text: clean(l.action + (l.origin ? ' · ' + l.origin : '')) });
  events.sort((x, y) => y.t - x.t);
  const th = ctx.threats ? ctx.threats.status() : null;
  const cfg = ctx.cfg();
  return {
    agent: a && { enabled: a.enabled, running: a.running, port: a.port, windowOpen: a.windowOpen, sites: a.sites.length, lastCall: a.lastCall, error: a.error, client: a.client, shares: a.shares.map(x => ({ id: x.id, site: clean(x.site, 80), mode: x.mode, until: x.until })) },
    wallet: { exists: !!w && w.exists(), unlocked, accounts: info ? info.accounts : [], chain: active ? { id: active.chainId, name: clean(active.name, 60), symbol: clean(active.symbol, 10) } : null },
    networks: nets.map(n => ({ chainId: n.chainId, name: clean(n.name, 60) })),
    protection: { safe: cfg.safeBrowsing !== false, adblock: !!cfg.adblock, https: cfg.httpsFirst !== false, lists: th ? th.counts : { malware: 0, phishing: 0 }, updated: th ? th.updated : 0 },
    events: events.slice(0, 30),
  };
}

function createApi(ctx, { fetchFn } = {}) {
  let lastPing = { t: 0, data: null };
  let clipTimer = null;
  return async function dashboardApi(name, arg) {
    try {
      switch (name) {
        case 'dashboard:state': return { ok: true, ...state(ctx) };
        case 'dashboard:ping': {
          if (lastPing.data && Date.now() - lastPing.t < PING_MIN_INTERVAL) return { ok: true, results: lastPing.data, cached: true };
          const results = await pingNetworks(ctx.wallet ? ctx.wallet.networks() : [], { fetchFn });
          lastPing = { t: Date.now(), data: results };
          return { ok: true, results };
        }
        case 'dashboard:copy': {
          const addr = String(arg && arg.address || '');
          const info = ctx.wallet && ctx.vault.status() === 'unlocked' && ctx.wallet.exists() ? ctx.wallet.info() : null;
          if (!info || !info.accounts.includes(addr)) return { ok: false, error: 'Адресу не знайдено (розблокуйте сховище).' };
          const { clipboard } = require('electron');
          clipboard.writeText(addr);
          clearTimeout(clipTimer);
          clipTimer = setTimeout(() => { try { if (clipboard.readText() === addr) clipboard.clear(); } catch { /* ignore */ } }, CLIP_CLEAR_MS);
          return { ok: true, cleared: CLIP_CLEAR_MS / 1000 };
        }
        case 'dashboard:agent': {
          const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
          if (!base.agent) return { ok: false, error: 'Недоступно.' };
          if (arg && arg.on) await base.agent.enable(); else base.agent.disable();
          return { ok: true };
        }
        case 'dashboard:agentTest': {
          const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
          return base.agent ? await base.agent.selfTest() : { ok: false, error: 'Недоступно.' };
        }
        case 'dashboard:unshare': {
          const base = ctx.manager ? ctx.manager.ctx('default') : ctx;
          if (base.agent) base.agent.unshareAll('припинено з панелі');
          return { ok: true };
        }
        default: throw new Error('unknown');
      }
    } catch (e) { return { ok: false, error: clean(e && e.message, 200) }; }
  };
}

module.exports = { pingNetworks, state, createApi, CLIP_CLEAR_MS };
