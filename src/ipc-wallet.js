'use strict';
// IPC гаманця (wallet:*) і сховища Arweave (arweave:*): виклики з внутрішніх сторінок w3ir://. Права перевіряє ipc.js (permitted).
const { dialog } = require('electron');
const { t: tr } = require('./i18n');

async function walletApi(ctx, entry, name, arg) {
  const w = ctx.wallet;
  const v = ctx.vault;
  const authed = async () => v.recentlyAuthed(w.reauthMs()) || (typeof arg.master === 'string' && v.status() === 'unlocked' && await v.reauth(arg.master.slice(0, 256)));
  try {
    // прихований гаманець: сторінка може лише дізнатись стан, показати або приховати; усе інше відхиляється
    if (w.hidden() && !['wallet:status', 'wallet:hide', 'wallet:unhide'].includes(name)) return { ok: false, hidden: true, error: 'Гаманець приховано. Покажіть його на сторінці гаманця.' };
    switch (name) {
      case 'wallet:hide': w.setHidden(true); return { ok: true };
      case 'wallet:unhide': {
        if (v.status() === 'none') {
          w.setHidden(false);
          return { ok: true };
        }
        if (v.status() === 'locked') {
          if (typeof arg.master === 'string' && arg.master) {
            const u = await v.unlock(arg.master.slice(0, 256));
            if (!u.ok) return { ok: false, error: u.error || 'Хибний майстер-пароль.' };
          } else {
            return { ok: false, needUnlock: true, error: 'Спершу розблокуйте сховище.' };
          }
        }
        if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : 'Введіть майстер-пароль.' };
        w.setHidden(false);
        return { ok: true };
      }
      case 'wallet:status': {
        const st = v.status();
        if (w.hidden()) return { ok: true, vault: st, exists: w.exists(), hidden: true, info: null };
        return { ok: true, vault: st, exists: w.exists(), inject: ctx.cfg().walletInject !== false, askAccount: ctx.cfg().walletAskAccount !== false, reauthMinutes: w.reauthMs() / 60000, prices: ctx.cfg().walletPrices !== false, nftAnyHost: ctx.cfg().walletNftAnyHost === true, info: st === 'unlocked' && w.exists() ? w.info() : null };
      }
      case 'wallet:create': return { ok: true, phrase: w.create() };
      case 'wallet:import': w.importPhrase(arg.phrase, { passphrase: arg.passphrase, evmPath: arg.evmPath, solPath: arg.solPath }); return { ok: true };
      case 'wallet:previewImport': return { ok: true, ...w.previewDerivation(arg.phrase, { passphrase: arg.passphrase, evmPath: arg.evmPath, solPath: arg.solPath }) };
      case 'wallet:addAccount': return { ok: true, accounts: w.addAccount() };
      case 'wallet:reveal': if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' }; return { ok: true, passphrase: w.revealPassphrase(), phrase: w.reveal() };
      case 'wallet:remove': {
        if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' };
        const r = await dialog.showMessageBox(entry.win.win, {
          type: 'warning', buttons: [tr('Видалити гаманець'), tr('Скасувати')], defaultId: 1, cancelId: 1, message: tr('Видалити гаманець із цього пристрою?'),
          detail: tr('Без фрази відновлення доступ до коштів буде втрачено назавжди. Переконайтеся, що фразу збережено.'),
        });
        if (r.response !== 0) return { ok: false, error: '' };
        w.remove();
        return { ok: true };
      }
      case 'wallet:balances': return { ok: true, balances: await w.balances() };
      case 'wallet:evmTokens': return { ok: true, ...(await w.evmTokens(arg.index)) };
      case 'wallet:prices': return { ok: true, ...(await w.priceInfo({ chain: arg.chain === 'sol' ? 'sol' : 'evm', tokens: arg.tokens })) };
      case 'wallet:setPrices': ctx.cfg().walletPrices = !!arg.on; ctx.settingsStore.save(); return { ok: true };
      case 'wallet:nfts': return { ok: true, ...(await w.evmNfts(arg.index)) };
      case 'wallet:evmNftMeta': return { ok: true, ...(await w.evmNftMeta(String(arg.contract), String(arg.id))) };
      case 'wallet:addNft': return { ok: true, nft: await w.addNft(String(arg.contract), String(arg.id)) };
      case 'wallet:removeNft': return { ok: true, removed: w.removeNft(String(arg.contract), String(arg.id)) };
      case 'wallet:discoverNfts': return { ok: true, ...(await w.discoverNfts(arg.index)) };
      case 'wallet:sendNft': return { ok: true, hash: await w.sendNft(entry.win, () => entry.win.tabs.includes(entry.tab), { index: arg.index, contract: String(arg.contract), tokenId: String(arg.id), to: arg.to, amount: arg.amount === undefined ? undefined : String(arg.amount), speed: arg.speed }) };
      case 'wallet:discoverTokens': return { ok: true, ...(await w.evmDiscoverTokens(Number(arg.index))) };
      case 'wallet:addToken': return { ok: true, token: await w.addToken(String(arg.address)) };
      case 'wallet:removeToken': return { ok: true, removed: w.removeToken(String(arg.address)) };
      case 'wallet:solHistory': return { ok: true, ...(await w.solHistory(String(arg.address))) };
      case 'wallet:solHistoryCsv': {
        const csv = w.solHistoryCsv(String(arg.address), tr);
        const stamp = new Date().toISOString().slice(0, 10);
        const r = await require('electron').dialog.showSaveDialog(entry.win.win, { title: tr('Зберегти історію (CSV)'), defaultPath: `w3ir-solana-history-${stamp}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
        if (r.canceled || !r.filePath) return { ok: false, error: 'Збереження скасовано.' };
        require('fs').writeFileSync(r.filePath, csv);
        return { ok: true, path: r.filePath };
      }
      case 'wallet:txStatuses': return { ok: true, statuses: await w.txStatuses(arg.items) };
      case 'wallet:pending': return { ok: true, items: await w.evmPending() };
      case 'wallet:replace': return { ok: true, hash: await w.replacePending(entry.win, () => entry.win.tabs.includes(entry.tab), { hash: String(arg.hash), mode: String(arg.mode) }) };
      case 'wallet:setPolicy': if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' }; return { ok: true, policy: w.setPolicy(arg.policy) };
      case 'wallet:portfolio': return { ok: true, ...(await w.portfolio({ force: !!arg.force })) };
      case 'wallet:scanApprovals': return { ok: true, ...(await w.scanApprovals(arg.index)) };
      case 'wallet:approvals': return { ok: true, ...(await w.listApprovals(arg.index)) };
      case 'wallet:evmHistory': return { ok: true, ...(await w.evmHistory(arg.index)) };
      case 'wallet:evmHistoryCsv': {
        const csv = w.evmHistoryCsv(arg.index, tr);
        const stamp = new Date().toISOString().slice(0, 10);
        const r = await require('electron').dialog.showSaveDialog(entry.win.win, { title: tr('Зберегти історію (CSV)'), defaultPath: `w3ir-history-${stamp}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
        if (r.canceled || !r.filePath) return { ok: false, error: 'Збереження скасовано.' };
        require('fs').writeFileSync(r.filePath, csv);
        return { ok: true, path: r.filePath };
      }
      case 'wallet:revokeApproval': return { ok: true, hash: await w.revokeApproval(entry.win, () => entry.win.tabs.includes(entry.tab), { index: arg.index, kind: String(arg.kind), token: arg.token, spender: arg.spender }) };
      case 'wallet:backupQuiz': if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' }; return { ok: true, ...w.backupQuiz() };
      case 'wallet:backupCheck': return { ok: true, correct: w.backupCheck(arg.answers) };
      case 'wallet:backupExport': {
        if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' };
        const pw = String(arg.password || ''), pw2 = String(arg.password2 || '');
        if (pw !== pw2) return { ok: false, error: 'Паролі резервної копії не збігаються.' };
        const data = w.backupExport(pw); // перевіряє довжину пароля
        const stamp = new Date().toISOString().slice(0, 10);
        const r = await dialog.showSaveDialog(entry.win.win, { title: tr('Зберегти резервну копію гаманця'), defaultPath: `w3ir-wallet-backup-${stamp}.w3irbackup`, filters: [{ name: 'W3IR backup', extensions: ['w3irbackup'] }] });
        if (r.canceled || !r.filePath) return { ok: false, error: 'Збереження скасовано.' };
        require('fs').writeFileSync(r.filePath, data, { mode: 0o600 });
        return { ok: true, path: r.filePath };
      }
      case 'wallet:backupImport': {
        const r = await dialog.showOpenDialog(entry.win.win, { title: tr('Відновити гаманець із резервної копії'), properties: ['openFile'], filters: [{ name: 'W3IR backup', extensions: ['w3irbackup'] }] });
        if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'Вибір скасовано.' };
        const fs = require('fs');
        if (fs.statSync(r.filePaths[0]).size > 1024 * 1024) return { ok: false, error: 'Файл завеликий для резервної копії.' };
        return { ok: true, ...w.backupImport(fs.readFileSync(r.filePaths[0]), String(arg.password || '')) };
      }
      case 'wallet:revoke': return { ok: true, hash: await w.revokeAllowance(entry.win, () => entry.win.tabs.includes(entry.tab), { index: arg.index, token: arg.token, spender: arg.spender }) };
      case 'wallet:contacts': return { ok: true, contacts: w.contacts() };
      case 'wallet:addContact': return { ok: true, contact: w.addContact(arg.name, arg.address) };
      case 'wallet:removeContact': return { ok: true, removed: w.removeContact(String(arg.address)) };
      case 'wallet:resolveName': return { ok: true, address: await w.resolveName(arg.name) };
      case 'wallet:importKey': return { ok: true, account: w.importKey(arg.key, arg.name) };
      case 'wallet:revealKey': if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' }; return { ok: true, key: w.revealKey(arg.id) };
      case 'wallet:removeImported': {
        if (!(await authed())) return { ok: false, needAuth: true, error: arg.master ? 'Хибний майстер-пароль.' : '' };
        const r = await dialog.showMessageBox(entry.win.win, {
          type: 'warning', buttons: [tr('Видалити рахунок'), tr('Скасувати')], defaultId: 1, cancelId: 1, message: tr('Видалити імпортований рахунок із гаманця?'),
          detail: tr('Приватний ключ буде стерто з цього пристрою. Без окремої резервної копії ключа доступ до коштів на цьому рахунку буде втрачено назавжди.'),
        });
        if (r.response !== 0) return { ok: false, error: '' };
        return { ok: true, removed: w.removeImported(arg.id) };
      }
      case 'wallet:addWatch': return { ok: true, account: w.addWatch(arg.address, arg.name) };
      case 'wallet:removeWatch': return { ok: true, removed: w.removeWatch(arg.id) };
      case 'wallet:qr': return { ok: true, qr: w.qrFor(arg.text) };
      case 'wallet:setDappAccount': return { ok: true, index: w.setDappAccount(String(arg.chain), arg.index) };
      case 'wallet:setSiteAccount': return { ok: true, address: w.setSiteAccount(arg.origin, String(arg.chain), arg.index) };
      case 'wallet:rename': return { ok: true, name: w.rename(arg.index, arg.name) };
      case 'wallet:send': {
        const sameTab = () => entry.win.tabs.includes(entry.tab);
        if (arg.chain === 'sol') {
          const hash = arg.asset ? await w.solSendToken(entry.win, sameTab, { index: arg.index, mint: arg.asset, to: arg.to, amount: arg.amount, speed: arg.speed }) : await w.solSend(entry.win, sameTab, { index: arg.index, to: arg.to, amount: arg.amount, speed: arg.speed });
          return { ok: true, hash, chain: 'sol' };
        }
        if (arg.chain === 'evm') {
          const hash = arg.asset ? await w.sendToken(entry.win, sameTab, { index: arg.index, token: arg.asset, to: arg.to, amount: arg.amount, speed: arg.speed }) : await w.sendNative(entry.win, sameTab, { index: arg.index, to: arg.to, amount: arg.amount, speed: arg.speed });
          return { ok: true, hash, chain: 'evm' };
        }
        throw new Error('unknown');
      }
      case 'wallet:solNfts': return { ok: true, ...(await w.solNfts(String(arg.address), { offset: arg.offset, limit: arg.limit })) };
      case 'wallet:solNftMeta': return { ok: true, ...(await w.solNftMeta(String(arg.address), String(arg.mint))) };
      case 'wallet:setNftAnyHost': ctx.cfg().walletNftAnyHost = !!arg.on; ctx.settingsStore.save(); return { ok: true };
      case 'wallet:solTokens': return { ok: true, ...(await w.solTokens(String(arg.address))) };
      case 'wallet:solBalances': return { ok: true, balances: await w.solBalances() };
      case 'wallet:solSetCluster': w.setSolCluster(String(arg.id)); return { ok: true };
      case 'wallet:solSetRpc': w.setSolRpc(String(arg.cluster), arg.url); return { ok: true };
      case 'wallet:setChain': w.setChain(Number(arg.id)); return { ok: true };
      case 'wallet:setRpc': w.setRpc(Number(arg.id), arg.url); return { ok: true };
      case 'wallet:disconnect': w.disconnectSite(String(arg.origin)); return { ok: true };
      case 'wallet:setInject': ctx.cfg().walletInject = !!arg.on; ctx.settingsStore.save(); return { ok: true };
      case 'wallet:setReauth': {
        const m = Number(arg.minutes);
        if (![2, 5, 10, 15].includes(m)) return { ok: false, error: 'Некоректне значення.' };
        ctx.cfg().walletReauthMinutes = m; ctx.settingsStore.save();
        return { ok: true };
      }
      case 'wallet:setAskAccount': ctx.cfg().walletAskAccount = !!arg.on; ctx.settingsStore.save(); return { ok: true };
      default: throw new Error('unknown');
    }
  } catch (e) { return { ok: false, error: e.code === 4100 ? 'Спершу розблокуйте сховище паролів.' : e.message }; }
}

