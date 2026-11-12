# Second Brain Bot: build plan (phase 1)

## Decisions taken (from the inspection, 2026-11-11)
| Topic | Decision |
|---|---|
| Telegram | New bot from BotFather + new n8n Telegram credential. Same ngrok domain/`WEBHOOK_URL`; the DMS bot is not touched. |
| n8n | 2.46.4. Build through the REST API (needs `N8N_API_KEY` in my shell); fallback = importable JSON. |
| Notion API | HTTP Request nodes, `Notion-Version: 2026-03-11`, existing `Notion account` credential. Data-source endpoints; block insert with `position.after_block`. |
| LLM | `gemini-3.5-flash-lite` (router, text extractors, voice transcription, edit patch); `gemini-3.8-flash` (receipt / note photos, PDFs). `responseMimeType: application/json` + schema, temperature 0. Model names live in `brain.config`. |
| Accounts cleanup | Trash `Savings` (unused) and `Checking Account` + its 3 zero-amount 2025 template transfers. Keep `Savings Account`. |
| Income Source | Add Job, Family, Scholarship/CAF, Freelance, Refund; remove the unused Affiliates, Digital Products, Real Estate; keep Salary/Ecommerce/Work (in use). Bot proposes only the 5 new ones. |
| Brain Dump | Placeholders kept; new to_do inserted after the section's last to_do. |
| Budgets | Read `Expense This Month` rollup + `Monthly Budget` from Categories. Budget 0 → "pas de budget", no %. |
| Priority / dates | LLM resolves dates against an explicit calendar list; priority is computed in code from due date + `urgent` flag (deterministic, testable). |

## Workflows
| Workflow | Trigger | Job |
|---|---|---|
| `SB · Main` | Telegram Trigger (message, callback_query) | allowlist my chat_id → commands / callbacks / awaited free-text / new content. Preprocess, route, extract, validate, save or recap, reply. |
| `SB · Router` | Execute Workflow + Webhook (eval) | prefix shortcut or LLM router → `items[]` |
| `SB · Extract finance` / `task` / `note` / `braindump` | Execute Workflow + Webhook (eval) | one Gemini call each, live option lists from `brain.cache` (1 h) |
| `SB · Save` | Execute Workflow | Notion writes for a batch, records refs for undo, budget lines; on Notion 5xx/timeout → `status='retrying'` |
| `SB · Scheduler` | Schedule every 10 min + n8n "instance started" | briefs (claimed via `sent_log`, so catch-up after a restart is the same code path), 12 h reminder / 48 h expiry of finance batches, Notion retry queue, cache refresh |
| `SB · Error` | Error Trigger (set as error workflow on all SB workflows) | Telegram: workflow, node, error message |
| `SB · Setup` | manual | fetches Notion IDs + Brain Dump block tree into `brain.config`, checks the integration can see all 7 targets |

## Flow per message
1. Allowlist → if `chat_state` awaits text (edit / other date) → handle that and stop.
2. Pre-process: voice → transcript (kept); photo/PDF → one classify call: receipt | note | other ("other" → 3 buttons: Reçu · Note · Ignorer).
3. Prefix `$ ! # ?` → single item of that type; else router; any item < 0.6 → 4 type buttons.
4. Extractors in parallel per item → validation Code node (rules from the spec + duplicate check: normalised-title trigram similarity ≥ 0.8 within ±3 days against the same target, which becomes a ⚠️ line).
5. Instant items saved now; finance items stored in `brain.pending`. ONE reply message per batch, every later change edits it.

## Callbacks
`callback_data = "cb:<10-char token>"`; state in `brain.callbacks`. Each tap claims the token atomically (`UPDATE … WHERE used_at IS NULL RETURNING`), and Save-all also moves `pending.status` open→saving atomically, so a double tap creates nothing twice.

## Tests (step 4, real executions)
Every branch in the spec's list, with a `TEST:` prefix in titles so I can trash the test pages afterwards (I will list them and ask before trashing).

## Out of scope for phase 1
~~`/ask` agent (phase 2)~~ → done as the conversation mode (`src/55_chat.js`), 2026-11-12. Currency conversion (non-EUR is flagged only). Multi-user.
