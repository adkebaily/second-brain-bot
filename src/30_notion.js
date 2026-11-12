// ===== Notion writes: pages, Brain Dump blocks, undo, budgets =====

const para = (text, color) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rtext(text), ...(color ? { color } : {}) } });
const bullet = text => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rtext(text) } });
const linkPara = (label, links) => ({
  object: 'block', type: 'paragraph', paragraph: {
    rich_text: [{ type: 'text', text: { content: label } }, ...links.flatMap((l, i) => [
      ...(i ? [{ type: 'text', text: { content: ' · ' } }] : []), { type: 'text', text: { content: clip(l.title, 80), link: { url: l.url } } }])],
  },
});
function mdBlocks(md) {
  const out = [];
  for (const raw of String(md || '').split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,3}\s/.test(line)) out.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: rtext(line.replace(/^#+\s*/, '')) } });
    else if (/^[-*•]\s/.test(line)) out.push(bullet(line.replace(/^[-*•]\s*/, '')));
    else out.push(para(line));
  }
  return out.slice(0, 90);
}
const sourceLine = src => `Source : ${src.input_type || 'texte'} · ${src.message_date || ''} ${src.message_time || ''} · Second Brain Bot`;

const rel = x => ({ relation: x ? [{ id: x.id }] : [] });
const titleProp = s => ({ title: rtext(s) });

function financeProps(d) {
  const base = { Amount: { number: d.amount }, Date: { date: { start: d.date } } };
  if (d.kind === 'expense') return { ...base, Expense: titleProp(d.title), Category: rel(d.category), Account: rel(d.account) };
  if (d.kind === 'income') return { ...base, Income: titleProp(d.title), Source: { select: d.income_source ? { name: d.income_source } : null }, Accounts: rel(d.account) };
  return { ...base, Transactions: titleProp(d.title), 'From Account': rel(d.from_account), 'To Account': rel(d.to_account) };
}
const financeDS = d => ({ expense: SB.DS.expenses, income: SB.DS.incomes, transfer: SB.DS.transfers }[d.kind]);
function taskProps(d) {
  return {
    Name: titleProp(d.name), Priority: { select: { name: d.priority } },
    'Due date': { date: d.due_date ? { start: d.due_date } : null },
    'Multi-select': { multi_select: d.tags.map(name => ({ name })) }, Goal: rel(d.goal),
  };
}
const noteProps = d => ({ Name: titleProp(d.name), Category: rel(d.category) });

async function createPage(ctx, ds, properties, children) {
  const p = await N(ctx, 'POST', '/pages', { parent: { type: 'data_source_id', data_source_id: ds }, properties, ...(children?.length ? { children } : {}) });
  invalidateLists(ctx);
  return { id: p.id, url: p.url, kind: 'page' };
}

async function ensureCategory(ctx, L, d) {
  if (d.category || !d.category_new) return;
  const existing = pickName(L.categories, d.category_new);
  if (existing) { d.category = { id: existing.id, name: existing.name }; d.category_new = null; return; }
  const p = await createPage(ctx, SB.DS.categories, { Category: titleProp(d.category_new) });
  L.categories.push({ id: p.id, name: d.category_new, budget: 0, spent: 0 });
  d.category = { id: p.id, name: d.category_new };
  d.category_new = null;
}

