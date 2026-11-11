// ===== Main engine: Telegram update → actions → ops for brain.apply =====

// Runs before brain.load: allowlist + what to load. null = ignore silently.
function prepare(update) {
  const cq = update.callback_query, m = update.message || cq?.message;
  if (!m || String(m.chat?.id) !== SB.CHAT_ID || (cq && String(cq.from?.id) !== SB.CHAT_ID)) return null;
  const load = { chat_id: +SB.CHAT_ID };
  if (cq?.data?.startsWith('cb:')) load.cb_token = cq.data.slice(3);
  if (!cq && m.text && !m.text.startsWith('/')) load.take_state = true;
  if (!cq && /^\/undo\b/.test(m.text || '')) load.last_saved = true;
  return { update, load };
}

function rowToBatch(r) {
  return r && { id: r.id, chat_id: r.chat_id, type: r.type, payload: r.payload, telegram_message_id: r.telegram_message_id, status: r.status,
    attempts: r.attempts || 0, last_error: r.last_error, reminded_at: r.reminded_at, saved_at: r.saved_at, created_at: r.created_at };
}
function track(ctx, b) { ctx.batches = ctx.batches || []; if (!ctx.batches.includes(b)) ctx.batches.push(b); return b; }

function computeStatus(b) {
  const items = b.payload.items;
  b.type = items.every(i => i.type === 'finance') ? 'finance' : items.some(i => i.type === 'finance') ? 'mixed' : 'instant';
  if (['cancelled', 'expired'].includes(b.status)) return;
  const waiting = items.some(i => i.state === 'pending' || i.state === 'needs_type') || b.payload.photo_ask;
  const anyLive = items.some(live);
  if (waiting) b.status = 'open';
  else if (items.some(i => i.state === 'failed')) b.status = 'retrying';
  else if (!anyLive && items.some(i => i.state === 'undone')) b.status = 'undone';
  else if (!anyLive) b.status = 'cancelled';
  else b.status = 'saved';
  if (items.some(i => i.state === 'saved') && !b.saved_at) b.saved_at = new Date().toISOString();
}

async function renderOut(ctx, b, L) {
  computeStatus(b);
  const { text, kb } = renderBatch(ctx, b, L);
  ctx.ops.push({ op: 'burn_callbacks', pending_id: b.id });
  await tgEdit(ctx, b.telegram_message_id, text, kb);
  track(ctx, b);
}

function flag(ctx, b, extra) { ctx.flags = ctx.flags || []; ctx.flags.push({ op: 'log_flag', batch_id: b.id, ...extra }); }

// Validates, dup-checks and (for non-finance) saves freshly extracted items.
async function finalizeNew(ctx, L, b, fresh) {
  for (const it of fresh) {
    it.warnings = it.warnings || [];
    if (it.type === 'finance') { const v = validateFinance(ctx, it); it.errors = v.errors; it.warnings.push(...v.warnings); it.state = 'pending'; }
  }
  ctx.stage = 'duplicate check';
  await Promise.all(fresh.map(async it => { const w = await dupWarning(ctx, it); if (w) it.warnings.push(w); }));
  ctx.stage = 'save to Notion';
  for (const it of fresh.filter(i => i.type !== 'finance')) await saveSafely(ctx, L, b, it);
}
async function saveSafely(ctx, L, b, it) {
  try { await saveItem(ctx, L, b, it); }
  catch (e) {
    if (!e.retryable) throw e;
    it.state = 'failed'; b.last_error = e.message;
  }
}

function addItems(b, list) {
  for (const it of list) { it.idx = b.payload.items.length; b.payload.items.push(it); }
}

async function extractSpans(ctx, L, b, spans, src, prefix) {
  ctx.stage = 'extract';
  const groups = await Promise.all(spans.map(async s => {
    if (s.confidence < 0.6) return [{ type: s.type, state: 'needs_type', span: s.text_span, confidence: s.confidence, data: {}, warnings: [] }];
    const call = rid(6);
    const meta = { batch_id: b.id, input_type: src.input_type, prefix_used: prefix, router_type: s.type, router_confidence: s.confidence, _call: call };
    const its = await extractItem(ctx, L, s.type, s.text_span, src, meta);
    return its.map(i => ({ ...i, span: s.text_span, _call: call }));
  }));
  const fresh = groups.flat();
  addItems(b, fresh);
  return fresh.filter(i => !i.state);
}

