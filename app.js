const API_URL = 'https://scriptforge-api.janmejay-crazzy.workers.dev';

const MAX_TURNS = 10;
const MAX_INPUT = 2000;
const RATE_LIMIT_MS = 3000;

const $ = (id) => document.getElementById(id);
const prefs = { lang: 'PowerShell', pack: 'Self-contained EXE', plat: 'Windows' };
let turns = [], busy = false, view = 'Script', data = { sec: {}, code: '', lang: '', full: '' };
let lastRequest = 0;

function sanitize(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function note(msg) {
  const d = document.createElement('div');
  const i = document.createElement('i');
  i.textContent = '[' + new Date().toTimeString().slice(0, 8) + ']';
  d.append(i, msg);
  $('tl').appendChild(d);
  $('tl').scrollTop = 1e9;
}

function status(s, cls) {
  $('st').textContent = s;
  $('dot').className = 'dot ' + (cls || '');
}

function strip(t) {
  return (t || '').replace(/```\w*\n?/g, '').replace(/\*\*/g, '').trim();
}

function parse(t) {
  const re = /^\s*(?:#+\s*)?\*{0,2}([A-Za-z][A-Za-z &]{4,})\*{0,2}\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(t))) marks.push({ k: m[1].trim().toUpperCase(), s: m.index, e: re.lastIndex });
  const sec = {};
  marks.forEach((x, i) => { sec[x.k] = t.slice(x.e, i + 1 < marks.length ? marks[i + 1].s : t.length).trim(); });
  const c = t.match(/```(\w*)\n([\s\S]*?)```/);
  return { sec, lang: c ? c[1].toLowerCase() : '', code: c ? c[2].replace(/\s+$/, '') : '', full: t };
}

function setBody(id, txt, ph) {
  const e = $(id);
  e.textContent = txt || ph;
  e.classList.toggle('empty', !txt);
}

function showCode() {
  const box = $('code');
  box.innerHTML = '';
  let txt, isCode = false;
  if (view === 'Script') {
    txt = data.code; isCode = !!txt;
    if (!txt) txt = data.full ? 'No code block in this answer. See the Full answer tab.' : '';
  } else if (view === 'Usage') {
    txt = ['USAGE', 'DEPENDENCIES', 'LOGGING LOCATIONS', 'ERROR HANDLING']
      .filter((k) => data.sec[k])
      .map((k) => k + '\n' + strip(data.sec[k]))
      .join('\n\n') || 'No usage notes in this answer.';
  } else {
    txt = strip(data.full) || '';
  }

  if (!txt) {
    const ph = document.createElement('div');
    ph.className = 'empty';
    ph.textContent = 'Nothing here yet. Describe a task and click Synthesize script.';
    box.appendChild(ph);
    box.className = '';
  } else {
    box.className = isCode ? '' : 'txt';
    if (isCode) {
      txt.split('\n').forEach((l) => {
        const s = document.createElement('span');
        s.className = 'l';
        s.textContent = l || ' ';
        box.appendChild(s);
      });
    } else {
      box.textContent = txt;
    }
  }

  $('m1').textContent = isCode ? 'Code ready: ' + txt.split('\n').length + ' lines' : 'Notes';
  $('m2').textContent = isCode ? (data.lang || prefs.lang) : view;
}

function tabs() {
  const t = $('tabs');
  t.innerHTML = '';
  [['Script', 'terminal'], ['Usage', 'menu_book'], ['Full answer', 'description']].forEach(([n, ic]) => {
    const b = document.createElement('button');
    b.className = 'tab' + (n === view ? ' on' : '');
    const ico = document.createElement('span');
    ico.className = 'mi';
    ico.textContent = ic;
    b.append(ico, n);
    b.onclick = () => { view = n; tabs(); showCode(); };
    t.appendChild(b);
  });
}

function fill() {
  const s = data.sec;
  setBody('b-sum', strip(s['SOLUTION SUMMARY']), 'The summary of your solution shows here.');
  setBody('b-build', strip(s['BUILD EXECUTABLE']), 'Build commands show here.');
  setBody('b-sec', strip(s['SECURITY CONSIDERATIONS']), 'Security notes show here.');
  setBody('b-roll', strip(s['ROLLBACK PLAN']), 'Recovery steps show here.');
}

async function run() {
  const raw = $('q').value.trim();
  if (!raw || busy) return;

  const now = Date.now();
  if (now - lastRequest < RATE_LIMIT_MS) {
    note('Please wait before sending another request.');
    return;
  }

  if (raw.length < 5) { note('Please describe your task in more detail.'); return; }

  const q = raw.slice(0, MAX_INPUT)
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '');

  busy = true;
  lastRequest = now;
  $('go').disabled = true;
  status('Forging…', 'busy');

  const msg = q + '\n\n(Preferences: language ' + prefs.lang + '; packaging ' + prefs.pack + '; target platform ' + prefs.plat + '.)';
  turns.push({ role: 'user', content: msg });
  if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS);
  note('Request sent: ' + q.slice(0, 70));

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);

    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: turns }),
      signal: ctrl.signal,
    });

    clearTimeout(timer);

    if (!r.ok) {
      const isRate = r.status === 429;
      throw new Error(isRate ? 'rate-limited' : 'HTTP ' + r.status);
    }

    const res = await r.json();
    if (!res || typeof res.text !== 'string' || res.text.length > 50000) throw new Error('invalid response');

    turns.push({ role: 'assistant', content: res.text });
    note('Answer received (' + res.text.length + ' chars)');

    data = parse(res.text);
    view = data.code ? 'Script' : 'Full answer';
    tabs(); fill(); showCode();
    status('Ready');
  } catch (e) {
    turns.pop();
    if (e.name === 'AbortError') note('Request timed out. Try again.');
    else if (e.message === 'rate-limited') note('Rate limit reached. Wait a moment and try again.');
    else note('Request failed. Check your connection and try again.');
    status('Error', 'err');
  }

  busy = false;
  $('go').disabled = false;
}

// Segment controls
document.querySelectorAll('.seg').forEach((s) => s.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  s.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  prefs[s.dataset.k] = b.textContent.trim();
}));

$('go').onclick = run;
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });

$('cp').onclick = () => {
  const t = data.code || data.full;
  if (!t) return;
  navigator.clipboard?.writeText(t).then(() => note('Copied to clipboard'), () => note('Clipboard access denied — copy manually'));
};

$('dl').onclick = () => {
  const t = data.code || data.full;
  if (!t) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([t], { type: 'text/plain' }));
  a.download = data.code ? 'script.' + (data.lang || 'txt').replace(/[^a-z0-9]/gi, '') : 'answer.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
};

$('exp').onclick = () => $('dl').click();

$('new').onclick = () => {
  turns = [];
  data = { sec: {}, code: '', lang: '', full: '' };
  view = 'Script';
  $('q').value = '';
  $('m1').textContent = 'Waiting for a task';
  $('m2').textContent = '—';
  $('tl').innerHTML = '';
  tabs(); fill(); showCode();
  note('New pipeline started.');
  status('Ready');
};

document.querySelectorAll('aside nav a').forEach((a) => a.addEventListener('click', () => {
  document.querySelectorAll('aside nav a').forEach((x) => x.classList.remove('on'));
  a.classList.add('on');
}));

tabs();
note('Studio ready. Describe a task to begin.');
