'use strict';
// Налаштування на сторінці гаманця: RPC-сервери, режими обережності, перемикачі безпеки.

function buildRpc(ctx) {
  const { sol, net } = ctx;
  // ----- мережі та RPC -----
  const rpc = h('input', { type: 'text', value: net.rpc, spellcheck: false, style: 'width:100%' });
  const rpcMsg = h('span', { class: 'note' });
  rpc.addEventListener('change', async () => {
    const r = await call('wallet:setRpc', { id: net.chainId, url: rpc.value });
    rpcMsg.textContent = r.ok ? ' Збережено.' : ' ' + r.error;
  });
  const solRpc = h('input', { type: 'text', value: sol.rpc[sol.cluster] || '', placeholder: sol.defaultRpc[sol.cluster], spellcheck: false, style: 'width:100%' });
  const solRpcMsg = h('span', { class: 'note' });
  solRpc.addEventListener('change', async () => {
    const r = await call('wallet:solSetRpc', { cluster: sol.cluster, url: solRpc.value });
    solRpcMsg.textContent = r.ok ? ' Збережено.' : ' ' + r.error;
  });
  return h('div', { class: 'list' },
      h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('div', null, 'RPC-сервер EVM'), h('div', { class: 'd' }, 'Через нього проходять запити про баланси та транзакції. Для приватності вкажіть власний вузол (https).'), rpc, rpcMsg)),
      h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('div', null, 'RPC-сервер Solana'), h('div', { class: 'd' }, 'Для вибраної мережі Solana; порожнє поле — типові вузли. Адреси виводяться з тієї самої фрази відновлення (шлях m/44′/501′/N′/0′, як у Phantom).'), solRpc, solRpcMsg)));
}

function buildPolicy(info) {
  // ----- режими обережності -----
  const pol = info.policy || {};
  const polContacts = h('input', { type: 'checkbox', class: 'switch', checked: !!pol.contactsOnly });
  const polConfirm = h('input', { type: 'number', min: '0', step: 'any', value: String(pol.confirmUsd || 0), style: 'width:110px;flex:none' });
  const polMax = h('input', { type: 'number', min: '0', step: 'any', value: String(pol.maxUsd || 0), style: 'width:110px;flex:none' });
  const polDaily = h('input', { type: 'number', min: '0', step: 'any', value: String(pol.dailyUsd || 0), style: 'width:110px;flex:none' });
  const polDays = h('input', { type: 'number', min: '0', max: '365', step: '1', value: String(pol.siteDays || 0), style: 'width:80px;flex:none' });
  const polMsg = h('span', { class: 'note' });
  const polRow = 'display:flex;gap:10px;align-items:center;justify-content:flex-start';
  const policyBox = h('div', { style: 'display:grid;gap:8px' },
    h('label', { style: polRow }, polContacts, h('span', null, 'Надсилати лише на мої рахунки та адреси з адресної книги')),
    h('label', { style: polRow }, polConfirm, h('span', null, 'USD: підтвердження великих сум із паузою 5 с (від; 0 — вимкнено)')),
    h('label', { style: polRow }, polMax, h('span', null, 'USD: забороняти переказ більше за (0 — без ліміту)')),
    h('label', { style: polRow }, polDaily, h('span', null, 'USD: забороняти переказів більше за добу (за останні 24 години; 0 — без ліміту)')),
    pol.dailyUsd ? h('div', { class: 'note' }, t('За останні 24 години надіслано ≈ {0} USD.', (info.spentUsd || 0).toFixed(2))) : null,
    h('label', { style: polRow }, polDays, h('span', null, 'Відключати сайти, якими не користувались N днів (0 — ніколи)')),
    pol.siteDays ? null : h('div', { class: 'note' }, 'Підключені сайти лишаються доти, доки ви їх не відключите. Рекомендовано 30 днів.'),
    h('div', { class: 'bar' }, h('button', { class: 'primary', onclick: async () => {
      polMsg.textContent = '\u2026';
      const r = await withAuth((x) => call('wallet:setPolicy', { ...x, policy: { contactsOnly: polContacts.checked, confirmUsd: Number(polConfirm.value) || 0, maxUsd: Number(polMax.value) || 0, dailyUsd: Number(polDaily.value) || 0, siteDays: Math.floor(Number(polDays.value) || 0) } }));
      if (!r) { polMsg.textContent = ''; return; }
      polMsg.textContent = r.ok ? t('Збережено.') : r.error;
    } }, 'Зберегти'), polMsg));
  return policyBox;
}