// ---------- new content ----------
const MEDIA_DOC = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
async function onContent(ctx, m) {
  const ph = await tgSend(ctx, '⏳', null, { reply_parameters: { message_id: m.message_id } });
  const t = paris(new Date(m.date * 1000));
  const src = { input_type: 'text', text: (m.text || m.caption || '').trim(), message_date: t.date, message_time: t.time, messageDate: t.date };
  const b = { id: rid(12), chat_id: +SB.CHAT_ID, type: 'instant', status: 'open', telegram_message_id: ph.message_id, attempts: 0, payload: { source: src, items: [] } };
  ctx.batch = b;
  const L = await lists(ctx);
  let file = null, kind = null;
  if (m.voice || m.audio) {
    ctx.stage = 'transcribe';
    const v = m.voice || m.audio;
    src.input_type = 'voice';
    const { out } = await llm(ctx, { kind: 'transcribe', system: HELPER.transcribe.system, schema: HELPER.transcribe.schema,
      parts: [media(v.mime_type || 'audio/ogg', await tgFile(ctx, v.file_id)), { text: 'Transcris.' }], meta: { batch_id: b.id, input_type: 'voice' } });
    src.transcript = (out.transcript || '').trim();
    src.raw = src.transcript;
    src.text = [src.text, src.transcript].filter(Boolean).join('\n');
  } else if (m.photo || (m.document && MEDIA_DOC.test(m.document.mime_type || ''))) {
    ctx.stage = 'classify photo';
    const f = m.photo ? m.photo[m.photo.length - 1] : m.document;
    src.mime = m.photo ? 'image/jpeg' : m.document.mime_type;
    src.input_type = src.mime === 'application/pdf' ? 'pdf' : 'photo';
    src.file_id = f.file_id;
    if ((f.file_size || 0) > 19.5e6) { await tgEdit(ctx, ph.message_id, '📎 Fichier trop gros (max 20 Mo).'); ctx.batch = null; return; }
    file = { mime: src.mime, b64: await tgFile(ctx, f.file_id) };
    const { out } = await llm(ctx, { kind: 'classify_image', system: HELPER.classify.system, schema: HELPER.classify.schema,
      parts: [media(file.mime, file.b64), { text: src.text || 'Classifie.' }], meta: { batch_id: b.id, input_type: src.input_type } });
    kind = out.kind;
    if (kind === 'other' || out.confidence < 0.6) {
      b.payload.photo_ask = true;
      b.payload.note = `🤔 Ce n'est ni un ticket ni des notes manuscrites (${esc(clip(out.text, 80))}). Les cours vont au bot DMS. Je fais quoi ?`;
      return renderOut(ctx, b, L);
    }
  } else if (!src.text) {
    await tgEdit(ctx, ph.message_id, '🤷 Je gère le texte, les vocaux, les photos et les PDF.');
    ctx.batch = null;
    return;
  }
  if (!src.text && !file) { await tgEdit(ctx, ph.message_id, '🤷 Je n\'ai rien entendu.'); ctx.batch = null; return; }
  await processContent(ctx, L, b, file, kind);
}

async function processContent(ctx, L, b, file, kind) {
  const src = b.payload.source;
  let routed;
  if (file) routed = { prefix: null, items: [{ type: kind === 'receipt' ? 'finance' : 'note', text_span: src.text, confidence: 1 }] };
  else { ctx.stage = 'router'; routed = await route(ctx, src.text, { batch_id: b.id, input_type: src.input_type }); }
  const spans = routed.items.filter(i => i.type !== 'command_like');
  if (!spans.length) { await tgEdit(ctx, b.telegram_message_id, '🤖 Rien à enregistrer. Les commandes : /help'); ctx.batch = null; ctx.logs.forEach(l => (l.batch_id = null)); return; }
  const fresh = await extractSpans(ctx, L, b, spans, { ...src, file }, routed.prefix);
  await finalizeNew(ctx, L, b, fresh);
  await renderOut(ctx, b, L);
}

