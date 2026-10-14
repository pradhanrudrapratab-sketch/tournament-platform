/* Manage area: Super Admin and Host tools. The server re-checks every permission; hiding things here is only convenience. */
(function () {
  'use strict';
  const CA = window.CA, S = CA.S, { esc, inr, fdate, api, ic, loading, toast, ask, sheet, closeSheet } = CA;
  const A = (S.adm = { tab: 'tournaments', data: null, q: '' });
  const isSuper = () => S.user && S.user.role === 'super_admin';
  const tabs = () => (isSuper()
    ? [['overview', 'Overview'], ['tournaments', 'Tournaments'], ['withdrawals', 'Withdrawals'], ['players', 'Players'], ['referrals', 'Referrals'], ['settings', 'Settings'], ['audit', 'Audit log']]
    : [['tournaments', 'Tournaments']]);

  CA.loaders.admin = async () => {
    if (!isSuper() && A.tab !== 'tournaments') A.tab = 'tournaments';
    if (!S.games.length) S.games = (await api('/games')).games;
    const t = A.tab;
    if (t === 'overview') A.data = await api('/admin/overview');
    else if (t === 'tournaments') A.data = await api('/admin/tournaments');
    else if (t === 'withdrawals') A.data = await api('/admin/withdrawals');
    else if (t === 'players') A.data = await api('/admin/players?q=' + encodeURIComponent(A.q));
    else if (t === 'referrals') A.data = await api('/admin/referrals');
    else if (t === 'settings') { const [s, g] = await Promise.all([api('/admin/settings'), api('/admin/games')]); A.data = { settings: s.settings, games: g.games }; }
    else if (t === 'audit') A.data = await api('/admin/audit');
  };
  async function reload() { A.data = null; CA.render(); await CA.loaders.admin(); CA.render(); }
  CA.act.admtab = async (d) => { A.tab = d.tab; await reload(); };

  const money = (p) => inr(p);
  const TS = { draft: 'Draft', published: 'Published', full: 'Full', registration_closed: 'Reg. closed', scheduled: 'Scheduled', live: 'Live', pending_result: 'Awaiting result', completed: 'Completed', cancelled: 'Cancelled' };

  function tournamentsHtml(list) {
    const rows = list.length ? list.map((t) => {
      const b = [];
      if (t.status === 'draft') b.push(`<button class="btn btn-foil btn-sm" data-act="tact" data-op="publish" data-id="${t.id}">${t.approval_requested && isSuper() ? 'Approve and publish' : isSuper() ? 'Publish' : 'Publish or request'}</button>`);
      if (['published', 'full', 'scheduled', 'registration_closed'].includes(t.status)) b.push(`<button class="btn btn-ghost btn-sm" data-act="tact" data-op="start" data-id="${t.id}">Start</button>`);
      if (t.status === 'live') b.push(`<button class="btn btn-ghost btn-sm" data-act="tplayers" data-id="${t.id}">Players</button><button class="btn btn-ghost btn-sm" data-act="tact" data-op="end" data-id="${t.id}">End</button>`);
      if (t.status === 'pending_result') b.push(`<button class="btn btn-foil btn-sm" data-act="tplayers" data-id="${t.id}">Results</button>`);
      if (!['completed', 'cancelled', 'pending_result'].includes(t.status)) b.push(`<button class="btn btn-ghost btn-sm" data-act="tedit" data-id="${t.id}">Edit</button><button class="btn btn-danger btn-sm" data-act="tact" data-op="cancel" data-id="${t.id}">Cancel</button>`);
      return `<div class="item"><div><div class="t">${esc(t.title)}</div><div class="s">${esc(t.game_name)}, ${esc(t.host_name)}. ${esc(fdate(t.scheduled_start_at))}. ${t.filled} of ${t.capacity} slots, entry ${money(t.entry_fee_paise)}</div><div style="margin-top:6px"><span class="badge ${t.status === 'live' ? 'b-live' : t.status === 'published' ? 'b-open' : ''}">${TS[t.status] || t.status}</span>${t.approval_requested ? ' <span class="badge b-wait">Approval requested</span>' : ''}</div></div><div class="acts">${b.join('')}</div></div>`;
    }).join('') : '<p class="mute" style="padding:16px 0">No tournaments yet.</p>';
    return `<div class="sec-h"><h2>Tournaments</h2><button class="btn btn-foil btn-sm" data-act="newt">New tournament</button></div><div class="card">${rows}</div>`;
  }

  function overviewHtml(d) {
    const s = d.stats;
    const row = (l, v) => `<div class="stat"><span class="mute">${l}</span><b>${v}</b></div>`;
    return `<div class="grid"><div class="card">${row('Registered players', s.players)}${row('Active', s.active_players)}${row('Suspended', s.suspended_players)}${row('Hosts', s.hosts)}${row('Enabled games', s.enabled_games)}</div>
      <div class="card">${row('Upcoming tournaments', s.upcoming)}${row('Live now', s.live)}${row('Completed', s.completed)}${row('Awaiting payment', s.awaiting_payment)}${row('Verified registrations', s.verified_registrations)}</div>
      <div class="card">${row('Pending withdrawals', s.withdrawals_pending)}${row('Withdrawals processing', s.withdrawals_processing)}${row('Verified entry payments', money(s.verified_payments_paise))}${row('Finalized prizes', money(s.finalized_prizes_paise))}</div>
      <div class="card">${d.recent.length ? d.recent.map((r) => `<div class="stat"><span>${esc(r.action)}<span class="mute"> by ${esc(r.actor || 'system')}</span></span><span class="mute">${esc(fdate(r.created_at))}</span></div>`).join('') : '<p class="mute" style="padding:16px 0">No recent actions.</p>'}</div></div>`;
  }

  function withdrawalsHtml(list) {
    const rows = list.length ? list.map((w) => {
      const b = [];
      if (w.status === 'pending') b.push(`<button class="btn btn-foil btn-sm" data-act="wact" data-op="approve" data-id="${w.id}">Approve</button><button class="btn btn-danger btn-sm" data-act="wact" data-op="reject" data-id="${w.id}">Reject</button>`);
      if (w.status === 'approved') b.push(`<button class="btn btn-ghost btn-sm" data-act="wact" data-op="processing" data-id="${w.id}">Mark processing</button>`);
      if (['approved', 'processing'].includes(w.status)) b.push(`<button class="btn btn-foil btn-sm" data-act="wact" data-op="confirm-payout" data-id="${w.id}">Confirm payout</button><button class="btn btn-danger btn-sm" data-act="wact" data-op="fail" data-id="${w.id}">Mark failed</button>`);
      return `<div class="item"><div><div class="t">${esc(w.display_name)}: ${money(w.requested_amount_paise)}</div><div class="s">Pay ${money(w.net_payout_paise)} after ${money(w.fee_paise)} fee to ${esc(w.payout_upi)}. ${esc(fdate(w.created_at))}</div><div style="margin-top:6px">${CA.wdBadge(w.status)}</div></div><div class="acts">${b.join('')}</div></div>`;
    }).join('') : '<p class="mute" style="padding:16px 0">No withdrawal requests.</p>';
    return `<div class="note">${ic('clock')}<div>Approving does not pay anyone. Send the money, then use <b>Confirm payout</b> with the UTR so the player sees it as paid. Players are told to expect credit in <b>${esc(CA.eta().wd)}</b>.</div></div><div class="card">${rows}</div>`;
  }

  function playersHtml(list) {
    const rows = list.map((p) => {
      const b = [];
      if (p.role !== 'super_admin') {
        b.push(p.status === 'active' ? `<button class="btn btn-ghost btn-sm" data-act="pstatus" data-id="${p.id}" data-to="suspended">Suspend</button>` : `<button class="btn btn-ghost btn-sm" data-act="pstatus" data-id="${p.id}" data-to="active">Reactivate</button>`);
        b.push(p.role === 'host' ? `<button class="btn btn-ghost btn-sm" data-act="prole" data-id="${p.id}" data-to="player">Make player</button>` : '');
        b.push(`<button class="btn btn-ghost btn-sm" data-act="prole" data-id="${p.id}" data-to="host">${p.role === 'host' ? 'Edit games' : 'Make host'}</button>`);
      }
      return `<div class="item"><div><div class="t">${esc(p.display_name)}</div><div class="s">${esc(p.email)}</div><div style="margin-top:6px"><span class="badge">${esc(p.role.replace('_', ' '))}</span> ${p.status === 'active' ? '' : `<span class="badge b-bad">${esc(p.status)}</span>`}</div></div><div class="acts">${b.join('')}</div></div>`;
    }).join('') || '<p class="mute" style="padding:16px 0">No players found.</p>';
    return `<form data-form="psearch" class="field"><input name="q" value="${esc(A.q)}" placeholder="Search by name, email or player ID" aria-label="Search players"></form><div class="card">${rows}</div>`;
  }

  function referralsHtml(d) {
    const s = d.stats;
    const row = (l, v) => `<div class="stat"><span class="mute">${l}</span><b>${v}</b></div>`;
    const list = d.referrals.length ? d.referrals.map((r) => `<div class="item"><div><div class="t">${esc(r.referrer_name)} invited ${esc(r.referred_name)}</div><div class="s">${esc(r.referrer_email)} and ${esc(r.referred_email)}. ${esc(fdate(r.created_at))}</div><div style="margin-top:6px">${{ pending: '<span class="badge b-wait">Pending</span>', rewarded: '<span class="badge b-ok">Rewarded</span>', void: '<span class="badge">Void</span>' }[r.status]}</div></div><div class="acts">${r.status === 'pending' ? `<button class="btn btn-danger btn-sm" data-act="rvoid" data-id="${r.id}">Void</button>` : ''}</div></div>`).join('') : '<p class="mute" style="padding:16px 0">No referrals yet.</p>';
    return `<div class="note">${ic('clock')}<div>Rewards, minimum entry and where the bonus is credited are set in <b>Settings</b>. Watch for people referring their own extra accounts, and void those while still pending.</div></div>
      <div class="card">${row('Total referrals', s.total)}${row('Waiting for first entry', s.pending)}${row('Rewarded', s.rewarded)}${row('Voided', s.void)}${row('Bonus paid out', money(s.paid_paise))}</div>
      <div class="card">${list}</div>`;
  }
  CA.act.rvoid = async (d) => {
    const v = await ask('Void referral', [{ name: 'reason', label: 'Reason', req: true }], 'Void referral');
    if (!v) return;
    run(() => api(`/admin/referrals/${d.id}/void`, { method: 'POST', body: { reason: v.reason } }), 'Referral voided');
  };
  const faqToText = (a) => (a || []).map((f) => f.q + '\n' + f.a).join('\n\n');
  const textToFaq = (t) => String(t || '').split(/\n\s*\n/).map((b) => { const l = b.trim().split('\n'); return { q: (l[0] || '').trim(), a: l.slice(1).join(' ').trim() }; }).filter((f) => f.q && f.a);

  function settingsHtml(d) {
    const s = d.settings;
    const f = (n, l, v, t, h) => `<div class="field"><label for="s-${n}">${l}</label><input id="s-${n}" name="${n}" type="${t || 'text'}" value="${esc(v)}">${h ? `<small>${h}</small>` : ''}</div>`;
    return `<form class="card pad" data-form="settings"><h2 style="font-size:16px;margin-bottom:14px">Platform settings</h2>
      ${f('platform_title', 'Platform title', s.platform_title)}${f('support_contact', 'Support contact', s.support_contact)}${f('discord_invite_url', 'Discord invite URL', s.discord_invite_url, 'url', 'Shown on empty states and the profile page.')}
      <div class="two">${f('withdraw_min', 'Minimum withdrawal (rupees)', s.withdraw_min_paise / 100, 'number')}${f('withdraw_fee_percent', 'Withdrawal fee (%)', s.withdraw_fee_bps / 100, 'number')}</div>
      <div class="two">${f('reveal_offset_minutes', 'Room reveal (minutes before start)', s.reveal_offset_seconds / 60, 'number')}${f('reservation_minutes', 'Unpaid slot hold (minutes)', s.reservation_minutes, 'number')}</div>
      ${f('no_show_delay_seconds', 'No-show delay (seconds)', s.no_show_delay_seconds, 'number')}
      <div class="two">${f('deposit_eta_text', 'Deposit time shown to players', s.deposit_eta_text)}${f('withdraw_eta_text', 'Withdrawal time shown to players', s.withdraw_eta_text)}</div>
      <h2 style="font-size:16px;margin:22px 0 14px">Referral program</h2>
      <div class="field"><label for="s-referral_enabled">Referral program</label><select id="s-referral_enabled" name="referral_enabled"><option value="true" ${s.referral_enabled ? 'selected' : ''}>On</option><option value="false" ${s.referral_enabled ? '' : 'selected'}>Off</option></select></div>
      <div class="two">${f('ref_referrer', 'Referrer gets (rupees)', s.referral_referrer_reward_paise / 100, 'number')}${f('ref_referee', 'Friend gets (rupees)', s.referral_referee_reward_paise / 100, 'number')}</div>
      ${f('ref_min_entry', 'Minimum entry fee that qualifies (rupees)', s.referral_min_entry_paise / 100, 'number', 'The friend\'s first paid entry must be at least this much. Stops free or tiny entries being used to farm bonuses.')}
      <div class="field"><label for="s-referral_credit_account">Bonus is credited to</label><select id="s-referral_credit_account" name="referral_credit_account"><option value="deposit" ${s.referral_credit_account === 'deposit' ? 'selected' : ''}>Deposit balance (spend on entries only)</option><option value="winnings" ${s.referral_credit_account === 'winnings' ? 'selected' : ''}>Winnings balance (withdrawable)</option></select><small>Deposit balance is safer against abuse.</small></div>
      <h2 style="font-size:16px;margin:22px 0 14px">Help and support page</h2>
      ${f('help_title', 'Page title', s.help_title)}
      <div class="field"><label for="s-help_intro">Intro text</label><textarea id="s-help_intro" name="help_intro" maxlength="400">${esc(s.help_intro)}</textarea></div>
      <div class="field"><label for="s-help_faq">Questions and answers</label><textarea id="s-help_faq" name="help_faq" style="min-height:200px">${esc(faqToText(s.help_faq))}</textarea><small>One question per block: first line is the question, the next lines are the answer. Leave a blank line between blocks. The Discord button on this page uses the Discord invite URL above.</small></div>
      <p class="mute" style="font-size:13px;margin-bottom:14px">Financial changes apply to future transactions only.</p>
      <button class="btn btn-foil" type="submit">Save settings</button></form>
      <section><div class="sec-h"><h2>Games</h2></div><div class="card">${d.games.map((g) => `<div class="item"><div><div class="t">${esc(g.name)}</div><div class="s">${g.enabled ? 'Open for registration' : 'Coming soon, registration blocked'}</div></div><button class="btn btn-ghost btn-sm" data-act="gtoggle" data-id="${g.id}" data-on="${g.enabled}" data-ct="${g.creation_enabled}">${g.enabled ? 'Disable' : 'Enable'}</button></div>`).join('')}</div></section>`;
  }

  CA.views.admin = () => {
    if (!S.user) return loading();
    if (S.user.must_change_password) return '<h1 class="h-page">Manage</h1><div class="banner"><span>Change your initial password in Profile to unlock admin tools.</span><button class="btn btn-foil btn-sm" data-act="go" data-view="profile">Open profile</button></div>';
    const nav = tabs();
    const sub = nav.length > 1 ? `<div class="sub-tabs">${nav.map((t) => `<button class="chip" data-act="admtab" data-tab="${t[0]}" aria-pressed="${A.tab === t[0]}">${t[1]}</button>`).join('')}</div>` : '';
    let body = loading();
    const d = A.data;
    if (d) {
      if (A.tab === 'overview') body = overviewHtml(d);
      else if (A.tab === 'tournaments') body = tournamentsHtml(d.tournaments);
      else if (A.tab === 'withdrawals') body = withdrawalsHtml(d.withdrawals);
      else if (A.tab === 'players') body = playersHtml(d.players);
      else if (A.tab === 'referrals') body = referralsHtml(d);
      else if (A.tab === 'settings') body = settingsHtml(d);
      else if (A.tab === 'audit') body = `<div class="card">${d.logs.map((l) => `<div class="item"><div><div class="t">${esc(l.action)}</div><div class="s">${esc(l.actor || 'system')}${l.resource_type ? ', ' + esc(l.resource_type) + ' ' + esc(l.resource_id) : ''}${l.reason ? '. ' + esc(l.reason) : ''}</div></div><span class="mute" style="font-size:13px">${esc(fdate(l.created_at))}</span></div>`).join('')}</div>`;
    }
    return `<h1 class="h-page">Manage</h1>${sub}${body}`;
  };

  const run = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg); await reload(); } catch (e) { CA.fail(e); } };

  /* tournaments */
  const localIso = (v) => (v ? new Date(v).toISOString() : null);
  CA.act.newt = () => {
    const games = S.games.filter((g) => g.enabled);
    sheet(`<h2>New tournament</h2><form data-form="newt">
      <div class="field"><label for="n-game">Game</label><select id="n-game" name="game_id">${games.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="n-title">Title</label><input id="n-title" name="title" required minlength="3" maxlength="80"></div>
      <div class="field"><label for="n-desc">Description</label><textarea id="n-desc" name="description" maxlength="1000"></textarea></div>
      <div class="two"><div class="field"><label for="n-fee">Entry fee (rupees)</label><input id="n-fee" name="fee" type="number" min="0" step="1" value="0" required></div><div class="field"><label for="n-pool">Prize pool (rupees)</label><input id="n-pool" name="pool" type="number" min="0" step="1" value="0" required></div></div>
      <div class="field"><label for="n-cap">Maximum players</label><input id="n-cap" name="capacity" type="number" min="2" max="1000" required></div>
      <div class="two"><div class="field"><label for="n-start">Start time</label><input id="n-start" name="start" type="datetime-local" required></div><div class="field"><label for="n-close">Registration closes</label><input id="n-close" name="close" type="datetime-local"></div></div>
      <div class="two"><div class="field"><label for="n-room">Room ID</label><input id="n-room" name="room_id" autocomplete="off"></div><div class="field"><label for="n-pass">Room password</label><input id="n-pass" name="room_password" autocomplete="off"></div></div>
      <div class="field"><label for="n-rules">Rules</label><textarea id="n-rules" name="rules" maxlength="4000"></textarea></div>
      <button class="btn btn-foil btn-block" type="submit">Save as draft</button></form>`);
  };
  CA.forms.newt = async (form) => {
    const d = Object.fromEntries(new FormData(form).entries());
    await api('/admin/tournaments', { method: 'POST', body: { game_id: +d.game_id, title: d.title, description: d.description, entry_fee_paise: Math.round(+d.fee * 100), prize_pool_paise: Math.round(+d.pool * 100), capacity: +d.capacity, scheduled_start_at: localIso(d.start), registration_closes_at: localIso(d.close), room_id: d.room_id, room_password: d.room_password, rules: d.rules } });
    closeSheet(); toast('Draft saved'); await reload();
  };
  CA.act.tedit = async (d) => {
    const v = await ask('Edit tournament', [
      { name: 'start', label: 'New start time (leave empty to keep)', type: 'datetime-local' },
      { name: 'room_id', label: 'Room ID (leave empty to keep)' },
      { name: 'room_password', label: 'Room password (leave empty to keep)' },
    ], 'Save changes');
    if (!v) return;
    const body = {};
    if (v.start) body.scheduled_start_at = localIso(v.start);
    if (v.room_id) body.room_id = v.room_id;
    if (v.room_password) body.room_password = v.room_password;
    if (!Object.keys(body).length) return;
    run(() => api('/admin/tournaments/' + d.id, { method: 'PATCH', body }), 'Updated. The reveal time follows the new schedule.');
  };
  CA.act.tact = async (d) => {
    let body;
    if (d.op === 'cancel') {
      const v = await ask('Cancel tournament', [{ name: 'reason', label: 'Reason', req: true, type: 'textarea', hint: 'Paid entries are refunded to players\' deposit wallets.' }], 'Cancel tournament');
      if (!v) return;
      body = { reason: v.reason };
    }
    run(async () => {
      const r = await api(`/admin/tournaments/${d.id}/${d.op}`, { method: 'POST', body: body || {} });
      if (r.pending_approval) toast('Sent to a Super Admin for approval');
    }, d.op === 'publish' ? null : 'Done');
  };

  CA.act.tplayers = async (d) => {
    const r = await api(`/admin/tournaments/${d.id}/participants`);
    const t = r.tournament, live = t.status === 'live', pending = t.status === 'pending_result';
    const rows = r.participants.map((p) => `<div class="item"><div><div class="t">Slot ${p.slot_number}: ${esc(p.display_name)}</div><div class="s">${p.status === 'absent' ? 'Marked absent' : 'Confirmed'}</div></div>
      <div class="acts">${live && p.status === 'confirmed' ? `<button class="btn btn-ghost btn-sm" data-act="noshow" data-reg="${p.registration_id}" data-tid="${t.id}">Mark no-show</button>` : ''}
      ${pending && p.status === 'confirmed' ? `<input aria-label="Placement" type="number" min="1" placeholder="Place" data-res="place" data-pid="${p.player_id}" style="width:78px"><input aria-label="Prize in rupees" type="number" min="0" placeholder="Prize ₹" data-res="prize" data-pid="${p.player_id}" style="width:92px">` : ''}</div></div>`).join('') || '<p class="mute">No confirmed players.</p>';
    sheet(`<h2>${esc(t.title)}</h2>
      ${live ? '<div class="note">' + ic('clock') + '<div>A no-show can be marked after the configured delay. The slot reopens at a lower price, can be resold up to two times, and the original player gets no refund.</div></div>' : ''}
      ${pending ? `<div class="note">${ic('clock')}<div>Prize pool ${money(t.prize_pool_paise)}. Prizes are credited to winnings only after the result is finalized.</div></div>` : ''}
      <div class="card">${rows}</div>
      ${pending ? `<div class="btn-row"><button class="btn btn-ghost" data-act="saveres" data-id="${t.id}">Save result</button>${isSuper() ? `<button class="btn btn-foil" data-act="finalize" data-id="${t.id}">Finalize result</button>` : ''}</div>` : ''}`);
  };
  CA.act.noshow = async (d) => {
    const v = await ask('Mark no-show', [{ name: 'price', label: 'Resale price (rupees)', type: 'number', req: true, min: 0, step: 1, hint: 'Must be lower than the entry fee.' }], 'Mark absent and reopen slot');
    if (!v) return;
    try { await api(`/admin/registrations/${d.reg}/no-show`, { method: 'POST', body: { price_paise: Math.round(+v.price * 100) } }); toast('Slot reopened for resale'); await reload(); } catch (e) { CA.fail(e); }
  };
  CA.act.saveres = async (d) => {
    const entries = [];
    CA.$$('[data-res=place]').forEach((el) => {
      if (!el.value) return;
      const prize = CA.$(`[data-res=prize][data-pid="${el.dataset.pid}"]`);
      entries.push({ player_id: +el.dataset.pid, placement: +el.value, prize_paise: Math.round(+(prize && prize.value || 0) * 100) });
    });
    await api(`/admin/tournaments/${d.id}/results`, { method: 'POST', body: { entries } });
    toast('Result saved. It is not final until a Super Admin confirms it.');
  };
  CA.act.finalize = async (d) => {
    const v = await ask('Finalize result?', [{ name: 'ok', label: 'Type FINALIZE to confirm', req: true }], 'Finalize and credit prizes');
    if (!v || v.ok.trim().toUpperCase() !== 'FINALIZE') return;
    run(async () => { await api(`/admin/tournaments/${d.id}/results/confirm`, { method: 'POST', body: {} }); closeSheet(); }, 'Result finalized');
  };

  /* withdrawals */
  CA.act.wact = async (d) => {
    let body = {};
    if (d.op === 'confirm-payout') { const v = await ask('Confirm payout', [{ name: 'ref', label: 'UTR or payout reference', req: true, hint: 'Only confirm after the money has actually been sent.' }], 'Mark as paid'); if (!v) return; body = { payout_reference: v.ref }; }
    if (d.op === 'reject' || d.op === 'fail') { const v = await ask(d.op === 'reject' ? 'Reject withdrawal' : 'Mark payout failed', [{ name: 'reason', label: 'Reason', req: true, type: 'textarea', hint: 'The reserved amount returns to the player\'s winnings.' }], 'Confirm'); if (!v) return; body = { reason: v.reason }; }
    run(() => api(`/admin/withdrawals/${d.id}/${d.op}`, { method: 'POST', body }), 'Updated');
  };

  /* players */
  CA.forms.psearch = async (form) => { A.q = new FormData(form).get('q').trim(); await reload(); };
  CA.act.pstatus = async (d) => {
    let body = { status: d.to };
    if (d.to !== 'active') { const v = await ask('Suspend player', [{ name: 'reason', label: 'Reason', req: true }], 'Suspend'); if (!v) return; body.reason = v.reason; }
    run(() => api(`/admin/players/${d.id}/status`, { method: 'PATCH', body }), 'Updated');
  };
  CA.act.prole = (d) => {
    if (d.to === 'player') {
      run(() => api(`/admin/players/${d.id}/role`, { method: 'PATCH', body: { role: 'player', reason: 'Host role removed' } }), 'Host role removed');
      return;
    }
    const games = S.games.filter((g) => g.enabled);
    sheet(`<h2>Host permissions</h2><form data-form="hostperm" data-id="${d.id}">
      ${games.map((g) => `<div class="card pad" style="margin-bottom:12px"><label class="check" style="margin:0 0 10px"><input type="checkbox" name="g${g.id}"><span><b style="color:var(--ivory)">${esc(g.name)}</b></span></label>
        <div class="field"><label for="p${g.id}">Publishing</label><select id="p${g.id}" name="pol${g.id}"><option value="approval">Needs Super Admin approval</option><option value="direct">Can publish directly</option></select></div>
        <label class="check" style="margin:0 0 6px"><input type="checkbox" name="res${g.id}"><span>Can submit results</span></label>
        <label class="check" style="margin:0"><input type="checkbox" name="fin${g.id}"><span>Can finalize results</span></label></div>`).join('')}
      <button class="btn btn-foil btn-block" type="submit">Save host permissions</button></form>`);
  };
  CA.forms.hostperm = async (form) => {
    const d = new FormData(form), out = [];
    S.games.filter((g) => g.enabled).forEach((g) => {
      if (d.get('g' + g.id)) out.push({ game_id: g.id, publish_policy: d.get('pol' + g.id), can_manage_results: !!d.get('res' + g.id), can_finalize_results: !!d.get('fin' + g.id) });
    });
    if (!out.length) return toast('Pick at least one game', true);
    await api(`/admin/players/${form.dataset.id}/role`, { method: 'PATCH', body: { role: 'host', games: out, reason: 'Host permissions set' } });
    closeSheet(); toast('Host updated'); await reload();
  };

  /* settings */
  CA.forms.settings = async (form) => {
    const d = Object.fromEntries(new FormData(form).entries());
    const body = {
      platform_title: d.platform_title, support_contact: d.support_contact, discord_invite_url: d.discord_invite_url,
      withdraw_min_paise: Math.round(+d.withdraw_min * 100), withdraw_fee_bps: Math.round(+d.withdraw_fee_percent * 100),
      reveal_offset_seconds: Math.round(+d.reveal_offset_minutes * 60), reservation_minutes: +d.reservation_minutes,
      no_show_delay_seconds: +d.no_show_delay_seconds, deposit_eta_text: d.deposit_eta_text, withdraw_eta_text: d.withdraw_eta_text,
      referral_enabled: d.referral_enabled === 'true', referral_referrer_reward_paise: Math.round(+d.ref_referrer * 100),
      referral_referee_reward_paise: Math.round(+d.ref_referee * 100), referral_min_entry_paise: Math.round(+d.ref_min_entry * 100),
      referral_credit_account: d.referral_credit_account, help_title: d.help_title, help_intro: d.help_intro, help_faq: textToFaq(d.help_faq),
    };
    await api('/admin/settings', { method: 'PUT', body });
    await CA.reloadCfg();
    toast('Settings saved'); await reload();
  };
  CA.act.gtoggle = (d) => {
    const on = d.on !== 'true';
    run(() => api('/admin/games/' + d.id, { method: 'PUT', body: { enabled: on, creation_enabled: d.ct === 'true', coming_soon: !on } }), on ? 'Game enabled' : 'Game disabled');
  };
})();