async function saveItem(ctx, L, batch, it) {
  const d = it.data, src = batch.payload.source;
  if (it.type === 'finance') {
    await ensureCategory(ctx, L, d);
    const body = [];
    if (d.lines.length) body.push(para('Articles'), ...d.lines.slice(0, 60).map(l => bullet(`${l.name} — ${eur(l.price)}`)));
    if (d.merchant) body.push(para('Commerçant : ' + d.merchant));
    if (d.card_last4) body.push(para('Carte •••• ' + d.card_last4));
    body.push(para(sourceLine(src), 'gray'));
    it.notion = await createPage(ctx, financeDS(d), financeProps(d), body);
  } else if (it.type === 'task') {
    it.notion = await createPage(ctx, SB.DS.todo, { ...taskProps(d), Status: { status: { name: 'Not started' } } }, [
      para(`Priorité ${d.priority} : ${d.priority_reason}`), para(sourceLine(src), 'gray')]);
  } else if (it.type === 'note') {
    const body = mdBlocks(d.body);
    if (d.raw) body.push({ object: 'block', type: 'toggle', toggle: { rich_text: rtext(`Texte brut (${src.input_type || 'texte'})`), children: String(d.raw).match(/[\s\S]{1,1900}/g).slice(0, 50).map(c => para(c)) } });
    body.push(para(sourceLine(src), 'gray'));
    it.notion = await createPage(ctx, SB.DS.notes, noteProps(d), body);
  } else if (it.type === 'braindump') {
    it.notion = await bdInsert(ctx, d.section, d.line);
  }
  it.state = 'saved';
  it.saved_at = new Date().toISOString();
}

async function updateItem(ctx, L, batch, it, fields) {
  const d = it.data;
  if (it.type === 'finance') {
    await ensureCategory(ctx, L, d);
    if (fields.includes('kind')) { await trashItem(ctx, it); return saveItem(ctx, L, batch, it); }
    return N(ctx, 'PATCH', `/pages/${it.notion.id}`, { properties: financeProps(d) });
  }
  if (it.type === 'task') return N(ctx, 'PATCH', `/pages/${it.notion.id}`, { properties: taskProps(d) });
  if (it.type === 'note') return N(ctx, 'PATCH', `/pages/${it.notion.id}`, { properties: noteProps(d) });
  if (it.type === 'braindump') {
    if (fields.includes('section')) { await trashItem(ctx, it); it.notion = await bdInsert(ctx, d.section, d.line); return; }
    return N(ctx, 'PATCH', `/blocks/${it.notion.id}`, { to_do: { rich_text: rtext(d.line) } });
  }
}

