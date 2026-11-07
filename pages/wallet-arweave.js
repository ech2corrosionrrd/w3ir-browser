'use strict';
// Розділ Arweave / Irys: перегляд NFT, конструктор метаданих, перевірка шлюзів.

function buildArweaveSection(first, net) {
  const input = h('input', { type: 'text', placeholder: 'Введіть txId або ar://...', spellcheck: false, style: 'flex:1' });
  const statusMsg = h('div', { class: 'note', style: 'margin-top:6px' });
  const cardContainer = h('div', { class: 'nft-grid' });

  const inspect = async () => {
    const val = input.value.trim();
    if (!val) return;
    statusMsg.textContent = 'Завантаження з Arweave шлюзів…';
    cardContainer.textContent = '';
    const res = await call('arweave:nft', { txId: val });
    if (!res.ok) {
      statusMsg.textContent = res.error || 'Помилка завантаження NFT.';
      return;
    }
    const meta = res.metadata;
    statusMsg.textContent = 'Знайдено в постійному сховищі Arweave.';

    const imgEl = h('img', {
      class: 'nft-thumb',
      src: meta.imageGateway || meta.image,
      alt: meta.name,
      onerror: () => { imgEl.style.display = 'none'; }
    });

    const traitsEls = (meta.attributes || []).map(a =>
      h('div', { class: 'nft-trait' }, `${a.trait_type}: `, h('strong', null, a.value))
    );

    const card = h('div', { class: 'nft-card' },
      meta.image ? imgEl : '',
      h('div', { class: 'nft-body' },
        h('span', { class: 'nft-badge' }, '⚡ Arweave Permanent'),
        h('div', { class: 'nft-title' }, meta.name),
        meta.description ? h('div', { class: 'nft-desc' }, meta.description) : '',
        traitsEls.length ? h('div', { class: 'nft-traits' }, traitsEls) : '',
        h('div', { class: 'tools', style: 'margin-top:8px' },
          h('a', { href: meta.arweaveUrl, target: '_blank' }, 'Відкрити ar://'),
          h('a', { href: `https://viewblock.io/arweave/tx/${meta.txId}`, target: '_blank' }, 'Оглядач блоків'))));

    cardContainer.append(card);
  };

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') inspect(); });

  const pingGateways = async () => {
    statusMsg.textContent = 'Перевірка шлюзів Arweave / Irys…';
    const r = await call('arweave:ping');
    if (!r || !r.ok) { statusMsg.textContent = (r && r.error) || 'Помилка перевірки шлюзів.'; return; }
    statusMsg.textContent = r.gateways.map(g => `${g.gateway.replace('https://', '')}: ${g.ok ? g.ms + ' ms' : t('недоступний')}`).join(' · ');
  };

  const openMetaBuilder = async () => {
    const f = [
      { name: 'name', label: 'Назва NFT', value: '' },
      { name: 'image', label: 'Зображення на Arweave (ar:// або txId)', value: input.value.trim() || 'ar://' },
      { name: 'description', label: 'Опис', type: 'textarea', value: '' },
    ];
    const v = await ask('Конструктор метаданих NFT (Arweave)', f, { okText: 'Сформувати JSON' });
    if (!v) return;
    const r = await call('arweave:buildMeta', v);
    if (!r || !r.ok) { statusMsg.textContent = (r && r.error) || t('Помилка'); return; }
    const jsonStr = JSON.stringify(r.metadata, null, 2);
    await ask('Готовий маніфест NFT (Arweave)', [{ name: 'json', label: 'JSON для завантаження в Arweave / Irys', type: 'textarea', value: jsonStr }], { okText: 'Закрити' });
  };

  return h('div', { class: 'card', style: 'max-width:none;margin:0' },
    h('p', { style: 'margin-top:0' }, 'Всі NFT та постійні медіафайли у W3IR Browser завантажуються та верифікуються напряму через децентралізоване сховище Arweave (шлюзи Irys / Arweave) без посередників чи платних API.'),
    h('div', { class: 'bar', style: 'margin:12px 0 6px' },
      input,
      h('button', { class: 'primary', onclick: inspect }, 'Переглянути NFT'),
      h('button', { onclick: openMetaBuilder }, 'Створити метадані'),
      h('button', { onclick: pingGateways }, 'Шлюзи Arweave')),
    statusMsg,
    cardContainer,
    h('div', { class: 'tools', style: 'margin-top:10px' },
      h('span', { class: 'note' }, 'Швидкі посилання маркетплейсів для першого рахунку:'),
      h('a', { href: `https://opensea.io/${first}` }, 'OpenSea'),
      h('a', { href: `https://rarible.com/user/${first}` }, 'Rarible'),
      net && net.explorer ? h('a', { href: `${net.explorer}/address/${first}#nfttransfers` }, 'Перекази NFT в оглядачі') : ''));
}
