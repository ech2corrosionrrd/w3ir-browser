'use strict';
// Захист від підміни адреси в буфері обміну. Шкідливі програми змінюють скопійовану адресу гаманця на свою. Браузер запам'ятовує
// адреси, які ВИ скопіювали в ньому (Ctrl+C / «Копіювати» у меню), і перед переказом порівнює з ними адресу отримувача: якщо вона
// інша, у вікні підтвердження з'являється попередження. Копіювання поза браузером (інші програми, телефон) побачити неможливо,
// тому за його відсутності попередження немає. Нічого не зберігається на диск, пам'ять очищається через 15 хвилин.
const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const WINDOW = 15 * 60 * 1000;
const MAX = 5;

const family = (a) => (EVM.test(a) ? 'evm' : (SOL.test(a) ? 'sol' : ''));
const norm = (a) => (EVM.test(a) ? a.toLowerCase() : a);

class ClipGuard {
  constructor(readText, now = () => Date.now()) {
    this.readText = readText;
    this.now = now;
    this.copies = [];
  }

  _prune() { const t = this.now(); this.copies = this.copies.filter(c => t - c.at < WINDOW); }

  // запам'ятати скопійований текст, якщо це адреса
  note(text) {
    const a = String(text == null ? '' : text).trim();
    if (!family(a)) return false;
    this._prune();
    this.copies = this.copies.filter(c => norm(c.addr) !== norm(a));
    this.copies.push({ addr: a, at: this.now() });
    if (this.copies.length > MAX) this.copies.shift();
    return true;
  }

  // Після Ctrl+C / «Копіювати»: буфер заповнюється асинхронно, тому читаємо з невеликою затримкою
  noteSoon(delay = 200) {
    setTimeout(() => { try { this.note(this.readText()); } catch { /* буфер недоступний */ } }, delay);
  }

  // Порівняння отримувача зі скопійованим у браузері. status: none | match | changed (similar — збігаються початок і кінець)
  check(to) {
    const f = family(String(to || ''));
    if (!f) return { status: 'none' };
    this._prune();
    const same = this.copies.filter(c => family(c.addr) === f);
    if (!same.length) return { status: 'none' };
    if (same.some(c => norm(c.addr) === norm(to))) return { status: 'match' };
    const last = same[same.length - 1].addr;
    const pre = f === 'evm' ? 6 : 4;
    const a = norm(last), b = norm(to);
    return { status: 'changed', copied: last, similar: a.slice(0, pre) === b.slice(0, pre) && a.slice(-4) === b.slice(-4) };
  }

  clear() { this.copies = []; }
}

module.exports = { ClipGuard };
