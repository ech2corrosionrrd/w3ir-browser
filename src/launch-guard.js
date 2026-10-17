'use strict';
// Захист запуску: у встановленій (упакованій) збірці параметри налагодження Chromium/Node вимкнені.
// Інакше змінений ярлик чи програма-інсталятор могли б запустити браузер з відкритим портом керування (`--remote-debugging-port`),
// через який видно й змінюється будь-яка сторінка, зокрема сховище паролів і гаманець.
// Для тестування розробником є окремий свідомий спосіб (приватна інструкція).

const DEBUG_FLAG = /^--(remote-debugging-(port|pipe|address)|remote-allow-origins|inspect(-brk|-port|-publish-uid)?|debug-port|enable-logging=stderr)\b/i;

// Перший знайдений параметр налагодження або null
function debugFlag(argv) {
  for (const a of argv || []) if (typeof a === 'string' && DEBUG_FLAG.test(a)) return a;
  return null;
}

// Чи треба заблокувати запуск: упакована збірка + параметр налагодження + без явного дозволу
function shouldBlock({ argv, packaged, env }) {
  return !!(packaged && debugFlag(argv) && !(env && env.W3IR_ALLOW_DEBUG === '1'));
}

module.exports = { debugFlag, shouldBlock, DEBUG_FLAG };
