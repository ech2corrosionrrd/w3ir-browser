'use strict';
// Активні дозволи токенів і NFT; значок на вкладці «Безпека».

function buildApprovals(ctx) {
  const { info, evmOpts } = ctx;
  // ----- активні дозволи токенів і NFT -----
  const apAcct = h('select', { 'aria-label': 'Рахунок', onchange: () => loadApprovals() }, evmOpts().map(o => h('option', { value: String(o.id) }, o.label)));
  const apMsg = h('div', { class: 'note', style: 'margin:8px 0' });
  const apList = h('div', { class: 'list' });
  let apDanger = [];
  const apBulk = h('button', { class: 'danger', style: 'display:none', onclick: async () => {
    for (const it of apDanger) {
      const r = await call('wallet:revokeApproval', { index: Number(apAcct.value), kind: it.kind, token: it.token, spender: it.spender });
      if (!r.ok) { apMsg.textContent = r.error; break; }
    }
    loadApprovals();
  } }, '');
  const apScan = h('button', { onclick: async () => {
    apMsg.textContent = t('Шукаю дозволи в недавніх подіях\u2026');
    const r = await call('wallet:scanApprovals', { index: Number(apAcct.value) });
    if (!r.ok) { apMsg.textContent = r.error; return; }
    await loadApprovals(t('Знайдено нових: {0}.', r.added) + (r.partial ? ' ' + t('Пошук неповний (обмеження RPC): старіші дозволи скасовуйте вручну чи через оглядач.') : ''));
  } }, 'Знайти дозволи');
  async function loadApprovals(prefix) {
    apMsg.textContent = '\u2026'; apList.textContent = ''; apBulk.style.display = 'none';
    const r = await call('wallet:approvals', { index: Number(apAcct.value) });
    if (!r.ok) { apMsg.textContent = r.error; return; }
    const net2 = info.networks.find(n => n.chainId === r.chainId);
    apDanger = r.items.filter(i => i.danger.length);
    updateSecBadge();
    apMsg.textContent = (prefix ? prefix + ' ' : '') + (r.items.length ? t('Діючих дозволів: {0}.', r.total) : (r.saved ? 'Діючих дозволів не знайдено.' : 'Натисніть «Знайти дозволи», щоб переглянути, хто може витрачати ваші токени.'));
    if (apDanger.length) { apBulk.style.display = ''; apBulk.textContent = t('Скасувати небезпечні ({0})', apDanger.length); }
    for (const it of r.items) {
      const who = it.label ? `${it.label} (${short(it.spender)})` : it.spender;
      apList.append(h('div', { class: 'item' },
        h('div', { class: 'main' },
          h('div', { class: 't' }, it.kind === 'nft' ? t('Усі NFT колекції {0}', short(it.token)) : `${it.symbol}${it.name ? ' \u2014 ' + it.name : ''}`),
          h('div', { class: 's pw', style: 'user-select:text' }, t('Кому: {0}', who)),
          it.danger.length ? h('div', { class: 'merr' }, '\u26A0 ' + it.danger.join('; ')) : ''),
        h('span', { class: 'note' }, it.kind === 'nft' ? '' : (it.unlimited ? t('НЕОБМЕЖЕНО') : it.amount)),
        net2 && net2.explorer ? h('a', { href: `${net2.explorer}/address/${it.token}` }, 'Оглядач') : '',
        h('button', { class: it.danger.length ? 'danger' : 'link', onclick: async () => {
          const rr = await call('wallet:revokeApproval', { index: Number(apAcct.value), kind: it.kind, token: it.token, spender: it.spender });
          if (!rr.ok) { apMsg.textContent = rr.error; return; }
          loadApprovals(t('Скасування надіслано: {0}', short(rr.hash)));
        } }, 'Скасувати')));
    }
  }
  const approvalsBox = h('div', null,
    h('p', { class: 'note' }, 'Тут видно, які адреси зараз можуть витрачати ваші токени ERC-20 чи всі NFT колекції. Небезпечні (необмежені чи для звичайного рахунку) угорі. Список складається з недавніх подій блокчейну й перевіряється за поточним станом контрактів.'),
    h('div', { class: 'bar' }, apAcct, apScan, h('button', { onclick: () => loadApprovals() }, 'Оновити'), apBulk), apMsg, apList);

  const secBadge = h('span', { class: 'wtab-badge', style: 'display:none' });
  function updateSecBadge() {
    if (apDanger && apDanger.length > 0) {
      secBadge.textContent = String(apDanger.length);
      secBadge.className = 'wtab-badge';
      secBadge.title = t('Скасувати небезпечні ({0})', apDanger.length);
      secBadge.style.display = '';
    } else if (info.backup && !info.backup.confirmed) {
      secBadge.textContent = '!';
      secBadge.className = 'wtab-badge warn';
      secBadge.title = t('Резервна копія фрази');
      secBadge.style.display = '';
    } else {
      secBadge.style.display = 'none';
    }
  }
  updateSecBadge();
  return { approvalsBox, secBadge };
}
