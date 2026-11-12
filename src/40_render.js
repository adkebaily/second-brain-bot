// ===== Batch recap message + keyboard (one message per batch, edited in place) =====

const KIND_EMOJI = { expense: '🔴', income: '🟢', transfer: '🔁' };
const live = it => !['deleted', 'cancelled', 'undone'].includes(it.state);
const pendingFinance = b => b.payload.items.filter(i => i.type === 'finance' && i.state === 'pending');

function fieldTxt(it, field, text) {
  return it.uncertain?.includes(field) ? `<b>${text}?</b>` : text;
}

const PRIO = { High: '🔥', Medium: '🔸', Low: '▫️' };
const META = '      ';
// 10-cell bar for budgets: ▰▰▰▰▰▰▰▱▱▱
const bar = pct => '▰'.repeat(Math.min(10, Math.round(pct / 10))) + '▱'.repeat(10 - Math.min(10, Math.round(pct / 10)));

function itemLines(it, multi) {
  const d = it.data, out = [];
  const n = multi ? `${it.idx + 1}. ` : '';
  const title = t => (it.state === 'saved' && it.notion ? `<a href="${esc(it.notion.url)}">${t}</a>` : t);
  const strike = s => (live(it) ? s : `<s>${s}</s>`);
  if (it.state === 'needs_type') {
    out.push(`${n}❓ « ${esc(clip(it.span, 80))} »`, `${META}c'est quoi ? choisis ci-dessous`);
    return out;
  }
  if (it.type === 'finance') {
    const where = d.kind === 'transfer'
      ? `${d.from_account ? esc(d.from_account.name) : '<b>compte source ?</b>'} → ${d.to_account ? esc(d.to_account.name) : '<b>compte cible ?</b>'}`
      : (d.account ? fieldTxt(it, 'account', esc(d.account.name)) : `<b>compte ?</b>${d.card_last4 ? ` (carte ••${d.card_last4})` : ''}`);
    const cat = d.kind === 'expense' ? (d.category ? fieldTxt(it, 'category', esc(d.category.name)) : d.category_new ? `🆕 <b>${esc(d.category_new)}</b> (nouvelle)` : '<b>catégorie ?</b>')
      : d.kind === 'income' ? (d.income_source ? esc(d.income_source) : '<b>source ?</b>') : 'virement';
    const sure = it.confidence >= 0.8 && !it.uncertain?.length ? '' : ' ⚠️';
    out.push(strike(`${n}${KIND_EMOJI[d.kind]} ${title(`<b>${esc(d.title)}</b>`)}   <b>${fieldTxt(it, 'amount', eur(d.amount))}</b>${d.currency !== 'EUR' ? ' ' + esc(d.currency) : ''}${sure}`));
    out.push(strike(`${META}🏷 ${cat}  ·  💳 ${where}  ·  📅 ${fieldTxt(it, 'date', fmtDay(d.date))}`));
    for (const l of d.lines.slice(0, 8)) out.push(`${META}   ‣ ${esc(clip(l.name, 40))}  ${eur(l.price)}`);
    if (d.lines.length > 8) out.push(`${META}   ‣ … +${d.lines.length - 8} articles`);
  } else if (it.type === 'task') {
    out.push(strike(`${n}☑️ ${title(`<b>${esc(d.name)}</b>`)}`));
    const meta = [`📅 ${d.due_date ? fmtDay(d.due_date) : 'sans date'}`, `${PRIO[d.priority] || ''} ${d.priority}`];
    if (d.tags.length) meta.push(`🏷 ${esc(d.tags.join(', '))}`);
    if (d.goal) meta.push(`🎯 ${esc(clip(d.goal.title, 40))}`);
    out.push(strike(META + meta.join('  ·  ')));
    if (d.priority_reason && live(it)) out.push(`${META}<i>${esc(d.priority_reason)}</i>`);
  } else if (it.type === 'note') {
    out.push(strike(`${n}📝 ${title(`<b>${esc(d.name)}</b>`)}`), strike(`${META}📂 ${esc(d.category?.name || '?')}`));
    if (d.suggested_tasks.length && !d.tasks_created && live(it)) for (const t of d.suggested_tasks) out.push(`${META}☐ ${esc(t)}`);
  } else if (it.type === 'braindump') {
    out.push(strike(`${n}💭 ${title(`<i>« ${esc(d.line)} »</i>`)}`), strike(`${META}${SB.SECTIONS[d.section]}`));
    if (d.expanded) out.push(`${META}🔍 ${esc(d.expanded)}`);
  }
  if (it.state === 'failed') out.push(`${META}⏳ Notion indisponible, nouvel essai automatique`);
  if (it.state === 'undone') out.push(`${META}↩️ annulé (corbeille Notion)`);
  for (const e of it.errors || []) if (live(it)) out.push(`${META}❌ ${esc(e)}`);
  for (const w of it.warnings || []) if (live(it)) out.push(`${META}⚠️ ${esc(w)}`);
  return out;
}

