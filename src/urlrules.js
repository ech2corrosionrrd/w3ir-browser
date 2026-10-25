'use strict';
// Правила для адрес верхнього рівня: видалення трекінгових параметрів та HTTPS-first.

const TRACK = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|twclid|ttclid|yclid|igshid|igsh|wickedid|vgo_ee|_openstat|mc_eid|mc_cid|_hsenc|_hsmi|_kx|mkt_tok|vero_id|oly_enc_id|oly_anon_id|rb_clickid|s_kwcid|zanpid|li_fat_id|epik|sccid|sc_customer|sc_lid|sc_llid|sc_eh|sc_src|guce_referrer|guce_referrer_sig|trk_contact|trk_msg|trk_module|trk_sid|cmpid|wtrid|zen_id|irclickid|hsa_[a-z0-9_]+|pk_(campaign|kwd|source|medium|content)|mtm_(campaign|kwd|source|medium|content|cid|group|placement)|ref_src|ref_url)$/i;

function stripTracking(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || !u.search) return url;
    let changed = false;
    for (const k of [...u.searchParams.keys()]) {
      if (TRACK.test(k)) { u.searchParams.delete(k); changed = true; }
    }
    return changed ? u.toString() : url;
  } catch { return url; }
}

function isLocalHost(h) {
  return h === 'localhost' || /\.(local|localhost|test|internal|lan)$/.test(h) || !h.includes('.')
    || /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':');
}

// Повертає https-варіант або null, якщо оновлювати не треба.
function upgradeHttps(url, bypass) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' || u.port || isLocalHost(u.hostname) || bypass.has(u.hostname)) return null;
    u.protocol = 'https:';
    return u.toString();
  } catch { return null; }
}

module.exports = { stripTracking, upgradeHttps };