// ---------- callbacks ----------
function replaceRows(markup, rows, text) {
  const kb = (markup?.inline_keyboard || []).map(r => r);
  const out = [];
  kb.forEach((r, i) => { if (rows[0] === i) out.push([{ text, callback_data: 'noop' }]); else if (!rows.includes(i)) out.push(r); });
  return out;
}

async function onCallback(ctx, cq) {
  ctx.cqMsg = cq.message;
  if (cq.data === 'noop') return tgAnswer(ctx, cq.id);
  const cb = ctx.db.cb;
  if (!cb) return tgAnswer(ctx, cq.id, 'Déjà fait ✔️');
  await tgAnswer(ctx, cq.id);
  const a = cb.action, d = cb.data || {};
  ctx.stage = 'button ' + a;

  // Buttons on briefs / lists (no batch)
  if (['done', 'mv', 'mvo', 'keep'].includes(a)) {
    let label;
    if (a === 'done') { await N(ctx, 'PATCH', `/pages/${d.task_id}`, { properties: { Status: { status: { name: 'Done' } } } }); label = `✔️ ${d.name}`; }
    if (a === 'mv') { await N(ctx, 'PATCH', `/pages/${d.task_id}`, { properties: { 'Due date': { date: { start: d.date } } } }); label = `➡️ ${d.name} → ${fmtDay(d.date)}`; }
    if (a === 'keep') label = `= ${d.name} (inchangée)`;
    if (a === 'mvo') {
      ctx.ops.push({ op: 'state_set', row: { chat_id: +SB.CHAT_ID, awaiting: 'other_date', ref: { task_id: d.task_id, name: d.name } } });
      label = `📅 ${d.name} : réponds avec la date`;
    }
    return T(ctx, 'editMessageReplyMarkup', { chat_id: SB.CHAT_ID, message_id: cq.message.message_id, reply_markup: { inline_keyboard: replaceRows(cq.message.reply_markup, d.rows, clip(label, 60)) } });
  }
  if (a === 'carddel') { ctx.ops.push({ op: 'card_del', card_last4: d.last4 }); ctx.db.card_map = (ctx.db.card_map || []).filter(c => c.card_last4 !== d.last4); return cardsMessage(ctx, cq.message.message_id); }

  const b = rowToBatch(ctx.db.pending);
  if (!b) return;
  ctx.batch = b;
  const L = await lists(ctx);
  const items = b.payload.items, it = d.idx != null ? items[d.idx] : null;
  b.payload.note = null;

  if (a === 'save') {
    const fin = items.filter(i => i.type === 'finance' && i.state === 'pending');
    for (const i of fin) await saveSafely(ctx, L, b, i);
    const cats = fin.filter(i => i.state === 'saved' && i.data.kind === 'expense' && i.data.category).map(i => i.data.category.id);
    if (cats.length) b.payload.budget_lines = await budgetLines(ctx, cats).catch(() => []);
  } else if (a === 'cancel') {
    for (const i of items) if (i.state === 'pending' || i.state === 'needs_type') { i.state = 'cancelled'; flag(ctx, b, { item_idx: i.idx, was_cancelled: true }); }
    b.payload.photo_ask = false;
    if (!items.some(i => i.state === 'saved')) b.status = 'cancelled';
  } else if (a === 'del' && it) {
    it.state = 'deleted'; flag(ctx, b, { item_idx: it.idx, was_cancelled: true });
  } else if (a === 'edit') {
    ctx.ops.push({ op: 'state_set', row: { chat_id: +SB.CHAT_ID, awaiting: 'edit_batch', ref: { pending_id: b.id } } });
    b.payload.note = '✏️ <b>Réponds avec ta correction</b>, ex. « 2: catégorie transport », « c\'était Revolut », « 1: pour mardi ».';
  } else if (a === 'undo') {
    for (const i of items.filter(x => x.state === 'saved')) { await trashItem(ctx, i); i.state = 'undone'; flag(ctx, b, { item_idx: i.idx, was_undone: true }); }
    b.payload.budget_lines = null;
  } else if (a === 'acct' && it) {
    const acc = { id: d.id, name: d.name };
    const targets = d.card ? items.filter(i => i.type === 'finance' && i.state === 'pending' && i.data.card_last4 === d.card && !i.data.account) : [];
    for (const i of [it, ...targets]) { i.data[d.field] = acc; i.uncertain = (i.uncertain || []).filter(f => f !== d.field); const v = validateFinance(ctx, i); i.errors = v.errors; }
    if (d.card && d.field === 'account') {
      ctx.ops.push({ op: 'card_set', row: { card_last4: d.card, account: d.name, account_page_id: d.id } });
      b.payload.note = `💳 Carte ••${d.card} → ${esc(d.name)} mémorisée.`;
    }
  } else if (a === 'type' && it) {
    const src = { ...b.payload.source, file: null };
    const call = rid(6);
    const got = await extractItem(ctx, L, d.type, it.span, src, { batch_id: b.id, input_type: src.input_type, router_type: d.type, router_confidence: 1, _call: call });
    const [first, ...rest] = got.map(g => ({ ...g, span: it.span, _call: call }));
    first.idx = it.idx; items[it.idx] = first;
    addItems(b, rest);
    await finalizeNew(ctx, L, b, [first, ...rest]);
  } else if (a === 'photo') {
    b.payload.photo_ask = false;
    if (d.kind === 'ignore') b.status = 'cancelled';
    else {
      const src = b.payload.source;
      const file = { mime: src.mime, b64: await tgFile(ctx, src.file_id) };
      await processContent(ctx, L, b, file, d.kind);
      return;
    }
  } else if (a === 'goal' && it?.data.goal_suggestion) {
    it.data.goal = it.data.goal_suggestion;
    await N(ctx, 'PATCH', `/pages/${it.notion.id}`, { properties: { Goal: rel(it.data.goal) } });
  } else if (a === 'mktasks' && it && !it.data.tasks_created) {
    const fresh = await extractSpans(ctx, L, b, it.data.suggested_tasks.map(t => ({ type: 'task', text_span: t, confidence: 1 })), { ...b.payload.source, file: null }, null);
    it.data.tasks_created = true;
    await finalizeNew(ctx, L, b, fresh);
  } else if (a === 'expand' && it && !it.data.expanded) {
    await expandIdea(ctx, L, b, it);
  }
  await renderOut(ctx, b, L);
}

