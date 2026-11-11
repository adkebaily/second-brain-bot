#!/usr/bin/env python3
"""Offline-quality eval: runs tests/fixtures.jsonl through the live router/extractors (SB · Test API webhook).

  python3 scripts/eval.py                 # all fixtures
  python3 scripts/eval.py --stage task    # one stage
  python3 scripts/eval.py --only f13,t02  # some ids
Writes tests/eval_results.json and prints a report. Eval calls are NOT written to bot_log.
"""
import base64, json, mimetypes, sys, time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import ROOT, post  # noqa: E402

FIELDS = {
    'finance': ['n_txn', 'kind', 'amount', 'date', 'category', 'account', 'from_account', 'to_account', 'income_source', 'currency'],
    'task': ['due_date', 'priority', 'tags', 'goal'],
    'note': ['category', 'has_tasks'],
    'braindump': ['section'],
}


def score(stage, exp, out):
    """Returns {field: bool} for the fields the fixture specifies."""
    res = {}
    if stage == 'finance':
        txs = exp['transactions']
        res['n_txn'] = len(out) == len(txs)
        for i, e in enumerate(txs):
            o = out[i] if i < len(out) else {}
            for f, v in e.items():
                ok = abs((o.get(f) or 0) - v) < 0.01 if f == 'amount' else o.get(f) == v
                res.setdefault(f, True)
                res[f] = res[f] and ok
    elif stage == 'task':
        o = out[0]
        for f, v in exp.items():
            res[f] = (bool(v) and v[0] in (o.get('tags') or [])) if f == 'tags' else o.get(f) == v
    elif stage == 'note':
        o = out[0]
        res['category'] = o.get('category') == exp['category']
        res['has_tasks'] = bool(o.get('suggested_tasks')) == exp['has_tasks']
    elif stage == 'braindump':
        res['section'] = out[0].get('section') == exp['section']
    return res


def run(case):
    body = {'stage': case['stage'], 'text': case.get('text', ''), 'today': case['today']}
    if case.get('file'):
        p = ROOT / case['file']
        body['file'] = {'mime': mimetypes.guess_type(p.name)[0] or 'image/jpeg', 'b64': base64.b64encode(p.read_bytes()).decode()}
    for attempt in range(3):
        r = post(body)
        if 'output' in r or attempt == 2:
            return r
        time.sleep(5)  # transient (quota / overload)


def main():
    args = sys.argv[1:]
    stage = args[args.index('--stage') + 1] if '--stage' in args else None
    only = set(args[args.index('--only') + 1].split(',')) if '--only' in args else None
    cases = [json.loads(l) for l in (ROOT / 'tests' / 'fixtures.jsonl').read_text().splitlines() if l.strip()]
    skipped = [c['id'] for c in cases if c.get('file') and (c['expected'] is None or not (ROOT / c['file']).exists())]
    cases = [c for c in cases if c['id'] not in skipped and (not stage or c['stage'] == stage) and (not only or c['id'] in only)]
    with ThreadPoolExecutor(2) as pool:  # free tier: 15 req/min per model
        results = list(pool.map(run, cases))

    rows, conf, router_ok, field = [], Counter(), [], defaultdict(list)
    lat, cost = [], []
    for c, r in zip(cases, results):
        out = r.get('output')
        row = {'id': c['id'], 'stage': c['stage'], 'latency_ms': r.get('latency_ms'), 'cost_eur': (r.get('usage') or {}).get('cost_eur'), 'models': r.get('models')}
        if out is None:
            row['error'] = r.get('error') or r
            rows.append(row)
            continue
        lat.append(r['latency_ms']); cost.append(r['usage']['cost_eur'])
        if c['stage'] == 'router':
            got = [i['type'] for i in out['items']]
            want = c['expected']['types']
            row.update(ok=got == want, got=got, want=want)
            router_ok.append(got == want)
            for k in range(max(len(got), len(want))):
                conf[(want[k] if k < len(want) else '∅', got[k] if k < len(got) else '∅')] += 1
        else:
            s = score(c['stage'], c['expected'], out)
            for f, ok in s.items():
                field[(c['stage'], f)].append(ok)
            row.update(ok=all(s.values()), fields=s, got=out)
        rows.append(row)

    print(f"\n=== Eval {time.strftime('%Y-%m-%d %H:%M')} — {len(rows)} cases ({len(skipped)} receipt slots skipped: {', '.join(skipped)})")
    if router_ok:
        print(f'\nRouter exact-match accuracy: {sum(router_ok)}/{len(router_ok)} = {sum(router_ok) / len(router_ok):.0%}')
        labels = ['finance', 'task', 'note', 'braindump', 'command_like', '∅']
        print('Confusion (rows = expected, cols = predicted):')
        print(' ' * 13 + ''.join(f'{l[:9]:>10}' for l in labels))
        for a in labels:
            if any(conf[(a, b)] for b in labels):
                print(f'{a[:12]:>13}' + ''.join(f'{conf[(a, b)] or "·":>10}' for b in labels))
    for st, fs in FIELDS.items():
        present = [(f, field[(st, f)]) for f in fs if field[(st, f)]]
        if present:
            print(f'\n{st}: ' + ' · '.join(f'{f} {sum(v)}/{len(v)}' for f, v in present))
    fails = [r for r in rows if not r.get('ok')]
    if fails:
        print(f'\nFailures ({len(fails)}):')
        for r in fails:
            detail = r.get('error') or ({'got': r['got'], 'want': r['want']} if r['stage'] == 'router' else {f: v for f, v in r['fields'].items() if not v})
            print(f"  {r['id']}: {json.dumps(detail, ensure_ascii=False)[:300]}")
            if r['stage'] != 'router' and 'got' in r:
                print(f"      got: {json.dumps(r['got'], ensure_ascii=False)[:300]}")
    if lat:
        print(f'\nMean latency: {sum(lat) / len(lat) / 1000:.2f} s per call (max {max(lat) / 1000:.1f} s)')
        print(f'Cost per message (paid-tier prices; free tier = 0 €): {sum(cost) / len(cost) * 1000:.3f} m€ mean, {sum(cost):.4f} € total')
    passed = sum(1 for r in rows if r.get('ok'))
    print(f'\nOverall: {passed}/{len(rows)} cases fully correct')
    (ROOT / 'tests' / 'eval_results.json').write_text(json.dumps({'ts': time.time(), 'rows': rows}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