const URL_RE = /https?:\/\/[^\s<>"]+/;
function learningProps(L, x, url) {
  const p = { 'Resource Name': titleProp(clip(x.name, 150)), Status: { status: { name: 'Not started' } } };
  const type = L.learn_types.find(t => norm(t) === norm(x.type));
  if (type) p.Type = { select: { name: type } };
  const cats = (x.categories || []).map(c => L.learn_categories.find(o => norm(o) === norm(c))).filter(Boolean);
  if (cats.length) p.Category = { multi_select: [...new Set(cats)].slice(0, 2).map(name => ({ name })) };
  if (x.takeaway) p['Key Takeaways'] = { rich_text: rtext(clip(x.takeaway, 300)) };
  if (url) p['Files & media'] = { files: [{ name: clip(url, 100), type: 'external', external: { url } }] }; // same place as the rows made by hand
  return p;
}
// 📚 button: the note / idea becomes a Learning Library row, then the original is removed. ↩️ trashes the new row.
async function moveToLearning(ctx, L, b, it) {
  const text = [it.span, it.data.detail].filter(Boolean).join('\n');
  const { out } = await llm(ctx, { kind: 'learning', system: fill(HELPER.learning.system, { LEARN_TYPES: L.learn_types.join(', '), LEARN_CATEGORIES: L.learn_categories.join(', ') }),
    schema: HELPER.learning.schema, parts: [{ text }], meta: { batch_id: b.id, item_idx: it.idx } });
  const url = (URL_RE.exec(text) || [])[0] || null;
  const page = await createPage(ctx, SB.DS.learning, learningProps(L, out, url), [para(text), para(sourceLine(b.payload.source), 'gray')]);
  await trashItem(ctx, it);
  it.notion = page;
  it.data.moved = { name: clip(out.name, 80), url: page.url };
}

async function trashItem(ctx, it) {
  if (!it.notion) return;
  try {
    if (it.notion.kind === 'block') await N(ctx, 'DELETE', `/blocks/${it.notion.id}`);
    else await N(ctx, 'PATCH', `/pages/${it.notion.id}`, { in_trash: true });
  } catch (e) { if (!/→ (404|400)/.test(e.message)) throw e; } // already gone
}

// ---------- Brain Dump page ----------
async function bdColumns(ctx) {
  if (ctx.db.config?.braindump) return ctx.db.config.braindump;
  const cols = {};
  const top = (await N(ctx, 'GET', `/blocks/${SB.BRAIN_DUMP_PAGE}/children?page_size=100`)).results.filter(b => b.type === 'column_list');
  for (const cl of top) {
    for (const col of (await N(ctx, 'GET', `/blocks/${cl.id}/children?page_size=100`)).results) {
      const kids = (await N(ctx, 'GET', `/blocks/${col.id}/children?page_size=100`)).results;
      const h = kids.find(b => b.type.startsWith('heading_'));
      const key = h && Object.keys(SB.SECTION_MATCH).find(k => SB.SECTION_MATCH[k].test(plain(h[h.type].rich_text)));
      if (key) cols[key] = { column_id: col.id, heading_id: h.id };
    }
  }
  if (Object.keys(cols).length !== 6) throw new Error(`Brain Dump: found ${Object.keys(cols).length}/6 sections`);
  ctx.ops.push({ op: 'config_set', key: 'braindump', value: cols });
  ctx.db.config = { ...(ctx.db.config || {}), braindump: cols };
  return cols;
}
async function bdChildren(ctx, key) {
  const col = (await bdColumns(ctx))[key];
  const out = [];
  let cursor;
  do {
    const r = await N(ctx, 'GET', `/blocks/${col.column_id}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`);
    out.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return { col, kids: out };
}
const isPlaceholder = b => SB.PLACEHOLDERS.includes(norm(plain(b.to_do?.rich_text)));
async function bdItems(ctx, key) {
  const { kids } = await bdChildren(ctx, key);
  return kids.filter(b => b.type === 'to_do' && !isPlaceholder(b))
    .map(b => ({ id: b.id, text: plain(b.to_do.rich_text), created: b.created_time, checked: b.to_do.checked, section: key, url: blockUrl(SB.BRAIN_DUMP_PAGE, b.id) }));
}
// New to_do goes right after the section's last to_do (before the divider), via the 2026-03-11 `position` param.
async function bdInsert(ctx, key, line) {
  const { col, kids } = await bdChildren(ctx, key);
  const todos = kids.filter(b => b.type === 'to_do');
  const after = todos.length ? todos[todos.length - 1].id : col.heading_id;
  const r = await N(ctx, 'PATCH', `/blocks/${col.column_id}/children`, {
    children: [{ object: 'block', type: 'to_do', to_do: { rich_text: rtext(line), checked: false } }],
    position: { type: 'after_block', after_block: { id: after } },
  });
  const b = r.results[0];
  return { id: b.id, url: blockUrl(SB.BRAIN_DUMP_PAGE, b.id), kind: 'block' };
}

// ---------- budgets ----------
function budgetLine(name, spent, budget) {
  const pct = Math.round((spent / budget) * 100);
  return `<b>${esc(name)}</b>${pct >= 100 ? ' 🚨' : pct >= 80 ? ' ⚠️' : ''}\n<code>${bar(pct)}</code> ${pct} %  ·  ${eur(spent).replace(' €', '')} / ${eur(budget)}`;
}
async function budgetLines(ctx, categoryIds) {
  const lines = [];
  for (const id of [...new Set(categoryIds)]) {
    const p = await N(ctx, 'GET', `/pages/${id}`);
    const name = pTitle(p);
    const budget = p.properties['Monthly Budget']?.number || 0;
    const r = p.properties['Expense This Month']?.rollup;
    const spent = r?.number ?? 0;
    if (!budget) { lines.push(`<b>${esc(name)}</b>  ${eur(spent)} ce mois <i>(pas de budget)</i>`); continue; }
    lines.push(budgetLine(name, spent, budget));
  }
  return lines;
}
