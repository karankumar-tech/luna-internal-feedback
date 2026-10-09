// The Luna Pulse app shell: the black sidebar, the sticky header and the phone drawer.
// Loaded as the first thing inside <body> on every dashboard page, so the frame is drawn before
// the page's own markup and nothing jumps. The page keeps its data and behaviour; it tells the
// shell who is signed in (setViewer / me) and how many reports need attention (setAttention).
(function () {
  'use strict';
  const CACHE = 'luna.shell.v1';
  const COLLAPSED = 'luna.shell.collapsed';
  const CLOSED_GROUPS = 'luna.shell.closed';
  const HOME_CACHE = 'luna.home.v1';

  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: no memory, still works */ } };
  const drop = (k) => { try { localStorage.removeItem(k); } catch {} };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // lucide icons, 24px grid, stroked
  const P = {
    report: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
    reports: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    attention: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    problems: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    analytics: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    diagnosis: '<path d="M11 2v2"/><path d="M5 2v2"/><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/>',
    benchmarks: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    progress: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    docs: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
    bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;

  // `match` says which paths light the item up; `perm` hides it from people who cannot use it.
  const NAV = [
    { group: 'Overview', items: [
      { id: 'reports', label: 'Reports', href: '/dashboard', match: /^\/dashboard\/?$|^\/dashboard\/submissions\// },
      { id: 'report', label: 'Report an issue', href: '/dashboard/report', match: /^\/dashboard\/report/ },
      { id: 'attention', label: 'Needs attention', href: '/dashboard/attention', match: /^\/dashboard\/attention/, badge: true },
      { id: 'problems', label: 'Problems', href: '/dashboard/kinds', match: /^\/dashboard\/kinds/ },
    ] },
    { group: 'Insight', items: [
      { id: 'analytics', label: 'Analytics', href: '/dashboard/analytics', match: /^\/dashboard\/analytics/ },
      { id: 'diagnosis', label: 'Diagnosis', href: '/dashboard/diagnosis', match: /^\/dashboard\/diagnosis/ },
      { id: 'benchmarks', label: 'Benchmarks', href: '/dashboard/benchmarks', match: /^\/dashboard\/benchmarks(?!\/progress)/ },
      { id: 'progress', label: 'Progress', href: '/dashboard/benchmarks/progress', match: /^\/dashboard\/benchmarks\/progress/ },
    ] },
    { group: 'Admin', items: [
      { id: 'people', label: 'People', href: '/dashboard/users', match: /^\/dashboard\/users/, perm: (p) => p.manage_users },
      { id: 'settings', label: 'Settings', href: '/dashboard/settings', match: /^\/dashboard\/settings/, perm: (p) => p.manage_categories || p.delete_test_data || p.run_diagnosis },
      { id: 'docs', label: 'API docs', href: '/docs', match: /^\/docs/ },
    ] },
  ];

  const body = document.body;
  const here = location.pathname;
  const closed = new Set(read(CLOSED_GROUPS) || []);
  const state = Object.assign({ name: null, email: null, role: null, perms: null, attention: 0 }, read(CACHE) || {});

  function navHtml() {
    return NAV.map((g) => {
      const items = g.items.map((it) => {
        const on = it.match.test(here);
        return `<a class="sb-item" href="${it.href}" data-nav="${it.id}" title="${esc(it.label)}"${on ? ' aria-current="page"' : ''}${it.perm ? ' hidden' : ''}>${icon(it.id)}<span class="sb-label">${esc(it.label)}</span>${it.badge ? '<span class="sb-badge" data-badge hidden></span>' : ''}</a>`;
      }).join('');
      const id = g.group.toLowerCase();
      return `<div class="sb-group${closed.has(id) ? ' closed' : ''}" data-group="${id}">
        <button class="sb-group-label" type="button" aria-expanded="${closed.has(id) ? 'false' : 'true'}"><span>${g.group}</span>${icon('down')}</button>
        <div class="sb-items"><div>${items}</div></div>
      </div>`;
    }).join('');
  }

  const shell = `
<aside class="app-sidebar" id="appSidebar" aria-label="Main">
  <div class="sb-brand"><a href="/dashboard" aria-label="Luna Pulse, all reports"><img class="logo-full" src="/logo.png" alt="Luna Pulse" width="141" height="46"><img class="logo-mark" src="/mark.png" alt="Luna Pulse" width="36" height="36"></a></div>
  <nav class="sb-nav" aria-label="Pages">${navHtml()}</nav>
  <div class="sb-foot">
    <a class="sb-user" href="/dashboard/settings" id="sbUser" title=""><span class="sb-avatar" id="sbAvatar" aria-hidden="true"></span><span class="sb-who"><b id="sbName">&nbsp;</b><small id="sbRole">&nbsp;</small></span></a>
    <button class="sb-icon" type="button" data-signout title="Sign out" aria-label="Sign out">${icon('logout')}</button>
  </div>
  <button class="sb-toggle" type="button" id="sbToggle" aria-label="Collapse the sidebar" aria-controls="appSidebar">${icon('left')}</button>
</aside>
<div class="sb-scrim" id="sbScrim" aria-hidden="true"></div>
<header class="app-header">
  <div class="hd-start">
    <button class="hd-icon hd-menu" type="button" id="hdMenu" aria-label="Open the menu" aria-controls="appSidebar" aria-expanded="false">${icon('menu')}</button>
    <div class="hd-search">${icon('search')}<input id="goRef" type="search" placeholder="Go to LN-… or LNK-…" aria-label="Go to a report (LN-00042) or a problem (LNK-0007)" aria-keyshortcuts="/" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd></div>
  </div>
  <div class="hd-end">
    <a class="hd-icon hd-docs" href="/docs" title="API docs" aria-label="API docs">${icon('docs')}</a>
    <a class="hd-icon" href="/dashboard/attention" id="hdBell" title="Needs attention" aria-label="Needs attention">${icon('bell')}<span class="dot" id="hdDot" hidden></span></a>
    <span class="hd-divider" aria-hidden="true"></span>
    <div class="hd-user">
      <button class="hd-avatar" type="button" id="hdAvatar" aria-haspopup="menu" aria-expanded="false" aria-label="Your account"></button>
    </div>
  </div>
</header>`;

  body.classList.add('has-shell', 'entering');
  if (read(COLLAPSED) === true) body.classList.add('sb-collapsed');
  body.insertAdjacentHTML('afterbegin', shell);
  setTimeout(() => body.classList.remove('entering'), 900);

  const $ = (id) => document.getElementById(id);

  // ---------- who is signed in ----------
  const initials = (name) => String(name || '').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '·';
  function paintViewer() {
    const name = state.name || state.email || (state.role ? 'Master key' : '');
    $('sbName').textContent = name || ' ';
    $('sbRole').textContent = state.role || ' ';
    $('sbAvatar').textContent = name ? initials(name) : '';
    $('hdAvatar').textContent = name ? initials(name) : '';
    $('sbUser').title = name ? `${name}${state.email ? ' · ' + state.email : ''} · ${state.role}` : '';
    const perms = state.perms || {};
    for (const g of NAV) for (const it of g.items) {
      if (!it.perm) continue;
      const a = document.querySelector(`[data-nav="${it.id}"]`);
      if (a) a.hidden = !it.perm(perms);
    }
    // The account link goes to Settings only for people who can open it.
    $('sbUser').setAttribute('href', NAV[2].items[1].perm(perms) ? '/dashboard/settings' : '/dashboard');
  }
  function paintAttention() {
    const n = Number(state.attention) || 0;
    const badge = document.querySelector('[data-badge]');
    if (badge) { badge.hidden = n === 0; badge.textContent = n > 99 ? '99+' : String(n); }
    $('hdDot').hidden = n === 0;
    $('hdBell').title = n ? `${n} need attention` : 'Needs attention';
    $('hdBell').setAttribute('aria-label', n ? `Needs attention: ${n}` : 'Needs attention');
  }
  const save = () => write(CACHE, { name: state.name, email: state.email, role: state.role, perms: state.perms, attention: state.attention });

  let mePromise = null;
  const LunaShell = {
    icon,
    /** The page already knows the viewer (the dashboard gets it with its data). */
    setViewer(v) {
      if (!v) return;
      state.name = v.name || null; state.email = v.email || null; state.role = v.role || null;
      state.perms = v.permissions || state.perms || {};
      save(); paintViewer();
    },
    /** GET /v1/me, once per page however many callers ask; rejects like the pages' api(). */
    me() {
      if (!mePromise) {
        mePromise = fetch('/v1/me', { credentials: 'same-origin', headers: { 'x-requested-with': 'dashboard' } }).then(async (r) => {
          const text = await r.text();
          let b = null; try { b = text ? JSON.parse(text) : null; } catch { b = null; }
          if (!r.ok) { const e = new Error((b && b.error && b.error.message) || `HTTP ${r.status}`); e.status = r.status; e.body = b; throw e; }
          LunaShell.setViewer(b);
          return b;
        });
      }
      return mePromise;
    },
    /** Fetches a file as the dashboard does (with its header) and hands it to the browser to save. Rejects like the pages' api(). */
    async download(path, fallbackName) {
      const r = await fetch(path, { credentials: 'same-origin', headers: { 'x-requested-with': 'dashboard' } });
      if (!r.ok) { const b = await r.json().catch(() => null); const e = new Error((b && b.error && b.error.message) || `HTTP ${r.status}`); e.status = r.status; throw e; }
      const name = (/filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '') || [])[1] || fallbackName;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob()); a.download = name;
      body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      return name;
    },
    setAttention(n) { state.attention = Math.max(0, Number(n) || 0); save(); paintAttention(); },
    /** The sign-in screen has no frame around it. */
    off() { body.classList.add('shell-off'); },
    on() { body.classList.remove('shell-off'); },
    async signOut() {
      try { await fetch('/dashboard/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'dashboard' } }); } catch {}
      drop(CACHE); drop(HOME_CACHE);
      location.href = '/dashboard';
    },
    toast(msg) {
      let t = $('shellToast');
      if (!t) { t = document.createElement('div'); t.id = 'shellToast'; t.className = 'toast'; t.setAttribute('role', 'status'); body.appendChild(t); }
      t.textContent = msg; t.style.display = 'none'; void t.offsetWidth; t.style.display = 'block';
      clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, 3200);
    },
  };
  // ---------- screenshots: full size over the page, one after another ----------
  // items: [{ url, thumb?, name?, caption? }]. Opens on `start`; arrows, swipe or the strip move
  // between them; Escape, the cross or a click outside the image closes it and gives focus back.
  let lb = null;
  function viewer(items, start, opener) {
    const list = (items || []).filter((x) => x && x.url);
    if (!list.length) return;
    if (!lb) {
      const root = document.createElement('div');
      root.className = 'lb'; root.hidden = true;
      root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Screenshots');
      root.innerHTML = `<div class="lb-top">
          <span class="lb-count" aria-live="polite"></span><span class="lb-name"></span>
          <a class="lb-btn lb-open" target="_blank" rel="noopener" title="Open the original in a new tab" aria-label="Open the original in a new tab">${icon('external')}</a>
          <button class="lb-btn lb-x" type="button" title="Close (Esc)" aria-label="Close">${icon('close')}</button>
        </div>
        <div class="lb-stage">
          <button class="lb-btn lb-nav lb-prev" type="button" title="Previous (←)" aria-label="Previous screenshot">${icon('left')}</button>
          <figure class="lb-fig"><img class="lb-img" alt=""><figcaption class="lb-cap"></figcaption></figure>
          <button class="lb-btn lb-nav lb-next" type="button" title="Next (→)" aria-label="Next screenshot">${icon('right')}</button>
        </div>
        <div class="lb-strip" role="group" aria-label="All screenshots"></div>`;
      body.appendChild(root);
      const q = (sel) => root.querySelector(sel);
      lb = { root, list: [], i: 0, opener: null, img: q('.lb-img'), strip: q('.lb-strip') };
      const close = () => {
        root.hidden = true; document.documentElement.classList.remove('lb-lock');
        document.removeEventListener('keydown', onKey, true);
        if (lb.opener && lb.opener.focus) lb.opener.focus();
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); show(lb.i - 1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); show(lb.i + 1); }
        else if (e.key === 'Home') { e.preventDefault(); show(0); }
        else if (e.key === 'End') { e.preventDefault(); show(lb.list.length - 1); }
        else if (e.key === 'Tab') {
          // Focus stays inside while it is open.
          const f = [...root.querySelectorAll('a[href], button:not([hidden])')].filter((x) => x.offsetParent !== null);
          if (!f.length) return;
          const first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      lb.close = close; lb.onKey = onKey;
      q('.lb-x').addEventListener('click', close);
      q('.lb-prev').addEventListener('click', () => show(lb.i - 1));
      q('.lb-next').addEventListener('click', () => show(lb.i + 1));
      // A click on the dark around the image closes, as it does on a phone's photo viewer.
      root.addEventListener('click', (e) => { if (e.target === root || e.target.classList.contains('lb-stage') || e.target.classList.contains('lb-fig')) close(); });
      lb.img.addEventListener('load', () => root.classList.remove('loading'));
      lb.img.addEventListener('error', () => root.classList.remove('loading'));
      // Swipe left or right on a touch screen.
      let x0 = null, y0 = 0;
      q('.lb-stage').addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') { x0 = e.clientX; y0 = e.clientY; } });
      q('.lb-stage').addEventListener('pointerup', (e) => {
        if (x0 === null) return;
        const dx = e.clientX - x0, dy = e.clientY - y0; x0 = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) show(lb.i + (dx < 0 ? 1 : -1));
      });
      q('.lb-stage').addEventListener('pointercancel', () => { x0 = null; });
    }
    const show = (i) => {
      const n = lb.list.length;
      lb.i = ((i % n) + n) % n;
      const it = lb.list[lb.i];
      lb.root.classList.add('loading');
      lb.img.src = it.url; lb.img.alt = it.name || `Screenshot ${lb.i + 1}`;
      if (lb.img.complete) lb.root.classList.remove('loading');
      lb.root.querySelector('.lb-count').textContent = n > 1 ? `${lb.i + 1} of ${n}` : '';
      lb.root.querySelector('.lb-name').textContent = it.name || '';
      lb.root.querySelector('.lb-cap').textContent = it.caption || '';
      lb.root.querySelector('.lb-cap').hidden = !it.caption;
      lb.root.querySelector('.lb-open').href = it.url;
      [...lb.strip.children].forEach((b, k) => { b.classList.toggle('on', k === lb.i); if (k === lb.i) { b.setAttribute('aria-current', 'true'); b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } else b.removeAttribute('aria-current'); });
      // The neighbours load while this one is looked at, so the next arrow is instant.
      for (const k of [lb.i - 1, lb.i + 1]) { const nb = lb.list[((k % n) + n) % n]; if (nb && nb !== it) { const pre = new Image(); pre.src = nb.url; } }
    };
    lb.list = list; lb.opener = opener || document.activeElement;
    lb.strip.replaceChildren();
    lb.strip.hidden = list.length < 2;
    for (const b of lb.root.querySelectorAll('.lb-nav')) b.hidden = list.length < 2;
    list.forEach((it, k) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'lb-thumb'; b.setAttribute('aria-label', `Screenshot ${k + 1}${it.name ? ': ' + it.name : ''}`);
      const im = document.createElement('img'); im.alt = ''; im.loading = 'lazy'; im.src = it.thumb || it.url; b.appendChild(im);
      b.addEventListener('click', () => show(k));
      lb.strip.appendChild(b);
    });
    lb.root.hidden = false; document.documentElement.classList.add('lb-lock');
    document.addEventListener('keydown', lb.onKey, true);
    show(Math.max(0, Math.min(list.length - 1, start || 0)));
    lb.root.querySelector('.lb-x').focus();
  }
  LunaShell.viewer = viewer;

  window.LunaShell = LunaShell;
  paintViewer(); paintAttention();

  // Pages that do not hand over a viewer get it here. The dashboard opts out (data-shell-viewer="page").
  if (body.dataset.shellViewer !== 'page') {
    const ask = () => LunaShell.me().catch(() => { /* signed out: the page sends people to sign in */ });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ask); else ask();
  }

  // ---------- sidebar: collapse, groups, drawer ----------
  const phone = () => matchMedia('(max-width: 1023px)').matches;
  $('sbToggle').addEventListener('click', () => {
    const on = !body.classList.contains('sb-collapsed');
    body.classList.toggle('sb-collapsed', on); write(COLLAPSED, on);
    $('sbToggle').setAttribute('aria-label', on ? 'Expand the sidebar' : 'Collapse the sidebar');
  });
  document.querySelectorAll('.sb-group-label').forEach((btn) => btn.addEventListener('click', () => {
    const g = btn.closest('.sb-group'); const id = g.dataset.group;
    const shut = !g.classList.contains('closed');
    g.classList.toggle('closed', shut); btn.setAttribute('aria-expanded', String(!shut));
    if (shut) closed.add(id); else closed.delete(id);
    write(CLOSED_GROUPS, [...closed]);
  }));
  // The current page's group never stays folded away.
  const current = document.querySelector('.sb-item[aria-current="page"]');
  if (current) { const g = current.closest('.sb-group'); g.classList.remove('closed'); g.querySelector('.sb-group-label').setAttribute('aria-expanded', 'true'); }

  function drawer(open) {
    body.classList.toggle('sb-open', open);
    $('hdMenu').setAttribute('aria-expanded', String(open));
    if (open) { const first = document.querySelector('.sb-item:not([hidden])'); if (first) first.focus(); }
  }
  $('hdMenu').addEventListener('click', () => drawer(!body.classList.contains('sb-open')));
  $('sbScrim').addEventListener('click', () => drawer(false));
  document.querySelectorAll('.sb-item').forEach((a) => a.addEventListener('click', () => { if (phone()) drawer(false); }));

  // ---------- account menu ----------
  function closeMenu() {
    const pop = document.querySelector('.hd-menu-pop'); if (!pop) return;
    pop.remove(); $('hdAvatar').setAttribute('aria-expanded', 'false');
  }
  $('hdAvatar').addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.querySelector('.hd-menu-pop')) { closeMenu(); return; }
    const name = state.name || state.email || 'Signed in';
    const pop = document.createElement('div');
    pop.className = 'hd-menu-pop'; pop.setAttribute('role', 'menu');
    const settings = NAV[2].items[1].perm(state.perms || {});
    pop.innerHTML = `<div class="who"><b>${esc(name)}</b><small>${esc([state.email, state.role].filter(Boolean).join(' · '))}</small></div>
      ${settings ? `<a role="menuitem" href="/dashboard/settings">${icon('settings')}Settings</a>` : ''}
      <a role="menuitem" href="/docs">${icon('docs')}API docs</a>
      <button role="menuitem" type="button" data-signout>${icon('logout')}Sign out</button>`;
    $('hdAvatar').parentElement.appendChild(pop); $('hdAvatar').setAttribute('aria-expanded', 'true');
    pop.querySelector('[role=menuitem]').focus();
    pop.querySelector('[data-signout]').addEventListener('click', () => LunaShell.signOut());
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.hd-user')) closeMenu(); });
  document.querySelector('.sb-foot [data-signout]').addEventListener('click', () => LunaShell.signOut());

  // ---------- keyboard: / to search, Escape to close ----------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMenu(); if (body.classList.contains('sb-open')) drawer(false); return; }
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault(); $('goRef').focus();
  });
  $('goRef').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = $('goRef').value.trim();
    if (/^(ln-?)?\d{1,9}$/i.test(v)) location.href = '/dashboard/submissions/' + encodeURIComponent(v.toUpperCase());
    else if (/^lnk-?\d{1,9}$/i.test(v)) location.href = '/dashboard/kinds/' + encodeURIComponent(v.toUpperCase());
    else LunaShell.toast('Type a report (LN-00042) or a problem (LNK-0007)');
  });
})();
