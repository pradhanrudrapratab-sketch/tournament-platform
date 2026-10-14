/* Crown Arena core: state, API, auth, shell, home, tournament detail, join, payments, wallet. */
(function () {
  'use strict';
  const CDN = 'https://www.gstatic.com/firebasejs/10.14.1';
  const CA = (window.CA = { views: {}, loaders: {}, act: {}, forms: {} });
  const S = (CA.S = { cfg: null, fb: null, bootError: '', noSignIn: false, homeError: '', user: null, view: 'home', authTab: 'login', game: 'all', list: [], games: [], loaded: false, skew: 0, cur: null, wallet: null, txs: [], wds: [] });

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = (p) => '₹' + (Number(p || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const fdate = (iso, tz) => {
    try { return new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz || 'Asia/Kolkata' }); }
    catch (_) { return new Date(iso).toLocaleString(); }
  };
  const nowMs = () => Date.now() + S.skew;
  const safeUrl = (u) => (/^https:\/\//i.test(u || '') ? u : '');
  const pad = (n) => String(n).padStart(2, '0');
  const eta = () => ({ dep: (S.cfg && S.cfg.deposit_eta_text) || '15 to 30 minutes', wd: (S.cfg && S.cfg.withdraw_eta_text) || '2 to 3 business days' });
  const loading = () => '<p class="mute">Loading</p>';
  try { const q = new URLSearchParams(window.location.search).get('ref'); if (q && /^[A-Za-z0-9]{6,12}$/.test(q)) localStorage.setItem('ca_ref', q.toUpperCase()); } catch (_) { /* storage unavailable */ }
  const storedRef = () => { try { return localStorage.getItem('ca_ref') || ''; } catch (_) { return ''; } };
  const clearRef = () => { try { localStorage.removeItem('ca_ref'); } catch (_) { /* ignore */ } };
  const refText = () => {
    const c = S.cfg || {}, x = c.referral_referrer_reward_paise || 0, y = c.referral_referee_reward_paise || 0;
    return x === y ? `You both get ${inr(x)}` : `You get ${inr(x)} and your friend gets ${inr(y)}`;
  };
  Object.assign(CA, { $, $$, esc, inr, fdate, nowMs, safeUrl, eta, loading, storedRef, clearRef, refText });

  const P = {
    home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    ticket: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M9 6v12" stroke-dasharray="2 2.5"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H4v1a4 4 0 0 0 4 4M16 6h4v1a4 4 0 0 1-4 4M12 13v4M8 20h8"/>',
    wallet: '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>',
  };
  const ic = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${P[n]}</svg>`;
  CA.ic = ic;

  function toast(msg, err) {
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3500 + msg.length * 40);
  }
  const fail = (e) => toast((e && e.message) || 'Something went wrong', true);
  Object.assign(CA, { toast, fail });

  async function api(path, opt) {
    opt = opt || {};
    const method = opt.method || 'GET';
    const h = { 'Content-Type': 'application/json' };
    if (S.fb && S.fb.auth.currentUser) h.Authorization = 'Bearer ' + (await S.fb.auth.currentUser.getIdToken());
    if (opt.headers) Object.assign(h, opt.headers);
    const r = await fetch('/api' + path, { method, headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.message || 'Something went wrong'); e.code = j.code; e.data = j; throw e; }
    return j;
  }
  CA.api = api;

  /* sheets */
  function sheet(html) {
    closeSheet();
    const o = document.createElement('div');
    o.className = 'overlay';
    o.id = 'sheet';
    o.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><button class="x" data-act="close" aria-label="Close">${ic('x')}</button>${html}</div>`;
    o.addEventListener('mousedown', (e) => { if (e.target === o) closeSheet(); });
    document.body.appendChild(o);
    document.body.style.overflow = 'hidden';
    return o;
  }
  function closeSheet() { const o = $('#sheet'); if (o) o.remove(); document.body.style.overflow = ''; }
  Object.assign(CA, { sheet, closeSheet });

  /* small form-in-a-sheet helper that resolves with the values (or null if dismissed) */
  function ask(title, fields, cta) {
    return new Promise((resolve) => {
      const html = fields.map((f) => {
        const base = `id="ak-${f.name}" name="${f.name}" ${f.req ? 'required' : ''} placeholder="${esc(f.ph || '')}"`;
        const inp = f.type === 'textarea' ? `<textarea ${base}></textarea>` : `<input ${base} type="${f.type || 'text'}" ${f.step ? `step="${f.step}"` : ''} ${f.min != null ? `min="${f.min}"` : ''}>`;
        return `<div class="field"><label for="ak-${f.name}">${esc(f.label)}</label>${inp}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</div>`;
      }).join('');
      const o = sheet(`<h2>${esc(title)}</h2><form data-form="ask">${html}<button class="btn btn-foil btn-block" type="submit">${esc(cta || 'Continue')}</button></form>`);
      let done = false;
      const form = $('form', o);
      form.addEventListener('submit', (e) => { e.preventDefault(); done = true; const d = Object.fromEntries(new FormData(form).entries()); closeSheet(); resolve(d); });
      const obs = new MutationObserver(() => { if (!document.body.contains(o)) { obs.disconnect(); if (!done) resolve(null); } });
      obs.observe(document.body, { childList: true });
    });
  }
  CA.ask = ask;

  /* countdowns (server-skew corrected; the server still decides what is actually allowed) */
  function tick() {
    $$('[data-count]').forEach((el) => {
      const left = Math.max(0, new Date(el.dataset.count).getTime() - nowMs());
      const s = Math.floor(left / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      if (el.dataset.mode === 'inline') el.textContent = `${pad(h)}:${pad(m)}:${pad(sec)}`;
      else el.innerHTML = `<div><b>${pad(h)}</b><small>hours</small></div><div><b>${pad(m)}</b><small>minutes</small></div><div><b>${pad(sec)}</b><small>seconds</small></div>`;
      if (left === 0 && el.dataset.fire && !el.dataset.fired) { el.dataset.fired = '1'; CA.fire(el.dataset.fire, el.dataset); }
    });
  }
  CA.tick = tick;
  CA.fire = (what, ds) => { if (what === 'room') loadRoom(ds.tid); if (what === 'home') go('home'); };
  setInterval(tick, 1000);

  /* auth */
  async function applyStoredRef() {
    const code = storedRef();
    if (!S.user || !code) return;
    try { await api('/me/referral', { method: 'POST', body: { code } }); toast('Referral code applied'); } catch (_) { /* invalid or too late: ignore quietly */ }
    clearRef();
  }
  async function loadMe() {
    try { S.user = (await api('/me')).user; }
    catch (e) {
      if (e.code === 'ACCOUNT_DISABLED') { toast(e.message, true); if (S.fb) await S.fb.A.signOut(S.fb.auth); }
      else if (e.code !== 'AUTH_REQUIRED' && e.code !== 'INVALID_TOKEN') toast(e.message, true);
      S.user = null;
    }
    if (S.user) await applyStoredRef();
  }
  CA.reloadCfg = async () => {
    try { S.cfg = Object.assign({}, S.cfg, await (await fetch('/api/config', { cache: 'no-store' })).json()); } catch (_) { /* keep old config */ }
  };
  CA.loadMe = loadMe;

  async function bootAuth() {
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      if (!r.ok) throw new Error('config ' + r.status);
      S.cfg = await r.json();
    } catch (e) {
      console.error('Could not load /api/config', e);
      S.bootError = 'We could not reach the server. Please try again in a moment.';
      return;
    }
    if (!S.cfg.firebase || !S.cfg.firebase.apiKey) { S.noSignIn = true; return; }
    try {
      const [app, A] = await Promise.all([import(CDN + '/firebase-app.js'), import(CDN + '/firebase-auth.js')]);
      S.fb = { A, auth: A.getAuth(app.initializeApp(S.cfg.firebase)) };
      await new Promise((resolve) => {
        let first = true;
        A.onAuthStateChanged(S.fb.auth, async (u) => {
          if (u) await loadMe(); else S.user = null;
          if (first) { first = false; resolve(); } else { S.wallet = null; render(); }
        });
      });
    } catch (e) { console.error(e); S.noSignIn = true; toast('Sign-in is unavailable right now', true); }
  }

  function authMsg(e) {
    const c = (e && e.code) || '';
    console.error('Firebase auth error:', c, e && e.message);
    if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(c)) return 'Email or password is incorrect.';
    if (/email-already-in-use/.test(c)) return 'An account with this email already exists. Try signing in.';
    if (/weak-password/.test(c)) return 'Use a password with at least 8 characters.';
    if (/too-many-requests/.test(c)) return 'Too many attempts. Wait a few minutes and try again.';
    if (/unauthorized-domain/.test(c)) return 'Google sign-in is blocked: this website is not in Firebase Authorized domains yet (auth/unauthorized-domain).';
    if (/operation-not-allowed/.test(c)) return 'This sign-in method is not enabled in Firebase yet (auth/operation-not-allowed).';
    if (/popup-blocked/.test(c)) return 'Your browser blocked the Google window. Allow pop-ups for this site and try again.';
    if (/network-request-failed/.test(c)) return 'Network problem. Check your connection and try again.';
    if (/invalid-api-key|api-key-not-valid/.test(c)) return 'Sign-in is misconfigured (invalid Firebase API key).';
    if (/operation-not-supported|web-storage-unsupported/.test(c)) return 'This browser cannot run Google sign-in here. Open the site in Chrome or Safari.';
    return `Could not sign in${c ? ' (' + c + ')' : ''}. Please try again.`;
  }

  CA.forms.auth = async (form) => {
    const A = S.fb && S.fb.A;
    if (!A) return toast('Sign-in is not set up yet.', true);
    const d = Object.fromEntries(new FormData(form).entries());
    try {
      if (S.authTab === 'register') {
        const c = await A.createUserWithEmailAndPassword(S.fb.auth, d.email.trim(), d.password);
        await A.updateProfile(c.user, { displayName: d.name.trim() });
        let mailed = true;
        try { await A.sendEmailVerification(c.user); } catch (e) { mailed = false; authMsg(e); }
        await loadMe();
        try { await api('/me', { method: 'PATCH', body: { display_name: d.name.trim() } }); S.user.display_name = d.name.trim(); } catch (_) { /* keep default name */ }
        if (d.ref && d.ref.trim()) {
          try { await api('/me/referral', { method: 'POST', body: { code: d.ref.trim() } }); toast('Referral code applied'); }
          catch (e) { if (e.code !== 'ALREADY_REFERRED') fail(e); }
          clearRef();
        }
        toast(mailed ? 'Account created. We sent a verification link. Check Spam or Promotions too.' : 'Account created, but the verification email could not be sent. Tap Resend email on the next screen.', !mailed);
      } else {
        let email = d.email.trim();
        const al = S.cfg.admin_alias;
        if (al && email.toLowerCase() === al.username.toLowerCase()) email = al.email;
        await A.signInWithEmailAndPassword(S.fb.auth, email, d.password);
      }
      S.view = 'home';
      render();
    } catch (e) { toast(authMsg(e), true); }
  };

  CA.act.google = async () => {
    const A = S.fb && S.fb.A;
    if (!A) return toast('Sign-in is not set up yet.', true);
    try { await A.signInWithPopup(S.fb.auth, new A.GoogleAuthProvider()); S.view = 'home'; render(); }
    catch (e) { if (!/popup-closed|cancelled-popup/.test(e.code || '')) toast(authMsg(e), true); }
  };
  CA.act.forgot = async () => {
    const d = await ask('Reset your password', [{ name: 'email', label: 'Email', type: 'email', req: true }], 'Send reset link');
    if (!d || !S.fb) return;
    try { await S.fb.A.sendPasswordResetEmail(S.fb.auth, d.email.trim()); } catch (_) { /* generic message either way */ }
    toast('If that email has an account, a reset link is on its way.');
  };
  CA.act.signout = async () => {
    if (S.fb) await S.fb.A.signOut(S.fb.auth);
    S.user = null; S.wallet = null; S.view = 'home'; render();
  };
  CA.act['auth-tab'] = (d) => { S.authTab = d.tab; render(); };

  function authView() {
    if (S.noSignIn) {
      return `<main class="auth"><div class="brand">${ic('crown')}<span>${esc(S.cfg.platform_title)}</span></div>
        <div><h1>Sign-in is not available yet</h1><p class="lede" style="margin-top:8px">We are finishing setup. You can still browse tournaments and the leaderboard. Please check back soon.</p></div>
        <button class="btn btn-foil" data-act="go" data-view="home">Browse tournaments</button></main>`;
    }
    const reg = S.authTab === 'register';
    return `<main class="auth">
      <div class="brand">${ic('crown')}<span>${esc(S.cfg.platform_title)}</span></div>
      <div><h1>${reg ? 'Create your account' : 'Welcome back'}</h1>
        <p class="lede" style="margin-top:8px">${reg ? 'Join Minecraft and Free Fire tournaments, track your results and withdraw your winnings.' : 'Sign in to join tournaments and manage your wallet.'}</p></div>
      <div class="tabs" role="group" aria-label="Account">
        <button data-act="auth-tab" data-tab="login" aria-pressed="${!reg}">Sign in</button>
        <button data-act="auth-tab" data-tab="register" aria-pressed="${reg}">Register</button></div>
      <form data-form="auth">
        ${reg ? '<div class="field"><label for="a-name">Display name</label><input id="a-name" name="name" required minlength="2" maxlength="40" autocomplete="nickname"></div>' : ''}
        <div class="field"><label for="a-email">${reg ? 'Email' : 'Email or username'}</label><input id="a-email" name="email" type="${reg ? 'email' : 'text'}" autocomplete="username" required></div>
        <div class="field"><label for="a-pw">Password</label><input id="a-pw" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="8"></div>
        ${reg && S.cfg.referral_enabled ? `<div class="field"><label for="a-ref">Referral code (optional)</label><input id="a-ref" name="ref" value="${esc(storedRef())}" maxlength="12" autocapitalize="characters" autocomplete="off"><small>${esc(refText())} after the first tournament entry.</small></div>` : ''}
        <button class="btn btn-foil btn-block" type="submit">${reg ? 'Create account' : 'Sign in'}</button>
      </form>
      <div class="divider">or</div>
      <button class="btn btn-ghost btn-block" data-act="google">Continue with Google</button>
      ${reg ? '' : '<button class="link" data-act="forgot">Forgot password?</button>'}
      <button class="link" data-act="go" data-view="home">Browse tournaments first</button>
    </main>`;
  }

  /* shell + routing */
  function shell(inner) {
    const u = S.user;
    const staff = u && (u.role === 'host' || u.role === 'super_admin');
    const items = [['home', 'Home', 'home'], ['matches', 'Matches', 'ticket'], ['leaderboard', 'Leaderboard', 'trophy'], ['wallet', 'Wallet', 'wallet'], ['profile', 'Profile', 'user']];
    if (staff) items.push(['admin', 'Manage', 'shield']);
    const brand = `<div class="brand">${ic('crown')}<span>${esc(S.cfg.platform_title)}</span></div>`;
    return `<div class="shell">
        <header class="top">${brand}<div class="top-acts"><button class="btn btn-ghost btn-sm" data-act="go" data-view="help">Help</button>${u ? '' : '<button class="btn btn-ghost btn-sm" data-act="go" data-view="auth">Sign in</button>'}</div></header>
        <main class="page" id="page">${inner}</main>
        <nav class="nav" aria-label="Main">${brand}${items.map((i) => `<button data-act="go" data-view="${i[0]}" ${S.view === i[0] ? 'aria-current="page"' : ''}>${ic(i[2])}<span>${i[1]}</span></button>`).join('')}</nav>
      </div>`;
  }

  function render() {
    if (!S.cfg) return;
    if (S.view === 'auth' && S.user) S.view = 'home';
    const app = $('#app');
    if (S.view === 'auth') { app.innerHTML = authView(); return; }
    const v = CA.views[S.view] || CA.views.home;
    const u = S.user;
    const verify = u && !u.email_verified && S.fb
      ? `<div class="banner"><span>Verify your email to join tournaments and add money. We sent a link to ${esc(u.email)}. Check Spam and Promotions too.</span><span class="btn-row" style="flex:none"><button class="btn btn-ghost btn-sm" data-act="resend">Resend email</button><button class="btn btn-foil btn-sm" data-act="recheck">I've verified</button></span></div>` : '';
    app.innerHTML = shell(verify + v());
    tick();
  }
  CA.render = render;

  async function go(view) {
    if (['matches', 'wallet', 'profile', 'admin'].includes(view) && !S.user) { S.view = 'auth'; S.authTab = 'login'; render(); return; }
    S.view = view;
    closeSheet();
    render();
    window.scrollTo(0, 0);
    const loader = CA.loaders[view];
    if (loader) { try { await loader(); } catch (e) { fail(e); } render(); }
  }
  CA.go = go;
  CA.act.go = (d) => go(d.view);
  CA.act.close = () => closeSheet();
  CA.act.reload = () => window.location.reload();
  CA.act.game = (d) => { S.game = d.game; render(); };
  CA.act.copy = async (d) => { try { await navigator.clipboard.writeText(d.text || ''); toast('Copied'); } catch (_) { toast('Copy is not available here', true); } };

  /* home */
  CA.loaders.home = async () => {
    try {
      const [g, t] = await Promise.all([api('/games'), api('/tournaments')]);
      S.games = g.games;
      S.skew = new Date(t.server_now).getTime() - Date.now();
      S.list = t.tournaments;
      S.homeError = '';
    } catch (e) { S.homeError = e.message || 'Could not load tournaments.'; }
    S.loaded = true;
  };

  const badge = (t) => {
    if (t.status === 'live') return '<span class="badge b-live">Live</span>';
    if (t.status === 'full' || t.filled >= t.capacity) return '<span class="badge b-wait">Full</span>';
    if (t.status === 'published') return '<span class="badge b-open">Open</span>';
    return `<span class="badge">${esc(String(t.status).replace(/_/g, ' '))}</span>`;
  };
  const discordBtn = (cls) => {
    const u = safeUrl(S.cfg.discord_invite_url);
    return u ? `<a class="btn ${cls || 'btn-foil'}" href="${esc(u)}" target="_blank" rel="noopener noreferrer">Join Discord server</a>` : '';
  };
  CA.discordBtn = discordBtn;

  function ticket(t, hero) {
    const full = t.filled >= t.capacity;
    const pct = Math.min(100, Math.round((t.filled / t.capacity) * 100));
    const when = t.status === 'live'
      ? '<div class="live-now">Live now</div>'
      : hero ? `<div class="count" data-count="${esc(t.scheduled_start_at)}" data-fire="home" aria-label="Time until start"></div><p class="mute">Starts ${esc(fdate(t.scheduled_start_at, t.timezone))}</p>`
        : `<p class="mute">${esc(fdate(t.scheduled_start_at, t.timezone))}</p>`;
    return `<article class="ticket ${hero ? 'hero' : ''}" data-act="open" data-id="${t.id}" role="button" tabindex="0">
      <div class="tk-top"><span class="tk-game">${esc(t.game_name)}</span>${badge(t)}</div>
      <h3 class="tk-title">${esc(t.title)}</h3>${when}
      <div class="perf"></div>
      <div class="tk-foot">
        <div><span class="mute">Entry</span><b>${t.entry_fee_paise ? inr(t.entry_fee_paise) : 'Free'}</b></div>
        <div><span class="mute">Prize pool</span><b>${inr(t.prize_pool_paise)}</b></div>
        <div class="slots"><span class="mute">${full ? 'SLOTS FULL' : `${t.filled} of ${t.capacity} slots`}</span><div class="meter"><i style="--w:${pct}%"></i></div></div>
      </div></article>`;
  }

  CA.views.home = () => {
    if (!S.loaded) return loading();
    if (S.homeError) return `<div class="empty"><h2>Could not load tournaments</h2><p class="lede">${esc(S.homeError)}</p><button class="btn btn-foil" data-act="go" data-view="home">Try again</button></div>`;
    const list = S.list.filter((t) => S.game === 'all' || t.game_slug === S.game);
    const chips = [`<button class="chip" data-act="game" data-game="all" aria-pressed="${S.game === 'all'}">All games</button>`]
      .concat(S.games.map((g) => (g.enabled
        ? `<button class="chip" data-act="game" data-game="${esc(g.slug)}" aria-pressed="${S.game === g.slug}">${esc(g.name)}</button>`
        : `<button class="chip" disabled>${esc(g.name)}${g.coming_soon ? ' (coming soon)' : ''}</button>`))).join('');
    let body;
    if (!list.length) {
      body = `<div class="empty"><h2>No tournaments right now</h2><p class="lede">Join our Discord server to get updates about upcoming tournaments.</p>${discordBtn()}</div>`;
    } else {
      const hero = list[0];
      const allFull = list.every((t) => t.status !== 'live' && t.filled >= t.capacity);
      const rest = list.slice(1);
      body = (allFull ? `<div class="banner"><span>All slots are full. Join Discord for upcoming tournaments.</span>${discordBtn('btn-ghost btn-sm')}</div>` : '')
        + ticket(hero, true)
        + (rest.length ? `<div class="sec-h"><h2>More tournaments</h2></div><div class="grid">${rest.map((t) => ticket(t, false)).join('')}</div>` : '');
    }
    const invite = S.cfg.referral_enabled ? `<div class="banner"><span>Invite a friend. ${esc(refText())} when they enter their first tournament.</span><button class="btn btn-ghost btn-sm" data-act="go" data-view="refer">Invite friends</button></div>` : '';
    return `<div class="chips" role="group" aria-label="Filter by game">${chips}</div>${body}${invite}`;
  };

  /* tournament detail */
  CA.act.open = async (d) => {
    sheet('<h2>Loading</h2><p class="mute">Fetching tournament details</p>');
    try {
      const r = await api('/tournaments/' + d.id);
      S.skew = new Date(r.server_now).getTime() - Date.now();
      S.cur = r;
      sheet(detailHtml(r));
      const my = r.tournament.my_registration;
      if (my && my.status === 'confirmed') loadRoom(r.tournament.id);
    } catch (e) { closeSheet(); fail(e); }
  };

  function detailHtml(r) {
    const t = r.tournament, full = t.filled >= t.capacity, my = t.my_registration;
    let action;
    if (my && my.status === 'confirmed') action = `<div id="room-box" data-tid="${t.id}"></div>`;
    else if (my && my.status === 'reserved') action = `<div class="note">${ic('clock')}<div>Your slot is held while we verify your payment. Open <b>Matches</b> to check the payment status.</div></div>`;
    else if (my && my.status === 'absent') action = `<div class="note">${ic('clock')}<div>You were marked absent, so this slot was released. Entry fees are not refunded for no-shows.</div></div>`;
    else if (!S.user) action = '<button class="btn btn-foil btn-block" data-act="go" data-view="auth">Sign in to join</button>';
    else if (['published', 'full'].includes(t.status) && !full) action = `<button class="btn btn-foil btn-block" data-act="join" data-id="${t.id}">Join for ${t.entry_fee_paise ? inr(t.entry_fee_paise) : 'free'}</button>`;
    else if (full) action = `<button class="btn btn-block" disabled>SLOTS FULL</button>${discordBtn('btn-ghost')}`;
    else action = '<button class="btn btn-block" disabled>Registration closed</button>';
    const resales = (r.resales || []).map((x) => `<div class="item"><div><div class="t">Slot ${x.slot_number} reopened</div><div class="s">Replacement price ${inr(x.resale_price_paise)}</div></div>${S.user && !my ? `<button class="btn btn-foil btn-sm" data-act="join" data-id="${t.id}" data-resale="${x.id}">Join for ${inr(x.resale_price_paise)}</button>` : ''}</div>`).join('');
    const mins = Math.round((new Date(t.scheduled_start_at) - new Date(t.reveal_at)) / 60000);
    return `<div><span class="tk-game">${esc(t.game_name)}</span> ${badge(t)}</div>
      <h2>${esc(t.title)}</h2>
      ${t.description ? `<p class="lede">${esc(t.description)}</p>` : ''}
      <div class="rows">
        <div><span class="l">Starts</span><span class="r">${esc(fdate(t.scheduled_start_at, t.timezone))}</span></div>
        <div><span class="l">Entry fee</span><span class="r">${t.entry_fee_paise ? inr(t.entry_fee_paise) : 'Free'}</span></div>
        <div><span class="l">Prize pool</span><span class="r">${inr(t.prize_pool_paise)}</span></div>
        <div><span class="l">Slots</span><span class="r">${t.filled} of ${t.capacity} taken</span></div>
        <div><span class="l">Room details</span><span class="r">${mins} minutes before start</span></div>
      </div>
      ${resales ? `<div><h3 style="font-size:15px;margin-bottom:4px">Reopened slots</h3>${resales}</div>` : ''}
      ${t.rules ? `<div><h3 style="font-size:15px;margin-bottom:8px">Rules</h3><p class="mute" style="white-space:pre-wrap">${esc(t.rules)}</p></div>` : ''}
      ${action}`;
  }

  async function loadRoom(tid) {
    const box = $('#room-box');
    if (!box) return;
    box.innerHTML = '<div class="room"><p class="mute">Checking room details</p></div>';
    try {
      const r = await api('/tournaments/' + tid + '/room-credentials');
      const kv = (label, val) => `<div class="kv"><div><div class="mute" style="font-size:13px">${label}</div><code>${esc(val || 'Not set yet')}</code></div>${val ? `<button class="btn btn-ghost btn-sm" data-act="copy" data-text="${esc(val)}">Copy</button>` : ''}</div>`;
      box.innerHTML = `<div class="room">${kv('Room ID', r.room_id)}${kv('Password', r.room_password)}</div>`;
    } catch (e) {
      if (e.code === 'NOT_YET' && e.data && e.data.reveal_at) {
        const at = e.data.reveal_at;
        if (new Date(at).getTime() - nowMs() <= 0) { box.innerHTML = '<div class="room"><p class="mute">Unlocking room details</p></div>'; setTimeout(() => loadRoom(tid), 3000); return; }
        box.innerHTML = `<div class="room"><div class="mute" style="font-size:13px">Room details unlock in</div><div class="ct" data-count="${esc(at)}" data-mode="inline" data-fire="room" data-tid="${tid}">--:--:--</div><p class="mute" style="font-size:13px;margin-top:6px">They appear here automatically. The server keeps the time, not your phone.</p></div>`;
        tick();
      } else box.innerHTML = `<div class="note">${ic('clock')}<div>${esc(e.message)}</div></div>`;
    }
  }

  /* join flow */
  CA.act.join = async (d) => {
    const r = S.cur && String(S.cur.tournament.id) === String(d.id) ? S.cur : await api('/tournaments/' + d.id);
    const t = r.tournament;
    let price = Number(t.entry_fee_paise);
    if (d.resale) { const x = (r.resales || []).find((z) => String(z.id) === String(d.resale)); if (x) price = Number(x.resale_price_paise); }
    let w = { deposit_paise: 0 };
    try { w = await api('/wallet'); } catch (_) { /* wallet optional here */ }
    const can = w.deposit_paise >= price;
    sheet(`<h2>Join ${esc(t.title)}</h2>
      <div class="rows"><div><span class="l">Entry</span><span class="r">${price ? inr(price) : 'Free'}</span></div><div><span class="l">Starts</span><span class="r">${esc(fdate(t.scheduled_start_at, t.timezone))}</span></div></div>
      <form data-form="join" data-id="${t.id}" data-resale="${d.resale || ''}" data-price="${price}">
        ${price ? `<label class="opt ${can ? '' : 'dis'}"><input type="radio" name="method" value="wallet" ${can ? 'checked' : 'disabled'}><span><b>Pay from deposit balance</b><br><span class="mute">${inr(w.deposit_paise)} available. Confirmed instantly.</span></span></label>
        <label class="opt"><input type="radio" name="method" value="gateway" ${can ? '' : 'checked'}><span><b>Pay with UPI</b><br><span class="mute">Reflects in ${esc(eta().dep)}.</span></span></label>` : ''}
        <label class="check"><input type="checkbox" name="accept" required><span>I understand that if I don't join the match, I get no refund, even if my slot is resold.</span></label>
        <button class="btn btn-foil btn-block" type="submit">${price ? 'Confirm and pay ' + inr(price) : 'Confirm my slot'}</button>
      </form>`);
  };

  CA.forms.join = async (form) => {
    const d = Object.fromEntries(new FormData(form).entries());
    const price = Number(form.dataset.price);
    const body = { method: price ? d.method : 'wallet', accept_policy: !!d.accept };
    if (form.dataset.resale) body.resale_id = Number(form.dataset.resale);
    try {
      const r = await api('/tournaments/' + form.dataset.id + '/registrations', { method: 'POST', body });
      if (r.order) { orderSheet(r.order, 'entry'); }
      else { closeSheet(); toast(`You're in! Slot ${r.registration.slot_number} is yours.`); }
      S.wallet = null;
      CA.loaders.home().then(render).catch(() => {});
    } catch (e) {
      if (e.code === 'EMAIL_NOT_VERIFIED') toast('Verify your email first, then try again.', true); else fail(e);
    }
  };

  /* payments */
  const orderBadge = (s) => ({ success: '<span class="badge b-ok">Received</span>', failed: '<span class="badge b-bad">Failed</span>', expired: '<span class="badge b-bad">Expired</span>', processing: '<span class="badge b-wait">Verifying</span>' }[s] || '<span class="badge b-wait">Waiting for payment</span>');
  function orderSheet(o, kind) {
    const done = o.status === 'success';
    const qr = safeUrl(o.qr_url), link = safeUrl(o.payment_url);
    sheet(`<h2>${done ? 'Payment received' : 'Complete your payment'}</h2>
      <div class="rows">
        <div><span class="l">Amount</span><span class="r">${inr(o.amount_paise)}</span></div>
        <div><span class="l">Status</span><span class="r">${orderBadge(o.status)}</span></div>
        <div><span class="l">Order</span><span class="r" style="font-size:13px">${esc(o.order_id)}</span></div>
      </div>
      ${done ? '' : `<div class="pay-box">${qr ? `<img class="qr" alt="UPI QR code" src="${esc(qr)}">` : ''}${link ? `<a class="btn btn-foil" target="_blank" rel="noopener noreferrer" href="${esc(link)}">Open payment page</a>` : '<p class="mute">Your payment link is being prepared. Tap Refresh status in a moment.</p>'}</div>`}
      <div class="note-stack">
        <div class="note">${ic('clock')}<div>Deposits reflect in your account in <b>${esc(eta().dep)}</b>. We re-check automatically after 15 minutes, or tap Refresh status any time.</div></div>
        ${kind === 'entry' ? `<div class="note">${ic('clock')}<div>Your slot is held while we verify the payment. If it is not confirmed in time, the slot is released.</div></div>` : ''}
      </div>
      ${done ? '<button class="btn btn-foil btn-block" data-act="close">Done</button>' : `<button class="btn btn-ghost btn-block" data-act="refresh-order" data-order="${esc(o.order_id)}" data-kind="${kind}">Refresh status</button>`}`);
  }
  CA.orderSheet = orderSheet;

  CA.act['refresh-order'] = async (d) => {
    const r = await api('/payments/orders/' + encodeURIComponent(d.order) + '/status');
    orderSheet(r.order, d.kind);
    if (r.order.status === 'success') { toast('Payment received'); S.wallet = null; CA.loaders.home().then(render).catch(() => {}); }
    else if (r.order.status === 'failed' || r.order.status === 'expired') toast('This payment did not go through. You can start again.', true);
    else toast('Still waiting for the payment provider.');
  };

  /* wallet */
  CA.loaders.wallet = async () => {
    const [w, t, d] = await Promise.all([api('/wallet'), api('/wallet/transactions'), api('/wallet/withdrawals')]);
    S.wallet = w; S.txs = t.transactions; S.wds = d.withdrawals;
  };
  const wdBadge = (s) => ({ success: '<span class="badge b-ok">Paid</span>', rejected: '<span class="badge b-bad">Rejected</span>', failed: '<span class="badge b-bad">Failed</span>', approved: '<span class="badge b-wait">Approved</span>', processing: '<span class="badge b-wait">Processing</span>', pending: '<span class="badge b-wait">Pending</span>' }[s] || `<span class="badge">${esc(s)}</span>`);
  const TX = { deposit: 'Wallet top-up', entry_fee: 'Tournament entry', prize: 'Prize', refund: 'Refund', withdrawal_reserve: 'Withdrawal requested', withdrawal_release: 'Withdrawal returned', late_payment_credit: 'Late payment credit', referral_bonus: 'Referral bonus' };
  CA.wdBadge = wdBadge;

  CA.views.wallet = () => {
    const w = S.wallet;
    if (!w) return loading();
    const e = eta();
    const wds = S.wds.length ? S.wds.map((x) => `<div class="item"><div><div class="t">${inr(x.requested_amount_paise)} requested</div><div class="s">You receive ${inr(x.net_payout_paise)} after ${inr(x.fee_paise)} fee. ${esc(fdate(x.created_at))}</div></div>${wdBadge(x.status)}</div>`).join('') : '<p class="mute" style="padding:16px 0">No withdrawals yet.</p>';
    const txs = S.txs.length ? S.txs.map((x) => `<div class="item"><div><div class="t">${esc(x.description || TX[x.transaction_type] || x.transaction_type)}</div><div class="s">${esc(fdate(x.created_at))}</div></div><span class="${x.direction === 'credit' ? 'pos' : 'neg'}">${x.direction === 'credit' ? '+' : '−'}${inr(x.amount_paise)}</span></div>`).join('') : '<p class="mute" style="padding:16px 0">Your transactions will show up here.</p>';
    return `<h1 class="h-page">Wallet</h1>
      <div class="card pad bal"><span class="mute">Winnings you can withdraw</span><div class="big">${inr(w.winnings_paise)}</div>
        <span class="mute">${w.pending_withdrawal_paise ? inr(w.pending_withdrawal_paise) + ' in pending withdrawals' : 'No withdrawals pending'}</span>
        <div class="split"><div><b>${inr(w.deposit_paise)}</b><span>Deposit balance</span></div><div><b>${inr(w.deposit_paise + w.winnings_paise)}</b><span>Total balance</span></div></div></div>
      <div class="btn-row"><button class="btn btn-foil" data-act="deposit">Add money</button><button class="btn btn-ghost" data-act="withdraw">Withdraw</button></div>
      <div class="note-stack">
        <div class="note">${ic('clock')}<div><b>Deposits</b> reflect in your account in <b>${esc(e.dep)}</b>.</div></div>
        <div class="note">${ic('clock')}<div><b>Withdrawals</b> are credited in <b>${esc(e.wd)}</b>. Minimum ${inr(w.withdraw_min_paise)}, platform fee ${w.withdraw_fee_bps / 100}%. Only tournament winnings can be withdrawn.</div></div>
      </div>
      <section><div class="sec-h"><h2>Withdrawals</h2></div><div class="card">${wds}</div></section>
      <section><div class="sec-h"><h2>Transactions</h2></div><div class="card">${txs}</div></section>`;
  };

  CA.act.deposit = () => {
    const min = (S.cfg.min_deposit_paise || 1000) / 100;
    sheet(`<h2>Add money</h2>
      <form data-form="deposit">
        <div class="amt-chips">${[100, 200, 500, 1000].map((a) => `<button type="button" class="chip" data-act="amt" data-v="${a}">₹${a}</button>`).join('')}</div>
        <div class="field"><label for="d-amt">Amount in rupees</label><input id="d-amt" name="amount" type="number" inputmode="numeric" min="${min}" step="1" required></div>
        <div class="note">${ic('clock')}<div>Deposits reflect in your account in <b>${esc(eta().dep)}</b>.</div></div>
        <button class="btn btn-foil btn-block" style="margin-top:16px" type="submit">Continue to payment</button>
      </form>`);
  };
  CA.act.amt = (d) => { const i = $('#d-amt'); if (i) i.value = d.v; };
  CA.forms.deposit = async (form) => {
    const paise = Math.round(Number(new FormData(form).get('amount')) * 100);
    const r = await api('/payments/orders', { method: 'POST', body: { amount_paise: paise } });
    orderSheet(r.order, 'deposit');
  };

  CA.act.withdraw = () => {
    const w = S.wallet;
    sheet(`<h2>Withdraw winnings</h2>
      <p class="mute">Available to withdraw: <b style="color:var(--ivory)">${inr(w.winnings_paise)}</b></p>
      <form data-form="withdraw">
        <div class="field"><label for="w-amt">Amount in rupees</label><input id="w-amt" name="amount" type="number" inputmode="numeric" min="${w.withdraw_min_paise / 100}" step="1" required data-live="wd"><small>Minimum ${inr(w.withdraw_min_paise)}</small></div>
        <div class="field"><label for="w-upi">UPI ID</label><input id="w-upi" name="upi" placeholder="name@bank" required autocomplete="off" autocapitalize="none"></div>
        <div class="calc"><div><span class="mute">Platform fee (${w.withdraw_fee_bps / 100}%)</span><span id="wd-fee">₹0</span></div><div><span class="mute">You receive</span><b id="wd-net">₹0</b></div></div>
        <div class="note">${ic('clock')}<div>Withdrawals are credited in <b>${esc(eta().wd)}</b> after approval.</div></div>
        <button class="btn btn-foil btn-block" style="margin-top:16px" type="submit">Request withdrawal</button>
      </form>`);
  };
  document.addEventListener('input', (e) => {
    if (!e.target.dataset || e.target.dataset.live !== 'wd' || !S.wallet) return;
    const p = Math.round(Number(e.target.value || 0) * 100);
    const fee = Math.floor((p * S.wallet.withdraw_fee_bps + 5000) / 10000); // same integer rounding as the server
    $('#wd-fee').textContent = inr(fee);
    $('#wd-net').textContent = inr(p - fee);
  });
  CA.forms.withdraw = async (form) => {
    const d = Object.fromEntries(new FormData(form).entries());
    const paise = Math.round(Number(d.amount) * 100);
    if (paise < S.wallet.withdraw_min_paise) return toast('Minimum withdrawal is ' + inr(S.wallet.withdraw_min_paise), true);
    if (paise > S.wallet.winnings_paise) return toast('You can only withdraw up to your winnings balance.', true);
    const key = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
    await api('/wallet/withdrawals', { method: 'POST', body: { amount_paise: paise, payout_upi: d.upi.trim() }, headers: { 'Idempotency-Key': key } });
    closeSheet();
    toast('Withdrawal requested. It is credited in ' + eta().wd + ' after approval.');
    await CA.loaders.wallet(); render();
  };

  /* global events */
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const h = CA.act[el.dataset.act];
    if (!h) return;
    Promise.resolve(h(el.dataset, el)).catch(fail);
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !S.user || S.user.email_verified || !S.fb || !S.fb.auth.currentUser) return;
    try {
      await S.fb.auth.currentUser.reload();
      if (S.fb.auth.currentUser.emailVerified) { await S.fb.auth.currentUser.getIdToken(true); await loadMe(); render(); toast('Email verified'); }
    } catch (_) { /* try again next time the tab is visible */ }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role=button][data-act]')) { e.preventDefault(); e.target.click(); }
    if (e.key === 'Escape') closeSheet();
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-form]');
    if (!f) return;
    e.preventDefault();
    const h = CA.forms[f.dataset.form];
    if (!h) return;
    const btn = f.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    Promise.resolve(h(f)).catch(fail).finally(() => { if (btn && document.body.contains(btn)) btn.disabled = false; });
  });

  async function boot() {
    await bootAuth();
    if (!S.cfg) {
      $('#app').innerHTML = `<main class="auth"><h1>Something went wrong</h1><p class="lede">${esc(S.bootError || 'Could not load the app.')}</p><button class="btn btn-foil" data-act="reload">Try again</button></main>`;
      return;
    }
    document.title = S.cfg.platform_title || 'Crown Arena';
    render();
    go('home');
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