function buildSecuritySettings(ctx, policyBox) {
  const { st, info, acctOptions } = ctx;
  return h('div', { class: 'list' },
      // режими обережності: ліміти, лише адресна книга, автовідключення сайтів
      h('div', { class: 'row', style: 'flex-direction:column;align-items:stretch;gap:8px' }, h('div', null, h('div', null, 'Режими обережності'), h('div', { class: 'd' }, 'Діють для переказів зі сторінки гаманця (не для транзакцій, які пропонують сайти). Зміна потребує майстер-пароля. Ліміти в USD працюють лише коли ціна відома.')),
        policyBox),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Параметри ключів'), h('div', { class: 'd' }, `EVM: ${({ standard: "m/44'/60'/0'/0/i", ledgerLive: "m/44'/60'/i'/0/0", legacy: "m/44'/60'/0'/i" })[(info.derivation || {}).evmPath] || "m/44'/60'/0'/0/i"} · Solana: ${({ phantom: "m/44'/501'/i'/0'", bip44: "m/44'/501'/i'" })[(info.derivation || {}).solPath] || "m/44'/501'/i'/0'"} · ${(info.derivation || {}).passphrase ? t('фраза-пароль задана') : t('без фрази-пароля')}`))),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Резервна копія фрази'), h('div', { class: 'd' }, info.backup && info.backup.confirmed ? t('Підтверджено {0}.', new Date(info.backup.at).toLocaleDateString(LOCALE)) : 'Не підтверджено.')),
        h('div', { class: 'bar' }, h('button', { onclick: async () => { if (await backupQuizFlow()) { alert(t('Готово: резервну копію підтверджено.')); render(); } } }, 'Перевірити фразу'), h('button', { onclick: backupExportDialog }, 'Зберегти зашифровану копію\u2026'))),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Надавати провайдер сайтам (window.ethereum, window.solana)'), h('div', { class: 'd' }, 'Вимкніть, якщо не користуєтеся dApp — сайти не зможуть навіть побачити гаманець')),
        (() => { const cb = h('input', { type: 'checkbox', class: 'switch', checked: st.inject, onchange: () => call('wallet:setInject', { on: cb.checked }) }); return cb; })()),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Повторно запитувати майстер-пароль'), h('div', { class: 'd' }, 'Скільки часу після введення пароля підтвердження транзакцій і підписів не вимагають його знову. Коротший час безпечніший; довший зручніший, якщо ви часто підтверджуєте дії.')),
        (() => { const sel = h('select', { onchange: () => call('wallet:setReauth', { minutes: Number(sel.value) }) }, [2, 5, 10, 15].map(m => h('option', { value: String(m), selected: (st.reauthMinutes || 2) === m }, t('{0} хв', m)))); return sel; })()),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Щоразу питати, яким рахунком увійти на сайті'), h('div', { class: 'd' }, 'Під час авторизації (підключення гаманця, вхід через гаманець) браузер показує вибір рахунку навіть для сайту, який уже підключено. Вимкніть, якщо сайти запитують підключення дуже часто.')),
        (() => { const cb = h('input', { type: 'checkbox', class: 'switch', checked: st.askAccount !== false, onchange: () => call('wallet:setAskAccount', { on: cb.checked }) }); return cb; })()),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Показувати орієнтовні ціни в USD'), h('div', { class: 'd' }, 'Ціни завантажуються з CoinGecko: сервіс бачить ваш IP та ідентифікатори монет і адреси контрактів токенів, але не адреси ваших рахунків. Ціни лише для показу й нічого не впливають на підтвердження. Вимкніть, щоб гаманець не звертався до цього сервісу.')),
        (() => { const cb = h('input', { type: 'checkbox', class: 'switch', checked: st.prices !== false, onchange: async () => { await call('wallet:setPrices', { on: cb.checked }); render(); } }); return cb; })()),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Завантажувати картинки й метадані NFT з будь-яких сайтів'), h('div', { class: 'd' }, 'Вимкнено: лише IPFS, Arweave/Irys і дані з блокчейну (сторонні сайти не бачать вашого IP). Увімкніть, якщо ваші NFT зберігаються на звичайних сайтах: такі сайти побачать ваш IP. Завантаження виконує браузер із захистом від локальних адрес і ліміти розміру.')),
        (() => { const cb = h('input', { type: 'checkbox', class: 'switch', checked: st.nftAnyHost === true, onchange: async () => { await call('wallet:setNftAnyHost', { on: cb.checked }); render(); } }); return cb; })()),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Скасування дозволів токенів'), h('div', { class: 'd' }, 'Відкликає право адреси витрачати ваш токен (approve 0). Корисно, якщо ви давали необмежений дозвіл сайту, якому більше не довіряєте.')), h('button', { onclick: () => revokeDialog(acctOptions) }, 'Скасувати дозвіл…')),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Показати фразу відновлення'), h('div', { class: 'd' }, 'Потрібен майстер-пароль')),
        h('button', { onclick: async () => {
          const r = await withAuth((x) => call('wallet:reveal', x));
          if (r && r.ok) showPhraseOnly(r.phrase, r.passphrase); else if (r && r.error) alert(r.error);
        } }, 'Показати')),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Приховати гаманець'), h('div', { class: 'd' }, 'Прибирає гаманець з меню, стартової сторінки й панелі та вимикає його для сайтів. Ключі лишаються у сховищі; показати знову можна лише з майстер-паролем.')),
        h('button', { onclick: async () => { const r = await call('wallet:hide'); if (r && r.ok) render(); else if (r && r.error) alert(r.error); } }, 'Приховати')),
      h('div', { class: 'row' }, h('div', null, h('div', null, 'Видалити гаманець'), h('div', { class: 'd' }, 'Видаляє ключі з цього пристрою. Без фрази відновлення кошти недоступні.')),
        h('button', { class: 'danger', onclick: async () => {
          const r = await withAuth((x) => call('wallet:remove', x));
          if (r && r.ok) render(); else if (r && r.error) alert(r.error);
        } }, 'Видалити')));
}
