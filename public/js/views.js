/* Leaderboard, Matches and Profile views. */
(function () {
  'use strict';
  const CA = window.CA, S = CA.S, { esc, inr, fdate, api, ic, loading, toast } = CA;
  S.lbGame = 'all'; S.lb = null; S.regs = null; S.orders = [];

  /* leaderboard: only finalized results count (enforced by the server) */
  CA.loaders.leaderboard = async () => {
    if (!S.games.length) S.games = (await api('/games')).games;
    S.lb = (await api('/leaderboard?game=' + encodeURIComponent(S.lbGame))).players;
  };
  CA.act.lbgame = async (d) => { S.lbGame = d.game; S.lb = null; CA.render(); await CA.loaders.leaderboard(); CA.render(); };

  const stat = (p) => `${p.wins} ${p.wins === 1 ? 'win' : 'wins'}, ${p.played} played`;
  CA.views.leaderboard = () => {
    const chips = [`<button class="chip" data-act="lbgame" data-game="all" aria-pressed="${S.lbGame === 'all'}">All games</button>`]
      .concat(S.games.map((g) => (g.enabled
        ? `<button class="chip" data-act="lbgame" data-game="${esc(g.slug)}" aria-pressed="${S.lbGame === g.slug}">${esc(g.name)}</button>`
        : `<button class="chip" disabled>${esc(g.name)} (coming soon)</button>`))).join('');
    let body;
    if (!S.lb) body = loading();
    else if (!S.lb.length) body = '<div class="empty"><h2>No ranked players yet</h2><p class="lede">Rankings appear after a tournament result is finalized.</p></div>';
    else {
      const top = S.lb.slice(0, 3), rest = S.lb.slice(3);
      const pod = (p, n) => (p ? `<div class="pod p${n}"><div class="medal">${n}</div><div class="nm" title="${esc(p.display_name)}">${esc(p.display_name)}</div><div class="w">${esc(stat(p))}</div>${p.winnings_paise != null ? `<div class="w">${inr(p.winnings_paise)} won</div>` : ''}</div>` : '<div></div>');
      body = `<div class="podium">${pod(top[1], 2)}${pod(top[0], 1)}${pod(top[2], 3)}</div>
        ${rest.length ? `<div class="card">${rest.map((p) => `<div class="item"><div style="display:flex;gap:10px;align-items:center;min-width:0"><span class="rank">${p.rank}</span><div style="min-width:0"><div class="t">${esc(p.display_name)}</div><div class="s">${esc(stat(p))}</div></div></div>${p.winnings_paise != null ? `<span class="neg">${inr(p.winnings_paise)}</span>` : ''}</div>`).join('')}</div>` : ''}`;
    }
    return `<h1 class="h-page">Leaderboard</h1><div class="chips">${chips}</div>${body}`;
  };

  /* matches */
  CA.loaders.matches = async () => {
    const [r, o] = await Promise.all([api('/me/registrations'), api('/payments/orders')]);
    S.regs = r.registrations;
    S.orders = o.orders.filter((x) => x.status === 'pending' || x.status === 'processing');
  };
  const RS = { confirmed: '<span class="badge b-ok">Confirmed</span>', reserved: '<span class="badge b-wait">Awaiting payment</span>', absent: '<span class="badge b-bad">Absent</span>', refunded: '<span class="badge">Refunded</span>', cancelled: '<span class="badge">Cancelled</span>', expired: '<span class="badge">Expired</span>' };
  CA.views.matches = () => {
    if (!S.regs) return loading();
    const pend = S.orders.length ? `<section><div class="sec-h"><h2>Payments in progress</h2></div><div class="card">${S.orders.map((o) => `<div class="item"><div><div class="t">${inr(o.amount_paise)} ${o.purpose === 'entry' ? 'tournament entry' : 'deposit'}</div><div class="s">${esc(o.order_id)}</div></div><button class="btn btn-ghost btn-sm" data-act="refresh-order" data-order="${esc(o.order_id)}" data-kind="${o.purpose}">Refresh status</button></div>`).join('')}</div></section>` : '';
    const list = S.regs.length ? S.regs.map((r) => `<div class="item"><div><div class="t">${esc(r.title)}</div><div class="s">${esc(r.game_name)}, slot ${r.slot_number}. ${esc(fdate(r.scheduled_start_at))}</div></div><div class="acts">${RS[r.status] || ''}<button class="btn btn-ghost btn-sm" data-act="open" data-id="${r.tournament_id}">Details</button></div></div>`).join('')
      : `<div class="empty"><h2>You haven't joined a match yet</h2><p class="lede">Pick a tournament and your slot will show up here.</p><button class="btn btn-foil" data-act="go" data-view="home">Browse tournaments</button></div>`;
    return `<h1 class="h-page">Matches</h1>${pend}<div class="${S.regs.length ? 'card' : ''}">${list}</div>`;
  };

  /* profile */
  CA.views.profile = () => {
    const u = S.user;
    if (!u) return loading();
    const roleLabel = { player: 'Player', host: 'Host', super_admin: 'Super Admin' }[u.role];
    const must = u.must_change_password;
    return `<h1 class="h-page">Profile</h1>
      ${must ? `<div class="banner"><span>Change your initial admin password now. Admin tools stay locked until you do.</span></div>` : ''}
      <div class="card"><div class="rows">
        <div><span class="l">Name</span><span class="r">${esc(u.display_name)}</span></div>
        <div><span class="l">Email</span><span class="r" style="font-size:14px">${esc(u.email)}</span></div>
        <div><span class="l">Role</span><span class="r">${roleLabel}</span></div>
        <div><span class="l">Email status</span><span class="r">${u.email_verified ? '<span class="badge b-ok">Verified</span>' : '<span class="badge b-wait">Not verified</span>'}</span></div>
      </div></div>
      ${u.email_verified ? '' : `<div class="note">${ic('clock')}<div>Verify your email to join tournaments and add money. Check your inbox for the link.</div></div><div class="btn-row"><button class="btn btn-ghost" data-act="resend">Resend email</button><button class="btn btn-ghost" data-act="recheck">I've verified</button></div>`}
      <section class="card pad"><h2 style="font-size:16px;margin-bottom:14px">Display name</h2>
        <form data-form="rename"><div class="field"><input name="name" value="${esc(u.display_name)}" minlength="2" maxlength="40" required aria-label="Display name"></div><button class="btn btn-ghost" type="submit">Save name</button></form></section>
      <section class="card pad"><h2 style="font-size:16px;margin-bottom:14px">Change password</h2>
        <form data-form="password"><div class="field"><input name="pw" type="password" minlength="10" autocomplete="new-password" required aria-label="New password"><small>At least 10 characters. You will sign in again afterwards.</small></div><button class="btn ${must ? 'btn-foil' : 'btn-ghost'}" type="submit">Update password</button></form></section>
      <div class="btn-row">${S.cfg.referral_enabled ? '<button class="btn btn-ghost" data-act="go" data-view="refer">Invite friends</button>' : ''}<button class="btn btn-ghost" data-act="go" data-view="help">Help and support</button></div>
      <div class="btn-row">${CA.discordBtn('btn-ghost')}<button class="btn btn-ghost" data-act="signout">Sign out</button></div>
      ${S.cfg.support_contact ? `<p class="mute">Need help? ${esc(S.cfg.support_contact)}</p>` : ''}`;
  };

  CA.forms.rename = async (form) => {
    const name = new FormData(form).get('name').trim();
    const r = await api('/me', { method: 'PATCH', body: { display_name: name } });
    S.user = r.user; toast('Name updated'); CA.render();
  };
  CA.forms.password = async (form) => {
    const pw = new FormData(form).get('pw');
    await api('/me/change-password', { method: 'POST', body: { new_password: pw } });
    toast('Password changed. Please sign in again.');
    await CA.act.signout();
  };
  CA.act.resend = async () => {
    if (!S.fb || !S.fb.auth.currentUser) return;
    try { await S.fb.A.sendEmailVerification(S.fb.auth.currentUser); }
    catch (e) {
      console.error('sendEmailVerification failed:', e.code, e.message);
      return toast(e.code === 'auth/too-many-requests' ? 'Too many requests. Wait a few minutes before resending.' : `Could not send the email (${e.code || 'error'}).`, true);
    }
    toast('Verification email sent. Check Inbox, Spam and Promotions.');
  };
  CA.act.recheck = async () => {
    if (!S.fb || !S.fb.auth.currentUser) return;
    await S.fb.auth.currentUser.reload();
    await S.fb.auth.currentUser.getIdToken(true);
    await CA.loadMe();
    CA.render();
    toast(S.user.email_verified ? 'Email verified' : 'Not verified yet', !S.user.email_verified);
  };

  /* help and support page: content comes from admin Settings */
  const contactHtml = (c) => {
    if (/^https:\/\//i.test(c)) return `<a href="${esc(c)}" target="_blank" rel="noopener noreferrer">${esc(c)}</a>`;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return `<a href="mailto:${esc(c)}">${esc(c)}</a>`;
    return esc(c);
  };
  CA.views.help = () => {
    const c = S.cfg, e = CA.eta();
    const staff = S.user && (S.user.role === 'host' || S.user.role === 'super_admin');
    const discord = CA.discordBtn();
    const faq = (c.help_faq || []).map((f) => `<details class="faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('');
    return `<h1 class="h-page">${esc(c.help_title || 'Help and support')}</h1>
      ${c.help_intro ? `<p class="lede">${esc(c.help_intro)}</p>` : ''}
      ${discord || staff ? `<div class="card pad support"><h2>Talk to us on Discord</h2><p class="mute">Fastest way to reach the team, get tournament updates and ask other players.</p>${discord || '<p class="mute">Add your Discord invite in Manage, Settings so players see the button here.</p>'}</div>` : ''}
      ${c.support_contact ? `<div class="note">${ic('clock')}<div>Other ways to reach us: <b>${contactHtml(c.support_contact)}</b></div></div>` : ''}
      <div class="note-stack">
        <div class="note">${ic('clock')}<div><b>Deposits</b> reflect in your account in <b>${esc(e.dep)}</b>.</div></div>
        <div class="note">${ic('clock')}<div><b>Withdrawals</b> are credited in <b>${esc(e.wd)}</b>.</div></div>
      </div>
      ${faq ? `<section><div class="sec-h"><h2>Common questions</h2></div><div class="card">${faq}</div></section>` : ''}`;
  };

  /* invite and earn */
  CA.loaders.refer = async () => { S.ref = await api('/me/referral'); };
  const RSTAT = { pending: '<span class="badge b-wait">Waiting for first entry</span>', rewarded: '<span class="badge b-ok">Rewarded</span>', void: '<span class="badge">Cancelled</span>' };
  CA.views.refer = () => {
    const r = S.ref;
    if (!r) return loading();
    if (!r.enabled) return '<h1 class="h-page">Invite friends</h1><div class="empty"><h2>Referrals are paused</h2><p class="lede">Check back soon. Tournaments and your wallet are not affected.</p></div>';
    const where = r.credit_account === 'winnings' ? 'your winnings balance' : 'your deposit balance';
    const txt = r.referrer_reward_paise === r.referee_reward_paise ? `You both get ${inr(r.referrer_reward_paise)}` : `You get ${inr(r.referrer_reward_paise)} and your friend gets ${inr(r.referee_reward_paise)}`;
    const apply = r.can_apply ? `<section class="card pad"><h2 style="font-size:16px;margin-bottom:14px">Have a friend's code?</h2><form data-form="applyref"><div class="field"><input name="code" maxlength="12" placeholder="Enter code" autocapitalize="characters" autocomplete="off" required aria-label="Referral code"><small>Add it before your first tournament entry.</small></div><button class="btn btn-ghost" type="submit">Apply code</button></form></section>` : '';
    const list = r.referrals.length ? `<section><div class="sec-h"><h2>Your invites</h2></div><div class="card">${r.referrals.map((x) => `<div class="item"><div><div class="t">${esc(x.name)}</div><div class="s">${esc(fdate(x.created_at))}</div></div>${RSTAT[x.status] || ''}</div>`).join('')}</div></section>` : '';
    return `<h1 class="h-page">Invite friends</h1>
      <p class="lede">${esc(txt)} when your friend enters their first tournament${r.min_entry_paise > 0 ? ' (entry of ' + inr(r.min_entry_paise) + ' or more)' : ''}. The bonus goes to ${where}.</p>
      <div class="code-card"><div class="mute">Your referral code</div><div class="code">${esc(r.code)}</div>
        <div class="btn-row"><button class="btn btn-ghost" data-act="copy" data-text="${esc(r.code)}">Copy code</button><button class="btn btn-foil" data-act="share">Share invite link</button></div></div>
      <div class="card"><div class="rows">
        <div><span class="l">Friends joined</span><span class="r">${r.stats.invited}</span></div>
        <div><span class="l">Rewarded</span><span class="r">${r.stats.rewarded}</span></div>
        <div><span class="l">You earned</span><span class="r">${inr(r.stats.earned_paise)}</span></div></div></div>
      ${apply}${list}`;
  };
  CA.act.share = async () => {
    const r = S.ref;
    const url = (typeof location !== 'undefined' ? location.origin : '') + '/?ref=' + r.code;
    const text = `Join me on ${S.cfg.platform_title}. Use my code ${r.code} and we both get a bonus.`;
    if (navigator.share) { try { await navigator.share({ title: S.cfg.platform_title, text, url }); return; } catch (_) { return; } }
    await CA.act.copy({ text: text + ' ' + url });
  };
  CA.forms.applyref = async (form) => {
    await api('/me/referral', { method: 'POST', body: { code: new FormData(form).get('code').trim() } });
    toast('Referral code applied');
    await CA.loaders.refer(); CA.render();
  };
})();
