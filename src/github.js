'use strict';
// Інтеграція з GitHub: сповіщення та запити на рев'ю прямо в браузері.
// Токен (classic PAT зі scope `notifications`) зберігається лише в головному процесі, зашифрований DPAPI;
// вебсторінки та інтерфейс його не бачать — вони отримують тільки списки.
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const { writeAtomic } = require('./crypto-util');

const API = 'https://api.github.com';
const HTML_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[^\s"'<>\\^`{|}]*)?$/;
const TOKEN_RE = /^[A-Za-z0-9_\-]{20,255}$/;
const { stripCtl } = require('./util');
const clean = (s, n = 200) => stripCtl(s, n);

// api.github.com/repos/o/r/pulls/5  ->  github.com/o/r/pull/5
function htmlFromApi(apiUrl, repoHtml) {
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/(issues|pulls|commits|releases)\/([^/?#]+)/.exec(apiUrl || '');
  let url = repoHtml;
  if (m) {
    const [, o, r, kind, id] = m;
    const seg = { issues: 'issues', pulls: 'pull', commits: 'commit', releases: 'releases' }[kind];
    url = kind === 'releases' ? `https://github.com/${o}/${r}/releases` : `https://github.com/${o}/${r}/${seg}/${id}`;
  }
  return HTML_URL.test(url || '') ? url : null;
}

class GitHub {
  constructor({ dir, onChange = () => {}, apiBase = API, allowInsecure = false }) {
    this.file = path.join(dir, 'github.token');
    this.onChange = onChange;
    this.apiBase = apiBase;
    this.allowInsecure = allowInsecure;
    this.token = null;
    this.timer = null;
    this.interval = 120000;
    this.etag = null;
    this.running = null;
    this.state = this._empty();
    this._load();
  }

  _empty() { return { login: '', notifications: [], reviews: [], error: '', updated: 0 }; }

  _load() {
    try {
      if (fs.existsSync(this.file) && safeStorage.isEncryptionAvailable()) this.token = safeStorage.decryptString(fs.readFileSync(this.file));
    } catch { this.token = null; }
  }

  connected() { return !!this.token; }

  status() {
    const s = this.state;
    return { connected: this.connected(), login: s.login, unread: s.notifications.length, reviews: s.reviews.length, error: s.error, updated: s.updated };
  }

  count() { return this.connected() ? this.state.notifications.length + this.state.reviews.length : 0; }

  panel() { return { connected: this.connected(), login: this.state.login, error: this.state.error, notifications: this.state.notifications, reviews: this.state.reviews, updated: this.state.updated }; }

  async _api(method, p, { body, etag } = {}) {
    if (!this.allowInsecure && !this.apiBase.startsWith('https://')) throw new Error('insecure api base');
    const headers = {
      Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'W3IR-Browser',
    };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch(this.apiBase + p, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000), redirect: 'error' });
    const poll = Number(res.headers.get('x-poll-interval'));
    if (poll > 0) this.interval = Math.max(60, poll) * 1000;
    let json = null;
    if (res.status !== 304 && res.status !== 205 && res.status !== 204) { try { json = await res.json(); } catch { json = null; } }
    return { status: res.status, json, etag: res.headers.get('etag') };
  }

  async connect(token) {
    token = String(token || '').trim();
    if (!TOKEN_RE.test(token)) throw new Error('Некоректний формат токена.');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Захищене сховище ключів недоступне.');
    const prev = this.token;
    this.token = token;
    try {
      const r = await this._api('GET', '/user');
      if (r.status === 401) throw new Error('GitHub відхилив токен (недійсний або прострочений).');
      if (r.status !== 200 || !r.json || typeof r.json.login !== 'string') throw new Error('Неочікувана відповідь GitHub (код ' + r.status + ').');
      this.state = this._empty();
      this.state.login = clean(r.json.login, 80);
      writeAtomic(fs, this.file, safeStorage.encryptString(token));
    } catch (e) {
      this.token = prev;
      throw e;
    }
    this.etag = null;
    this.start();
    return this.status();
  }

  disconnect() {
    this.stop();
    this.token = null;
    this.etag = null;
    this.state = this._empty();
    try { fs.unlinkSync(this.file); } catch { /* ignore */ }
    this.onChange();
  }

  start() {
    this.stop();
    if (!this.connected()) return;
    this.refresh();
    const tick = () => { this.timer = setTimeout(async () => { await this.refresh(); if (this.timer) tick(); }, this.interval); };
    tick();
  }

  stop() { clearTimeout(this.timer); this.timer = null; }

  async refresh() {
    if (!this.connected()) return;
    if (this.running) return this.running;
    this.running = (async () => {
      await null;
      try {
        if (!this.state.login) {
          const u = await this._api('GET', '/user');
          if (u.status === 200 && u.json && u.json.login) this.state.login = clean(u.json.login, 80);
        }
        const n = await this._api('GET', '/notifications?per_page=30', { etag: this.etag });
        if (n.status === 401) { this.state.error = 'Токен недійсний або прострочений. Підключіть GitHub заново.'; this.stop(); return; }
        if (n.status === 403 || n.status === 429) { this.state.error = 'Перевищено ліміт запитів GitHub. Спробуємо пізніше.'; return; }
        if (n.status === 200 && Array.isArray(n.json)) {
          this.etag = n.etag;
          this.state.notifications = n.json.slice(0, 30).map(x => {
            const repoHtml = x.repository && x.repository.html_url;
            const url = htmlFromApi(x.subject && x.subject.url, repoHtml);
            return url ? {
              id: clean(x.id, 40), title: clean(x.subject && x.subject.title), repo: clean(x.repository && x.repository.full_name, 120),
              type: clean(x.subject && x.subject.type, 40), reason: clean(x.reason, 40), url, updated: Date.parse(x.updated_at) || 0,
            } : null;
          }).filter(Boolean);
        } else if (n.status !== 304) {
          this.state.error = 'GitHub повернув помилку ' + n.status;
          return;
        }
        const q = encodeURIComponent('is:open is:pr review-requested:@me archived:false');
        const r = await this._api('GET', `/search/issues?q=${q}&per_page=20`);
        if (r.status === 200 && r.json && Array.isArray(r.json.items)) {
          this.state.reviews = r.json.items.map(x => (HTML_URL.test(x.html_url || '') ? {
            title: clean(x.title), repo: clean(String(x.repository_url || '').replace(/^.*\/repos\//, ''), 120), number: Number(x.number) || 0, url: x.html_url, updated: Date.parse(x.updated_at) || 0,
          } : null)).filter(Boolean);
        }
        this.state.error = '';
        this.state.updated = Date.now();
      } catch (e) {
        this.state.error = /abort|timeout/i.test(e.message) ? 'GitHub не відповідає.' : 'Помилка мережі: ' + clean(e.message, 100);
      } finally {
        this.running = null;
        this.onChange();
      }
    })();
    return this.running;
  }

  async markRead(id) {
    if (!this.connected() || !/^\d+$/.test(String(id))) return;
    try { await this._api('PATCH', `/notifications/threads/${id}`); } catch { /* ignore */ }
    this.state.notifications = this.state.notifications.filter(x => x.id !== String(id));
    this.onChange();
  }

  async markAllRead() {
    if (!this.connected()) return;
    try { await this._api('PUT', '/notifications', { body: { read: true } }); } catch { /* ignore */ }
    this.state.notifications = [];
    this.etag = null;
    this.onChange();
  }
}

// Розбір адреси сторінки репозиторію (для контекстних команд)
const RESERVED = new Set(['features', 'settings', 'marketplace', 'notifications', 'pulls', 'issues', 'explore', 'topics', 'sponsors', 'orgs', 'login', 'logout', 'new', 'search', 'about', 'pricing', 'enterprise', 'collections', 'trending', 'codespaces', 'apps', 'users', 'organizations', 'join', 'signup', 'contact', 'site', 'readme', 'customer-stories', 'security', 'sitemap', 'git-guides', 'account', 'dashboard']);
function githubRepo(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null;
    const [o, r, kind, ...rest] = u.pathname.split('/').filter(Boolean);
    if (!o || !r || RESERVED.has(o.toLowerCase()) || !/^[A-Za-z0-9_.-]+$/.test(o) || !/^[A-Za-z0-9_.-]+$/.test(r)) return null;
    return { owner: o, repo: r.replace(/\.git$/, ''), kind: kind || '', rest };
  } catch { return null; }
}

module.exports = { GitHub, htmlFromApi, githubRepo, HTML_URL };
