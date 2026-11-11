"""Test harness: drives the real bot through the protected SB · Test API webhook.

Updates are shaped like Telegram's, so they run exactly the code path of SB · Main
(same Prepare → brain.load → Engine → brain.apply). Bot replies really go to the chat.
"""
import json, os, random, subprocess, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = dict(l.split('=', 1) for l in (ROOT / '.env').read_text().split('\n') if '=' in l)
CHAT = int(json.loads((ROOT / 'config.local.json').read_text())['chat_id'])
CREATED = ROOT / 'tests' / '.created_batches'  # batch ids made by tests, for cleanup


def post(body, timeout=240):
    req = urllib.request.Request(ENV['N8N_URL'] + '/webhook/sb-test', method='POST', data=json.dumps(body).encode(),
                                 headers={'content-type': 'application/json', 'X-SB-Key': ENV['SB_TEST_KEY']})
    t0 = time.time()
    try:
        out = json.load(urllib.request.urlopen(req, timeout=timeout))
    except urllib.error.HTTPError as e:
        out = {'http_error': e.code, 'body': e.read().decode()[:800]}
    out['_secs'] = round(time.time() - t0, 1)
    return out


def sql(q):
    r = subprocess.run(['podman', 'exec', '-i', 'n8n_postgres_1', 'psql', '-U', 'n8n', '-d', 'n8n', '-At', '-c', q],
                       capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def sql_json(q):
    out = sql(f'select coalesce(json_agg(t), \'[]\') from ({q}) t')
    return json.loads(out or '[]')


def _remember(res):
    ids = [b['id'] for b in res.get('batches', [])]
    if ids:
        with CREATED.open('a') as f:
            f.write('\n'.join(ids) + '\n')


def message(text=None, **extra):
    m = {'message_id': random.randint(10**8, 10**9), 'chat': {'id': CHAT, 'type': 'private'}, 'from': {'id': CHAT},
         'date': int(time.time()), **({'text': text} if text is not None else {}), **extra}
    res = post({'update': {'update_id': random.randint(1, 10**9), 'message': m}})
    _remember(res)
    return res


def batch(bid):
    rows = sql_json(f"select * from brain.pending where id = '{bid}'")
    return rows[0] if rows else None


def tokens(bid, action, **match):
    rows = sql_json(f"select token, data from brain.callbacks where pending_id = '{bid}' and action = '{action}' and used_at is null order by created_at desc")
    return [r['token'] for r in rows if all(r['data'].get(k) == v for k, v in match.items())]


def tap(token, message_id=None, markup=None):
    cq = {'id': 'test-' + token, 'from': {'id': CHAT}, 'data': 'cb:' + token,
          'message': {'message_id': message_id or 1, 'chat': {'id': CHAT}, **({'reply_markup': markup} if markup else {})}}
    res = post({'update': {'update_id': random.randint(1, 10**9), 'callback_query': cq}})
    _remember(res)
    return res


def tap_action(bid, action, **match):
    b = batch(bid)
    toks = tokens(bid, action, **match)
    assert toks, f'no unused {action} button on {bid} {match}'
    return tap(toks[0], b['telegram_message_id'])


def notion(method, path, body=None):
    nenv = dict(l.split('=', 1) for l in Path('~/n8n/.env').expanduser().read_text().split('\n') if '=' in l)
    req = urllib.request.Request('https://api.notion.com/v1' + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={'Authorization': 'Bearer ' + nenv['SB_NOTION_TOKEN'], 'Notion-Version': '2026-03-11', 'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req))


def telegram(method, body=None, files=None):
    """Bot API call from the host (used to upload test media and get real file_ids)."""
    nenv = dict(l.split('=', 1) for l in Path('~/n8n/.env').expanduser().read_text().split('\n') if '=' in l)
    url = f"https://api.telegram.org/bot{nenv['SB_TELEGRAM_TOKEN']}/{method}"
    if files:
        args = ['curl', '-s', url] + sum([['-F', f'{k}={v}'] for k, v in (body or {}).items()], []) + sum([['-F', f'{k}=@{v}'] for k, v in files.items()], [])
        return json.loads(subprocess.run(args, capture_output=True, text=True).stdout)
    req = urllib.request.Request(url, method='POST', data=json.dumps(body or {}).encode(), headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req))
