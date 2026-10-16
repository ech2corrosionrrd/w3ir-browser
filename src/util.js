'use strict';
// Спільні дрібні функції (раніше дублювались у кількох модулях).

// Керівні символи (C0, DEL, C1) → пробіл, обрізання до n символів
const CTL = /[\u0000-\u001f\u007f-\u009f]/g;
const stripCtl = (s, n = 200) => String(s == null ? '' : s).replace(CTL, ' ').slice(0, n);

// Сувора очистка тексту сторінки для ШІ й журналів: ще й невидимі символи та двонаправлені керівні (Trojan Source),
// стиснення пробілів
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
const cleanStrict = (s, n = 200) => String(s == null ? '' : s).replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

const isWebUrl = (u) => /^https?:/i.test(u || '');

module.exports = { stripCtl, cleanStrict, isWebUrl };