// ---------- ✏️ edit replies ----------
const EDITABLE = {
  finance: ['kind', 'title', 'amount', 'date', 'category', 'income_source', 'account', 'from_account', 'to_account'],
  task: ['name', 'due_date', 'priority', 'tags', 'goal'], note: ['name', 'category'], braindump: ['section', 'line'],
};
function editView(it) {
  const d = it.data, v = { n: it.idx + 1, type: it.type, state: it.state };
  if (it.type === 'finance') Object.assign(v, { kind: d.kind, title: d.title, amount: d.amount, date: d.date, category: d.category?.name || d.category_new, income_source: d.income_source, account: d.account?.name, from_account: d.from_account?.name, to_account: d.to_account?.name });
  if (it.type === 'task') Object.assign(v, { name: d.name, due_date: d.due_date, priority: d.priority, tags: d.tags.join(', '), goal: d.goal?.title });
  if (it.type === 'note') Object.assign(v, { name: d.name, category: d.category?.name });
  if (it.type === 'braindump') Object.assign(v, { section: d.section, line: d.line });
  return v;
}
function applyChange(ctx, L, it, field, value) {
  const d = it.data, val = String(value ?? '').trim();
  if (!EDITABLE[it.type]?.includes(field)) return false;
  if (it.type === 'finance') {
    if (field === 'kind') { if (!['expense', 'income', 'transfer'].includes(val)) return false; if (val === 'transfer' && d.account) d.from_account = d.account; d.kind = val; }
    else if (field === 'title') d.title = clip(val, 80);
    else if (field === 'amount') { const n = parseFloat(val.replace(',', '.').replace(/[^\d.]/g, '')); if (!(n > 0)) return false; d.amount = Math.round(n * 100) / 100; }
    else if (field === 'date') { if (!isDate(val)) return false; d.date = val; }
    else if (field === 'category') { const nw = /^NEW:\s*(.+)$/i.exec(val); const c = pickName(L.categories, nw ? nw[1] : val); if (c) { d.category = { id: c.id, name: c.name }; d.category_new = null; } else { d.category = null; d.category_new = clip((nw ? nw[1] : val).trim(), 40); } }
    else if (field === 'income_source') { const s = L.income_sources.find(x => norm(x) === norm(val)); if (!s) return false; d.income_source = s; }
    else { const a = resolveAccount(L, val); if (!a) return false; d[field] = { id: a.id, name: a.name }; }
    it.uncertain = (it.uncertain || []).filter(f => f !== field);
    it.confidence = Math.max(it.confidence, 0.9);
  } else if (it.type === 'task') {
    if (field === 'name') d.name = clip(val, 100);
    else if (field === 'due_date') { if (/^(none|null|)$/i.test(val)) d.due_date = null; else if (isDate(val)) d.due_date = val; else return false; d.priority = priorityFor(today(ctx), d.due_date, d.urgent); }
    else if (field === 'priority') { const p = ['High', 'Medium', 'Low'].find(x => norm(x) === norm(val)); if (!p) return false; d.priority = p; d.priority_reason = 'choisie à la main'; }
    else if (field === 'tags') d.tags = val.split(/[,;]/).map(x => SB.TAGS.find(t => norm(t) === norm(x))).filter(Boolean).slice(0, 2);
    else if (field === 'goal') {
      if (/^(none|null|)$/i.test(val)) d.goal = null;
      else { const g = L.goals.map(g => [g, sim(g.title, val)]).sort((x, y) => y[1] - x[1])[0]; if (!g || g[1] < 0.25) return false; d.goal = { id: g[0].id, title: g[0].title }; }
    }
  } else if (it.type === 'note') {
    if (field === 'name') d.name = clip(val, 100);
    else { const c = pickName(L.notecats, val); if (!c) return false; d.category = { id: c.id, name: c.name }; }
  } else if (it.type === 'braindump') {
    if (field === 'section') { if (!SB.SECTIONS[val]) return false; d.section = val; }
    else d.line = val.split(/\s+/).slice(0, 15).join(' ');
  }
  return true;
}

