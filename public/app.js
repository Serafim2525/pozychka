// ПозичКа — клієнтська частина (без фреймворків).
'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const app = $('#app');
  const nav = $('#nav');
  const DAY = 24 * 60 * 60 * 1000;

  const CATS = [['Зарядки', '🔌'], ['Канцелярія', '✏️'], ['Книги', '📚'], ['Спорт', '⚽'], ['Інше', '🎒']];
  const CAT_ICON = Object.fromEntries(CATS);
  const CLASSES = [];
  for (let g = 5; g <= 11; g++) for (const l of 'АБВГ') CLASSES.push(`${g}-${l}`);
  const STATUS = { requested: 'Очікує', approved: 'Підтверджено', rejected: 'Відхилено', given: 'Видано', returned: 'Повернуто' };
  const ROLE = { student: 'Учень', teacher: 'Класний керівник', admin: 'Адміністратор' };

  const state = {
    user: null,
    notif: { requests: 0, messages: 0, total: 0 },
    page: '',
    q: '',
    cat: '',
    cls: '',
    avail: false,
    token: 0,
    itemsSeq: 0,
    timers: [],
    scanner: null,
    scanBusy: false,
    qrTab: 'show',
    loansTab: 'borrowed',
    adminTab: 'users',
    adminClass: '9-А',
  };

  // ---------- Утиліти ----------

  // Екранування будь-якого тексту перед вставкою в HTML — захист від XSS.
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  const num = (v) => Number(v) || 0;

  function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }
  const days = (n) => `${n} ${plural(n, ['день', 'дні', 'днів'])}`;
  const firstName = (name) => String(name || '').split(' ')[0];
  const initial = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();

  function fmtDate(iso, withTime = true) {
    if (!iso) return '—';
    const opts = withTime
      ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'long' };
    return new Date(iso).toLocaleString('uk-UA', opts);
  }

  const karmaChip = (k) => `<span class="karma ${num(k) < 3 ? 'low' : ''}" title="Карма">⭐ ${num(k).toFixed(1)}</span>`;
  const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
  const pill = (status) => `<span class="pill ${esc(status)}">${esc(STATUS[status] || status)}</span>`;
  const unreadBadge = (n) => (num(n) > 0 ? `<b class="badge inline" title="Нові повідомлення">💬 ${num(n)}</b>` : '');
  const formatCode = (c) => (c ? `${c.slice(0, 4)}-${c.slice(4)}` : '');

  function thumb(photo, cat, small = false) {
    const inner = photo
      ? `<img src="/uploads/${esc(encodeURIComponent(photo))}" alt="" loading="lazy">`
      : esc(CAT_ICON[cat] || '📦');
    return `<div class="thumb ${small ? 'sm' : ''}">${inner}</div>`;
  }

  const empty = (icon, text) => `<div class="empty"><span class="big">${icon}</span>${esc(text)}</div>`;

  // Нагадування про термін: скільки лишилось або червоне попередження.
  function dueInfo(due) {
    if (!due) return '';
    const ms = new Date(due) - Date.now();
    if (ms < 0) {
      const d = Math.floor(-ms / DAY);
      const txt = d >= 1 ? `прострочено на ${days(d)}` : 'термін минув сьогодні';
      return `<div class="due overdue">⚠️ Увага: ${txt}! Річ треба повернути негайно (−0.5 карми).</div>`;
    }
    if (ms < DAY) {
      const h = Math.max(1, Math.ceil(ms / (60 * 60 * 1000)));
      return `<div class="due soon">⏰ Лишилось ${h} год — останній день (до ${esc(fmtDate(due))})</div>`;
    }
    return `<div class="due">📅 Лишилось ${days(Math.ceil(ms / DAY))} — до ${esc(fmtDate(due))}</div>`;
  }

  let toastTimer;
  function toast(msg, type = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), 3200);
  }

  function handle(err) {
    if (err && err.silent) return;
    toast(err && err.message ? err.message : 'Щось пішло не так', 'err');
  }

  async function api(path, { method = 'GET', body, form } = {}) {
    const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (form) opts.body = form;
    else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      throw new Error("Немає зв'язку з сервером");
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      state.user = null;
      toast(data.error || 'Потрібно увійти', 'err');
      go('#/login');
      const e = new Error(data.error || 'Потрібно увійти');
      e.silent = true;
      throw e;
    }
    if (!res.ok) throw new Error(data.error || `Помилка ${res.status}`);
    return data;
  }

  const scripts = {};
  function loadScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => {
          delete scripts[src];
          reject(new Error('Не вдалося завантажити сканер QR'));
        };
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }

  // ---------- Сповіщення ----------

  async function refreshNotif() {
    if (!state.user) return;
    try {
      state.notif = await api('/api/notifications');
    } catch {
      return;
    }
    paintBadges();
  }

  function paintBadges() {
    const n = state.notif;
    const set = (el, v) => {
      el.textContent = v > 99 ? '99+' : String(v);
      el.classList.toggle('hidden', !v);
    };
    set($('#nav-badge'), n.total);
    $$('[data-badge]').forEach((el) => set(el, num(n[el.dataset.badge])));
  }

  // ---------- Спільні шматки розмітки ----------

  const bell = () =>
    `<a class="icon-btn" href="#/requests" aria-label="Сповіщення">🔔<b class="badge hidden" data-badge="total"></b></a>`;

  function pageTop(titleHtml, { back = true, right } = {}) {
    return `<header class="top"><div class="top-row">
      <div class="page-title">${back ? '<button class="icon-btn back" data-act="back" aria-label="Назад">‹</button>' : ''}<h1>${titleHtml}</h1></div>
      <div class="top-actions">${right ?? bell()}</div>
    </div></header>`;
  }

  function chipsHtml() {
    const all = [['', '✨ Усе'], ...CATS.map(([c, i]) => [c, `${i} ${c}`])];
    return `<div class="chips" role="tablist" aria-label="Категорії">${all
      .map(([c, label]) => `<button class="chip ${state.cat === c ? 'on' : ''}" data-act="cat" data-cat="${esc(c)}">${esc(label)}</button>`)
      .join('')}</div>`;
  }

  function itemCard(i) {
    const me = state.user.id;
    let btn;
    if (i.owner_id === me) btn = '<span class="pill">Твоя річ</span>';
    else if (i.my_request) btn = '<button class="btn sm sent" disabled>Запит надіслано ✓</button>';
    else if (!i.is_available) btn = '<button class="btn sm gray" disabled>Зайнято</button>';
    else btn = `<button class="btn sm" data-act="borrow" data-id="${num(i.id)}">Позичити</button>`;
    return `<article class="item ${i.is_available ? '' : 'busy'}">
      ${thumb(i.photo, i.category)}
      <div class="info">
        <b>${esc(i.title)}</b>
        <div class="meta"><a href="#/user/${num(i.owner_id)}">${esc(firstName(i.owner_name))}</a> · ${esc(i.owner_class)} · 📍 ${esc(i.location)}</div>
        ${i.description ? `<div class="desc">${esc(i.description)}</div>` : ''}
        <div class="row">${karmaChip(i.owner_karma)}<span class="meta">⏳ на ${days(num(i.max_days))}</span>${btn}</div>
      </div>
    </article>`;
  }

  // Картка позики. as — з чиєї точки зору: 'borrower' або 'owner'.
  function loanCard(l, as, actions = '') {
    const who = as === 'borrower'
      ? `Власник: ${esc(l.owner_name)} · ${esc(l.owner_class)}`
      : `Позичальник: ${esc(l.borrower_name)} · ${esc(l.borrower_class)} ${karmaChip(l.borrower_karma)}`;
    return `<article class="item">
      ${thumb(l.item_photo, l.item_category, true)}
      <div class="info">
        <a href="#/loan/${num(l.id)}"><b>${esc(l.item_title)}</b></a>
        <div class="meta">${who}</div>
        <div class="row"><span>${pill(l.status)}${unreadBadge(l.unread)}</span><span class="meta">${esc(fmtDate(l.created_at))}</span></div>
        ${l.status === 'given' ? dueInfo(l.due_date) : ''}
        <div class="row">${actions}<a class="btn sm ghost" href="#/loan/${num(l.id)}">💬 Відкрити</a></div>
      </div>
    </article>`;
  }

  // ---------- Роутер ----------

  const routes = [
    [/^\/$/, viewHome, 'home'],
    [/^\/search$/, viewSearch, 'search'],
    [/^\/add$/, viewAdd, 'add'],
    [/^\/qr$/, viewQr, 'qr'],
    [/^\/profile$/, viewProfile, 'profile'],
    [/^\/requests$/, viewRequests, 'profile'],
    [/^\/loans$/, viewLoans, 'profile'],
    [/^\/loan\/(\d+)$/, viewLoan, 'profile'],
    [/^\/user\/(\d+)$/, viewUser, 'home'],
    [/^\/admin$/, viewAdmin, 'profile'],
    [/^\/class$/, viewClass, 'profile'],
    [/^\/login$/, viewLogin, null, true],
    [/^\/register$/, viewRegister, null, true],
  ];

  function go(hash) {
    if (location.hash === hash) router();
    else location.hash = hash;
  }

  async function cleanup() {
    state.timers.forEach(clearInterval);
    state.timers = [];
    await stopScanner();
  }

  async function router({ keepScroll = false } = {}) {
    const token = ++state.token;
    await cleanup();
    const path = location.hash.replace(/^#/, '') || '/';
    const route = routes.find(([re]) => re.test(path)) || routes[0];
    const [re, view, navKey, isPublic] = route;
    const match = path.match(re) || [];
    if (!isPublic && !state.user) return go('#/login');
    if (isPublic && state.user) return go('#/');

    nav.classList.toggle('hidden', Boolean(isPublic));
    app.classList.toggle('no-nav', Boolean(isPublic));
    $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === navKey));
    state.page = navKey || '';

    try {
      const out = await view(match[1]);
      if (token !== state.token) return; // користувач уже перейшов на іншу сторінку
      const y = window.scrollY;
      app.innerHTML = out.html;
      window.scrollTo(0, keepScroll ? y : 0);
      paintBadges();
      if (out.mount) await out.mount();
    } catch (err) {
      if (err.silent || token !== state.token) return;
      app.innerHTML = `${pageTop('Помилка')}<div class="section">${empty('😕', err.message)}</div>`;
    }
  }
  const refresh = () => router({ keepScroll: true });

  // ---------- Вхід і реєстрація ----------

  function authShell(inner) {
    return `<div class="auth">
      <img class="logo" src="/logo.svg" alt="Логотип ПозичКи">
      <h1>ПозичКа</h1>
      <div class="slogan">Забув? Позич за хвилину!</div>
      <div class="card">${inner}</div>
    </div>`;
  }

  async function viewLogin() {
    return {
      html: authShell(`
        <h2>Вхід</h2>
        <form class="form" data-form="login" novalidate>
          <div class="error hidden"></div>
          <label class="field"><span>Шкільна пошта</span>
            <input type="email" name="email" required placeholder="імʼя@school.ua" autocomplete="username"></label>
          <label class="field"><span>Пароль</span>
            <input type="password" name="password" required autocomplete="current-password"></label>
          <button class="btn block" type="submit">Увійти</button>
        </form>
        <p class="switch">Ще немає акаунта? <a href="#/register">Зареєструватися</a></p>
        <div class="demo">Демо-акаунти (натисни, щоб увійти):
          <div class="btns">
            <button class="btn sm ghost" data-act="demo" data-email="olena@school.ua" data-pass="123456">🎒 Учениця Олена</button>
            <button class="btn sm ghost" data-act="demo" data-email="teacher@school.ua" data-pass="teacher123">👩‍🏫 Класний керівник</button>
            <button class="btn sm ghost" data-act="demo" data-email="admin@school.ua" data-pass="admin123">🛠 Адмін</button>
          </div>
        </div>`),
    };
  }

  async function viewRegister() {
    return {
      html: authShell(`
        <h2>Реєстрація</h2>
        <form class="form" data-form="register" novalidate>
          <div class="error hidden"></div>
          <label class="field"><span>Імʼя та прізвище</span>
            <input type="text" name="name" required minlength="2" maxlength="60" placeholder="Олена Коваль" autocomplete="name"></label>
          <label class="field"><span>Клас</span>
            <select name="class" required><option value="">Оберіть клас</option>${CLASSES.map((c) => `<option>${c}</option>`).join('')}</select></label>
          <label class="field"><span>Шкільна пошта</span>
            <input type="email" name="email" required placeholder="імʼя@school.ua" autocomplete="email">
            <small>Лише адреси домену @school.ua</small></label>
          <label class="field"><span>Пароль</span>
            <input type="password" name="password" required minlength="6" autocomplete="new-password" placeholder="щонайменше 6 символів"></label>
          <label class="field"><span>Повторіть пароль</span>
            <input type="password" name="password2" required minlength="6" autocomplete="new-password"></label>
          <button class="btn block" type="submit">Створити акаунт</button>
        </form>
        <p class="switch">Вже є акаунт? <a href="#/login">Увійти</a></p>`),
    };
  }

  // ---------- Головна та пошук ----------

  async function loadItems() {
    const box = $('#items');
    if (!box) return;
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.cat) p.set('category', state.cat);
    if (state.page === 'search') {
      if (state.cls) p.set('class', state.cls);
      if (state.avail) p.set('available', '1');
    }
    const seq = ++state.itemsSeq;
    const { items } = await api(`/api/items?${p}`);
    if (seq !== state.itemsSeq || !box.isConnected) return;
    const count = $('#count');
    if (count) count.textContent = `${items.length} ${plural(items.length, ['річ', 'речі', 'речей'])}`;
    box.innerHTML = items.length
      ? items.map(itemCard).join('')
      : empty('🤷', 'Нічого не знайдено. Спробуй інший запит або категорію — або додай свою річ через «+».');
  }

  let searchTimer;
  function bindSearch() {
    const input = $('#q');
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = input.value.trim();
        loadItems().catch(handle);
      }, 250);
    });
  }

  async function viewHome() {
    const u = state.user;
    return {
      html: `<header class="top">
          <div class="brand"><img src="/logo.svg" alt="">ПозичКа</div>
          <div class="top-row">
            <div><small>Привіт, ${esc(firstName(u.name))} 👋</small><h1>Що позичимо сьогодні?</h1></div>
            <div class="top-actions">${bell()}<a class="avatar" href="#/profile" aria-label="Профіль">${esc(initial(u.name))}</a></div>
          </div>
          <div class="search"><input type="search" id="q" placeholder="Зарядка, калькулятор, книга…" value="${esc(state.q)}" autocomplete="off" aria-label="Пошук за назвою"></div>
        </header>
        ${chipsHtml()}
        <section class="section">
          <div class="section-title">Речі поруч <span id="count"></span></div>
          <div id="items">${empty('⏳', 'Завантаження…')}</div>
        </section>`,
      mount: () => {
        bindSearch();
        loadItems().catch(handle);
      },
    };
  }

  async function viewSearch() {
    return {
      html: `<header class="top">
          <div class="top-row"><h1>🔍 Пошук</h1><div class="top-actions">${bell()}</div></div>
          <div class="search"><input type="search" id="q" placeholder="Що шукаєш?" value="${esc(state.q)}" autocomplete="off" aria-label="Пошук за назвою"></div>
        </header>
        ${chipsHtml()}
        <div class="filters">
          <select data-change="cls" aria-label="Клас власника">
            <option value="">Усі класи</option>
            ${CLASSES.map((c) => `<option ${state.cls === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
          <label class="toggle"><input type="checkbox" data-change="avail" ${state.avail ? 'checked' : ''}> Лише вільні</label>
        </div>
        <section class="section">
          <div class="section-title">Результати <span id="count"></span></div>
          <div id="items">${empty('⏳', 'Завантаження…')}</div>
        </section>`,
      mount: () => {
        bindSearch();
        $('#q').focus();
        loadItems().catch(handle);
      },
    };
  }

  // ---------- Додавання речі ----------

  async function viewAdd() {
    return {
      html: `${pageTop('➕ Додати річ')}
        <section class="section">
          <form class="card form" data-form="add-item" novalidate>
            <label class="photo-pick" id="photo-pick">
              <span id="photo-preview">📷<br>Додати фото (необовʼязково)<br><small>JPG, PNG, WEBP або GIF до 2 МБ</small></span>
              <input type="file" name="photo" accept="image/jpeg,image/png,image/webp,image/gif" data-change="photo">
            </label>
            <label class="field"><span>Назва *</span>
              <input type="text" name="title" required minlength="2" maxlength="80" placeholder="Напр.: Зарядка Type-C"></label>
            <div class="field"><span>Категорія *</span>
              <div class="cat-pick">${CATS.map(([c, i], k) => `<label><input type="radio" name="category" value="${esc(c)}" ${k === 0 ? 'checked' : ''}><span class="chip">${i} ${esc(c)}</span></label>`).join('')}</div>
            </div>
            <label class="field"><span>Опис</span>
              <textarea name="description" maxlength="500" placeholder="Стан, особливості, як забрати…"></textarea></label>
            <div class="two-col">
              <label class="field"><span>Де забрати *</span>
                <input type="text" name="location" required maxlength="60" placeholder="каб. 24, 2 поверх"></label>
              <label class="field"><span>Термін позики *</span>
                <select name="max_days">${[1, 2, 3, 5, 7, 14, 30].map((d) => `<option value="${d}">${days(d)}</option>`).join('')}</select></label>
            </div>
            <div class="error hidden"></div>
            <button class="btn block" type="submit">Опублікувати річ</button>
          </form>
        </section>`,
    };
  }

  // ---------- QR ----------

  async function viewQr() {
    const tab = state.qrTab;
    const tabs = `<div class="tabs">
      <button class="${tab === 'show' ? 'on' : ''}" data-act="tab" data-key="qrTab" data-tab="show">🎒 Мій код</button>
      <button class="${tab === 'scan' ? 'on' : ''}" data-act="tab" data-key="qrTab" data-tab="scan">📷 Сканувати</button>
    </div>`;

    if (tab === 'show') {
      const { loans } = await api('/api/loans/borrowed');
      const active = loans.filter((l) => l.qr_image);
      const cards = active.map((l) => `<div class="card qr-box">
          <div class="row" style="margin-top:0"><b>${esc(l.item_title)}</b>${pill(l.status)}</div>
          <p class="meta">Власник: ${esc(l.owner_name)} · ${esc(l.owner_class)} · 📍 ${esc(l.item_location)}</p>
          <p style="margin-top:8px;font-weight:700">${l.status === 'approved'
            ? '👉 Покажи цей код власнику, щоб отримати річ'
            : '👉 Щоб повернути річ, покажи цей код власнику'}</p>
          <img src="${esc(l.qr_image)}" alt="QR-код позики">
          <div class="code">${esc(formatCode(l.qr_code))}</div>
          ${l.status === 'given' ? dueInfo(l.due_date) : ''}
          <div class="row" style="justify-content:center"><a class="btn sm ghost" href="#/loan/${num(l.id)}">💬 Чат із власником</a></div>
        </div>`);
      return {
        html: `${pageTop('📷 QR-передача', { back: false })}${tabs}
          <section class="section">
            ${cards.join('') || `<div class="card">${empty('🎫', 'Тут зʼявиться QR-код, коли власник підтвердить твій запит на позику.')}</div>`}
          </section>`,
      };
    }

    const { loans } = await api('/api/loans/lent');
    const waiting = loans.filter((l) => ['approved', 'given'].includes(l.status));
    return {
      html: `${pageTop('📷 QR-передача', { back: false })}${tabs}
        <section class="section">
          <div class="card">
            <p style="font-weight:700;margin-bottom:10px">Ти власник? Відскануй QR-код позичальника, щоб підтвердити видачу або повернення речі.</p>
            <div id="reader" class="hidden"></div>
            <div class="btns" style="margin-top:10px">
              <button class="btn block" data-act="scan-start" id="scan-start">📷 Увімкнути камеру</button>
              <button class="btn block warn hidden" data-act="scan-stop" id="scan-stop">✖ Зупинити камеру</button>
            </div>
            <form class="form" data-form="code" style="margin-top:14px" novalidate>
              <label class="field"><span>…або введи код вручну</span>
                <input type="text" name="code" class="code-input" maxlength="12" placeholder="XXXX-XXXX" autocomplete="off" autocapitalize="characters"></label>
              <div class="error hidden"></div>
              <button class="btn block orange" type="submit">Підтвердити код</button>
            </form>
          </div>
          <div class="section-title" style="margin-top:18px">Чекають на скан <span>${waiting.length}</span></div>
          ${waiting.map((l) => loanCard(l, 'owner', `<span class="meta">${l.status === 'approved' ? '➡️ видача' : '⬅️ повернення'}</span>`)).join('')
            || `<div class="card">${empty('✅', 'Немає речей, які чекають на передачу.')}</div>`}
        </section>`,
    };
  }

  async function startScanner() {
    await loadScript('/vendor/html5-qrcode.min.js');
    const Lib = window.__Html5QrcodeLibrary__;
    const reader = $('#reader');
    if (!Lib || !reader) throw new Error('Сканер недоступний');
    if (state.scanner) return;
    reader.classList.remove('hidden');
    const scanner = new Lib.Html5Qrcode('reader');
    state.scanner = scanner;
    try {
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        async (decoded) => {
          if (state.scanBusy) return;
          state.scanBusy = true;
          await stopScanner();
          try {
            await submitCode(decoded);
          } catch (e) {
            handle(e);
          } finally {
            state.scanBusy = false;
          }
        },
        () => {}
      );
      $('#scan-start')?.classList.add('hidden');
      $('#scan-stop')?.classList.remove('hidden');
    } catch {
      state.scanner = null;
      reader.classList.add('hidden');
      throw new Error('Не вдалося увімкнути камеру. Дозволь доступ до камери або введи код вручну.');
    }
  }

  async function stopScanner() {
    const s = state.scanner;
    state.scanner = null;
    if (s) {
      try {
        await s.stop();
        s.clear();
      } catch {
        /* камера вже зупинена */
      }
    }
    $('#reader')?.classList.add('hidden');
    $('#scan-start')?.classList.remove('hidden');
    $('#scan-stop')?.classList.add('hidden');
  }

  async function submitCode(code) {
    const r = await api('/api/qr/scan', { method: 'POST', body: { code } });
    toast(r.message, 'ok');
    go(`#/loan/${num(r.loan_id)}`);
  }

  // ---------- Мої запити ----------

  async function viewRequests() {
    const [{ loans: lent }, { loans: borrowed }] = await Promise.all([api('/api/loans/lent'), api('/api/loans/borrowed')]);
    const incoming = lent.filter((l) => l.status === 'requested');
    const toHand = lent.filter((l) => l.status === 'approved');
    const mine = borrowed.filter((l) => ['requested', 'approved'].includes(l.status));
    const rejected = borrowed.filter((l) => l.status === 'rejected').slice(0, 3);

    const incomingHtml = incoming
      .map((l) => loanCard(l, 'owner', `<button class="btn sm" data-act="approve" data-id="${num(l.id)}">✔ Підтвердити</button>
        <button class="btn sm warn" data-act="reject" data-id="${num(l.id)}">✖ Відхилити</button>`))
      .join('');
    const handHtml = toHand
      .map((l) => loanCard(l, 'owner', '<button class="btn sm orange" data-act="goto-scan">📷 Сканувати QR</button>'))
      .join('');
    const mineHtml = mine
      .map((l) => loanCard(l, 'borrower', `${l.status === 'approved' ? '<button class="btn sm orange" data-act="goto-show">🎫 Мій QR</button>' : ''}
        <button class="btn sm gray" data-act="cancel" data-id="${num(l.id)}">Скасувати</button>`))
      .join('');

    return {
      html: `${pageTop('📩 Мої запити')}
        <section class="section">
          <div class="section-title">Вхідні запити <b class="badge inline hidden" data-badge="requests"></b></div>
          ${incomingHtml || `<div class="card">${empty('📭', 'Нових запитів на твої речі немає.')}</div>`}
        </section>
        ${handHtml ? `<section class="section"><div class="section-title">Чекають передачі</div>${handHtml}</section>` : ''}
        <section class="section">
          <div class="section-title">Мої надіслані запити</div>
          ${mineHtml || `<div class="card">${empty('🔍', 'Ти ще нічого не просив. Знайди потрібну річ на головній!')}</div>`}
          ${rejected.map((l) => loanCard(l, 'borrower')).join('')}
        </section>`,
    };
  }

  // ---------- Мої позики ----------

  async function viewLoans() {
    const tab = state.loansTab;
    const as = tab === 'borrowed' ? 'borrower' : 'owner';
    const { loans } = await api(tab === 'borrowed' ? '/api/loans/borrowed' : '/api/loans/lent');
    const active = loans.filter((l) => ['requested', 'approved', 'given'].includes(l.status));
    // Спочатку прострочені та ті, в яких термін спливає раніше.
    active.sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
    const history = loans.filter((l) => ['returned', 'rejected'].includes(l.status));
    const overdue = active.filter((l) => l.status === 'given' && l.due_date && new Date(l.due_date) < Date.now()).length;

    return {
      html: `${pageTop('🔄 Мої позики')}
        <div class="tabs">
          <button class="${tab === 'borrowed' ? 'on' : ''}" data-act="tab" data-key="loansTab" data-tab="borrowed">Я позичив</button>
          <button class="${tab === 'lent' ? 'on' : ''}" data-act="tab" data-key="loansTab" data-tab="lent">У мене позичили</button>
        </div>
        ${overdue ? `<div class="section"><div class="due overdue">⚠️ Прострочених позик: ${overdue}. ${as === 'borrower' ? 'Поверни речі якнайшвидше!' : 'Напиши позичальнику в чат.'}</div></div>` : ''}
        <section class="section">
          <div class="section-title">Активні <span>${active.length}</span></div>
          ${active.map((l) => loanCard(l, as)).join('') || `<div class="card">${empty('🌤', 'Активних позик немає.')}</div>`}
        </section>
        <section class="section">
          <div class="section-title">Історія <span>${history.length}</span></div>
          ${history.map((l) => loanCard(l, as)).join('') || `<div class="card">${empty('📜', 'Історія поки порожня.')}</div>`}
        </section>`,
    };
  }

  // ---------- Сторінка позики: статус, QR, чат, відгук ----------

  function chatHtml(messages) {
    const me = state.user.id;
    if (!messages.length) return empty('💬', 'Ще немає повідомлень. Домовтесь, де і коли передати річ.');
    return messages
      .map((m) => `<div class="msg ${m.sender_id === me ? 'mine' : ''}">${m.sender_id === me ? '' : `<b>${esc(firstName(m.sender_name))}</b>\n`}${esc(m.text)}<time>${esc(fmtDate(m.created_at))}</time></div>`)
      .join('');
  }

  function paintChat(messages) {
    const box = $('#chat');
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = chatHtml(messages);
    box.dataset.count = String(messages.length);
    if (atBottom || !box.dataset.painted) box.scrollTop = box.scrollHeight;
    box.dataset.painted = '1';
  }

  function loanActions(l) {
    const id = num(l.id);
    const qr = l.qr_image
      ? `<div class="qr-box"><img src="${esc(l.qr_image)}" alt="QR-код"><div class="code">${esc(formatCode(l.qr_code))}</div></div>`
      : '';
    if (l.role === 'borrower') {
      switch (l.status) {
        case 'requested':
          return `<p>⏳ Чекаємо, поки ${esc(firstName(l.owner_name))} підтвердить запит.</p>
            <div class="btns" style="margin-top:10px"><button class="btn sm gray" data-act="cancel" data-id="${id}">Скасувати запит</button></div>`;
        case 'approved':
          return `<p><b>✅ Запит підтверджено!</b> Зустрінься з власником і покажи цей QR — він його відсканує, і річ буде видано.</p>${qr}
            <div class="btns"><button class="btn sm gray" data-act="cancel" data-id="${id}">Скасувати</button></div>`;
        case 'given':
          return `${dueInfo(l.due_date)}<p style="margin-top:10px"><b>Щоб повернути річ,</b> покажи власнику цей QR-код.</p>${qr}`;
        default:
          break;
      }
    }
    if (l.role === 'owner') {
      switch (l.status) {
        case 'requested':
          return `<p>${esc(l.borrower_name)} (${esc(l.borrower_class)}) просить позичити річ.</p>
            <div class="btns" style="margin-top:10px">
              <button class="btn" data-act="approve" data-id="${id}">✔ Підтвердити</button>
              <button class="btn warn" data-act="reject" data-id="${id}">✖ Відхилити</button>
            </div>`;
        case 'approved':
          return `<p>Під час зустрічі відскануй QR-код позичальника — статус зміниться на «видано».</p>
            <div class="btns" style="margin-top:10px">
              <button class="btn orange" data-act="goto-scan">📷 Сканувати QR</button>
              <button class="btn gray" data-act="reject" data-id="${id}">Скасувати</button>
            </div>`;
        case 'given':
          return `${dueInfo(l.due_date)}<p style="margin-top:10px">Коли річ повернуть — відскануй QR-код позичальника.</p>
            <div class="btns" style="margin-top:10px"><button class="btn orange" data-act="goto-scan">📷 Прийняти повернення</button></div>`;
        default:
          break;
      }
    }
    if (l.status === 'rejected') return '<p>Запит відхилено або скасовано.</p>';
    if (l.status === 'returned') return `<p>✅ Річ повернуто ${esc(fmtDate(l.returned_at))}.${l.penalized ? ' Із запізненням (−0.5 карми).' : ''}</p>`;
    return '';
  }

  async function viewLoan(idStr) {
    const id = Number(idStr);
    const [{ loan: l }, { messages }] = await Promise.all([api(`/api/loans/${id}`), api(`/api/loans/${id}/messages`)]);
    const me = state.user.id;
    const reviewForm = l.can_review
      ? `<div class="card">
          <div class="section-title">Оціни ${esc(firstName(l.role === 'borrower' ? l.owner_name : l.borrower_name))}</div>
          <form class="form" data-form="review" data-id="${id}" novalidate>
            <div class="star-pick">${[1, 2, 3, 4, 5].map((v) => `<button type="button" data-act="star" data-v="${v}" aria-label="${v} із 5">★</button>`).join('')}</div>
            <input type="hidden" name="rating" value="">
            <textarea name="comment" maxlength="300" placeholder="Коментар (необовʼязково)"></textarea>
            <div class="error hidden"></div>
            <button class="btn block" type="submit">Надіслати оцінку</button>
          </form>
        </div>`
      : '';
    const reviews = l.reviews
      .map((r) => `<div class="card review"><div class="row" style="margin-top:0"><b>${esc(r.author_name)}${r.author_id === me ? ' (ти)' : ''}</b><span class="stars">${stars(num(r.rating))}</span></div>
        ${r.comment ? `<p class="meta" style="margin-top:4px">${esc(r.comment)}</p>` : ''}</div>`)
      .join('');
    const canChat = l.role !== 'viewer';

    return {
      html: `${pageTop(`Позика #${id}`)}
        <section class="section">
          <div class="card">
            <div class="user-row">${thumb(l.item_photo, l.item_category, true)}
              <div class="info"><b>${esc(l.item_title)}</b><div class="row" style="margin-top:4px">${pill(l.status)}</div></div>
            </div>
            <dl class="kv" style="margin-top:12px">
              <dt>Власник</dt><dd><a href="#/user/${num(l.owner_id)}">${esc(l.owner_name)}</a> · ${esc(l.owner_class)} ${karmaChip(l.owner_karma)}</dd>
              <dt>Позичальник</dt><dd><a href="#/user/${num(l.borrower_id)}">${esc(l.borrower_name)}</a> · ${esc(l.borrower_class)} ${karmaChip(l.borrower_karma)}</dd>
              <dt>Де забрати</dt><dd>📍 ${esc(l.item_location)}</dd>
              <dt>Термін</dt><dd>${l.due_date ? `до ${esc(fmtDate(l.due_date))}` : `${days(num(l.item_max_days))} після передачі`}</dd>
              <dt>Запит</dt><dd>${esc(fmtDate(l.created_at))}</dd>
              ${l.given_at ? `<dt>Видано</dt><dd>${esc(fmtDate(l.given_at))}</dd>` : ''}
              ${l.returned_at ? `<dt>Повернуто</dt><dd>${esc(fmtDate(l.returned_at))}</dd>` : ''}
            </dl>
          </div>
          <div class="card">${loanActions(l)}</div>
          ${reviewForm}
          ${reviews ? `<div class="section-title" style="margin-top:6px">Відгуки</div>${reviews}` : ''}
          ${canChat ? `<div class="card">
            <div class="section-title">💬 Чат</div>
            <div class="chat" id="chat"></div>
            <form class="chat-form" data-form="chat" data-id="${id}" autocomplete="off">
              <input type="text" name="text" maxlength="500" placeholder="Напиши повідомлення…" aria-label="Повідомлення" required>
              <button class="btn" type="submit" aria-label="Надіслати">➤</button>
            </form>
          </div>` : ''}
        </section>`,
      mount: () => {
        if (!canChat) return;
        paintChat(messages);
        refreshNotif();
        state.timers.push(
          setInterval(async () => {
            try {
              const r = await api(`/api/loans/${id}/messages`);
              const box = $('#chat');
              if (box && Number(box.dataset.count) !== r.messages.length) {
                paintChat(r.messages);
                refreshNotif();
              }
            } catch {
              /* наступна спроба за кілька секунд */
            }
          }, 4000)
        );
      },
    };
  }

  // ---------- Профіль ----------

  function reviewCard(r) {
    return `<div class="card review">
      <div class="row" style="margin-top:0"><b>${esc(r.author_name)} · ${esc(r.author_class)}</b><span class="stars">${stars(num(r.rating))}</span></div>
      <p class="meta">📦 ${esc(r.item_title)} · ${esc(fmtDate(r.created_at, false))}</p>
      ${r.comment ? `<p style="margin-top:4px">${esc(r.comment)}</p>` : ''}
    </div>`;
  }

  async function viewProfile() {
    const data = await api('/api/profile');
    const u = data.user;
    state.user = { ...state.user, ...u };
    const me = u.id;
    const isStaff = u.role === 'teacher' || u.role === 'admin';

    const items = data.items
      .map((i) => `<article class="item">${thumb(i.photo, i.category, true)}
        <div class="info"><b>${esc(i.title)}</b>
          <div class="meta">📍 ${esc(i.location)} · на ${days(num(i.max_days))} · позичали ${num(i.times_lent)} р.</div>
          <div class="row">${i.is_available ? '<span class="pill returned">Вільна</span>' : '<span class="pill given">Зайнята</span>'}
            <button class="btn sm gray" data-act="del-item" data-id="${num(i.id)}">🗑 Видалити</button></div>
        </div></article>`)
      .join('');

    const history = data.history
      .slice(0, 10)
      .map((l) => loanCard(l, l.borrower_id === me ? 'borrower' : 'owner'))
      .join('');

    return {
      html: `<header class="top profile-head">
          <div class="top-row"><span></span><div class="top-actions">${bell()}</div></div>
          <div class="avatar big">${esc(initial(u.name))}</div>
          <h1>${esc(u.name)}</h1>
          <small>${u.class !== '—' ? `${esc(u.class)} · ` : ''}${esc(ROLE[u.role])} · ${esc(u.email)}</small>
          <div class="karma-big">⭐ ${num(u.karma).toFixed(1)} <small>карма</small></div>
        </header>
        <div class="stats">
          <div class="stat"><b>${num(data.stats.borrowed)}</b><small>позичив</small></div>
          <div class="stat"><b>${num(data.stats.lent)}</b><small>дав у позику</small></div>
          <div class="stat"><b>${data.reviews.length}</b><small>відгуків</small></div>
        </div>
        <section class="section">
          <nav class="menu">
            <a href="#/requests">📩 Мої запити <b class="badge inline hidden" data-badge="requests"></b><span class="go">›</span></a>
            <a href="#/loans">🔄 Мої позики <b class="badge inline hidden" data-badge="messages"></b><span class="go">›</span></a>
            ${isStaff ? '<a href="#/class">🧑‍🏫 Мій клас<span class="go">›</span></a>' : ''}
            ${u.role === 'admin' ? '<a href="#/admin">🛠 Панель адміністратора<span class="go">›</span></a>' : ''}
            <button data-act="logout">🚪 Вийти</button>
          </nav>
        </section>
        <section class="section">
          <div class="card" style="font-size:13px;color:var(--mut)">
            ⭐ <b>Карма</b> — середня оцінка з відгуків після повернення речей. Кожне прострочення знімає 0.5.
            Якщо карма опуститься нижче 2 — акаунт блокується автоматично.
            ${num(data.stats.overdue) ? `<br><b style="color:var(--c)">Прострочень: ${num(data.stats.overdue)}</b>` : ''}
          </div>
        </section>
        <section class="section">
          <div class="section-title">Мої речі <span>${data.items.length}</span></div>
          ${items || `<div class="card">${empty('📦', 'Ти ще нічого не додав.')}<div class="btns" style="justify-content:center"><a class="btn" href="#/add">+ Додати річ</a></div></div>`}
        </section>
        <section class="section">
          <div class="section-title">Історія позик <a href="#/loans"><span>усі ›</span></a></div>
          ${history || `<div class="card">${empty('📜', 'Історія поки порожня.')}</div>`}
        </section>
        <section class="section">
          <div class="section-title">Відгуки про мене</div>
          ${data.reviews.map(reviewCard).join('') || `<div class="card">${empty('💬', 'Відгуків ще немає.')}</div>`}
        </section>`,
    };
  }

  async function viewUser(idStr) {
    const { user: u, items, reviews } = await api(`/api/users/${Number(idStr)}`);
    return {
      html: `${pageTop(esc(u.name))}
        <section class="section">
          <div class="card user-row">
            <div class="avatar">${esc(initial(u.name))}</div>
            <div class="info"><b>${esc(u.name)}</b><div class="meta">${esc(u.class)} · ${esc(ROLE[u.role])}</div></div>
            ${karmaChip(u.karma)}${u.is_blocked ? '<span class="pill blocked">Заблоковано</span>' : ''}
          </div>
        </section>
        <section class="section">
          <div class="section-title">Речі <span>${items.length}</span></div>
          ${items.map((i) => `<article class="item">${thumb(i.photo, i.category, true)}<div class="info"><b>${esc(i.title)}</b>
            <div class="meta">📍 ${esc(i.location)} · на ${days(num(i.max_days))}</div>
            <div class="row">${i.is_available ? '<span class="pill returned">Вільна</span>' : '<span class="pill given">Зайнята</span>'}</div></div></article>`).join('')
            || `<div class="card">${empty('📦', 'Речей немає.')}</div>`}
        </section>
        <section class="section">
          <div class="section-title">Відгуки <span>${reviews.length}</span></div>
          ${reviews.map(reviewCard).join('') || `<div class="card">${empty('💬', 'Відгуків ще немає.')}</div>`}
        </section>`,
    };
  }

  // ---------- Класний керівник ----------

  async function viewClass() {
    const q = state.user.role === 'admin' ? `?class=${encodeURIComponent(state.adminClass)}` : '';
    const data = await api(`/api/teacher/class${q}`);
    const picker = state.user.role === 'admin'
      ? `<div class="filters"><select data-change="admin-class" aria-label="Клас">${data.classes.map((c) => `<option ${c === data.class ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`
      : '';
    return {
      html: `${pageTop(`🧑‍🏫 Клас ${esc(data.class)}`)}
        ${picker}
        <section class="section">
          <div class="section-title">Учні <span>${data.students.length}</span></div>
          ${data.students.map((s) => `<div class="card user-row">
              <div class="avatar">${esc(initial(s.name))}</div>
              <div class="info"><a href="#/user/${num(s.id)}"><b>${esc(s.name)}</b></a>
                <div class="meta">речей: ${num(s.items)} · зараз позичив: ${num(s.active)}</div>
                ${num(s.overdue) ? `<div class="due overdue">⚠️ Прострочено: ${num(s.overdue)}</div>` : ''}
              </div>
              ${karmaChip(s.karma)}${s.is_blocked ? '<span class="pill blocked">Блок</span>' : ''}
            </div>`).join('') || `<div class="card">${empty('👥', 'У цьому класі ще немає учнів.')}</div>`}
        </section>
        <section class="section">
          <div class="section-title">Речі зараз на руках</div>
          ${data.loans.map((l) => `<div class="card">
              <b>${esc(l.item_title)}</b>
              <div class="meta">${esc(l.owner_name)} (${esc(l.owner_class)}) → ${esc(l.borrower_name)} (${esc(l.borrower_class)})</div>
              ${dueInfo(l.due_date)}
            </div>`).join('') || `<div class="card">${empty('✅', 'Активних позик немає.')}</div>`}
        </section>`,
    };
  }

  // ---------- Адміністратор ----------

  async function viewAdmin() {
    const tab = state.adminTab;
    const tabs = `<div class="tabs">
      <button class="${tab === 'users' ? 'on' : ''}" data-act="tab" data-key="adminTab" data-tab="users">👥 Користувачі</button>
      <button class="${tab === 'items' ? 'on' : ''}" data-act="tab" data-key="adminTab" data-tab="items">📦 Речі</button>
    </div>`;

    if (tab === 'users') {
      const { users, stats } = await api('/api/admin/users');
      return {
        html: `${pageTop('🛠 Адміністратор')}
          <section class="section"><div class="stat-grid">
            <div class="stat"><b>${num(stats.users)}</b><small>користувачів</small></div>
            <div class="stat"><b>${num(stats.items)}</b><small>речей</small></div>
            <div class="stat"><b>${num(stats.active)}</b><small>на руках</small></div>
            <div class="stat"><b>${num(stats.returned)}</b><small>повернено</small></div>
          </div></section>
          ${tabs}
          <section class="section">
            ${users.map((u) => `<div class="card">
                <div class="user-row">
                  <div class="avatar">${esc(initial(u.name))}</div>
                  <div class="info"><b>${esc(u.name)}</b><div class="meta">${esc(u.email)} · ${esc(u.class)} · ${esc(ROLE[u.role])}</div></div>
                  ${karmaChip(u.karma)}
                </div>
                <div class="row">
                  <span class="meta">речей: ${num(u.items)} · прострочень: ${num(u.overdue)} ${u.is_blocked ? '<span class="pill blocked">Заблоковано</span>' : ''}</span>
                  ${u.role === 'admin' ? '' : u.is_blocked
                    ? `<button class="btn sm" data-act="block" data-id="${num(u.id)}" data-blocked="0">🔓 Розблокувати</button>`
                    : `<button class="btn sm warn" data-act="block" data-id="${num(u.id)}" data-blocked="1">🔒 Заблокувати</button>`}
                </div>
              </div>`).join('')}
          </section>`,
      };
    }

    const { items } = await api('/api/admin/items');
    return {
      html: `${pageTop('🛠 Адміністратор')}${tabs}
        <section class="section">
          ${items.map((i) => `<article class="item">${thumb(i.photo, i.category, true)}
              <div class="info"><b>${esc(i.title)}</b>
                <div class="meta">${esc(i.owner_name)} · ${esc(i.owner_class)} · ${esc(i.owner_email)}</div>
                <div class="row">${i.is_available ? '<span class="pill returned">Вільна</span>' : '<span class="pill given">Зайнята</span>'}
                  <button class="btn sm warn" data-act="del-item" data-id="${num(i.id)}">🗑 Видалити</button></div>
              </div></article>`).join('') || `<div class="card">${empty('📦', 'Речей немає.')}</div>`}
        </section>`,
    };
  }

  // ---------- Дії (делегування подій, бо CSP забороняє inline-обробники) ----------

  const actions = {
    back: () => (history.length > 1 ? history.back() : go('#/')),

    async demo(el) {
      const form = $('form[data-form="login"]');
      form.email.value = el.dataset.email;
      form.password.value = el.dataset.pass;
      form.requestSubmit();
    },

    cat(el) {
      state.cat = el.dataset.cat;
      $$('.chips .chip').forEach((c) => c.classList.toggle('on', c.dataset.cat === state.cat));
      return loadItems();
    },

    async borrow(el) {
      el.disabled = true;
      try {
        await api('/api/loans', { method: 'POST', body: { item_id: Number(el.dataset.id) } });
      } catch (e) {
        el.disabled = false;
        throw e;
      }
      el.textContent = 'Запит надіслано ✓';
      el.classList.add('sent');
      toast('Запит надіслано! Слідкуй за статусом у «Мої позики»', 'ok');
    },

    async approve(el) {
      await api(`/api/loans/${Number(el.dataset.id)}/approve`, { method: 'POST' });
      toast('Запит підтверджено! Позичальник отримав QR-код', 'ok');
      refreshNotif();
      refresh();
    },

    async reject(el) {
      if (!confirm('Відхилити цей запит?')) return;
      await api(`/api/loans/${Number(el.dataset.id)}/reject`, { method: 'POST' });
      toast('Запит відхилено');
      refreshNotif();
      refresh();
    },

    async cancel(el) {
      if (!confirm('Скасувати запит на позику?')) return;
      await api(`/api/loans/${Number(el.dataset.id)}/cancel`, { method: 'POST' });
      toast('Запит скасовано');
      refresh();
    },

    async 'del-item'(el) {
      if (!confirm('Видалити цю річ? Дію не можна скасувати.')) return;
      await api(`/api/items/${Number(el.dataset.id)}`, { method: 'DELETE' });
      toast('Річ видалено');
      refresh();
    },

    async block(el) {
      const blocked = el.dataset.blocked === '1';
      if (blocked && !confirm('Заблокувати користувача? Він не зможе увійти.')) return;
      await api(`/api/admin/users/${Number(el.dataset.id)}/block`, { method: 'POST', body: { blocked } });
      toast(blocked ? 'Користувача заблоковано' : 'Користувача розблоковано');
      refresh();
    },

    tab(el) {
      const key = el.dataset.key;
      if (!['qrTab', 'loansTab', 'adminTab'].includes(key)) return;
      state[key] = el.dataset.tab;
      refresh();
    },

    'goto-scan': () => {
      state.qrTab = 'scan';
      go('#/qr');
    },
    'goto-show': () => {
      state.qrTab = 'show';
      go('#/qr');
    },
    'scan-start': () => startScanner(),
    'scan-stop': () => stopScanner(),

    star(el) {
      const form = el.closest('form');
      const v = Number(el.dataset.v);
      form.rating.value = String(v);
      $$('[data-act="star"]', form).forEach((b) => b.classList.toggle('on', Number(b.dataset.v) <= v));
    },

    async logout() {
      await api('/api/auth/logout', { method: 'POST' });
      state.user = null;
      state.notif = { requests: 0, messages: 0, total: 0 };
      go('#/login');
    },
  };

  const forms = {
    async login(f) {
      const email = f.email.value.trim();
      if (!email || !f.password.value) throw new Error('Введіть пошту та пароль');
      const r = await api('/api/auth/login', { method: 'POST', body: { email, password: f.password.value } });
      state.user = r.user;
      toast(`Вітаємо, ${firstName(r.user.name)}!`, 'ok');
      refreshNotif();
      go('#/');
    },

    async register(f) {
      const body = {
        name: f.name.value.trim(),
        class: f.class.value,
        email: f.email.value.trim(),
        password: f.password.value,
      };
      if (body.name.length < 2) throw new Error('Вкажіть імʼя');
      if (!body.class) throw new Error('Оберіть клас');
      if (!/^[^\s@]+@school\.ua$/i.test(body.email)) throw new Error('Потрібна шкільна пошта домену @school.ua');
      if (body.password.length < 6) throw new Error('Пароль має містити щонайменше 6 символів');
      if (body.password !== f.password2.value) throw new Error('Паролі не збігаються');
      const r = await api('/api/auth/register', { method: 'POST', body });
      state.user = r.user;
      toast('Акаунт створено! Ласкаво просимо 🎉', 'ok');
      go('#/');
    },

    async 'add-item'(f) {
      const fd = new FormData(f);
      if (String(fd.get('title')).trim().length < 2) throw new Error('Вкажіть назву речі');
      if (!String(fd.get('location')).trim()) throw new Error('Вкажіть, де забрати річ');
      const photo = fd.get('photo');
      if (photo && photo.size === 0) fd.delete('photo');
      else if (photo && photo.size > 2 * 1024 * 1024) throw new Error('Фото завелике — максимум 2 МБ');
      await api('/api/items', { method: 'POST', form: fd });
      toast('Річ опубліковано! 🎉', 'ok');
      state.q = '';
      state.cat = '';
      go('#/');
    },

    async code(f) {
      const code = f.code.value.trim();
      if (!code) throw new Error('Введіть код');
      await submitCode(code);
    },

    async chat(f) {
      const input = f.text;
      const text = input.value.trim();
      if (!text) return;
      const id = Number(f.dataset.id);
      await api(`/api/loans/${id}/messages`, { method: 'POST', body: { text } });
      input.value = '';
      const r = await api(`/api/loans/${id}/messages`);
      paintChat(r.messages);
      const box = $('#chat');
      if (box) box.scrollTop = box.scrollHeight;
      input.focus();
    },

    async review(f) {
      const rating = Number(f.rating.value);
      if (!rating) throw new Error('Обери оцінку від 1 до 5 зірок');
      const r = await api(`/api/loans/${Number(f.dataset.id)}/review`, {
        method: 'POST',
        body: { rating, comment: f.comment.value.trim() },
      });
      toast(`Дякуємо за відгук! Карма тепер ${num(r.target_karma).toFixed(1)}`, 'ok');
      refresh();
    },
  };

  const changes = {
    cls(el) {
      state.cls = el.value;
      return loadItems();
    },
    avail(el) {
      state.avail = el.checked;
      return loadItems();
    },
    'admin-class'(el) {
      state.adminClass = el.value;
      refresh();
    },
    photo(el) {
      const file = el.files && el.files[0];
      const box = $('#photo-preview');
      if (!file) return;
      if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
        el.value = '';
        throw new Error('Дозволені лише фото JPG, PNG, WEBP або GIF');
      }
      if (file.size > 2 * 1024 * 1024) {
        el.value = '';
        throw new Error('Фото завелике — максимум 2 МБ');
      }
      const img = document.createElement('img');
      img.alt = 'Попередній перегляд';
      img.src = URL.createObjectURL(file);
      box.replaceChildren(img);
    },
  };

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !actions[el.dataset.act]) return;
    e.preventDefault();
    if (el.disabled) return;
    try {
      await actions[el.dataset.act](el, e);
    } catch (err) {
      handle(err);
    }
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('form[data-form]');
    if (!f || !forms[f.dataset.form]) return;
    e.preventDefault();
    const btn = f.querySelector('[type=submit]');
    const errBox = f.querySelector('.error');
    if (errBox) errBox.classList.add('hidden');
    if (btn) btn.disabled = true;
    try {
      await forms[f.dataset.form](f);
    } catch (err) {
      if (err.silent) return;
      if (errBox) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      } else handle(err);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.addEventListener('change', async (e) => {
    const el = e.target.closest('[data-change]');
    if (!el || !changes[el.dataset.change]) return;
    try {
      await changes[el.dataset.change](el);
    } catch (err) {
      handle(err);
    }
  });

  // ---------- Старт ----------

  async function init() {
    try {
      const r = await api('/api/auth/me');
      state.user = r.user;
    } catch {
      state.user = null;
    }
    window.addEventListener('hashchange', () => router());
    setInterval(refreshNotif, 15000);
    refreshNotif();
    router();
  }

  init();
})();
