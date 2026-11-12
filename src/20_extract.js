// ===== Router, extractors, post-processing, validation =====

const PREFIX = { $: 'finance', '!': 'task', '#': 'note', '?': 'braindump', '@': 'chat' };
const ACCOUNT_ALIASES = [
  [/esp[eè]ces|cash|liquide/i, 'Cash Wallet'],
  [/[ée]pargne|savings|binance/i, 'Savings Account'],
];

async function route(ctx, text, meta = {}) {
  const m = /^\s*([$!#?@])\s*/.exec(text);
  if (m) return { prefix: m[1], items: [{ type: PREFIX[m[1]], text_span: text.slice(m[0].length).trim(), confidence: 1 }] };
  const { out } = await llm(ctx, { kind: 'router', system: PROMPTS.router.system, schema: PROMPTS.router.schema, parts: [{ text }], meta });
  const items = (out.items || []).filter(i => i.text_span && i.text_span.trim());
  return { prefix: null, items: items.length ? items : [{ type: 'braindump', text_span: text, confidence: 0.3 }] };
}

const pickName = (list, name) => {
  if (!name) return null;
  const n = norm(name);
  return list.find(x => norm(x.name) === n) || list.find(x => norm(x.name).includes(n) || n.includes(norm(x.name))) || null;
};
function resolveAccount(L, name) {
  if (!name) return null;
  const hit = pickName(L.accounts, name);
  if (hit) return hit;
  for (const [re, target] of ACCOUNT_ALIASES) if (re.test(name)) return pickName(L.accounts, target);
  return null;
}

// ---------- finance ----------
async function extractFinance(ctx, L, { text, file, messageDate, meta }) {
  const parts = [];
  if (file) parts.push(media(file.mime, file.b64));
  parts.push({ text: text || '(receipt attached)' });
  const { out } = await llm(ctx, {
    kind: 'finance', system: fill(PROMPTS.finance.system, promptVars(ctx, L, messageDate)), schema: PROMPTS.finance.schema, parts,
    models: file ? SB.MODELS.vision : SB.MODELS.text, think: file ? 'low' : 'minimal', meta,
  });
  return out;
}

function postFinance(ctx, L, out, src) {
  const txns = out.transactions || [];
  const items = txns.map(t => {
    const d = {
      kind: t.kind, title: clip(t.title || t.merchant || 'Dépense', 80), amount: Math.round((+t.amount || 0) * 100) / 100,
      currency: (t.currency || 'EUR').toUpperCase(), date: isDate(t.date) ? t.date : src.messageDate, merchant: t.merchant || null,
      lines: (t.items || []).map(x => ({ name: x.name, price: +x.price || 0 })), rationale: t.rationale || '',
      category: null, category_new: null, income_source: null, account: null, from_account: null, to_account: null,
      card_last4: /^\d{4}$/.test(t.card_last4 || '') ? t.card_last4 : null, payment_method: t.payment_method || null,
    };
    const uncertain = new Set(t.uncertain_fields || []);
    if (d.kind === 'expense') {
      const nw = /^NEW:\s*(.+)$/i.exec(t.category || '');
      const c = nw ? pickName(L.categories, nw[1]) : pickName(L.categories, t.category);
      if (c) d.category = { id: c.id, name: c.name };
      else if (nw) d.category_new = clip(nw[1].trim(), 40);
      else uncertain.add('category');
    }
    if (d.kind === 'income') d.income_source = L.income_sources.includes(t.income_source) ? t.income_source : (/refund|rembours/i.test(t.title) ? 'Refund' : null);
    const acc = n => { const a = resolveAccount(L, n); return a ? { id: a.id, name: a.name } : null; };
    if (d.kind === 'transfer') { d.from_account = acc(t.from_account); d.to_account = acc(t.to_account); }
    else {
      d.account = acc(t.account) || (d.payment_method === 'cash' ? acc('Cash Wallet') : null);
      if (!d.account && d.card_last4) {
        const m = (ctx.db.card_map || []).find(c => c.card_last4 === d.card_last4);
        if (m && L.accounts.some(a => a.id === m.account_page_id)) d.account = { id: m.account_page_id, name: m.account };
      }
    }
    return { type: 'finance', data: d, confidence: Math.max(0, Math.min(1, +t.confidence || 0.5)), uncertain: [...uncertain], warnings: [] };
  });
  if (out.receipt_total != null && items.length) {
    const sum = items.reduce((s, i) => s + i.data.amount, 0);
    if (Math.abs(sum - out.receipt_total) > 0.05) {
      for (const i of items) { i.confidence = Math.min(i.confidence, 0.5); i.uncertain = [...new Set([...i.uncertain, 'amount'])]; }
      items[0].warnings.push(`Total des lignes ${eur(sum)} ≠ total du ticket ${eur(out.receipt_total)}`);
    }
  }
  return items;
}

// Blocking errors (no ✅ button until fixed) and warnings, per finance line.
function validateFinance(ctx, it) {
  const d = it.data, t = today(ctx), errors = [], warnings = [];
  if (!(d.amount > 0)) errors.push('montant invalide');
  if (!isDate(d.date)) errors.push('date invalide');
  else {
    if (daysBetween(t, d.date) > 1) errors.push('date dans le futur');
    if (daysBetween(d.date, t) > 365) errors.push('date de plus d\'un an');
  }
  if (d.currency !== 'EUR') warnings.push(`devise ${d.currency} : montant non converti`);
  if (d.kind === 'expense' && !d.category && !d.category_new) errors.push('catégorie manquante');
  if (d.kind === 'transfer' && d.from_account && d.to_account && d.from_account.id === d.to_account.id) errors.push('virement vers le même compte');
  return { errors, warnings };
}
const needsAccount = d => (d.kind === 'transfer' ? (!d.from_account ? 'from_account' : !d.to_account ? 'to_account' : null) : (!d.account ? 'account' : null));

// ---------- task ----------
async function extractTask(ctx, L, { text, meta }) {
  const { out } = await llm(ctx, { kind: 'task', system: fill(PROMPTS.task.system, promptVars(ctx, L)), schema: PROMPTS.task.schema, parts: [{ text }], meta });
  return out;
}
function priorityFor(t, due, urgent) {
  const d = due ? daysBetween(t, due) : null;
  if (urgent || (d !== null && d <= 2)) return 'High';
  if (d !== null && d <= 7) return 'Medium';
  return 'Low';
}
function postTask(ctx, L, out) {
  const t = today(ctx), warnings = [];
  let due = isDate(out.due_date) ? out.due_date : null;
  if (due && due < t && !out.due_is_past_ok) { warnings.push(`date passée (${fmtDay(due)}) ignorée`); due = null; }
  const g = Number.isInteger(out.goal_index) ? L.goals[out.goal_index] : null;
  const conf = +out.goal_confidence || 0;
  const d = {
    name: clip(out.name || 'Tâche', 100), due_date: due, urgent: !!out.urgent,
    priority: priorityFor(t, due, out.urgent), priority_reason: out.priority_reason || '',
    tags: [...new Set((out.tags || []).filter(x => SB.TAGS.includes(x)))].slice(0, 2),
    goal: g && conf >= 0.7 ? { id: g.id, title: g.title } : null,
    goal_suggestion: g && conf < 0.7 && conf >= 0.3 ? { id: g.id, title: g.title } : null,
  };
  return { type: 'task', data: d, confidence: 0.9, warnings, uncertain: [] };
}

// ---------- note ----------
async function extractNote(ctx, L, { text, file, meta }) {
  const schema = JSON.parse(JSON.stringify(PROMPTS.note.schema));
  schema.properties.category.enum = L.notecats.map(c => c.name);
  const parts = [];
  if (file) parts.push(media(file.mime, file.b64));
  parts.push({ text: text || '(photo of notes attached)' });
  const { out } = await llm(ctx, {
    kind: 'note', system: fill(PROMPTS.note.system, promptVars(ctx, L)), schema, parts,
    models: file ? SB.MODELS.vision : SB.MODELS.text, think: file ? 'low' : 'minimal', meta,
  });
  return out;
}
function postNote(ctx, L, out, src) {
  const c = pickName(L.notecats, out.category) || pickName(L.notecats, 'Personal');
  return {
    type: 'note', confidence: 0.9, warnings: [], uncertain: [],
    data: {
      name: clip(out.name || 'Note', 100), category: c ? { id: c.id, name: c.name } : null,
      body: out.cleaned_markdown || src.text, raw: src.file ? (out.raw_text || '') : (src.raw || src.text),
      suggested_tasks: (out.suggested_tasks || []).slice(0, 5), tasks_created: false, learning: !!out.learning,
    },
  };
}

// ---------- brain dump ----------
async function extractBraindump(ctx, L, { text, meta }) {
  const { out } = await llm(ctx, { kind: 'braindump', system: PROMPTS.braindump.system, schema: PROMPTS.braindump.schema, parts: [{ text }], meta });
  return out;
}
function postBraindump(ctx, out, src) {
  const words = String(out.line || src.text).trim().split(/\s+/);
  return {
    type: 'braindump', confidence: 0.9, warnings: [], uncertain: [],
    data: { section: SB.SECTIONS[out.section] ? out.section : 'personal', line: words.slice(0, 15).join(' '), detail: out.detail || '', expanded: null, learning: !!out.learning },
  };
}

// Runs the right extractor for one routed span; returns 1..n batch items.
async function extractItem(ctx, L, type, span, src, meta) {
  if (type === 'finance') return postFinance(ctx, L, await extractFinance(ctx, L, { text: span, file: src.file, messageDate: src.messageDate, meta }), src);
  if (type === 'task') return [postTask(ctx, L, await extractTask(ctx, L, { text: span, meta }))];
  if (type === 'note') return [postNote(ctx, L, await extractNote(ctx, L, { text: span, file: src.file, meta }), { ...src, text: span })];
  return [postBraindump(ctx, await extractBraindump(ctx, L, { text: span, meta }), { text: span })];
}

// ---------- duplicate check (warnings only; never blocks) ----------
async function dupWarning(ctx, it) {
  try {
    const d = it.data;
    if (it.type === 'finance') {
      const ds = { expense: SB.DS.expenses, income: SB.DS.incomes, transfer: SB.DS.transfers }[d.kind];
      if (!isDate(d.date)) return null;
      const rows = await nQuery(ctx, ds, { filter: { and: [
        { property: 'Date', date: { on_or_after: addDays(d.date, -3) } }, { property: 'Date', date: { on_or_before: addDays(d.date, 3) } },
        { property: 'Amount', number: { equals: d.amount } }] } }, 50);
      const hit = rows.find(p => sim(pTitle(p), d.title) >= 0.5 || p.properties.Date?.date?.start === d.date);
      return hit ? `doublon possible : « ${pTitle(hit)} » ${eur(d.amount)} le ${fmtDay(hit.properties.Date?.date?.start)}` : null;
    }
    if (it.type === 'task') {
      const rows = await nQuery(ctx, SB.DS.todo, { filter: { property: 'Status', status: { does_not_equal: 'Done' } }, sorts: [{ timestamp: 'created_time', direction: 'descending' }] }, 200);
      const hit = rows.find(p => sim(pTitle(p), d.name) >= 0.6);
      return hit ? `tâche similaire déjà ouverte : « ${pTitle(hit)} »` : null;
    }
    if (it.type === 'note') {
      const rows = await nQuery(ctx, SB.DS.notes, { filter: { timestamp: 'created_time', created_time: { on_or_after: addDays(today(ctx), -60) } } }, 200);
      const hit = rows.find(p => sim(pTitle(p), d.name) >= 0.6);
      return hit ? `note similaire : « ${pTitle(hit)} »` : null;
    }
    if (it.type === 'braindump') {
      const hit = (await bdItems(ctx, d.section)).find(b => sim(b.text, d.line) >= 0.6);
      return hit ? `déjà dans ${SB.SECTIONS[d.section]} : « ${clip(hit.text, 60)} »` : null;
    }
  } catch (e) { return null; }
  return null;
}
