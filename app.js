const API_URL = 'https://scriptforge-api.janmejay-crazzy.workers.dev';
const API_KEY = ''; // ponytail: empty API key - set via env var or config

const $ = (id) => document.getElementById(id);
let turns = [], busy = false, data = { code: '', full: '' };

// Security constants
const MAX_TURNS = 10;
const MAX_INPUT_LENGTH = 2000;
const RATE_LIMIT_MS = 3000; // 3 second cooldown between requests

let lastRequestTime = 0;

// Input sanitization
function sanitizeInput(input) {
  return input
    .replace(/[<>]/g, '') // Remove angle brackets
    .replace(/javascript:/gi, '') // Remove javascript: protocol
    .replace(/on\w+=/gi, '') // Remove event handlers
    .trim()
    .slice(0, MAX_INPUT_LENGTH);
}

async function run() {
  const q = sanitizeInput($('q').value);
  if (!q || busy) return;

  // Rate limiting
  const now = Date.now();
  if (now - lastRequestTime < RATE_LIMIT_MS) {
    $('code').textContent = `Please wait ${Math.ceil((RATE_LIMIT_MS - (now - lastRequestTime)) / 1000)} seconds before next request.`;
    return;
  }
  lastRequestTime = now;

  // Input validation
  if (q.length < 5) {
    $('code').textContent = 'Please provide a more detailed description (minimum 5 characters).';
    return;
  }

  busy = true;
  $('go').disabled = true;

  turns.push({ role: 'user', content: q });
  if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS); // Limit conversation history

  try {
    // Validate API_KEY exists
    if (!API_KEY) {
      throw new Error('API key not configured');
    }

    const headers = { 'Content-Type': 'application/json' };
    headers['x-api-key'] = API_KEY;

    // Request timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    // Validate response before processing
    const r = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: turns }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!r.ok) {
      throw new Error(`API error: ${r.status}`);
    }

    const res = await r.json();

    // Validate response structure
    if (!res || typeof res.text !== 'string') {
      throw new Error('Invalid API response format');
    }

    // Response size validation
    if (res.text.length > 50000) { // 50KB limit
      throw new Error('Response too large');
    }

    turns.push({ role: 'assistant', content: res.text });

    data.full = res.text;
    const match = res.text.match(/```\w*\n([\s\S]*?)```/);
    data.code = match ? match[1] : '';

    // Enhanced sanitization for display
    const sanitized = (data.code || data.full || 'No response')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/&/g, '&amp;'); // Additional ampersand encoding

    $('code').innerHTML = sanitized; // Use innerHTML since we've properly encoded
  } catch (e) {
    // Clear sensitive data on error
    turns.pop();

    // Don't leak error details
    if (e.name === 'AbortError') {
      $('code').textContent = 'Request timed out. Please try again.';
    } else {
      $('code').textContent = 'Request failed. Please try again.';
    }
    console.error('API request failed:', e.message);
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