async function onEditText(ctx, m, st) {
  const b = rowToBatch(ctx.db.pending);
  if (!b) return onContent(ctx, m);
  ctx.batch = b;
  ctx.stage = 'edit';
  const L = await lists(ctx);
  const editable = b.payload.items.filter(i => ['pending', 'saved'].includes(i.state));
  const { out } = await llm(ctx, { kind: 'edit', system: fill(HELPER.edit.system, promptVars(ctx, L)), schema: HELPER.edit.schema,
    parts: [{ text: `Items:\n${JSON.stringify(editable.map(editView))}\n\nCorrection: ${m.text}` }], meta: { batch_id: b.id, input_type: 'text' } });
  const changed = new Map();
  for (const c of out.changes || []) {
    const it = b.payload.items[c.n - 1];
    if (it && editable.includes(it) && applyChange(ctx, L, it, c.field, c.value)) changed.set(it, [...(changed.get(it) || []), c.field]);
  }
  if (!changed.size) {
    ctx.ops.push({ op: 'state_set', row: { chat_id: +SB.CHAT_ID, awaiting: 'edit_batch', ref: { pending_id: b.id } } });
    b.payload.note = '🤔 Je n\'ai pas compris la correction. Réessaie, ex. « 2: montant 12,50 ».';
    await tgReact(ctx, m.message_id, '🤔');
    return renderOut(ctx, b, L);
  }
  for (const [it, fields] of changed) {
    if (it.state === 'pending') { const v = validateFinance(ctx, it); it.errors = v.errors; it.warnings = (it.warnings || []).filter(w => !/devise/.test(w)).concat(v.warnings); }
    else await updateItem(ctx, L, b, it, fields);
    flag(ctx, b, { item_idx: it.idx, was_edited: true, edited_fields: fields });
  }
  b.payload.note = `✏️ Corrigé : ${[...changed].map(([it, f]) => `${it.idx + 1} (${f.join(', ')})`).join(' · ')}`;
  await tgReact(ctx, m.message_id, '👌');
  await renderOut(ctx, b, L);
}