function renderBatch(ctx, b, L) {
  const p = b.payload, items = p.items, pid = b.id;
  const fin = pendingFinance(b);
  const lines = [];
  if (b.status === 'open' && fin.length) lines.push('🧾 <b>À CONFIRMER</b>', '<i>Rien n\'est enregistré avant ✅</i>');
  else if (b.status === 'cancelled') lines.push('❌ <b>ANNULÉ</b>');
  else if (b.status === 'expired') lines.push('⌛ <b>EXPIRÉ</b>', '<i>Annulé après 48 h sans réponse</i>');
  else if (b.status === 'undone') lines.push('↩️ <b>ANNULÉ</b>', '<i>Pages mises à la corbeille Notion</i>');
  else if (b.status === 'retrying') lines.push('⏳ <b>ENREGISTREMENT PARTIEL</b>', '<i>Notion ne répond pas, je réessaie</i>');
  else lines.push('✅ <b>ENREGISTRÉ</b>');
  if (p.source?.transcript) lines.push('', `🎙 <i>${esc(clip(p.source.transcript, 300))}</i>`);
  for (const it of items) lines.push('', ...itemLines(it, items.length > 1));
  if (p.budget_lines?.length) lines.push('', '━━━━━━━━━━━━', '📊 <b>Budgets du mois</b>', ...p.budget_lines);
  if (p.note) lines.push('', p.note);

  const kb = [];
  if (['cancelled', 'expired', 'undone'].includes(b.status)) return { text: lines.join('\n'), kb };

  const nt = items.find(i => i.state === 'needs_type');
  if (nt) kb.push([['💸 Finance', 'finance'], ['✅ Tâche', 'task'], ['📝 Note', 'note'], ['💭 Idée', 'braindump']].map(([t, v]) => btn(ctx, t, 'type', { idx: nt.idx, type: v }, pid)));
  if (p.photo_ask) kb.push([['🧾 Reçu', 'receipt'], ['📝 Note', 'note'], ['🚫 Ignorer', 'ignore']].map(([t, v]) => btn(ctx, t, 'photo', { kind: v }, pid)));

  if (b.status === 'open' && fin.length) {
    const missing = fin.find(i => needsAccount(i.data));
    if (missing && L) {
      const field = needsAccount(missing.data);
      const label = { account: 'Compte', from_account: 'Depuis', to_account: 'Vers' }[field];
      kb.push([{ text: `${label} pour la ligne ${missing.idx + 1} ⤵`, callback_data: 'noop' }]);
      const accBtns = L.accounts.map(a => btn(ctx, a.name, 'acct', { idx: missing.idx, field, id: a.id, name: a.name, card: missing.data.card_last4 }, pid));
      for (let i = 0; i < accBtns.length; i += 3) kb.push(accBtns.slice(i, i + 3));
    }
    const blocked = fin.some(i => i.errors?.length || needsAccount(i.data));
    kb.push([
      ...(blocked ? [] : [btn(ctx, '✅ Tout enregistrer', 'save', {}, pid)]),
      btn(ctx, '✏️ Modifier', 'edit', {}, pid, true), btn(ctx, '❌ Annuler', 'cancel', {}, pid)]);
    if (fin.length > 1) kb.push(fin.map(i => btn(ctx, `🗑 ${i.idx + 1}`, 'del', { idx: i.idx }, pid)));
  }
  const saved = items.filter(i => i.state === 'saved');
  for (const it of saved) {
    if (it.type === 'task' && it.data.goal_suggestion && !it.data.goal) kb.push([btn(ctx, `🎯 ${it.idx + 1} → ${clip(it.data.goal_suggestion.title, 40)}`, 'goal', { idx: it.idx }, pid)]);
    if (it.type === 'note' && it.data.suggested_tasks.length && !it.data.tasks_created) kb.push([btn(ctx, `➕ Créer ${it.data.suggested_tasks.length} tâche${it.data.suggested_tasks.length > 1 ? 's' : ''}`, 'mktasks', { idx: it.idx }, pid)]);
    if (it.type === 'braindump' && !it.data.expanded) kb.push([btn(ctx, `🔍 Développer ${it.idx + 1}`, 'expand', { idx: it.idx }, pid)]);
  }
  if (saved.length || items.some(i => i.state === 'failed')) {
    const row = [];
    if (!(b.status === 'open' && fin.length)) row.push(btn(ctx, '✏️ Modifier', 'edit', {}, pid, true));
    if (saved.length) row.push(btn(ctx, '↩️ Défaire', 'undo', {}, pid));
    kb.push(row);
  }
  return { text: lines.join('\n'), kb };
}

