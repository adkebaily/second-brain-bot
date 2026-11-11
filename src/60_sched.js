// ===== Scheduler: briefs (with catch-up), finance reminders/expiry, Notion retry =====

// Which briefs are due now. A brief missed while the laptop was off is sent at the next run the
// same day; brain.load claims each (kind, date) once via sent_log, so nothing is sent twice.
function dueClaims(now = new Date()) {
  const p = paris(now), out = [];
  if (p.hh >= 8) out.push({ kind: 'morning', for_date: p.date });
  if (p.hh >= 21) out.push({ kind: 'evening', for_date: p.date });
  if (p.dow === 0 && p.hh >= 20) out.push({ kind: 'weekly', for_date: p.date });
  return out;
}

async function allBrainDump(ctx) {
  const out = [];
  for (const key of Object.keys(SB.SECTIONS)) out.push(...await bdItems(ctx, key));
  return out;
}
const parisDay = iso => paris(new Date(iso)).date;

async function morningBrief(ctx) {
  const t = today(ctx), y = addDays(t, -1);
  const L = await lists(ctx, true);
  const [tasks, bd] = await Promise.all([openTasks(ctx, t), allBrainDump(ctx)]);
  const lines = ['☀️ <b>BONJOUR !</b>', `<i>${fmtDay(t)}</i>`, ''];
  lines.push(tasks.length ? `📋 <b>Aujourd'hui</b>  ·  ${tasks.length} tâche${tasks.length > 1 ? 's' : ''}` : '🎉 <b>Aucune tâche aujourd\'hui ni en retard</b>', ...tasks.slice(0, 25).map(x => taskLine(ctx, x)));
  const hot = L.categories.filter(c => c.budget > 0 && c.spent / c.budget >= 0.8);
  if (hot.length) lines.push('', '━━━━━━━━━━━━', '📊 <b>Budgets à surveiller</b>', ...hot.map(c => budgetLine(c.name, c.spent, c.budget)));
  const yd = bd.filter(x => parisDay(x.created) === y);
  if (yd.length) lines.push('', '━━━━━━━━━━━━', `💭 <b>Idées d'hier</b>  ·  ${yd.length}`, ...yd.map(x => `${SB.SECTIONS[x.section].split(' ')[0]} <a href="${esc(x.url)}">${esc(clip(x.text, 80))}</a>`));
  const waiting = (ctx.db.open || []).filter(r => r.status === 'open' && r.payload.items.some(i => i.type === 'finance' && i.state === 'pending'));
  if (waiting.length) lines.push('', '━━━━━━━━━━━━', `🧾 <b>À confirmer</b>  ·  ${waiting.length} message${waiting.length > 1 ? 's' : ''}`,
    ...waiting.map(r => `• ${r.payload.items.filter(i => i.state === 'pending').map(i => `${esc(i.data.title)} <b>${eur(i.data.amount)}</b>`).join(', ')}`));
  return tgSend(ctx, lines.join('\n'), taskKb(ctx, tasks, false));
}

async function eveningBrief(ctx) {
  const tasks = await openTasks(ctx, today(ctx));
  if (!tasks.length) return tgSend(ctx, '🌙 <b>BONNE SOIRÉE !</b>\n<i>Plus rien d\'ouvert pour aujourd\'hui.</i>');
  return tgSend(ctx, ['🌙 <b>BILAN DU SOIR</b>', '<i>Qu\'as-tu terminé aujourd\'hui ?</i>', '', '✅ fait  ·  ➡️ demain  ·  📅 autre date  ·  = garder', '<i>Rien ne change sans ton choix.</i>', '',
    ...tasks.slice(0, 12).map(x => taskLine(ctx, x)), ...(tasks.length > 12 ? [`… +${tasks.length - 12} (voir /today)`] : [])].join('\n'), taskKb(ctx, tasks, true));
}

async function weeklyBrief(ctx) {
  const t = today(ctx), wk = weekStart(t);
  const L = await lists(ctx, true);
  const since = parisMidnight(wk);
  const created = { timestamp: 'created_time', created_time: { on_or_after: since } };
  const [exp, inc, tCreated, tDone, notes, bd] = await Promise.all([
    nQuery(ctx, SB.DS.expenses, { filter: { property: 'Date', date: { on_or_after: wk } } }, 500),
    nQuery(ctx, SB.DS.incomes, { filter: { property: 'Date', date: { on_or_after: wk } } }, 500),
    nQuery(ctx, SB.DS.todo, { filter: created }, 500),
    // shortcut: "done this week" = Done and edited this week (Notion has no status-change date), good enough for a weekly count
    nQuery(ctx, SB.DS.todo, { filter: { and: [{ property: 'Status', status: { equals: 'Done' } }, { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } }] } }, 500),
    nQuery(ctx, SB.DS.notes, { filter: created }, 500),
    allBrainDump(ctx)]);
  const sum = rows => rows.reduce((s, p) => s + (p.properties.Amount?.number || 0), 0);
  const out = sum(exp), inn = sum(inc);
  const byCat = {};
  for (const p of exp) { const id = p.properties.Category?.relation?.[0]?.id || 'none'; byCat[id] = (byCat[id] || 0) + (p.properties.Amount?.number || 0); }
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, v]) => {
    const c = L.categories.find(x => x.id === id);
    const month = c?.budget ? `\n<code>${bar((c.spent / c.budget) * 100)}</code> mois ${Math.round((c.spent / c.budget) * 100)} %` : '';
    return `• ${esc(c?.name || 'Sans catégorie')}  <b>${eur(v)}</b>${month}`;
  });
  const bdWeek = bd.filter(x => parisDay(x.created) >= wk);
  return tgSend(ctx, ['🗓 <b>BILAN DE LA SEMAINE</b>', `<i>${fmtDay(wk)} → ${fmtDay(t)}</i>`, '',
    '💶 <b>Argent</b>', `🟢 Entrées    <b>${eur(inn)}</b>`, `🔴 Sorties    <b>${eur(out)}</b>`, `${inn - out >= 0 ? '📈' : '📉'} Net          <b>${eur(inn - out)}</b>`,
    ...(top.length ? ['', '🏷 <b>Top catégories</b>', ...top] : []), '', '━━━━━━━━━━━━',
    `☑️ Tâches     <b>${tDone.length}</b> terminées · ${tCreated.length} créées`,
    `💭 Idées       <b>${bdWeek.length}</b>`,
    `📝 Notes      <b>${notes.length}</b>`].join('\n'));
}