async function arweaveApi(ctx, name, arg) {
  const ar = ctx.arweave;
  try {
    switch (name) {
      case 'arweave:status':
        return { ok: true, gateways: ar.DEFAULT_GATEWAYS };
      case 'arweave:resolve': {
        const input = String(arg.url || arg.txId || '').trim();
        let txId = input;
        let pathname = '';
        if (input.startsWith('ar://')) {
          const parsed = ar.parseArweaveUrl(input);
          if (!parsed) return { ok: false, error: 'Недійсний формат посилання ar://' };
          txId = parsed.txId;
          pathname = parsed.pathname + parsed.search;
        }
        if (!ar.isValidTxId(txId)) return { ok: false, error: 'Недійсний хеш транзакції Arweave (має бути 43 символи base64url).' };
        return {
          ok: true,
          txId,
          arweaveUrl: ar.formatArweaveUrl(txId, pathname),
          gatewayUrl: ar.resolveGatewayUrl(txId, pathname, 0)
        };
      }
      case 'arweave:nft': {
        const input = String(arg.txId || arg.url || '').trim();
        const txId = input.startsWith('ar://') ? (ar.parseArweaveUrl(input)?.txId || '') : input;
        if (!ar.isValidTxId(txId)) return { ok: false, error: 'Недійсний хеш транзакції Arweave.' };
        const metadata = await ar.fetchMetadata(txId);
        return { ok: true, metadata };
      }
      case 'arweave:tags': {
        const input = String(arg.txId || arg.url || '').trim();
        const txId = input.startsWith('ar://') ? (ar.parseArweaveUrl(input)?.txId || '') : input;
        if (!ar.isValidTxId(txId)) return { ok: false, error: 'Недійсний хеш транзакції Arweave.' };
        const tags = await ar.fetchTags(txId);
        return { ok: true, tags };
      }
      case 'arweave:ping':
        return { ok: true, gateways: await ar.probeGateways() };
      case 'arweave:buildMeta':
        return { ok: true, metadata: ar.buildNftMetadata(arg) };
      default: throw new Error('unknown');
    }
  } catch (e) {
    return { ok: false, error: e.message || 'Помилка звернення до Arweave' };
  }
}

module.exports = { walletApi, arweaveApi };