const HELP_TEXT = [
  '🧠 <b>Second Brain</b>',
  'Envoie du texte, un vocal, une photo de ticket, de notes ou un PDF. Plusieurs choses dans un message ? Je sépare tout seul.',
  '',
  '<b>Raccourcis</b> (pas de tri automatique)',
  '<code>$</code> finance — <i>$ 12,50 courses Lidl revolut</i>',
  '<code>!</code> tâche — <i>! appeler la CAF avant vendredi</i>',
  '<code>#</code> note — <i># SED : un système à événements discrets…</i>',
  '<code>?</code> brain dump — <i>? pourquoi les LLM hallucinent ?</i>',
  '<code>@</code> discuter — <i>@ j\'hésite entre deux stages</i>',
  '',
  '<b>Discuter</b>',
  'Pose une question sur tes données (« combien en resto ce mois ? », « mes tâches de la semaine ») ou réfléchis à voix haute : je réponds court, une question à la fois, puis je propose quoi enregistrer. La conversation se ferme seule après 30 min ou 6 échanges.',
  '',
  '<b>Commandes</b>',
  '/today — tâches du jour + en retard',
  '/month — dépenses du mois vs budgets',
  '/undo — annuler le dernier enregistrement',
  '/cards — cartes → comptes (<code>/cards 1234 Revolut</code>)',
  '/help — ce message',
  '',
  '<b>Boutons</b>',
  '✅ enregistrer · ✏️ corriger (réponds en texte, ex. « 2: catégorie transport ») · ❌ annuler · 🗑 supprimer une ligne',
  '↩️ défaire (corbeille Notion) · 🎯 lier à un objectif · ➕ créer les tâches d\'une note · 🔍 développer une idée',
  '➡️ reporter à demain · 📅 autre date · = garder',
  '',
  'Finance : rien n\'est écrit avant ✅. Tâches, notes et idées sont enregistrées tout de suite.',
  'Briefs : 08:00 matin · 21:00 soir · dimanche 20:00 bilan.',
].join('\n');
