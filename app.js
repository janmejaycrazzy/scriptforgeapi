const API_URL = 'https://scriptforge-api.janmejay-crazzy.workers.dev';
const API_KEY = '';

const $ = (id) => document.getElementById(id);
let turns = [], busy = false, data = { code: '', full: '' };

async function run() {
  const q = $('q').value.trim();
  if (!q || busy) return;

  busy = true;
  $('go').disabled = true;

  turns.push({ role: 'user', content: q });

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['x-api-key'] = API_KEY;

    const r = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: turns }),
    });

    const res = await r.json();
    turns.push({ role: 'assistant', content: res.text });

    data.full = res.text;
    const match = res.text.match(/```\w*\n([\s\S]*?)```/);
    data.code = match ? match[1] : '';

    $('code').textContent = data.code || data.full || 'No response';
  } catch (e) {
    $('code').textContent = 'Request failed';
  }

  busy = false;
  $('go').disabled = false;
}

$('go').onclick = run;
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    run();
  }
});

$('cp').onclick = () => navigator.clipboard?.writeText(data.code || data.full);
$('dl').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data.code || data.full]));
  a.download = 'script.txt';
  a.click();
};
