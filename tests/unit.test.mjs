// Offline tests for the deterministic parts of the bot. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
const lib = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort().map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const S = vm.createContext({ Buffer, setTimeout, Intl, console, Date, Math, JSON });
vm.runInContext(lib + '\nthis.X = { SB, paris, addDays, fmtDay, calendar, priorityFor, postFinance, validateFinance, needsAccount, postTask, postBraindump, applyChange, renderBatch, finish, makeCtx, prepare, dueClaims, parisMidnight, sim, route, computeStatus, weekStart, replaceRows };', S);
const X = S.X;
X.SB.CHAT_ID = '111111111'; // placeholder in src; real id comes from config.local.json at deploy
// values from the vm realm have other prototypes; compare as plain JSON
const deq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);

const L = {
  categories: [{ id: 'c-food', name: 'Food & Dining', budget: 60, spent: 10 }, { id: 'c-shop', name: 'Shopping', budget: 0, spent: 0 }, { id: 'c-tr', name: 'Transportation', budget: 0, spent: 0 }],
  accounts: [{ id: 'a-bnp', name: 'BNP' }, { id: 'a-rev', name: 'Revolut' }, { id: 'a-cash', name: 'Cash Wallet' }, { id: 'a-sav', name: 'Savings Account' }],
  goals: [{ id: 'g1', title: 'Land an AI internship starting April 2027' }],
  notecats: [{ id: 'n-uni', name: 'University' }, { id: 'n-p', name: 'Personal' }],
  income_sources: ['Salary', 'Job', 'Family', 'Scholarship/CAF', 'Freelance', 'Refund'],
};
const ctxAt = (date, db = {}) => { const c = X.makeCtx({}, {}, { card_map: [], ...db }); c.todayOverride = date; return c; };
const T0 = '2026-11-11'; // mercredi
const txn = o => ({ kind: 'expense', title: 'Café', amount: 4, currency: 'EUR', date: T0, items: [], category: 'Food & Dining', account: null, confidence: 0.9, uncertain_fields: [], ...o });

