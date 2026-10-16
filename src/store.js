'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const stores = new Set();
const BACKUP_EVERY_MS = 10 * 60 * 1000;

// Невеликий JSON-стор у userData з відкладеним атомарним записом.
class Store {
  constructor(name, defaults, dir) {
    this.file = path.join(dir || app.getPath('userData'), name + '.json');
    const base = JSON.parse(JSON.stringify(defaults));
    this.data = base;
    this.recovered = ''; // '' | 'backup' | 'defaults': що сталось із пошкодженим файлом
    this.lastBak = 0;
    const apply = (saved) => {
      if (Array.isArray(base)) { if (!Array.isArray(saved)) throw new Error('shape'); this.data = saved; }
      else if (saved && typeof saved === 'object' && !Array.isArray(saved)) this.data = { ...base, ...saved };
      else throw new Error('shape');
    };
    if (fs.existsSync(this.file)) {
      try { apply(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
      catch {
        // пошкоджений файл не перезаписуємо мовчки порожніми даними: зберігаємо його окремо й пробуємо резервну копію
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
        try { apply(JSON.parse(fs.readFileSync(this.file + '.bak', 'utf8'))); this.recovered = 'backup'; fs.copyFileSync(this.file + '.bak', this.file); }
        catch { this.recovered = 'defaults'; }
        console.error(`Store ${this.file} пошкоджено; відновлено: ${this.recovered}`);
      }
    }
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
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, JSON.stringify(this.data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // резервна копія попередньої версії (не частіше, ніж раз на 10 хв, щоб не подвоювати запис великої історії)
      if (Date.now() - this.lastBak > BACKUP_EVERY_MS && fs.existsSync(this.file)) {
        try { fs.copyFileSync(this.file, this.file + '.bak'); this.lastBak = Date.now(); } catch { /* ignore */ }
      }
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Store write failed', this.file, e.message);
    }
  }
}

function flushAll() { for (const s of stores) if (s.timer) s.flush(); }

module.exports = { Store, flushAll };
