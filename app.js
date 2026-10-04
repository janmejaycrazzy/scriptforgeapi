/* ScriptForge AI — external script (CSP-compliant: script-src 'self') */
/* No CDN dependencies, no inline eval */
const API_URL = 'https://scriptforge-api.janmejay-crazzy.workers.dev';
// API_KEY is injected at build-time or via config — NEVER commit it to source.
// Set via your build pipeline or edit this value locally for dev.
const API_KEY = '';
const MAX_TURNS = 20;
const MAX_MSG_LEN = 4000;

const EXT = {
  powershell: 'ps1', ps1: 'ps1',
  python: 'py', py: 'py',
  bash: 'sh', sh: 'sh',
  batch: 'bat', bat: 'bat',
  terraform: 'tf', hcl: 'tf',
  yaml: 'yml', yml: 'yml',
  json: 'json',
  javascript: 'js', js: 'js',
  vbscript: 'vbs', vbs: 'vbs',
};

const $ = (id) => document.getElementById(id);
const prefs = { lang: 'PowerShell', pack: 'Self-contained EXE', plat: 'Windows' };
let turns = [], busy = false, view = 'Script', data = { sec: {}, code: '', lang: '', full: '' };

/* ---- UI wire-up ---- */
document.querySelectorAll('.seg').forEach((s) => s.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  s.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  prefs[s.dataset.k] = b.textContent.trim();
}));

['Bulk-create Azure AD users from a CSV', 'Back up SQL databases nightly', 'Disk space monitor with email alerts', 'Silent-install software on many PCs'].forEach((t) => {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = t;
  b.onclick = () => { $('q').value = t; $('q').focus(); };
  $('chips').appendChild(b);
});

/* ---- Helpers ---- */
function note(msg) {
  const d = document.createElement('div');
  const t = new Date().toTimeString().slice(0, 8);
  const i = document.createElement('i');
  i.textContent = '[' + t + ']';
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
  while ((m = re.exec(t))) {
    marks.push({ k: m[1].trim().toUpperCase(), s: m.index, e: re.lastIndex });
  }
  const sec = {};
  marks.forEach((x, i) => {
    sec[x.k] = t.slice(x.e, i + 1 < marks.length ? marks[i + 1].s : t.length).trim();
  });
  const c = t.match(/```(\w*)\n([\s\S]*?)```/);
  return {
    sec,
    lang: c ? c[1].toLowerCase() : '',
    code: c ? c[2].replace(/\s+$/, '') : '',
    full: t,
  };
}

function setBody(id, txt, ph) {
  const e = $(id);
  e.textContent = txt || ph;
  e.classList.toggle('empty', !txt);
}

function showCode() {
  const box = $('code');
  box.textContent = '';

  let txt, isCode = false;
  if (view === 'Script') {
    txt = data.code;
    isCode = !!txt;
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
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'Nothing here yet. Describe a task and click Synthesize script.';
    box.appendChild(d);
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
  t.textContent = '';
  [
    ['Script', 'terminal'],
    ['Usage', 'menu_book'],
    ['Full answer', 'description'],
  ].forEach(([n, ic]) => {
    const b = document.createElement('button');
    b.className = 'tab' + (n === view ? ' on' : '');
    const i = document.createElement('span');
    i.className = 'mi';
    i.textContent = ic;
    b.append(i, n);
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
  $('p1').textContent = data.lang ? data.lang : prefs.lang;
  $('p2').textContent = prefs.pack;
}

/* ---- Main action ---- */
async function run() {
  const q = $('q').value.trim();
  if (!q || busy) return;

  /* client-side input cap */
  if (q.length > MAX_MSG_LEN) {
    status('Error', 'err');
    note('Prompt exceeds ' + MAX_MSG_LEN + ' characters — truncated by the browser.');
    $('go').disabled = false;
    return;
  }

  busy = true;
  $('go').disabled = true;
  status('Forging…', 'busy');

  const msg = q + '\n\n(Preferences: language ' + prefs.lang + '; packaging ' + prefs.pack + '; target platform ' + prefs.plat + '.)';
  turns.push({ role: 'user', content: msg });
  if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS);
  note('Request sent: ' + q.slice(0, 70));

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['x-api-key'] = API_KEY;

    const r = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: turns }),
    });

    if (!r.ok) {
      let m = '';
      try { m = (await r.json()).error || ''; } catch (_) {}
      throw new Error('HTTP ' + r.status + (m ? ' - ' + m : ''));
    }

    const res = await r.json();
    turns.push({ role: 'assistant', content: res.text });
    note('Answer received (' + res.text.length + ' characters)');

    data = parse(res.text);
    const found = Object.keys(data.sec).length;
    note(found ? 'Sections found: ' + found : 'Follow-up answer (no sections)');
    view = data.code ? 'Script' : 'Full answer';
    tabs();
    fill();
    showCode();
    status('Ready');
  } catch (e) {
    turns.pop();
    const isRate = /429/.test(e && e.message);
    note(isRate ? 'Rate limit reached. Wait a minute and try again.' : 'Request failed. Check the API endpoint and try again.');
    status('Error', 'err');
  }

  busy = false;
  $('go').disabled = false;
}

function save(name, txt) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}

$('go').onclick = run;
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    run();
  }
});
$('q').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 130) + 'px';
});

$('cp').onclick = () => {
  const t = data.code || data.full;
  if (!t) return;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).then(
      () => note('Copied to clipboard'),
      () => note('Clipboard access denied — copy manually')
    );
  } else {
    note('Clipboard blocked — copy manually');
  }
};

const dl = () => {
  if (data.code) save('script.' + (EXT[data.lang] || 'txt'), data.code);
  else if (data.full) save('answer.txt', data.full);
};

$('dl').onclick = dl;
$('exp').onclick = dl;

$('new').onclick = () => {
  turns = [];
  data = { sec: {}, code: '', lang: '', full: '' };
  view = 'Script';
  $('q').value = '';
  tabs();
  fill();
  showCode();
  $('m1').textContent = 'Waiting for a task';
  $('m2').textContent = '—';
  $('tl').textContent = '';
  note('New pipeline started');
  status('Ready');
};

document.querySelectorAll('aside nav a').forEach((a) => a.addEventListener('click', () => {
  document.querySelectorAll('aside nav a').forEach((x) => x.classList.remove('on'));
  a.classList.add('on');
}));

tabs();
note('Studio ready. Describe a task to begin.');