test('dates: Paris day, weekday labels, calendar, week start, DST-aware midnight', () => {
  assert.equal(X.paris(new Date('2026-11-11T23:30:00Z')).date, '2026-11-12'); // 00:30 in Paris
  assert.equal(X.fmtDay('2026-11-16'), 'lun. 16/11');
  assert.match(X.calendar(T0, 1, 1), /2026-11-10 mardi \(hier\)\n2026-11-11 mercredi \(aujourd'hui\)\n2026-11-12 jeudi \(demain\)/);
  assert.equal(X.weekStart('2026-11-15'), '2026-11-09');
  assert.equal(X.parisMidnight('2026-11-09'), '2026-11-09T00:00:00+01:00');
  assert.equal(X.parisMidnight('2026-07-06'), '2026-07-06T00:00:00+02:00');
});

test('priority: ≤2 days or urgent → High, ≤7 → Medium, else/no date → Low', () => {
  assert.equal(X.priorityFor(T0, '2026-11-13', false), 'High');
  assert.equal(X.priorityFor(T0, '2026-11-18', false), 'Medium');
  assert.equal(X.priorityFor(T0, '2026-11-25', false), 'Low');
  assert.equal(X.priorityFor(T0, null, false), 'Low');
  assert.equal(X.priorityFor(T0, null, true), 'High');
});

test('briefs due: catch-up claims all briefs already due today', () => {
  const at = iso => X.dueClaims(new Date(iso)).map(c => c.kind).join(',');
  assert.equal(at('2026-11-11T06:59:00Z'), '');            // 07:59 Paris
  assert.equal(at('2026-11-11T07:00:00Z'), 'morning');     // 08:00
  assert.equal(at('2026-11-11T21:10:00Z'), 'morning,evening'); // laptop on at 22:10
  assert.equal(at('2026-11-15T19:00:00Z'), 'morning,weekly');  // Sunday 20:00
});

test('finance: cash alias, card map, receipt total mismatch lowers confidence', () => {
  const c = ctxAt(T0, { card_map: [{ card_last4: '1234', account: 'Revolut', account_page_id: 'a-rev' }] });
  const [a] = X.postFinance(c, L, { transactions: [txn({ account: 'ESPÈCES' })] }, { messageDate: T0 });
  assert.equal(a.data.account.name, 'Cash Wallet');
  const [b] = X.postFinance(c, L, { transactions: [txn({ card_last4: '1234' })] }, { messageDate: T0 });
  assert.equal(b.data.account.name, 'Revolut');
  const [u] = X.postFinance(c, L, { transactions: [txn({ card_last4: '9999' })] }, { messageDate: T0 });
  assert.equal(u.data.account, null);
  assert.equal(X.needsAccount(u.data), 'account');
  const r = X.postFinance(c, L, { receipt_total: 10, transactions: [txn({ amount: 6 }), txn({ amount: 3.5, category: 'Shopping' })] }, { messageDate: T0 });
  assert.ok(r.every(i => i.confidence <= 0.5));
  assert.match(r[0].warnings[0], /≠ total du ticket/);
  const ok = X.postFinance(c, L, { receipt_total: 9.53, transactions: [txn({ amount: 6 }), txn({ amount: 3.5 })] }, { messageDate: T0 });
  assert.equal(ok[0].warnings.length, 0); // within ±0.05 €
});

test('finance: NEW: category kept as proposal; refund source; transfer accounts', () => {
  const c = ctxAt(T0);
  const [n] = X.postFinance(c, L, { transactions: [txn({ category: 'NEW:Education' })] }, { messageDate: T0 });
  assert.equal(n.data.category_new, 'Education');
  const [r] = X.postFinance(c, L, { transactions: [txn({ kind: 'income', title: 'Remboursement Amazon', category: null, income_source: null })] }, { messageDate: T0 });
  assert.equal(r.data.income_source, 'Refund');
  const [t] = X.postFinance(c, L, { transactions: [txn({ kind: 'transfer', from_account: 'BNP', to_account: 'épargne' })] }, { messageDate: T0 });
  assert.equal(t.data.to_account.name, 'Savings Account');
  assert.equal(X.needsAccount(t.data), null);
});

test('finance validation: amount, date window, category, currency', () => {
  const c = ctxAt(T0);
  const v = o => { const [i] = X.postFinance(c, L, { transactions: [txn(o)] }, { messageDate: T0 }); return X.validateFinance(c, i); };
  deq(v({}).errors, []);
  assert.ok(v({ amount: 0 }).errors.includes('montant invalide'));
  assert.ok(v({ date: '2026-11-13' }).errors.includes('date dans le futur'));
  deq(v({ date: '2026-11-12' }).errors, []); // +1 day allowed
  assert.ok(v({ date: '2025-11-01' }).errors.includes("date de plus d'un an"));
  assert.ok(v({ category: 'Bogus' }).errors.includes('catégorie manquante'));
  assert.match(v({ currency: 'USD' }).warnings[0], /USD/);
});

test('task: past date dropped unless explicit; goal link ≥0.7 else suggestion; tags whitelisted', () => {
  const c = ctxAt(T0);
  const base = { name: 'Appeler la CAF', due_date: '2026-11-16', due_is_past_ok: false, urgent: true, priority_reason: 'admin', tags: ['Personel', 'Bogus'], goal_index: null, goal_confidence: 0 };
  const a = X.postTask(c, L, base);
  assert.equal(a.data.priority, 'High');
  deq([...a.data.tags], ['Personel']);
  const p = X.postTask(c, L, { ...base, due_date: '2026-11-01' });
  assert.equal(p.data.due_date, null);
  assert.match(p.warnings[0], /date passée/);
  assert.equal(X.postTask(c, L, { ...base, due_date: '2026-11-01', due_is_past_ok: true }).data.due_date, '2026-11-01');
  assert.equal(X.postTask(c, L, { ...base, goal_index: 0, goal_confidence: 0.85 }).data.goal.id, 'g1');
  const s = X.postTask(c, L, { ...base, goal_index: 0, goal_confidence: 0.5 }).data;
  assert.equal(s.goal, null);
  assert.equal(s.goal_suggestion.id, 'g1');
});

test('brain dump line is capped at 15 words; unknown section → personal', () => {
  const b = X.postBraindump(ctxAt(T0), { section: 'nope', line: Array(30).fill('mot').join(' ') }, { text: '' });
  assert.equal(b.data.section, 'personal');
  assert.equal(b.data.line.split(' ').length, 15);
});

test('edit patch: account/category/date/amount and task due recomputes priority', () => {
  const c = ctxAt(T0);
  const [f] = X.postFinance(c, L, { transactions: [txn({})] }, { messageDate: T0 });
  assert.ok(X.applyChange(c, L, f, 'account', 'c\'était revolut'.replace("c'était ", '')));
  assert.equal(f.data.account.name, 'Revolut');
  assert.ok(X.applyChange(c, L, f, 'category', 'transportation'));
  assert.equal(f.data.category.name, 'Transportation');
  assert.ok(X.applyChange(c, L, f, 'amount', '12,50'));
  assert.equal(f.data.amount, 12.5);
  assert.equal(X.applyChange(c, L, f, 'date', 'demain'), false); // must be resolved by the LLM first
  assert.equal(X.applyChange(c, L, f, 'name', 'x'), false);       // not a finance field
  const t = X.postTask(c, L, { name: 'Lire', due_date: null, urgent: false, tags: [], goal_index: null, goal_confidence: 0 });
  assert.equal(t.data.priority, 'Low');
  X.applyChange(c, L, t, 'due_date', '2026-11-12');
  assert.equal(t.data.priority, 'High');
});

const batch = items => ({ id: 'B1', chat_id: 1, status: 'open', telegram_message_id: 9, payload: { source: { input_type: 'text' }, items: items.map((it, idx) => ({ idx, ...it })) } });

test('recap keyboard: no ✅ until account known; account picker; 🗑 per line; buttons are tokens', () => {
  const c = ctxAt(T0);
  const fin = X.postFinance(c, L, { transactions: [txn({}), txn({ account: 'BNP', title: 'Pain' })] }, { messageDate: T0 }).map(i => ({ ...i, state: 'pending', errors: [] }));
  const b = batch(fin);
  X.computeStatus(b);
  const { text, kb } = X.renderBatch(c, b, L);
  const labels = kb.flat().map(x => x.text);
  assert.ok(!labels.includes('✅ Tout enregistrer'));
  assert.ok(labels.includes('Revolut') && labels.includes('🗑 1') && labels.includes('🗑 2'));
  assert.match(text, /<b>compte \?<\/b>/);
  assert.ok(kb.flat().every(x => x.callback_data === 'noop' || /^cb:[A-Za-z0-9]{10}$/.test(x.callback_data)));
  assert.ok(kb.flat().every(x => Buffer.byteLength(x.callback_data) <= 64));
  b.payload.items[0].data.account = { id: 'a-rev', name: 'Revolut' };
  assert.ok(X.renderBatch(c, b, L).kb.flat().some(x => x.text === '✅ Tout enregistrer'));
});

test('mixed batch: instant item saved + finance pending → open; undo/edit buttons; status transitions', () => {
  const c = ctxAt(T0);
  const [f] = X.postFinance(c, L, { transactions: [txn({ account: 'BNP' })] }, { messageDate: T0 });
  const t = { type: 'task', state: 'saved', notion: { id: 'p', url: 'https://notion.so/p' }, data: { name: 'Appeler la CAF', due_date: '2026-11-16', priority: 'High', priority_reason: '', tags: ['Personel'], goal: null, goal_suggestion: { id: 'g1', title: 'Land an AI internship' } }, warnings: [] };
  const b = batch([{ ...f, state: 'pending', errors: [] }, t]);
  X.computeStatus(b);
  assert.equal(b.status, 'open');
  assert.equal(b.type, 'mixed');
  const labels = X.renderBatch(c, b, L).kb.flat().map(x => x.text);
  assert.ok(labels.includes('✅ Tout enregistrer') && labels.includes('↩️ Annuler') && labels.some(l => l.startsWith('🎯 2')));
  b.payload.items[0].state = 'saved'; X.computeStatus(b); assert.equal(b.status, 'saved');
  b.payload.items.forEach(i => (i.state = 'undone')); X.computeStatus(b); assert.equal(b.status, 'undone');
});

test('finish(): pending row first, callbacks after it, one log row per item, tokens on first item only', () => {
  const c = ctxAt(T0);
  const b = batch([{ type: 'finance', _call: 'k1', confidence: 0.9, data: {} }, { type: 'finance', _call: 'k1', confidence: 0.4, data: {} }]);
  c.batch = b;
  c.logs.push({ extractor_type: 'finance', model: 'm', tokens_in: 100, tokens_out: 20, cost_eur: 0.001, latency_ms: 900, batch_id: 'B1', _call: 'k1' });
  c.logs.push({ extractor_type: 'router', model: 'm', tokens_in: 50, tokens_out: 5, cost_eur: 0.0001, latency_ms: 300, batch_id: 'GONE' });
  c.callbacks.push({ token: 't', chat_id: 1, action: 'save', pending_id: 'B1' });
  const ops = X.finish(c);
  deq(ops.map(o => o.op), ['pending', 'callbacks', 'log']);
  const rows = ops[2].rows;
  assert.equal(rows.length, 3);
  deq(rows.filter(r => r.extractor_type === 'finance').map(r => [r.item_idx, r.tokens_in, r.confidence]), [[0, 100, 0.9], [1, 0, 0.4]]);
  assert.equal(rows.find(r => r.extractor_type === 'router').batch_id, null); // unknown batch → no FK violation
  assert.ok(!JSON.stringify(ops[0]).includes('_call'));
});

test('allowlist + load params', () => {
  const msg = (id, text) => ({ message: { message_id: 1, chat: { id }, from: { id }, text, date: 0 } });
  assert.equal(X.prepare(msg(42, 'hi')), null);
  deq(X.prepare(msg(111111111, 'hello')).load, { chat_id: 111111111, take_state: true });
  deq(X.prepare(msg(111111111, '/undo')).load, { chat_id: 111111111, last_saved: true });
  const cq = { callback_query: { id: 'q', from: { id: 111111111 }, data: 'cb:abc', message: { chat: { id: 111111111 } } } };
  deq(X.prepare(cq).load, { chat_id: 111111111, cb_token: 'abc' });
  assert.equal(X.prepare({ callback_query: { ...cq.callback_query, from: { id: 7 } } }), null);
});

test('prefix shortcuts skip the router', async () => {
  const c = ctxAt(T0);
  for (const [p, type] of [['$', 'finance'], ['!', 'task'], ['#', 'note'], ['?', 'braindump']]) {
    const r = await X.route(c, `${p} quelque chose`);
    assert.equal(r.items[0].type, type);
    assert.equal(r.items[0].text_span, 'quelque chose');
  }
  assert.equal(c.logs.length, 0);
});

test('brief buttons: tapped task rows collapse to one label', () => {
  const kb = { inline_keyboard: [[{ text: 'a' }], [{ text: 'b1' }, { text: 'b2' }], [{ text: 'c' }]] };
  deq(X.replaceRows(kb, [0, 1], 'done').map(r => r[0].text), ['done', 'c']);
});

test('similarity is accent/case-insensitive', () => {
  assert.ok(X.sim('Appeler la CAF', 'appeler la caf') > 0.95);
  assert.ok(X.sim('Courses Lidl', 'Réviser probas') < 0.2);
});
