'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const stores = new Set();

// Невеликий JSON-стор у userData з відкладеним атомарним записом.
class Store {
  constructor(name, defaults, dir) {
    this.file = path.join(dir || app.getPath('userData'), name + '.json');
    const base = JSON.parse(JSON.stringify(defaults));
    this.data = base;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(base)) { if (Array.isArray(saved)) this.data = saved; }
      else if (saved && typeof saved === 'object') this.data = { ...base, ...saved };
    } catch { /* перший запуск або пошкоджений файл */ }
    this.timer = null;
    stores.add(this);
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Store write failed', this.file, e.message);
    }
  }
}

function flushAll() { for (const s of stores) if (s.timer) s.flush(); }

module.exports = { Store, flushAll };
