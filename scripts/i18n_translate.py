"""Machine-translates i18n/source.json (Italian) into i18n/<lang>.json.
English comes from Italian; the other languages from the reviewed English (en.json + all.fix.json + en.fix.json),
which is less ambiguous for short UI labels. Results are cached; manual fixes in i18n/<lang>.fix.json win."""
import json, re, sys, os, time, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor
LANGS = sys.argv[1:] or ['en', 'es', 'de', 'fr', 'ar', 'ru', 'zh', 'ja']
SRC = json.load(open('i18n/source.json'))
SRCSET = set(SRC)
TOK = re.compile(r'\{[^{}\s]{0,12}\}|https?://[\w./:-]*[\w/]|`[^`]*`')
# Official Google Cloud Translation API (v2). Bring your own key: export GOOGLE_TRANSLATE_API_KEY=...
# (no keys are shipped with the project; unofficial endpoints are not used, to respect Google's terms of service).
API_KEY = os.environ.get('GOOGLE_TRANSLATE_API_KEY', '')
def call(text, tl, sl='it'):
    if not API_KEY:
        raise SystemExit('Set GOOGLE_TRANSLATE_API_KEY (Google Cloud Translation API) or translate by hand in i18n/<lang>.json.')
    tl2 = 'zh-CN' if tl == 'zh' else tl
    data = urllib.parse.urlencode({'q': text, 'source': sl, 'target': tl2, 'format': 'text', 'key': API_KEY}).encode()
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request('https://translation.googleapis.com/language/translate/v2', data), timeout=30) as r:
                return json.loads(r.read().decode())['data']['translations'][0]['translatedText']
        except Exception:
            time.sleep(2 * (attempt + 1))
    raise RuntimeError('translate failed')
def ok(src, out):
    return out and sorted(TOK.findall(src)) == sorted(TOK.findall(out))
def fix_ws(src, out):
    lead = src[:len(src) - len(src.lstrip())]; trail = src[len(src.rstrip()):]
    return lead + out.strip() + trail
def single(s, tl, sl):
    core = s.strip()
    if not core: return s
    if '\n' in core:
        parts = core.split('\n')
        return fix_ws(s, '\n'.join(single(p, tl, sl) if p.strip() else p for p in parts))
    return fix_ws(s, call(core, tl, sl))
def load(p):
    return json.load(open(p)) if os.path.exists(p) else {}
for tl in LANGS:
    sl = 'it' if tl == 'en' else 'en'
    if sl == 'en':
        EN = {**load('i18n/en.json'), **load('i18n/all.fix.json'), **load('i18n/en.fix.json')}
        text = {k: EN.get(k, k) for k in SRC}
    else:
        text = {k: k for k in SRC}
    path = f'i18n/{tl}.json'
    cache = json.load(open(path)) if os.path.exists(path) else {}
    todo = [s for s in SRC if s not in cache]
    batches, cur, size = [], [], 0
    for s in todo:
        if '\n' in text[s].strip() or not text[s].strip():
            batches.append([s]); continue
        if size + len(text[s]) > 1500 or len(cur) >= (1 if os.environ.get('SINGLE') else 50):
            batches.append(cur); cur, size = [], 0
        cur.append(s); size += len(text[s]) + 1
    if cur: batches.append(cur)
    def run(b):
        res = {}
        if len(b) > 1:
            out = call('\n'.join(text[x].strip() for x in b), tl, sl).split('\n')
            if len(out) == len(b):
                for s, o in zip(b, out):
                    if ok(text[s], o): res[s] = fix_ws(text[s], o)
        for s in b:
            if s not in res:
                o = single(text[s], tl, sl)
                res[s] = o if ok(text[s], o) else None
        return res
    with ThreadPoolExecutor(3) as ex:
        for r in ex.map(run, batches):
            for s, o in r.items():
                if o is not None: cache[s] = o
                else: print(tl, 'placeholder mismatch, kept source:', s[:70])
    json.dump({k: cache[k] for k in sorted(cache) if k in SRCSET}, open(path, 'w'), ensure_ascii=False, indent=0)
    print(tl, 'done', len(todo), 'new,', len([s for s in SRC if s in cache]), '/', len(SRC))
