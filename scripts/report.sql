-- Real-use quality report from brain.bot_log (eval runs are not logged there).
-- Run: podman exec -i n8n_postgres_1 psql -U n8n -d n8n < scripts/report.sql
-- Item rows = extractor_type in (finance, task, note, braindump): one row per item the bot extracted.
\pset footer off
\echo '== Items per type: saved without edits, edited, cancelled, undone (last 90 days)'
WITH items AS (
  SELECT l.*, p.status AS batch_status,
         (p.payload->'items'->l.item_idx->>'state') AS item_state
    FROM brain.bot_log l LEFT JOIN brain.pending p ON p.id = l.batch_id
   WHERE l.extractor_type IN ('finance','task','note','braindump') AND l.ts > now() - interval '90 days')
SELECT extractor_type AS type,
       count(*)                                                       AS items,
       count(*) FILTER (WHERE item_state = 'saved' AND NOT was_edited) AS saved_no_edit,
       round(100.0 * count(*) FILTER (WHERE item_state = 'saved' AND NOT was_edited) / nullif(count(*) FILTER (WHERE item_state IN ('saved','undone')), 0), 1) AS pct_saved_without_edit,
       round(100.0 * avg(was_edited::int), 1)    AS pct_edited,
       round(100.0 * avg(was_cancelled::int), 1) AS pct_cancelled,
       round(100.0 * avg(was_undone::int), 1)    AS pct_undone,
       round(avg(confidence)::numeric, 2)        AS mean_conf
  FROM items GROUP BY 1 ORDER BY 2 DESC;

\echo '== Most-edited fields per type'
SELECT extractor_type AS type, f AS field, count(*) AS edits
  FROM brain.bot_log, unnest(edited_fields) AS f
 WHERE was_edited AND ts > now() - interval '90 days'
 GROUP BY 1, 2 ORDER BY 1, 3 DESC;

\echo '== Undo rate (batches with at least one saved item)'
SELECT count(*) AS saved_batches,
       count(*) FILTER (WHERE status = 'undone' OR payload->'items' @> '[{"state":"undone"}]') AS undone_batches,
       round(100.0 * count(*) FILTER (WHERE status = 'undone' OR payload->'items' @> '[{"state":"undone"}]') / nullif(count(*), 0), 1) AS undo_rate_pct
  FROM brain.pending WHERE saved_at IS NOT NULL AND created_at > now() - interval '90 days';

\echo '== Router: type mix and low-confidence rate'
SELECT router_type, count(*) AS items, round(100.0 * avg((router_confidence < 0.6)::int), 1) AS pct_low_conf,
       count(*) FILTER (WHERE prefix_used IS NOT NULL) AS via_prefix
  FROM brain.bot_log WHERE extractor_type IN ('finance','task','note','braindump') AND ts > now() - interval '90 days'
 GROUP BY 1 ORDER BY 2 DESC;

\echo '== Cost and latency per message (paid-tier prices; 0 € on the free tier)'
SELECT input_type, count(DISTINCT batch_id) AS messages,
       round(sum(cost_eur) / nullif(count(DISTINCT batch_id), 0) * 1000, 3) AS meur_per_msg,
       round(avg(latency_ms)) AS mean_call_ms,
       round(sum(tokens_in + tokens_out)::numeric / nullif(count(DISTINCT batch_id), 0)) AS tokens_per_msg
  FROM brain.bot_log WHERE batch_id IS NOT NULL AND ts > now() - interval '90 days'
 GROUP BY 1 ORDER BY 2 DESC;

\echo '== Model use (fallbacks show up here)'
SELECT model, extractor_type, count(*) FROM brain.bot_log WHERE model IS NOT NULL AND ts > now() - interval '30 days' GROUP BY 1, 2 ORDER BY 3 DESC;
