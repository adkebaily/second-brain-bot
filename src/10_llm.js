// ===== Gemini calls + live Notion option lists =====

// PROMPTS (router/finance/task/note/braindump: {system, schema}) is generated from prompts/*.md by build.py.

const HELPER = {
  transcribe: {
    system: 'Transcribe this voice note exactly, in the language spoken (usually French, sometimes English or mixed). Keep the words as said, add punctuation, no summary, no translation. If there is no speech, return an empty transcript.',
    schema: { type: 'OBJECT', required: ['transcript'], properties: { transcript: { type: 'STRING' } } },
  },
  classify: {
    system: 'Classify this image or PDF sent by a student to a note-taking bot.\n- receipt: a shop/restaurant receipt, ticket de caisse, invoice or payment proof with amounts.\n- note: handwritten notes, a whiteboard, a page of personal notes or a to-do list.\n- other: anything else (screenshots, photos of people/places, course slides, printed documents).\nAlso return the visible text (short, max 400 chars) and a confidence 0-1.',
    schema: { type: 'OBJECT', required: ['kind', 'confidence', 'text'], properties: { kind: { type: 'STRING', enum: ['receipt', 'note', 'other'] }, confidence: { type: 'NUMBER' }, text: { type: 'STRING' } } },
  },
  edit: {
    system: `You apply a user's correction to numbered items a bot extracted. Today is {{TODAY}}.
Calendar:
{{CALENDAR}}
Allowed values: categories {{CATEGORIES}} · accounts {{ACCOUNTS}} · income sources {{INCOME_SOURCES}} · task tags {{TAGS}} · priorities High, Medium, Low · note categories {{NOTE_CATEGORIES}} · brain-dump sections personal, questions, ideas, digital, recommendations, career.
Editable fields per type:
- finance: kind (expense|income|transfer), title, amount, date, category, income_source, account, from_account, to_account
- task: name, due_date (YYYY-MM-DD or "none"), priority, tags (comma-separated), goal (goal title or "none")
- note: name, category
- braindump: section, line
Rules: "2: catégorie transport" = item 2. No number → apply to the item(s) it obviously concerns; if it concerns every finance line (e.g. "c'était Revolut" when accounts are missing), return one change per line.
Map words to allowed values ("transport" → Transportation, "resto" → Food & Dining, "liquide" → Cash Wallet). A category that matches nothing becomes "NEW:<Name>".
Dates: resolve relative words with the calendar; output YYYY-MM-DD. Amounts: plain number with a dot.
Only output fields the user wants changed.`,
    schema: { type: 'OBJECT', required: ['changes'], properties: { changes: { type: 'ARRAY', items: { type: 'OBJECT', required: ['n', 'field', 'value'], properties: { n: { type: 'INTEGER' }, field: { type: 'STRING' }, value: { type: 'STRING' } } } } } },
  },
  date: {
    system: 'Today is {{TODAY}}. Calendar:\n{{CALENDAR}}\nThe user answers "when should this task be due?". Return the date as YYYY-MM-DD ("avant X" = the day before X), or null if no date is given.',
    schema: { type: 'OBJECT', required: ['due_date'], properties: { due_date: { type: 'STRING', nullable: true } } },
  },
  expand: {
    system: 'You help a French student think through one idea from their brain dump. Answer in the language of the idea, concise and concrete, no fluff.\n- problem: what problem/need it addresses (1 sentence)\n- why: why it matters to this student (1 sentence)\n- angles: exactly 3 distinct angles or approaches (each ≤ 20 words)\n- risks: 1-3 risks or objections (each ≤ 15 words)\n- next_step: the smallest concrete next step, doable in under 30 minutes\n- keywords: 3-5 search keywords (single words, original language)\n- summary: one line (≤ 20 words) summarising the expansion',
    schema: { type: 'OBJECT', required: ['problem', 'why', 'angles', 'risks', 'next_step', 'keywords', 'summary'], properties: {
      problem: { type: 'STRING' }, why: { type: 'STRING' }, angles: { type: 'ARRAY', items: { type: 'STRING' } }, risks: { type: 'ARRAY', items: { type: 'STRING' } },
      next_step: { type: 'STRING' }, keywords: { type: 'ARRAY', items: { type: 'STRING' } }, summary: { type: 'STRING' } } },
  },
  rerank: {
    system: 'Given an idea and numbered candidate items from the same person\'s notes, tasks and brain dump, return the numbers of at most 3 candidates that are genuinely related (same topic or directly useful). Return an empty list if none is clearly related.',
    schema: { type: 'OBJECT', required: ['related'], properties: { related: { type: 'ARRAY', items: { type: 'INTEGER' } } } },
  },
};

