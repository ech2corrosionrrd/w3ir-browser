'use strict';
// Нативний стейкінг Solana: список стейк-акаунтів, делегування, деактивація, виведення.

function buildSolStakingSection(st, sol, net, solAddrOf, acctOptions) {
  const container = h('div', { class: 'card', style: 'max-width:none;margin:0' });
  const selAcct = h('select', { style: 'margin-right:8px' });
  acctOptions().forEach(o => {
    if (o.chain === 'sol' || o.chain === null) {
      selAcct.append(h('option', { value: String(o.id) }, o.label));
    }
  });

  const refreshBtn = h('button', { onclick: () => loadStakes() }, t('Оновити'));
  const stakeBtn = h('button', { class: 'primary', style: 'margin-left:8px', onclick: () => showStakeDialog() }, t('+ Новий стейк'));
  const topBar = h('div', { class: 'bar', style: 'margin-bottom:12px' }, selAcct, refreshBtn, stakeBtn);

  const statusMsg = h('div', { class: 'note', style: 'margin:8px 0' });
  const stakesList = h('div', { class: 'list', style: 'margin-top:8px' });

  async function loadStakes() {
    const id = Number(selAcct.value);
    const addr = solAddrOf(id);
    if (!addr) return;
    statusMsg.textContent = t('Отримання стейк-акаунтів Solana…');
    stakesList.textContent = '';
    const r = await call('wallet:solStakeAccounts', { address: addr });
    if (!r.ok) {
      statusMsg.textContent = r.error || t('Не вдалося отримати стейки.');
      return;
    }
    const list = r.accounts || [];
    if (!list.length) {
      statusMsg.textContent = t('У цього рахунку немає активних або створених стейк-акаунтів на цій мережі.');
      return;
    }
    statusMsg.textContent = `${t('Знайдено стейк-акаунтів:')} ${list.length}`;
    list.forEach(item => {
      const isDeactivating = item.deactivationEpoch && item.deactivationEpoch !== '18446744073709551615';
      const stateBadge = isDeactivating
        ? h('span', { class: 'badge warn', style: 'margin-left:8px' }, t('Деактивується'))
        : (item.voter ? h('span', { class: 'badge ok', style: 'margin-left:8px' }, t('Делеговано')) : h('span', { class: 'badge', style: 'margin-left:8px' }, item.state));

      const row = h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch;gap:6px' },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center' },
          h('div', null,
            h('strong', null, `${item.sol} SOL`),
            stateBadge
          ),
          h('div', { class: 'bar' },
            !isDeactivating && item.voter ? h('button', {
              class: 'danger',
              onclick: async () => {
                if (!confirm(`${t('Деактивувати стейк')} ${short(item.pubkey)}?`)) return;
                statusMsg.textContent = t('Підготовка деактивації…');
                const res = await call('wallet:solStakeDeactivate', { index: id, stakeAccount: item.pubkey });
                if (res.ok) { alert(t('Транзакцію деактивації надіслано!')); loadStakes(); }
                else alert(res.error || t('Помилка'));
              }
            }, t('Деактивувати')) : '',
            isDeactivating || !item.voter ? h('button', {
              class: 'primary',
              onclick: async () => {
                if (!confirm(`${t('Вивести залишкові')} ${item.sol} SOL?`)) return;
                statusMsg.textContent = t('Підготовка виведення коштів…');
                const res = await call('wallet:solStakeWithdraw', { index: id, stakeAccount: item.pubkey });
                if (res.ok) { alert(t('Кошти успішно виведено на ваш рахунок!')); loadStakes(); }
                else alert(res.error || t('Помилка'));
              }
            }, t('Вивести SOL')) : ''
          )
        ),
        h('div', { class: 'd', style: 'font-size:12px;user-select:text' },
          h('span', null, `${t('Акаунт стейку')}: `),
          h('a', { href: `https://explorer.solana.com/address/${item.pubkey}`, target: '_blank' }, short(item.pubkey)),
          item.voter ? h('span', { style: 'margin-left:12px' }, `${t('Валідатор')}: `, h('a', { href: `https://explorer.solana.com/address/${item.voter}`, target: '_blank' }, short(item.voter))) : ''
        )
      );
      stakesList.append(row);
    });
  }

  selAcct.onchange = () => loadStakes();

  async function showStakeDialog() {
    const id = Number(selAcct.value);
    const box = h('div', { class: 'modal', onmousedown: (e) => { if (e.target === box) box.remove(); } });
    const mbox = h('div', { class: 'mbox', style: 'max-width:500px' });
    const title = h('h2', { class: 'mtitle' }, t('Делегування SOL (Стейкінг)'));

    const amtInput = h('input', { type: 'text', placeholder: '0.1', inputMode: 'decimal', style: 'width:100%;margin-bottom:8px' });
    const valSel = h('select', { style: 'width:100%;margin-bottom:8px' }, h('option', { value: '' }, t('Завантаження валідаторів…')));
    const valInput = h('input', { type: 'text', placeholder: t('Або введіть vote-адресу валідатора вручну'), style: 'width:100%;margin-bottom:12px;font-size:12px' });
    const msg = h('div', { class: 'note', style: 'margin:8px 0' });

    call('wallet:solVoteAccounts').then(res => {
      valSel.textContent = '';
      if (!res.ok || !res.validators || !res.validators.length) {
        valSel.append(h('option', { value: '' }, t('Вкажіть адресу вручну нижче')));
        return;
      }
      valSel.append(h('option', { value: '' }, `-- ${t('Оберіть валідатора')} --`));
      res.validators.forEach(v => {
        valSel.append(h('option', { value: v.votePubkey }, `${short(v.votePubkey)} (${v.activatedStake} SOL, ${t('комісія')} ${v.commission}%)`));
      });
    });

    const submitBtn = h('button', {
      class: 'primary',
      onclick: async () => {
        const vote = valInput.value.trim() || valSel.value;
        const amt = amtInput.value.trim();
        if (!vote) { alert(t('Будь ласка, оберіть або введіть vote-адресу валідатора.')); return; }
        if (!amt || Number(amt) <= 0) { alert(t('Введіть коректну суму для стейкінгу (мін. 0.01 SOL).')); return; }
        msg.textContent = t('Формування транзакції та запит підтвердження…');
        submitBtn.disabled = true;
        const res = await call('wallet:solStakeDelegate', {
          index: id,
          votePubkey: vote,
          amount: amt,
        });
        if (res.ok) {
          box.remove();
          alert(`${t('Стейк успішно створено й делеговано!')} ${short(res.signature)}`);
          loadStakes();
        } else {
          submitBtn.disabled = false;
          msg.textContent = res.error || t('Помилка');
        }
      }
    }, t('Делегувати стейк'));

    const cancelBtn = h('button', { onclick: () => box.remove() }, t('Скасувати'));

    mbox.append(
      title,
      h('p', { class: 'd', style: 'margin-bottom:12px' }, t('Стейкінг блокує ваші SOL у нативному стейк-акаунті під захистом Solana Stake Program. Валідатор не отримує доступу до ваших коштів. Ви можете деактивувати стейк та повернути кошти у будь-який момент.')),
      h('label', null, `${t('Сума SOL')}:`),
      amtInput,
      h('label', null, `${t('Валідатор')}:`),
      valSel,
      valInput,
      msg,
      h('div', { class: 'mbtns' }, cancelBtn, submitBtn)
    );
    box.append(mbox);
    document.body.append(box);
  }

  container.append(
    h('p', { style: 'margin-top:0' }, t('Нативний стейкінг Solana через Stake Program: вибір валідатора, створення стейк-акаунта, деактивація та безпечне виведення винагород безпосередньо у гаманець.')),
    topBar,
    statusMsg,
    stakesList
  );

  setTimeout(() => loadStakes(), 200);

  return container;
}
