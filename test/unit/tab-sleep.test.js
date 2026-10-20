'use strict';
// Unit-тести логіки сплячих вкладок (економія пам'яті) без Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const tabSleep = require(path.join(__dirname, '..', '..', 'src', 'tab-sleep.js'));

function createMockWindow(cfg = {}) {
  const win = {
    ctx: {
      cfg: () => ({ sleepTabs: true, sleepMinutes: 15, ...cfg }),
    },
    activeId: 1,
    pushed: 0,
    push() { this.pushed++; },
    tabUrl(t) { return t.url; },
    tabs: [],
    active() { return this.tabs.find(t => t.id === this.activeId); },
  };
  Object.assign(win, tabSleep.methods);
  return win;
}

function createMockTab({ id, url = 'https://example.com', title = 'Example', active = false, pinned = false, playing = false, lastActive = Date.now() }) {
  return {
    id,
    url,
    favicon: 'https://example.com/favicon.ico',
    pinned,
    playing,
    lastActive,
    sleep: null,
    view: {
      webContents: {
        isCurrentlyAudible: () => playing,
        isLoading: () => false,
        getTitle: () => title,
        navigationHistory: {
          getAllEntries: () => [{ url, title }],
          getActiveIndex: () => 0,
          restore: () => Promise.resolve(),
        },
        loadURL: () => Promise.resolve(),
        executeJavaScript: () => Promise.resolve(false), // no unsaved inputs
      },
    },
  };
}

test('tab-sleep: sleepDelay розраховує час очікування за налаштуваннями', () => {
  const win = createMockWindow({ sleepMinutes: 30 });
  // Якщо SLEEP_ENV задано (у тестовому середовищі), він має пріоритет; інакше 30 * 60 * 1000
  const delay = win.sleepDelay();
  if (tabSleep.SLEEP_ENV) {
    assert.equal(delay, tabSleep.SLEEP_ENV);
  } else {
    assert.equal(delay, 30 * 60 * 1000);
  }
});

test('tab-sleep: sleepTab не присипляє активну вкладку або не-web сторінки', () => {
  const win = createMockWindow();
  const activeTab = createMockTab({ id: 1, url: 'https://active.example' });
  const internalTab = createMockTab({ id: 2, url: 'w3ir://settings' });
  win.tabs = [activeTab, internalTab];

  // Активна вкладка не засинає
  assert.equal(win.sleepTab(activeTab), false);
  assert.equal(activeTab.sleep, null);

  // Внутрішня w3ir:// сторінка не засинає
  assert.equal(win.sleepTab(internalTab), false);
  assert.equal(internalTab.sleep, null);
});

test('tab-sleep: sleepTab та wake успішний життєвий цикл', () => {
  const win = createMockWindow();
  const inactiveTab = createMockTab({ id: 2, url: 'https://news.example', title: 'News' });
  win.tabs = [inactiveTab];

  // Присипляємо
  const ok = win.sleepTab(inactiveTab);
  assert.equal(ok, true);
  assert.ok(inactiveTab.sleep);
  assert.equal(inactiveTab.sleep.url, 'https://news.example');
  assert.equal(inactiveTab.sleep.title, 'News');
  assert.equal(win.pushed, 1);

  // Спроба повторно приспати вже сплячу вкладку повертає false
  assert.equal(win.sleepTab(inactiveTab), false);

  // Пробуджуємо
  win.wake(inactiveTab);
  assert.equal(inactiveTab.sleep, null);
  assert.equal(inactiveTab.favicon, 'https://example.com/favicon.ico');
});

test('tab-sleep: sleepNow присипляє всі допустимі неактивні вкладки', async () => {
  const win = createMockWindow();
  const activeTab = createMockTab({ id: 1, url: 'https://active.example' });
  const tab2 = createMockTab({ id: 2, url: 'https://site2.example' });
  const tab3Pinned = createMockTab({ id: 3, url: 'https://pinned.example', pinned: true });
  const tab4Audible = createMockTab({ id: 4, url: 'https://music.example', playing: true });
  const tab5 = createMockTab({ id: 5, url: 'https://site5.example' });

  win.tabs = [activeTab, tab2, tab3Pinned, tab4Audible, tab5];

  const sleptCount = await win.sleepNow();
  // Тільки tab2 і tab5 мають заснути (активна, закріплена й з аудіо пропускаються)
  assert.equal(sleptCount, 2);
  assert.equal(activeTab.sleep, null);
  assert.ok(tab2.sleep);
  assert.equal(tab3Pinned.sleep, null);
  assert.equal(tab4Audible.sleep, null);
  assert.ok(tab5.sleep);
});