function costEur(model, tin, tout) {
  const p = SB.PRICES[model] || SB.PRICES['gemini-3.5-flash-lite'];
  return +(((tin * p[0] + tout * p[1]) / 1e6) * SB.USD_EUR).toFixed(6);
}

// One structured-output call. Falls back to the next model on overload/quota errors.
async function llm(ctx, { kind, system, parts, schema, models = SB.MODELS.text, think = 'minimal', meta = {} }) {
  let lastErr;
  for (const model of models) {
    for (let a = 0; a < 2; a++) {
      const t0 = Date.now();
      const r = await http(ctx, {
        method: 'POST', url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        headers: { 'x-goog-api-key': ctx.env.SB_GEMINI_API_KEY }, timeout: 120000,
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema, thinkingConfig: { thinkingLevel: think } },
        },
      });
      if (r.statusCode === 200) {
        const text = (r.body.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
        let out;
        try { out = JSON.parse(text); } catch (e) { lastErr = new Error(`Gemini ${model}: invalid JSON`); continue; }
        const u = r.body.usageMetadata || {};
        const tin = u.promptTokenCount || 0, tout = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
        ctx.logs.push({ extractor_type: kind, model, tokens_in: tin, tokens_out: tout, cost_eur: costEur(model, tin, tout), latency_ms: Date.now() - t0, ...meta });
        return { out, model };
      }
      lastErr = new Error(`Gemini ${model} ${r.statusCode}: ${redact(ctx, r.body?.error?.message || r.body?.message || '')}`);
      if (![0, 429, 500, 502, 503, 504].includes(r.statusCode)) throw lastErr;
      if (r.statusCode === 429) break; // per-model quota: switch model now
      if (a === 0) await sleep(1500);
    }
  }
  throw lastErr;
}

const media = (mime, b64) => ({ inlineData: { mimeType: mime, data: b64 } });

// ---------- live option lists, cached 1 h in brain.cache ----------
async function lists(ctx, fresh = false) {
  const c = ctx.db.cache?.lists;
  if (!fresh && c && Date.now() - Date.parse(c.fetched_at) < SB.LIST_TTL_MS) return c.value;
  const [cats, accts, goals, ncats, inc] = await Promise.all([
    nQuery(ctx, SB.DS.categories), nQuery(ctx, SB.DS.accounts),
    nQuery(ctx, SB.DS.goals, { filter: { property: 'Status', status: { does_not_equal: 'Completed' } } }),
    nQuery(ctx, SB.DS.notecats), N(ctx, 'GET', `/data_sources/${SB.DS.incomes}`),
  ]);
  const num = v => (v?.type === 'number' ? v.number : v?.type === 'rollup' ? (v.rollup?.number ?? 0) : v?.type === 'formula' ? (v.formula?.number ?? 0) : 0) || 0;
  const value = {
    categories: cats.map(p => ({ id: p.id, name: pTitle(p), budget: num(p.properties['Monthly Budget']), spent: num(p.properties['Expense This Month']) })),
    accounts: accts.map(p => ({ id: p.id, name: pTitle(p) })),
    goals: goals.map(p => ({ id: p.id, title: pTitle(p), desc: clip(plain(p.properties.Description?.rich_text), 160), url: p.url })),
    notecats: ncats.map(p => ({ id: p.id, name: pTitle(p) })),
    income_sources: (inc.properties?.Source?.select?.options || []).map(o => o.name),
  };
  ctx.ops.push({ op: 'cache_set', key: 'lists', value });
  ctx.db.cache = { ...(ctx.db.cache || {}), lists: { value, fetched_at: new Date().toISOString() } };
  return value;
}
function invalidateLists(ctx) {
  if (!ctx.invalidated) { ctx.invalidated = true; ctx.ops.push({ op: 'cache_del', key: 'lists' }); }
}

function promptVars(ctx, L, messageDate) {
  const t = today(ctx);
  return {
    TODAY: `${t} (${JOURS[dow(t)]})`,
    MESSAGE_DATE: messageDate || t,
    CALENDAR: calendar(t, 14, 21),
    CATEGORIES: L.categories.map(c => c.name).join(', '),
    ACCOUNTS: L.accounts.map(a => a.name).join(', '),
    INCOME_SOURCES: SB.INCOME_SOURCES.filter(s => L.income_sources.includes(s)).join(', '),
    TAGS: SB.TAGS.join(', '),
    GOALS: L.goals.map((g, i) => `${i}. ${g.title}${g.desc ? ' — ' + g.desc : ''}`).join('\n'),
    NOTE_CATEGORIES: L.notecats.map(c => c.name).join(', '),
  };
}