async function onOtherDate(ctx, m, st) {
  ctx.stage = 'other date';
  const L = { categories: [], accounts: [], goals: [], notecats: [], income_sources: [] };
  const { out } = await llm(ctx, { kind: 'date', system: fill(HELPER.date.system, promptVars(ctx, L)), schema: HELPER.date.schema, parts: [{ text: m.text }] });
  if (!isDate(out.due_date)) {
    ctx.ops.push({ op: 'state_set', row: { chat_id: +SB.CHAT_ID, awaiting: 'other_date', ref: st.ref } });
    return tgSend(ctx, `🤔 Pas compris la date pour « ${esc(st.ref.name)} ». Ex. « jeudi », « le 20 », « dans 3 jours ».`, null, { reply_parameters: { message_id: m.message_id } });
  }
  await N(ctx, 'PATCH', `/pages/${st.ref.task_id}`, { properties: { 'Due date': { date: { start: out.due_date } } } });
  return tgSend(ctx, `📅 « ${esc(st.ref.name)} » → ${fmtDay(out.due_date)}`, null, { reply_parameters: { message_id: m.message_id } });
}

// ---------- 🔍 expand ----------
async function expandIdea(ctx, L, b, it) {
  ctx.stage = 'expand';
  const d = it.data;
  const { out } = await llm(ctx, { kind: 'expand', system: HELPER.expand.system, schema: HELPER.expand.schema,
    parts: [{ text: `Idée : ${d.line}\n${d.detail ? 'Détail : ' + d.detail : ''}` }], meta: { batch_id: b.id, item_idx: it.idx } });
  // related: keyword search in Notes/To-Do + all Brain Dump lines, then LLM rerank
  const kw = (out.keywords || []).slice(0, 4);
  const cands = [];
  const searches = await Promise.all(kw.map(k => N(ctx, 'POST', '/search', { query: k, filter: { property: 'object', value: 'page' }, page_size: 10 }).catch(() => ({ results: [] }))));
  for (const p of searches.flatMap(s => s.results)) {
    const ds = p.parent?.data_source_id;
    if ((ds === SB.DS.notes || ds === SB.DS.todo) && !cands.some(c => c.url === p.url)) cands.push({ title: pTitle(p), url: p.url, kind: ds === SB.DS.notes ? 'note' : 'tâche' });
  }
  for (const key of Object.keys(SB.SECTIONS)) for (const x of await bdItems(ctx, key)) if (x.id !== it.notion.id) cands.push({ title: x.text, url: x.url, kind: 'brain dump', score: sim(x.text, d.line + ' ' + kw.join(' ')) });
  const top = cands.sort((x, y) => (y.score ?? 1) - (x.score ?? 1)).slice(0, 15);
  let related = [];
  if (top.length) {
    const r = await llm(ctx, { kind: 'rerank', system: HELPER.rerank.system, schema: HELPER.rerank.schema,
      parts: [{ text: `Idée : ${d.line}\nCandidats :\n${top.map((c, i) => `${i}. [${c.kind}] ${c.title}`).join('\n')}` }], meta: { batch_id: b.id, item_idx: it.idx } });
    related = (r.out.related || []).filter(i => top[i]).slice(0, 3).map(i => top[i]);
  }
  const blocks = [
    para('Problème : ' + out.problem), para('Pourquoi : ' + out.why), para('Angles'),
    ...out.angles.slice(0, 3).map(bullet), para('Risques'), ...out.risks.slice(0, 3).map(bullet),
    para('Prochaine étape : ' + out.next_step),
  ];
  if (related.length) blocks.push(linkPara('Liés : ', related));
  await N(ctx, 'PATCH', `/blocks/${it.notion.id}/children`, { children: blocks });
  d.expanded = `${out.summary} → ${out.next_step}${related.length ? ` (${related.length} lié${related.length > 1 ? 's' : ''})` : ''}`;
}

