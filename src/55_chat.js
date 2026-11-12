// ===== Conversation: ask my data · thinking partner · clarify before saving =====
// State = chat_state row awaiting 'chat', ref {turns:[{who,text}], pending_id?, clarify?:{idx}}; brain.load drops it after 30 min.

const CHAT_MAX_TURNS = 6; // user messages per conversation, then the bot wraps up
const CHAT_TYPE_EMOJI = { task: '✅', note: '📝', braindump: '💭' };
const chatStateOp = ref => ({ op: 'state_set', row: { chat_id: +SB.CHAT_ID, awaiting: 'chat', ref } });

// The ❓ question pending on an unclear item, if that item is still waiting for its type.
function clarifyTarget(ctx, ref) {
  const b = ref?.clarify && rowToBatch(ctx.db.pending);
  const it = b?.payload.items[ref.clarify.idx];
  return it?.state === 'needs_type' && b.status === 'open' ? { b, it } : null;
}

function chatBaseData(L) {
  const cats = L.categories.filter(c => c.budget || c.spent).map(c => `${c.name} ${eur(c.spent)}${c.budget ? ' / ' + eur(c.budget) : ' (pas de budget)'}`);
  return [`Budgets ce mois : ${cats.join(' · ') || 'aucune dépense'}`, `Objectifs actifs : ${L.goals.map(g => g.title).join(' · ') || 'aucun'}`].join('\n');
}

async function pageText(ctx, id) {
  const r = await N(ctx, 'GET', `/blocks/${id}/children?page_size=50`).catch(() => ({ results: [] }));
  return clip(r.results.map(b => plain(b[b.type]?.rich_text)).filter(Boolean).join('\n'), 1200);
}

async function chatLookups(ctx, L, lookups) {
  const t = today(ctx), out = [];
  for (const q of (lookups || []).slice(0, 3)) {
    if (q.kind === 'tasks') {
      const to = isDate(q.to) ? q.to : addDays(t, 7);
      const ts = await openTasks(ctx, to);
      out.push(`Tâches ouvertes jusqu'au ${to} (${ts.length}) :\n` + ts.map(x => `- ${x.name} · ${x.due || 'sans date'}${x.priority ? ' · ' + x.priority : ''}`).join('\n'));
    } else if (q.kind === 'expenses' || q.kind === 'incomes') {
      const from = isDate(q.from) ? q.from : t.slice(0, 8) + '01', to = isDate(q.to) ? q.to : t;
      const and = [{ property: 'Date', date: { on_or_after: from } }, { property: 'Date', date: { on_or_before: to } }];
      const cat = q.kind === 'expenses' ? pickName(L.categories, q.category) : null;
      if (cat) and.push({ property: 'Category', relation: { contains: cat.id } });
      const rows = await nQuery(ctx, q.kind === 'expenses' ? SB.DS.expenses : SB.DS.incomes, { filter: { and }, sorts: [{ property: 'Date', direction: 'descending' }] }, 300);
      const catName = id => L.categories.find(c => c.id === id)?.name || '';
      const total = rows.reduce((s, p) => s + (p.properties.Amount?.number || 0), 0);
      out.push(`${q.kind === 'expenses' ? 'Dépenses' : 'Revenus'} du ${from} au ${to}${cat ? ' · ' + cat.name : ''} : ${rows.length} lignes, total ${eur(total)}\n` +
        rows.slice(0, 40).map(p => `- ${p.properties.Date?.date?.start?.slice(0, 10)} · ${pTitle(p)} · ${eur(p.properties.Amount?.number || 0)}${q.kind === 'expenses' ? ' · ' + catName(p.properties.Category?.relation?.[0]?.id) : ''}`).join('\n'));
    } else if (q.kind === 'search' && q.query) {
      const words = norm(q.query).split(' ').filter(w => w.length >= 3).slice(0, 4);
      const found = await Promise.all(words.map(w => N(ctx, 'POST', '/search', { query: w, filter: { property: 'object', value: 'page' }, page_size: 10 }).catch(() => ({ results: [] }))));
      const pages = [];
      for (const p of found.flatMap(r => r.results)) if ([SB.DS.notes, SB.DS.todo].includes(p.parent?.data_source_id) && !pages.some(x => x.id === p.id)) pages.push(p);
      const bodies = await Promise.all(pages.slice(0, 3).map(p => p.parent.data_source_id === SB.DS.notes ? pageText(ctx, p.id) : ''));
      const bd = (await Promise.all(Object.keys(SB.SECTIONS).map(k => bdItems(ctx, k).catch(() => [])))).flat()
        .filter(x => words.some(w => norm(x.text).includes(w))).slice(0, 8);
      const hits = [
        ...pages.slice(0, 6).map((p, i) => `- [${p.parent.data_source_id === SB.DS.notes ? 'note' : 'tâche'}] ${pTitle(p)}${bodies[i] ? '\n  ' + bodies[i].replace(/\n/g, '\n  ') : ''}`),
        ...bd.map(x => `- [brain dump] ${x.text}`)];
      out.push(`Recherche « ${q.query} » :\n${hits.join('\n') || '(rien trouvé)'}`);
    }
  }
  return out.join('\n\n');
}

