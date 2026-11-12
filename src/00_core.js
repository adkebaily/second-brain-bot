// ===== Second Brain Bot: core (config, HTTP, Telegram, dates, text utils) =====
// Inlined by build.py into every Code node; runs in n8n's task runner and in plain Node for tests.

// __SB_*__ placeholders are filled from config.local.json by build.py --deploy (kept out of git).
const SB = {
  CHAT_ID: '__SB_CHAT_ID__',
  TZ: 'Europe/Paris',
  NOTION_VERSION: '2026-03-11',
  DS: {
    expenses: '__SB_DS_expenses__',
    incomes: '__SB_DS_incomes__',
    transfers: '__SB_DS_transfers__',
    categories: '__SB_DS_categories__',
    accounts: '__SB_DS_accounts__',
    todo: '__SB_DS_todo__',
    notes: '__SB_DS_notes__',
    notecats: '__SB_DS_notecats__',
    goals: '__SB_DS_goals__',
    learning: '__SB_DS_learning__',
  },
  BRAIN_DUMP_PAGE: '__SB_BRAIN_DUMP_PAGE__',
  SECTIONS: {
    personal: '🤍 Personal', questions: '？Questions', ideas: '💡 Thoughts & Ideas',
    digital: '💻 Digital', recommendations: '⭐ Recommendations', career: '🌱 Career',
  },
  SECTION_MATCH: { personal: /personal/i, questions: /questions/i, ideas: /thoughts/i, digital: /digital/i, recommendations: /recommendations/i, career: /career/i },
  PLACEHOLDERS: ['', 'new task', 'new question', 'new idea', 'new recommendations'],
  TAGS: ['Personel', 'Studies', 'Familly', 'Chores', 'Travel', 'Work', 'Leisure', 'Sport', 'Self-development'],
  INCOME_SOURCES: ['Job', 'Family', 'Scholarship/CAF', 'Freelance', 'Refund'],
  // free tier = 15 requests/min PER MODEL: on 429 the next model takes over
  MODELS: { text: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'], vision: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] },
  // USD per 1M tokens (ai.google.dev/pricing, 2026-11-11). shortcut: fixed USD→EUR rate, update with prices.
  PRICES: { 'gemini-3.5-flash-lite': [0.30, 2.50], 'gemini-3.8-flash': [0.75, 3.75], 'gemini-3.6-flash': [0.75, 3.75], 'gemini-3.1-flash-lite': [0.25, 1.50] },
  USD_EUR: 0.87,
  LIST_TTL_MS: 3600e3,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rid = (n = 10) => Array.from({ length: n }, () => '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 62)]).join('');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const eur = n => (Math.round(n * 100) / 100).toFixed(2).replace('.', ',') + ' €';
const clip = (s, n) => (s = String(s ?? '')).length > n ? s.slice(0, n - 1) + '…' : s;

function makeCtx(helpers, env, db, extra = {}) {
  return { helpers, env, db: db || {}, ops: [], logs: [], callbacks: [], now: new Date(), chatId: SB.CHAT_ID, ...extra };
}

function redact(ctx, s) {
  let out = String(s ?? '');
  for (const k of ['SB_NOTION_TOKEN', 'SB_GEMINI_API_KEY', 'SB_TELEGRAM_TOKEN']) if (ctx.env?.[k]) out = out.split(ctx.env[k]).join('***');
  return out.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot***');
}

async function http(ctx, o) {
  try {
    return await ctx.helpers.httpRequest({ json: true, returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: 90000, ...o });
  } catch (e) {
    return { statusCode: 0, body: { message: redact(ctx, e.message) } };
  }
}

// ---------- Notion ----------
async function N(ctx, method, path, body) {
  for (let a = 0; ; a++) {
    const r = await http(ctx, {
      method, url: 'https://api.notion.com/v1' + path, body,
      headers: { Authorization: 'Bearer ' + ctx.env.SB_NOTION_TOKEN, 'Notion-Version': SB.NOTION_VERSION },
    });
    if (r.statusCode >= 200 && r.statusCode < 300) return r.body;
    const retryable = r.statusCode === 0 || r.statusCode === 429 || r.statusCode >= 500;
    if (retryable && a < 2) { await sleep(a ? 3000 : 1000); continue; }
    const err = new Error(`Notion ${method} ${path.split('?')[0]} → ${r.statusCode} ${redact(ctx, r.body?.message || '')}`);
    err.retryable = retryable;
    throw err;
  }
}

async function nQuery(ctx, ds, body = {}, max = 300) {
  const out = [];
  let cursor;
  do {
    const r = await N(ctx, 'POST', `/data_sources/${ds}/query`, { page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && out.length < max);
  return out;
}

const plain = arr => (arr || []).map(t => t.plain_text).join('');
const pTitle = p => plain(Object.values(p.properties || {}).find(x => x.type === 'title')?.title);
const rtext = s => {
  const chunks = [];
  s = String(s ?? '');
  for (let i = 0; i < s.length || i === 0; i += 1900) chunks.push({ type: 'text', text: { content: s.slice(i, i + 1900) } });
  return chunks;
};
const blockUrl = (pageId, blockId) => `https://www.notion.so/${pageId.replace(/-/g, '')}#${blockId.replace(/-/g, '')}`;

// ---------- Telegram ----------
async function T(ctx, method, body) {
  for (let a = 0; ; a++) {
    const r = await http(ctx, { method: 'POST', url: `https://api.telegram.org/bot${ctx.env.SB_TELEGRAM_TOKEN}/${method}`, body });
    if (r.body?.ok) return r.body.result;
    const d = r.body?.description || r.body?.message || String(r.statusCode);
    if (/message is not modified/i.test(d)) return null;
    if ((r.statusCode === 429 || r.statusCode === 0 || r.statusCode >= 500) && a < 2) {
      await sleep(((r.body?.parameters?.retry_after) || 1) * 1000);
      continue;
    }
    throw new Error(`Telegram ${method}: ${redact(ctx, d)}`);
  }
}
const kbMarkup = kb => (kb && kb.length ? { inline_keyboard: kb } : { inline_keyboard: [] });
const tgSend = (ctx, text, kb, extra = {}) => T(ctx, 'sendMessage', {
  chat_id: ctx.chatId, text: clip(text, 4000), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: kbMarkup(kb), ...extra,
  ...(extra.reply_parameters ? { reply_parameters: { allow_sending_without_reply: true, ...extra.reply_parameters } } : {}),
});
const tgEdit = (ctx, message_id, text, kb) => T(ctx, 'editMessageText', {
  chat_id: ctx.chatId, message_id, text: clip(text, 4000), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: kbMarkup(kb),
});
const tgAnswer = (ctx, id, text, alert = false) => T(ctx, 'answerCallbackQuery', { callback_query_id: id, text, show_alert: alert }).catch(() => null);
const tgReact = (ctx, message_id, emoji = '👌') => T(ctx, 'setMessageReaction', { chat_id: ctx.chatId, message_id, reaction: [{ type: 'emoji', emoji }] }).catch(() => null);

async function tgFile(ctx, file_id) {
  const f = await T(ctx, 'getFile', { file_id });
  const r = await ctx.helpers.httpRequest({ url: `https://api.telegram.org/file/bot${ctx.env.SB_TELEGRAM_TOKEN}/${f.file_path}`, encoding: 'arraybuffer', json: false, timeout: 90000 })
    .catch(e => { throw new Error('Telegram file download: ' + redact(ctx, e.message)); });
  return Buffer.from(r).toString('base64');
}

// Button with server-side state: callback_data = 'cb:<token>'.
function btn(ctx, text, action, data = {}, pendingId = null, reusable = false) {
  const token = rid(10);
  ctx.callbacks.push({ token, chat_id: ctx.chatId, action, data, pending_id: pendingId, reusable });
  return { text, callback_data: 'cb:' + token };
}

// ---------- dates (Europe/Paris) ----------
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
function paris(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: SB.TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, hh: +p.hour, mm: +p.minute, dow: dow(date), time: `${p.hour}:${p.minute}` };
}
const today = ctx => ctx.todayOverride || paris(ctx.now).date;
function addDays(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dow(s) { return new Date(s + 'T12:00:00Z').getUTCDay(); }
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T12:00:00Z'));
const fmtDay = s => isDate(s) ? `${JOURS[dow(s)].slice(0, 3)}. ${s.slice(8, 10)}/${s.slice(5, 7)}` : '?';
function calendar(t, back, fwd) {
  const lines = [];
  for (let i = -back; i <= fwd; i++) {
    const d = addDays(t, i);
    lines.push(`${d} ${JOURS[dow(d)]}${i === 0 ? ' (aujourd\'hui)' : i === 1 ? ' (demain)' : i === -1 ? ' (hier)' : ''}`);
  }
  return lines.join('\n');
}
const weekStart = t => addDays(t, -((dow(t) + 6) % 7)); // Monday
function parisMidnight(s) { // 'YYYY-MM-DD' → ISO timestamp of 00:00 Paris time (CET/CEST aware)
  const off = new Intl.DateTimeFormat('en-US', { timeZone: SB.TZ, timeZoneName: 'shortOffset' }).formatToParts(new Date(s + 'T12:00:00Z')).find(p => p.type === 'timeZoneName').value;
  const m = /GMT([+-])(\d+)(?::(\d+))?/.exec(off) || ['', '+', '0'];
  return `${s}T00:00:00${m[1]}${m[2].padStart(2, '0')}:${(m[3] || '0').padStart(2, '0')}`;
}

// ---------- text similarity (duplicate check, related items) ----------
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function trigrams(s) { const t = `  ${norm(s)} `; const set = new Set(); for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3)); return set; }
function sim(a, b) {
  const A = trigrams(a), B = trigrams(b);
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}
function fill(tpl, vars) { return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] ?? m)); }