// ---------- commands ----------
async function onCommand(ctx, m, text) {
  const [cmd0, ...args] = text.split(/\s+/);
  const cmd = cmd0.split('@')[0].toLowerCase();
  ctx.stage = 'command ' + cmd;
  if (cmd === '/start' || cmd === '/help') {
    const msg = await tgSend(ctx, HELP_TEXT);
    const old = ctx.db.config?.help_msg_id;
    if (old) await T(ctx, 'unpinChatMessage', { chat_id: SB.CHAT_ID, message_id: old }).catch(() => null);
    await T(ctx, 'pinChatMessage', { chat_id: SB.CHAT_ID, message_id: msg.message_id, disable_notification: true });
    ctx.ops.push({ op: 'config_set', key: 'help_msg_id', value: msg.message_id });
    return;
  }
  if (cmd === '/today') return tasksMessage(ctx, 'today');
  if (cmd === '/month') return tgSend(ctx, await monthText(ctx));
  if (cmd === '/cards') {
    const mm = /^(\d{4})\s+(.+)$/.exec(args.join(' '));
    if (mm) {
      const a = resolveAccount(await lists(ctx), mm[2]);
      if (!a) return tgSend(ctx, `Compte inconnu : ${esc(mm[2])}`);
      ctx.ops.push({ op: 'card_set', row: { card_last4: mm[1], account: a.name, account_page_id: a.id } });
      ctx.db.card_map = [...(ctx.db.card_map || []).filter(c => c.card_last4 !== mm[1]), { card_last4: mm[1], account: a.name, account_page_id: a.id }];
    }
    return cardsMessage(ctx);
  }
  if (cmd === '/undo') {
    const b = rowToBatch(ctx.db.pending);
    if (!b) return tgSend(ctx, 'Rien à annuler.');
    ctx.batch = b;
    const L = await lists(ctx);
    const saved = b.payload.items.filter(x => x.state === 'saved');
    for (const i of saved) { await trashItem(ctx, i); i.state = 'undone'; flag(ctx, b, { item_idx: i.idx, was_undone: true }); }
    b.payload.budget_lines = null;
    await renderOut(ctx, b, L);
    return tgSend(ctx, `↩️ ${saved.length} élément${saved.length > 1 ? 's' : ''} annulé${saved.length > 1 ? 's' : ''} (corbeille Notion).`, null, { reply_parameters: { message_id: b.telegram_message_id } });
  }
  return tgSend(ctx, 'Commande inconnue. /help');
}

async function cardsMessage(ctx, editId) {
  const cards = (ctx.db.card_map || []).sort((x, y) => x.card_last4.localeCompare(y.card_last4));
  const text = ['💳 <b>Cartes → comptes</b>', ...(cards.length ? cards.map(c => `••${c.card_last4} → ${esc(c.account)}`) : ['(aucune)']), '',
    'Ajouter / changer : <code>/cards 1234 Revolut</code>. Une carte inconnue sur un ticket est demandée une fois puis mémorisée.'].join('\n');
  const kb = cards.map(c => [btn(ctx, `🗑 ••${c.card_last4}`, 'carddel', { last4: c.card_last4 })]);
  return editId ? tgEdit(ctx, editId, text, kb) : tgSend(ctx, text, kb);
}

// ---------- shared task lists (/today, morning, evening) ----------
async function openTasks(ctx, until) {
  const rows = await nQuery(ctx, SB.DS.todo, { filter: { and: [
    { property: 'Status', status: { does_not_equal: 'Done' } }, { property: 'Due date', date: { on_or_before: until } }] },
  sorts: [{ property: 'Due date', direction: 'ascending' }] }, 40);
  return rows.map(p => ({ id: p.id, name: pTitle(p), due: p.properties['Due date']?.date?.start?.slice(0, 10), url: p.url, priority: p.properties.Priority?.select?.name }));
}
function taskLine(ctx, t) {
  const late = t.due ? daysBetween(t.due, today(ctx)) : 0;
  return `• <a href="${esc(t.url)}">${esc(t.name)}</a>${late > 0 ? ` — <i>en retard de ${late} j</i>` : ''}${t.priority === 'High' ? ' 🔥' : ''}`;
}
function taskKb(ctx, tasks, evening) {
  const kb = [];
  const tomorrow = addDays(today(ctx), 1);
  for (const t of tasks.slice(0, evening ? 12 : 25)) {
    const name = clip(t.name, 40);
    if (!evening) { const r = kb.length; kb.push([btn(ctx, `✅ ${name}`, 'done', { task_id: t.id, name, rows: [r] })]); continue; }
    const r = kb.length, rows = [r, r + 1];
    kb.push([btn(ctx, `✅ ${name}`, 'done', { task_id: t.id, name, rows })]);
    kb.push([btn(ctx, '➡️ Demain (suggéré)', 'mv', { task_id: t.id, name, rows, date: tomorrow }), btn(ctx, '📅 Autre date', 'mvo', { task_id: t.id, name, rows }), btn(ctx, '= Garder', 'keep', { task_id: t.id, name, rows })]);
  }
  return kb;
}
async function tasksMessage(ctx) {
  const tasks = await openTasks(ctx, today(ctx));
  if (!tasks.length) return tgSend(ctx, '🎉 Aucune tâche pour aujourd\'hui ni en retard.');
  return tgSend(ctx, [`📋 <b>Aujourd'hui + en retard</b> (${tasks.length})`, ...tasks.map(t => taskLine(ctx, t))].join('\n'), taskKb(ctx, tasks, false));
}