async function maintain(ctx, row) {
  const b = rowToBatch(row);
  const ageH = (Date.now() - Date.parse(row.created_at)) / 3600e3;
  const finPending = b.payload.items.filter(i => i.type === 'finance' && i.state === 'pending');
  if (b.status === 'open' && finPending.length) {
    if (ageH >= 48) {
      ctx.stage = 'expire batch';
      for (const i of finPending) { i.state = 'cancelled'; flag(ctx, b, { item_idx: i.idx, was_cancelled: true }); }
      if (!b.payload.items.some(i => i.state === 'saved')) b.status = 'expired';
      b.payload.note = '⌛ Finance non confirmée en 48 h : annulée.';
      return renderOut(ctx, b, await lists(ctx));
    }
    if (ageH >= 12 && !b.reminded_at) {
      ctx.stage = 'remind batch';
      await tgSend(ctx, `⏰ <b>Toujours en attente de ✅</b>\n<i>Annulé automatiquement dans ${Math.round(48 - ageH)} h.</i>`, null, { reply_parameters: { message_id: b.telegram_message_id, allow_sending_without_reply: true } });
      b.reminded_at = new Date().toISOString();
      track(ctx, b);
    }
    return;
  }
  if (b.status === 'retrying') {
    ctx.stage = 'retry Notion';
    const L = await lists(ctx);
    b.attempts++;
    for (const i of b.payload.items.filter(x => x.state === 'failed')) await saveSafely(ctx, L, b, i);
    if (b.payload.items.some(i => i.state === 'failed')) return track(ctx, b); // still down: try again next run
    b.payload.note = `✅ Notion est revenu : enregistré après ${b.attempts} essai${b.attempts > 1 ? 's' : ''}.`;
    return renderOut(ctx, b, L);
  }
}

async function schedEngine(ctx) {
  const errors = [];
  for (const c of ctx.db.claims || []) {
    try {
      ctx.stage = c.kind + ' brief';
      const msg = await { morning: morningBrief, evening: eveningBrief, weekly: weeklyBrief }[c.kind](ctx);
      ctx.ops.push({ op: 'sent_msg', kind: c.kind, for_date: c.for_date, message_id: msg.message_id });
    } catch (e) {
      ctx.ops.push({ op: 'sent_unclaim', kind: c.kind, for_date: c.for_date }); // retried at the next run
      errors.push(`[${ctx.stage}] ${redact(ctx, e.message)}`);
    }
  }
  for (const row of ctx.db.open || []) {
    try { await maintain(ctx, row); } catch (e) { errors.push(`[${ctx.stage} ${row.id}] ${redact(ctx, e.message)}`); }
  }
  return errors;
}

// ===== Eval / test API =====
async function evalEngine(ctx, body) {
  ctx.todayOverride = body.today || null;
  const L = await lists(ctx);
  const t0 = Date.now();
  let output;
  if (body.stage === 'router') output = await route(ctx, body.text);
  else {
    const file = body.file ? { mime: body.file.mime, b64: body.file.b64 } : null;
    const src = { text: body.text || '', messageDate: body.message_date || today(ctx), file, input_type: file ? 'photo' : 'text' };
    const items = await extractItem(ctx, L, body.stage, body.text || '', src, {});
    output = items.map(i => {
      const d = { ...i.data };
      for (const k of ['category', 'account', 'from_account', 'to_account', 'goal', 'goal_suggestion']) if (d[k] && typeof d[k] === 'object') d[k] = d[k].name || d[k].title;
      if (i.type === 'note') d.category = i.data.category?.name;
      if (i.type === 'finance') { const v = validateFinance(ctx, i); d.errors = v.errors; d.warnings = [...i.warnings, ...v.warnings]; }
      return { type: i.type, confidence: i.confidence, ...d };
    });
  }
  const usage = ctx.logs.reduce((s, l) => ({ tokens_in: s.tokens_in + l.tokens_in, tokens_out: s.tokens_out + l.tokens_out, cost_eur: s.cost_eur + l.cost_eur }), { tokens_in: 0, tokens_out: 0, cost_eur: 0 });
  return { output, latency_ms: Date.now() - t0, usage, models: ctx.logs.map(l => l.model) };
}