// One conversation turn. st = live chat state or null (new conversation). phId = message to edit, else a new one is sent.
// Returns {capture:true} when the message is new content to save instead (the caller captures it).
async function chatTurn(ctx, L, text, st, phId) {
  ctx.stage = 'chat';
  const ref = st?.ref || {};
  const clar = clarifyTarget(ctx, ref);
  const turns = [...(ref.turns || []), { who: 'Moi', text: clip(text, 1500) }];
  const wrap = turns.filter(x => x.who === 'Moi').length >= CHAT_MAX_TURNS;
  const system = fill(PROMPTS.chat.system, promptVars(ctx, L));
  let data = chatBaseData(L), looked = false, out;
  for (;;) {
    const prompt = [
      turns.length > 1 && 'Conversation :\n' + turns.slice(0, -1).map(x => `${x.who} : ${x.text}`).join('\n'),
      'DATA :\n' + data,
      clar && `CLARIFY : « ${clar.it.span} »`,
      wrap && 'WRAP UP : dernier échange, termine (action end) avec conclusion + prochaine étape.',
      looked && 'Les lookups sont faits : n\'en demande plus.',
      'Nouveau message : ' + text].filter(Boolean).join('\n\n');
    ({ out } = await llm(ctx, { kind: 'chat', system, schema: PROMPTS.chat.schema, parts: [{ text: prompt }], think: 'low' }));
    if (looked || !out.lookups?.length) break;
    ctx.stage = 'chat lookup';
    data += '\n\n' + await chatLookups(ctx, L, out.lookups);
    looked = true; // max one lookup round: 2 LLM calls per turn at most
  }
  if (out.action === 'capture' && !(clar && out.resolved_type !== 'none')) return { capture: true };

  let reply = clip((out.reply || '').trim(), 700);
  if (clar && ['finance', 'task', 'note', 'braindump'].includes(out.resolved_type)) {
    ctx.batch = clar.b;
    await retype(ctx, L, clar.b, clar.it, out.resolved_type, `${clar.it.span}\n${text}`);
    await renderOut(ctx, clar.b, L);
    ctx.batch = null;
    out.action = 'end';
    reply = reply || '👌';
  }
  const props = out.action !== 'end' ? [] : (out.proposals || []).map(p => ({ ...p, text: (p.text || '').replace(/^\s*[$!#?@]\s*/, '').trim() }))
    .filter(p => CHAT_TYPE_EMOJI[p.type] && p.text).slice(0, 3); // buttons only when closing: no noise mid-talk
  const kb = props.map((p, r) => [btn(ctx, clip(`${CHAT_TYPE_EMOJI[p.type]} ${p.text}`, 60), 'chatsave', { type: p.type, text: clip(p.text, 300), rows: [r] })]);
  const html = esc(reply || '🤔') + (props.length ? '\n\n<i>Enregistrer ?</i>' : '');
  if (phId) await tgEdit(ctx, phId, html, kb); else await tgSend(ctx, html, kb);
  if (out.action !== 'end' && !wrap) {
    ctx.ops.push(chatStateOp({ turns: [...turns, { who: 'Bot', text: reply }].slice(-2 * CHAT_MAX_TURNS),
      ...(clar ? { pending_id: clar.b.id, clarify: ref.clarify } : {}) }));
  }
  return { capture: false };
}

// Tap on a proposal button: capture it like a prefixed message, in a new recap under the conversation.
async function chatSave(ctx, cq, d) {
  await T(ctx, 'editMessageReplyMarkup', { chat_id: SB.CHAT_ID, message_id: cq.message.message_id,
    reply_markup: { inline_keyboard: replaceRows(cq.message.reply_markup, d.rows, clip('✔️ ' + d.text, 60)) } });
  const ph = await tgSend(ctx, '⏳', null, { reply_parameters: { message_id: cq.message.message_id } });
  const t = paris(ctx.now);
  const b = newBatch(ph.message_id, { input_type: 'text', text: d.text, message_date: t.date, message_time: t.time, messageDate: t.date });
  ctx.batch = b;
  const L = await lists(ctx);
  const fresh = await extractSpans(ctx, L, b, [{ type: d.type, text_span: d.text, confidence: 1 }], b.payload.source, null);
  await finalizeNew(ctx, L, b, fresh);
  await renderOut(ctx, b, L);
}