async function monthText(ctx) {
  const t = today(ctx), start = t.slice(0, 8) + '01';
  const L = await lists(ctx, true);
  const [exp, inc] = await Promise.all([
    nQuery(ctx, SB.DS.expenses, { filter: { property: 'Date', date: { on_or_after: start } } }, 500),
    nQuery(ctx, SB.DS.incomes, { filter: { property: 'Date', date: { on_or_after: start } } }, 500)]);
  const sum = rows => rows.reduce((s, p) => s + (p.properties.Amount?.number || 0), 0);
  const out = sum(exp), inn = sum(inc);
  const lines = [`📅 <b>${t.slice(0, 7)}</b> — dépenses ${eur(out)} · revenus ${eur(inn)} · net ${eur(inn - out)}`, ''];
  for (const c of L.categories.sort((x, y) => y.spent - x.spent)) {
    if (!c.budget) { if (c.spent) lines.push(`${esc(c.name)} : ${eur(c.spent)} (pas de budget)`); continue; }
    const pct = Math.round((c.spent / c.budget) * 100);
    lines.push(`${pct >= 100 ? '🚨' : pct >= 80 ? '⚠️' : '•'} ${esc(c.name)} : ${eur(c.spent).replace(' €', '')}/${eur(c.budget)} (${pct}%)`);
  }
  return lines.join('\n');
}

async function mainEngine(ctx, prep) {
  const u = prep.update;
  if (u.callback_query) return onCallback(ctx, u.callback_query);
  const m = u.message;
  const text = (m.text || '').trim();
  if (text.startsWith('/')) return onCommand(ctx, m, text);
  const st = ctx.db.state;
  if (st?.awaiting === 'edit_batch' && m.text) return onEditText(ctx, m, st);
  if (st?.awaiting === 'other_date' && m.text) return onOtherDate(ctx, m, st);
  return onContent(ctx, m);
}

// ---------- ops for brain.apply ----------
function finish(ctx) {
  const ops = [];
  const batches = [...(ctx.batches || [])];
  if (ctx.batch && !batches.includes(ctx.batch)) batches.push(ctx.batch);
  for (const b of batches) {
    ops.push({ op: 'pending', row: { id: b.id, chat_id: b.chat_id, type: b.type, payload: b.payload, telegram_message_id: b.telegram_message_id,
      status: b.status, attempts: b.attempts, last_error: b.last_error, reminded_at: b.reminded_at, saved_at: b.saved_at } });
  }
  ops.push(...ctx.ops);
  if (ctx.callbacks.length) ops.push({ op: 'callbacks', rows: ctx.callbacks });
  // one log row per extracted item; tokens stay on the first item of each LLM call
  const known = new Set(batches.map(b => b.id));
  const rows = [];
  for (const l of ctx.logs) {
    const { _call, ...row } = l;
    if (row.batch_id && !known.has(row.batch_id)) row.batch_id = null;
    if (!_call) { rows.push(row); continue; }
    const its = batches.flatMap(b => b.payload.items).filter(i => i._call === _call);
    if (!its.length) { rows.push(row); continue; }
    its.forEach((it, k) => rows.push({ ...row, item_idx: it.idx, confidence: it.confidence, extractor_type: it.type,
      ...(k ? { tokens_in: 0, tokens_out: 0, cost_eur: 0, latency_ms: 0 } : {}) }));
  }
  for (const b of batches) for (const i of b.payload.items) delete i._call;
  if (rows.length) ops.push({ op: 'log', rows });
  ops.push(...(ctx.flags || []));
  return ops;
}
