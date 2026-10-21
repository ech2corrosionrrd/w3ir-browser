'use strict';
// IPC налаштувань браузера: винятки й дозволи сайтів (sites:*), безпека (safe:*), оновлення (update:*), синхронізація закладок (sync:*).
const { t: tr } = require('./i18n');

async function sitesApi(ctx, name, arg) {
  switch (name) {
    case 'sites:list': {
      const perms = Object.entries(ctx.permsStore.data)
        .filter(([k, v]) => typeof v === 'boolean' && k.includes('|'))
        .map(([k, v]) => { const i = k.lastIndexOf('|'); return { origin: k.slice(0, i), perm: k.slice(i + 1), value: v }; })
        .sort((a, b) => a.origin.localeCompare(b.origin) || a.perm.localeCompare(b.perm));
      return { ok: true, perms, adblockAllow: (ctx.cfg().adblockAllow || []).slice().sort() };
    }
    case 'sites:resetPerm': return { ok: ctx.setSitePerm(ctx.session, String(arg.origin), String(arg.perm), null) };
    case 'sites:resetAllPerms': { const st = ctx.permsStore.data; for (const k of Object.keys(st)) delete st[k]; ctx.permsStore.save(); return { ok: true }; }
    case 'sites:adblockRemove': ctx.setAdblockAllowed(String(arg.domain), false); ctx.pushAll(); return { ok: true };
    default: throw new Error('unknown');
  }
}

async function safeApi(ctx, name, arg) {
  const t = ctx.threats;
  const httpUrl = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x : null; } catch { return null; } };
  switch (name) {
    case 'safe:status': return { ok: true, ...t.status(), updating: !!t.running };
    case 'safe:update': await t.update(); return { ok: !t.meta.error, error: t.meta.error, ...t.status() };
    case 'safe:proceed': { const u = httpUrl(arg.url); if (!u) return { ok: false }; t.bypass.add(u.hostname.toLowerCase()); return { ok: true }; }
    case 'safe:trust': {
      const u = httpUrl(arg.url);
      if (!u) return { ok: false };
      const hn = u.hostname.toLowerCase();
      const had = t.bypass.delete(hn);
      const th = t.check(u.href);
      if (th && !th.canTrust) { if (had) t.bypass.add(hn); return { ok: false, error: 'Сайти зі списків шахрайських ресурсів не можна додати в довірені.' }; }
      const { parse } = require('tldts-experimental');
      const dom = parse(u.hostname).domain || u.hostname;
      const list = ctx.cfg().safeAllow = ctx.cfg().safeAllow || [];
      if (!list.includes(dom) && list.length < 200) list.push(dom);
      ctx.settingsStore.save();
      return { ok: true };
    }
    default: throw new Error('unknown');
  }
}

async function updateApi(ctx, name, arg, entry) {
  const m = ctx.manager;
  const base = m ? m.ctx('default') : ctx; // налаштування оновлення спільні й зберігаються в основному профілі
  const u = m && m.updater;
  if (!u) throw new Error('unavailable');
  const { parseFeed } = require('./updater');
  switch (name) {
    case 'update:status': return u.status();
    case 'update:check': return u.check({ manual: true });
    case 'update:setFeed': {
      const feed = String(arg.feed || '').trim().slice(0, 300);
      if (feed && !parseFeed(feed)) return { ok: false, error: 'Вкажіть https-адресу теки з оновленнями або github:власник/репозиторій.', ...u.status() };
      base.cfg().updateFeed = feed;
      base.settingsStore.save();
      return { ok: true, ...u.status() };
    }
    case 'update:install': if (entry) entry.win.exec('updateInstall'); return u.status();
    case 'update:download': await u.download(); return u.status();
    case 'update:setBeta': base.cfg().betaChannel = !!arg.on; base.settingsStore.save(); return { ok: true, ...u.status() };
    case 'update:setAuto': base.cfg().autoUpdate = !!arg.on; base.settingsStore.save(); return { ok: true, ...u.status() };
    default: throw new Error('unknown');
  }
}

async function syncApi(ctx, entry, name, arg) {
  const S = ctx.sync;
  const { dialog } = require('electron');
  switch (name) {
    case 'sync:status': return S.status();
    case 'sync:pickFolder': {
      const r = await dialog.showOpenDialog(entry.win.win, { title: tr('Папка синхронізації (наприклад, у OneDrive або Dropbox)'), properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    }
    case 'sync:enable':
      try { await S.enable(String(arg.folder || ''), String(arg.passphrase || '').slice(0, 256)); return { ok: true }; }
      catch (e) { return { ok: false, error: e.message }; }
    case 'sync:disable': S.disable(); return { ok: true };
    case 'sync:now': await S.syncNow(); return S.status();
    default: throw new Error('unknown');
  }
}

module.exports = { sitesApi, safeApi, updateApi, syncApi };
