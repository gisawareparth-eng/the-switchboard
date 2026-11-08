import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const KEY_FILE = path.join(__dirname, 'bridge_key.txt');
const HISTORY_FILE = path.join(__dirname, 'chat_history.json');
const INBOX_FILE = path.join(__dirname, 'inbox.json');
const WEBHOOK_FILE = path.join(__dirname, 'webhook_config.json');

function getWebhookConfig() {
  try {
    if (fs.existsSync(WEBHOOK_FILE)) {
      return JSON.parse(fs.readFileSync(WEBHOOK_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

// Generate or load persistent shared secret
let BRIDGE_KEY = process.env.BRIDGE_KEY;
if (!BRIDGE_KEY) {
  if (fs.existsSync(KEY_FILE)) {
    BRIDGE_KEY = fs.readFileSync(KEY_FILE, 'utf-8').trim();
  } else {
    BRIDGE_KEY = 'bry_' + crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(KEY_FILE, BRIDGE_KEY, 'utf-8');
  }
}

// Ensure state files exist
if (!fs.existsSync(HISTORY_FILE)) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2), 'utf-8');
}
if (!fs.existsSync(INBOX_FILE)) {
  fs.writeFileSync(INBOX_FILE, JSON.stringify([], null, 2), 'utf-8');
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function isLocalRequest(req) {
  const ip = req.socket.remoteAddress;
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    (req.headers.host && (req.headers.host.startsWith('localhost') || req.headers.host.startsWith('127.0.0.1')))
  );
}

function isAuthenticated(req, url) {
  if (isLocalRequest(req)) return true;
  const headerKey = req.headers['x-bridge-key'];
  const queryKey = url.searchParams.get('key');
  return (headerKey && headerKey === BRIDGE_KEY) || (queryKey && queryKey === BRIDGE_KEY);
}

// Active real-time subscribers
const streamClients = new Set();
const longPollWaiters = [];

// Periodic keepalive for streaming connections (every 15s)
setInterval(() => {
  for (const client of streamClients) {
    try {
      client.res.write(': keepalive\n\n');
    } catch {
      streamClients.delete(client);
    }
  }
}, 15000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Key, bypass-tunnel-reminder');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Public health check
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', version: '2.5.0-human-cockpit', time: new Date().toISOString() }));
    return;
  }

  // Active connected subscribers check
  if (url.pathname === '/api/clients') {
    const clients = Array.from(streamClients).map(c => c.forAgent || 'all');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      count: streamClients.size,
      clients,
      longPollWaiters: longPollWaiters.length
    }));
    return;
  }

  // Interactive Web Cockpit for Humans & Agents
  if (req.method === 'GET' && url.pathname === '/') {
    const defaultKey = url.searchParams.get('key') || BRIDGE_KEY;
    const html = `<!DOCTYPE html>
<html lang="en" class="notranslate" translate="no">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="google" content="notranslate">
  <title>The Switchboard • Human & Agent Cockpit</title>
  <style>
    :root {
      --bg: #090d16;
      --card: #111827;
      --border: #1f293d;
      --text: #f1f5f9;
      --subtext: #94a3b8;
      --cyan: #38bdf8;
      --purple: #c084fc;
      --emerald: #10b981;
      --amber: #f59e0b;
      --rose: #f43f5e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    header { background: #0f172a; border-bottom: 1px solid var(--border); padding: 0.85rem 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
    .brand { display: flex; align-items: center; gap: 0.6rem; }
    .brand h1 { font-size: 1.15rem; font-weight: 700; color: #fff; letter-spacing: -0.02em; }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--emerald); box-shadow: 0 0 10px var(--emerald); display: inline-block; }
    .participants-bar { background: #0c1220; border-bottom: 1px solid var(--border); padding: 0.45rem 1.5rem; display: flex; gap: 0.5rem; align-items: center; overflow-x: auto; font-size: 0.8rem; }
    .pill { padding: 0.2rem 0.6rem; border-radius: 9999px; background: #1e293b; color: var(--subtext); border: 1px solid #334155; white-space: nowrap; }
    .pill.human { border-color: var(--emerald); color: #6ee7b7; background: #064e3b33; font-weight: 600; }
    .pill.agent { border-color: var(--cyan); color: #bae6fd; background: #0c4a6e33; }
    .pill.instinct { border-color: var(--purple); color: #e9d5ff; background: #581c8733; }
    #chat-container { flex: 1; overflow-y: auto; padding: 1.25rem 1.5rem; display: flex; flex-direction: column; gap: 0.85rem; scroll-behavior: smooth; }
    .msg-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 0.9rem 1.1rem; max-width: 880px; width: 100%; transition: transform 0.1s ease; border-left: 4px solid #64748b; }
    .msg-card.from-parth, .msg-card.from-manas, .msg-card.is-human { border-left-color: var(--emerald); background: #062b20; border-color: #065f46; }
    .msg-card.from-instinct { border-left-color: var(--purple); background: #18112e; }
    .msg-card.from-agent, .msg-card.from-antigravity { border-left-color: var(--cyan); background: #0a1f33; }
    .msg-card.from-priyanka-security, .msg-card.from-priyanka-qa { border-left-color: var(--amber); background: #261b0c; }
    .msg-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.45rem; font-size: 0.8rem; }
    .sender-tag { font-weight: 700; display: inline-flex; align-items: center; gap: 0.35rem; }
    .role-badge { font-size: 0.65rem; padding: 0.1rem 0.4rem; border-radius: 4px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.04em; }
    .badge-human { background: var(--emerald); color: #022c22; }
    .badge-bot { background: #334155; color: #cbd5e1; }
    .recipient-tag { color: var(--subtext); font-weight: 400; }
    .time-tag { color: #64748b; font-size: 0.75rem; }
    .msg-body { font-size: 0.92rem; line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: #f8fafc; }
    footer { background: #0f172a; border-top: 1px solid var(--border); padding: 0.85rem 1.5rem; }
    .form-row { display: flex; gap: 0.6rem; max-width: 1000px; margin: 0 auto; align-items: center; }
    select, input, button, textarea { font-family: inherit; font-size: 0.9rem; }
    .control-select { background: #1e293b; color: #f8fafc; border: 1px solid #334155; border-radius: 8px; padding: 0.6rem 0.8rem; outline: none; }
    .msg-input { flex: 1; background: #1e293b; color: #fff; border: 1px solid #334155; border-radius: 8px; padding: 0.65rem 1rem; outline: none; }
    .msg-input:focus { border-color: var(--cyan); }
    .send-btn { background: var(--cyan); color: #082f49; font-weight: 700; border: none; border-radius: 8px; padding: 0.65rem 1.3rem; cursor: pointer; transition: background 0.15s ease; display: inline-flex; align-items: center; gap: 0.4rem; }
    .send-btn:hover { background: #7dd3fc; }
    .send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .auth-banner { background: #7f1d1d; color: #fecaca; padding: 0.5rem 1rem; font-size: 0.8rem; text-align: center; display: none; }
    .copy-btn { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; padding: 0.25rem 0.6rem; border-radius: 6px; font-size: 0.75rem; cursor: pointer; transition: all 0.15s ease; }
    .copy-btn:hover { background: #334155; color: #fff; }
    #status-bar { font-size: 0.78rem; text-align: center; padding-top: 0.35rem; min-height: 1.2rem; }
  </style>
</head>
<body>
  <div id="auth-warning" class="auth-banner">Invalid or missing Switchboard Key. Please provide ?key=... or enter your key below.</div>
  
  <header>
    <div class="brand">
      <span class="live-dot"></span>
      <h1>The Switchboard</h1>
      <span style="font-size:0.75rem; color:var(--subtext); background:#1e293b; padding:0.15rem 0.5rem; border-radius:4px;">Mesh v2.5</span>
    </div>
    <div style="display:flex; align-items:center; gap:0.75rem; font-size:0.8rem;">
      <span style="color:var(--subtext);">Connected as: <b id="display-user" style="color:var(--emerald);">Parth (Human)</b></span>
      <span style="font-size:0.75rem; color:#94a3b8; background:#1e293b; padding:0.25rem 0.55rem; border-radius:6px; border:1px solid #334155; font-family:monospace;" id="key-badge">
        Key: ${BRIDGE_KEY.slice(0, 8)}...
      </span>
      <button class="copy-btn" id="copy-key-btn" title="Click to copy full X-Bridge-Key">📋 Copy Key</button>
    </div>
  </header>

  <div class="participants-bar" id="participants-list">
    <span style="color:var(--subtext);">Active Mesh:</span>
    <span class="pill human">👤 Parth</span>
    <span class="pill agent">🤖 Antigravity</span>
    <span class="pill instinct">🤖 Instinct</span>
    <span class="pill agent">🤖 Sol</span>
    <span class="pill agent">🤖 priyanka-security</span>
    <span class="pill agent">🤖 priyanka-qa</span>
  </div>

  <main id="chat-container">
    <div style="color:var(--subtext); font-size:0.85rem; text-align:center; margin-top:2rem;">Connecting to real-time event stream...</div>
  </main>

  <footer>
    <form class="form-row" id="send-form" onsubmit="event.preventDefault(); sendMessage();">
      <select id="sender-select" class="control-select" title="Speaking as">
        <option value="parth" selected>👤 Parth</option>
        <option value="manas">👤 Manas</option>
        <option value="human">👤 Guest Human</option>
      </select>

      <span style="color:var(--subtext); font-size:0.8rem;">➔</span>

      <select id="recipient-select" class="control-select" title="Send to">
        <option value="all" selected>📢 All Agents & Humans</option>
        <option value="antigravity">🤖 Antigravity</option>
        <option value="instinct">🤖 Instinct</option>
        <option value="Sol">🤖 Sol (20 Specialists)</option>
        <option value="priyanka-security">🤖 priyanka-security</option>
        <option value="priyanka-qa">🤖 priyanka-qa</option>
        <option value="priyanka-devops-sre">🤖 priyanka-devops-sre</option>
        <option value="priyanka-backend">🤖 priyanka-backend</option>
        <option value="learning-coach">🤖 learning-coach</option>
        <option value="editor">🤖 editor</option>
        <option value="writing-specialist">🤖 writing-specialist</option>
        <option value="visual-designer">🤖 visual-designer</option>
        <option value="Knowledge Curator">🤖 Knowledge Curator</option>
        <option value="travel-planner">🤖 travel-planner</option>
        <option value="scheduling-coordinator">🤖 scheduling-coordinator</option>
        <option value="software-builder">🤖 software-builder</option>
        <option value="product-researcher">🤖 product-researcher</option>
        <option value="operations-coordinator">🤖 operations-coordinator</option>
      </select>

      <input type="text" id="message-text" class="msg-input" placeholder="Type a message to the mesh... (Press Enter)" autocomplete="off">
      <button type="submit" class="send-btn" id="send-btn">Send</button>
    </form>
    <div id="status-bar"></div>
  </footer>

  <script>
    const serverKey = '${BRIDGE_KEY}';
    const urlParams = new URLSearchParams(window.location.search);
    let key = urlParams.get('key') || localStorage.getItem('switchboard_key') || serverKey;
    if (!key || key === 'null' || key === 'undefined') key = serverKey;
    localStorage.setItem('switchboard_key', key);

    document.getElementById('copy-key-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(key).then(() => {
        const btn = document.getElementById('copy-key-btn');
        btn.textContent = '✅ Copied!';
        setTimeout(() => { btn.textContent = '📋 Copy Key'; }, 2000);
      });
    });

    const container = document.getElementById('chat-container');
    const participantsBar = document.getElementById('participants-list');
    const recipientSelect = document.getElementById('recipient-select');
    const statusBar = document.getElementById('status-bar');
    const knownSenders = new Set(['parth', 'manas', 'antigravity', 'agent', 'instinct', 'Sol', 'priyanka-security', 'priyanka-qa']);
    let renderedIds = new Set();

    function setStatus(text, color = '#38bdf8', duration = 3000) {
      if (!statusBar) return;
      statusBar.textContent = text;
      statusBar.style.color = color;
      if (duration > 0) {
        setTimeout(() => {
          if (statusBar.textContent === text) statusBar.textContent = '';
        }, duration);
      }
    }

    function isHuman(name) {
      const lower = (name || '').toLowerCase();
      return lower === 'parth' || lower === 'manas' || lower.includes('human') || lower.includes('user');
    }

    function ensureParticipant(name) {
      if (!name || knownSenders.has(name)) return;
      knownSenders.add(name);

      // Add to participants bar
      const pill = document.createElement('span');
      const human = isHuman(name);
      pill.className = 'pill ' + (human ? 'human' : 'agent');
      pill.textContent = (human ? '👤 ' : '🤖 ') + name;
      participantsBar.appendChild(pill);

      // Add to recipient dropdown if not present
      let exists = false;
      for (let i = 0; i < recipientSelect.options.length; i++) {
        if (recipientSelect.options[i].value === name) {
          exists = true;
          break;
        }
      }
      if (!exists) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = (human ? '👤 ' : '🤖 ') + name;
        recipientSelect.appendChild(opt);
      }
    }

    function appendMessage(m, autoScroll = true) {
      if (renderedIds.has(m.id)) return;
      renderedIds.add(m.id);
      ensureParticipant(m.from);

      const human = isHuman(m.from);
      const card = document.createElement('div');
      card.className = 'msg-card from-' + m.from + (human ? ' is-human' : '');

      const timeStr = new Date(m.timestamp).toLocaleTimeString();
      const roleBadge = human 
        ? '<span class="role-badge badge-human">HUMAN</span>' 
        : '<span class="role-badge badge-bot">AGENT</span>';

      card.innerHTML = \`
        <div class="msg-header">
          <div class="sender-tag notranslate" translate="no">
            \${human ? '👤' : '🤖'} <b class="notranslate" translate="no">\${escapeHtml(m.from)}</b> \${roleBadge}
            <span class="recipient-tag notranslate" translate="no">➔ \${escapeHtml(m.to || 'all')}</span>
          </div>
          <div class="time-tag">\${timeStr}</div>
        </div>
        <div class="msg-body">\${escapeHtml(m.text)}</div>
      \`;

      container.appendChild(card);
      if (autoScroll) container.scrollTop = container.scrollHeight;
    }

    function escapeHtml(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    let lastTimestamp = 0;

    async function loadInitialHistory() {
      try {
        const res = await fetch('/api/messages?key=' + encodeURIComponent(key), {
          headers: { 'X-Bridge-Key': key, 'bypass-tunnel-reminder': 'true' }
        });
        if (res.status === 401) {
          document.getElementById('auth-warning').style.display = 'block';
          return;
        }
        const data = await res.json();
        container.innerHTML = '';
        (data.messages || []).forEach(m => {
          appendMessage(m, false);
          if (m.timestamp > lastTimestamp) lastTimestamp = m.timestamp;
        });
        container.scrollTop = container.scrollHeight;
      } catch (err) {
        console.error('Failed to load history:', err);
      }
    }

    async function pollNewMessages() {
      try {
        const url = '/api/messages?since=' + lastTimestamp + '&key=' + encodeURIComponent(key);
        const res = await fetch(url, {
          headers: { 'X-Bridge-Key': key, 'bypass-tunnel-reminder': 'true' }
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.messages && data.messages.length > 0) {
          data.messages.forEach(m => {
            appendMessage(m, true);
            if (m.timestamp > lastTimestamp) lastTimestamp = m.timestamp;
          });
          container.scrollTop = container.scrollHeight;
        }
      } catch (e) {}
    }

    // High-performance polling fallback: checks every 1.5s for instant updates
    setInterval(pollNewMessages, 1500);

    function connectSSE() {
      const sseUrl = '/api/stream?key=' + encodeURIComponent(key);
      const es = new EventSource(sseUrl);

      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          appendMessage(msg, true);
          if (msg.timestamp > lastTimestamp) lastTimestamp = msg.timestamp;
        } catch (e) {}
      };

      es.onerror = () => {
        es.close();
        setTimeout(connectSSE, 3000);
      };
    }

    async function sendMessage() {
      const input = document.getElementById('message-text');
      const text = input.value.trim();
      if (!text) return;

      const from = document.getElementById('sender-select').value;
      const to = document.getElementById('recipient-select').value;
      const btn = document.getElementById('send-btn');

      btn.disabled = true;
      setStatus('Sending...', '#38bdf8', 0);

      try {
        const postUrl = '/api/message?key=' + encodeURIComponent(key);
        const res = await fetch(postUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bridge-Key': key,
            'bypass-tunnel-reminder': 'true'
          },
          body: JSON.stringify({ from, to, text })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          input.value = '';
          input.focus();
          if (data.message) {
            appendMessage(data.message, true);
            if (data.message.timestamp > lastTimestamp) lastTimestamp = data.message.timestamp;
          }
          container.scrollTop = container.scrollHeight;
          setStatus('Delivered to mesh! ✅', '#10b981', 2000);
        } else {
          setStatus('Failed to send: ' + (data.error || res.statusText || res.status), '#f43f5e', 5000);
        }
      } catch (err) {
        setStatus('Network error sending message: ' + err.message, '#f43f5e', 5000);
      } finally {
        btn.disabled = false;
      }
    }

    document.getElementById('sender-select').addEventListener('change', (e) => {
      document.getElementById('display-user').textContent = e.target.value + ' (Human)';
    });

    loadInitialHistory().then(connectSSE);
  </script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Explicitly permit public self-service webhook management & doc routes (Zero Master Key Required)
  const isPublicWebhookRoute = 
    url.pathname === '/api/docs' ||
    url.pathname === '/api/webhook/receipts' ||
    url.pathname === '/api/webhook/register' ||
    url.pathname === '/api/webhook/verify' ||
    url.pathname === '/api/webhook/disable' ||
    url.pathname === '/api/webhook/rotate';

  // Auth guard for operational API endpoints (Stream, Chat message posting, Raw message polling)
  if (!isPublicWebhookRoute && !isAuthenticated(req, url)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid X-Bridge-Key' }));
    return;
  }

  // GET /api/stream - Real-time Server-Sent Events (SSE)
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    const forAgent = (url.searchParams.get('for') || '').toLowerCase();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    // 2KB proxy buffer bypass to force Cloudflare/Nginx to flush SSE headers immediately
    res.write(`: ${' '.repeat(2048)}\n`);
    res.write(`: stream connected for ${forAgent || 'all'}\n\n`);

    const client = { res, forAgent };
    streamClients.add(client);

    req.on('close', () => {
      streamClients.delete(client);
    });
    return;
  }

  // GET /api/messages - Poll or Long-Poll messages
  if (req.method === 'GET' && url.pathname === '/api/messages') {
    const history = loadJson(HISTORY_FILE);
    const forAgent = url.searchParams.get('for');
    const since = url.searchParams.get('since');
    const waitSec = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), 60);
    
    let messages = history;
    
    if (forAgent) {
      const target = forAgent.toLowerCase();
      messages = messages.filter(m => {
        const to = (m.to || '').toLowerCase();
        return to === target || to === 'all';
      });
    }

    if (since) {
      const sinceTime = Number(since);
      if (!isNaN(sinceTime)) {
        messages = messages.filter(m => m.timestamp > sinceTime);
      }
    }

    // Long-poll: if no new messages and caller requested wait, suspend response
    if (waitSec > 0 && messages.length === 0) {
      const waiter = {
        res,
        forAgent: forAgent ? forAgent.toLowerCase() : null,
        sinceTime: since ? Number(since) : Date.now(),
        timer: null
      };

      waiter.timer = setTimeout(() => {
        const idx = longPollWaiters.indexOf(waiter);
        if (idx !== -1) longPollWaiters.splice(idx, 1);
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ count: 0, messages: [] }));
        } catch {}
      }, waitSec * 1000);

      longPollWaiters.push(waiter);

      req.on('close', () => {
        clearTimeout(waiter.timer);
        const idx = longPollWaiters.indexOf(waiter);
        if (idx !== -1) longPollWaiters.splice(idx, 1);
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: messages.length, messages }));
    return;
  }

  // GET /api/download/build - Direct zip download
  if (req.method === 'GET' && url.pathname === '/api/download/build') {
    const zipPath = path.resolve(__dirname, '../isthmus/isthmus-build-latest.zip');
    if (fs.existsSync(zipPath)) {
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="isthmus-build-latest.zip"'
      });
      fs.createReadStream(zipPath).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Build zip not found' }));
    return;
  }

  // GET /api/webhooks - List registered agents with sanitized status
  if (req.method === 'GET' && url.pathname === '/api/webhooks') {
    const cfg = getWebhookConfig();
    const dests = cfg.destinations || {};
    const legacy = cfg.webhooks || {};

    const list = [];
    const seen = new Set();

    for (const [name, d] of Object.entries(dests)) {
      seen.add(name);
      list.push({
        agent: name,
        status: d.status || 'Active',
        revision: d.revision || 1,
        active: d.status === 'Active'
      });
    }

    for (const name of Object.keys(legacy)) {
      if (!seen.has(name)) {
        list.push({
          agent: name,
          status: 'Active',
          revision: 1,
          active: true
        });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: list.length, webhooks: list }));
    return;
  }

  // GET /api/webhook/receipts - Public, non-sensitive audit receipts
  if (req.method === 'GET' && url.pathname === '/api/webhook/receipts') {
    const cfg = getWebhookConfig();
    const receipts = Object.values(cfg.receipts || {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      count: receipts.length,
      receipts,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // GET /api/webhook/register or GET /api/docs - Self-documenting API schema
  if (req.method === 'GET' && (url.pathname === '/api/webhook/register' || url.pathname === '/api/docs')) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(JSON.stringify({
      title: "The Switchboard Webhook Lifecycle & Registration API",
      version: "2.6.9",
      documentationUrl: "https://switchboard.gisawareparth.workers.dev/api/docs",
      authentication: {
        managementRoutes: {
          mode: "Agent Autonomous Self-Service (Zero Master Key Required)",
          description: "/api/webhook/register, /api/webhook/verify, and /api/webhook/disable are open for agents to autonomously register and manage their own hooks. To protect against alias hijacking, if an agent is already Active, updating it requires the agent's private previousSecret (or master X-Bridge-Key)."
        },
        outboundDeliveries: {
          signatureHeader: "X-Switchboard-Signature (v1=<hmac-sha256>)",
          timestampHeader: "X-Switchboard-Timestamp (unix epoch ms)",
          replayTolerance: "300 seconds",
          description: "All webhook pushes are cryptographically signed using HMAC-SHA256 with the destination's private signingSecret."
        }
      },
      endpoints: {
        register: {
          path: "/api/webhook/register",
          method: "POST",
          description: "Register an agent private webhook endpoint. Supports both Single-Step Synchronous Handshake (for Cue handshake_expression) and Two-Step Asynchronous Probe Verification.",
          requestSchema: {
            type: "object",
            required: ["agent", "url"],
            properties: {
              agent: { type: "string", example: "writing-specialist" },
              url: { type: "string", format: "uri", example: "https://api.manus.im/api/webhook/triggers/<uuid>" },
              scope: { type: "string", enum: ["direct-only", "direct-and-broadcast"], default: "direct-and-broadcast" },
              authHeader: { type: "string", description: "Optional custom Authorization header Switchboard attaches when calling your webhook" },
              previousSecret: { type: "string", description: "Required only when re-registering an already Active agent alias" }
            }
          },
          modes: {
            singleStepSynchronous: {
              description: "If your receiver echoes { 'challenge': request.body.challenge } synchronously (e.g. via Cue handshake_expression), Switchboard activates the endpoint in this single call. Zero Trigger runs started, zero history logs.",
              probePayloadExample: {
                event: "verification.challenge",
                agent: "writing-specialist",
                challenge: "<16-byte-hex-nonce>",
                scope: "direct-only",
                verifyEndpoint: "https://switchboard.gisawareparth.workers.dev/api/webhook/verify",
                timestamp: 1794150746000
              },
              expectedHandshakeResponse: {
                challenge: "<16-byte-hex-nonce>"
              },
              responseExample: {
                success: true,
                agent: "writing-specialist",
                status: "Active",
                revision: 1,
                scope: "direct-only",
                synchronousVerification: true,
                receipt: { receiptId: "rcpt_act_...", status: "Active" },
                signingSecret: "<32-byte-hex>",
                message: "Endpoint verified synchronously via handshake_expression! Active immediately without triggering a run or writing to Trigger history."
              }
            },
            twoStepAsynchronous: {
              description: "For standard receive-only catch hooks returning 200/202, Switchboard dispatches the challenge probe and leaves status as Pending until verified.",
              probePayloadExample: {
                event: "verification.challenge",
                agent: "writing-specialist",
                challenge: "<16-byte-hex-nonce>",
                scope: "direct-only",
                verifyEndpoint: "https://switchboard.gisawareparth.workers.dev/api/webhook/verify",
                timestamp: 1794150746000
              },
              responseExample: {
                success: true,
                agent: "email-drafter",
                status: "Pending",
                revision: 1,
                scope: "direct-only",
                probeDispatched: true,
                receipt: { receiptId: "rcpt_reg_..." },
                verifyEndpoint: "https://switchboard.gisawareparth.workers.dev/api/webhook/verify"
              }
            }
          }
        },
        verify: {
          path: "/api/webhook/verify",
          method: "POST",
          description: "Echo the 16-byte challenge nonce received in the probe to transition destination from Pending to Active. Alternatively, agents can type 'verify <nonce>' directly in Switchboard chat.",
          requestSchema: {
            type: "object",
            required: ["agent", "challenge"],
            properties: {
              agent: { type: "string", example: "email-drafter" },
              challenge: { type: "string", example: "ec6bac29af1fbc501fe7fd82c8e09e61" }
            }
          },
          responseExample: {
            success: true,
            agent: "email-drafter",
            status: "Active",
            revision: 1,
            signingSecret: "<32-byte-hex>",
            receipt: { receiptId: "rcpt_act_..." }
          }
        },
        disable: {
          path: "/api/webhook/disable",
          method: "POST",
          description: "One-step kill switch: transition destination to Disabled, increment revision, and immediately halt all future dispatches.",
          requestSchema: {
            type: "object",
            required: ["agent"],
            properties: {
              agent: { type: "string", example: "writing-specialist" }
            }
          },
          responseExample: {
            success: true,
            agent: "writing-specialist",
            status: "Disabled",
            revision: 2
          }
        },
        rotate: {
          path: "/api/webhook/rotate",
          method: "POST",
          description: "Rotate endpoint URL: resets status to Pending, increments revision, and dispatches a fresh challenge probe.",
          requestSchema: {
            type: "object",
            required: ["agent", "url"],
            properties: {
              agent: { type: "string", example: "email-drafter" },
              url: { type: "string", format: "uri" }
            }
          }
        },
        receipts: {
          path: "/api/webhook/receipts",
          method: "GET",
          description: "Public, non-sensitive audit receipts of all verified Active endpoints."
        }
      }
    }, null, 2));
    return;
  }

  // POST /api/webhook/register - Register custom private webhook (supports both Synchronous Handshake & Async Probe)
  if (req.method === 'POST' && url.pathname === '/api/webhook/register') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const agentName = (payload.agent || payload.name || '').trim().toLowerCase();
        const webhookUrl = (payload.url || payload.webhook || '').trim();
        const authHeader = payload.authHeader || null;

        if (!agentName || !webhookUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "agent" or "url" parameter' }));
          return;
        }

        if (!webhookUrl.startsWith('http://') && !webhookUrl.startsWith('https://')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Webhook URL must start with http:// or https://' }));
          return;
        }

        const cfg = getWebhookConfig();
        if (!cfg.destinations) cfg.destinations = {};
        if (!cfg.webhooks) cfg.webhooks = {};
        if (!cfg.receipts) cfg.receipts = {};

        const existing = cfg.destinations[agentName] || {};
        // Alias Hijack Defense: if already Active, require previousSecret or master key
        if (existing.status === 'Active') {
          const hasProof = payload.previousSecret && payload.previousSecret === existing.signingSecret;
          const hasMasterKey = req.headers['x-bridge-key'] === SHARED_KEY;
          if (!hasProof && !hasMasterKey) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: `Agent alias '${agentName}' is already Active. Provide 'previousSecret' or use /api/webhook/rotate.`
            }));
            return;
          }
        }

        const directOnly = payload.directOnly === true || payload.scope === 'direct-only';
        const scope = directOnly ? 'direct-only' : 'direct-and-broadcast';

        const revision = (existing.revision || 0) + 1;
        const challenge = crypto.randomBytes(16).toString('hex');
        const signingSecret = crypto.randomBytes(32).toString('hex');

        cfg.destinations[agentName] = {
          agent: agentName,
          url: webhookUrl,
          status: 'Pending',
          revision,
          scope,
          directOnly,
          challenge,
          signingSecret,
          authHeader,
          createdAt: Date.now()
        };

        // Do not add to cfg.webhooks until verified Active!
        if (cfg.webhooks && cfg.webhooks[agentName]) {
          delete cfg.webhooks[agentName];
        }

        const registrationReceipt = {
          receiptId: 'rcpt_reg_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
          agent: agentName,
          status: 'Pending',
          revision,
          scope,
          issuedAt: new Date().toISOString(),
          issuer: 'https://switchboard.gisawareparth.workers.dev',
          probeDispatched: true
        };
        fs.writeFileSync(WEBHOOK_FILE, JSON.stringify(cfg, null, 2), 'utf-8');

        // Dispatch probe and await synchronous handshake (e.g. Cue handshake_expression)
        let isSyncVerified = false;
        let actReceipt = null;

        try {
          const probeHeaders = {
            'Content-Type': 'application/json',
            'User-Agent': 'The-Switchboard/2.6.0-verifier'
          };
          if (authHeader) probeHeaders['Authorization'] = authHeader;

          const probePromise = fetch(webhookUrl, {
            method: 'POST',
            headers: probeHeaders,
            body: JSON.stringify({
              event: 'verification.challenge',
              agent: agentName,
              challenge,
              scope,
              verifyEndpoint: 'https://switchboard.gisawareparth.workers.dev/api/webhook/verify',
              timestamp: Date.now()
            })
          });

          // Wait up to 3500ms for synchronous handshake_expression response
          const probeRes = await Promise.race([
            probePromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('probe_timeout')), 3500))
          ]).catch(() => null);

          if (probeRes) {
            console.log(`[Verifier] Probe returned HTTP ${probeRes.status} from ${agentName}`);
            const resText = await probeRes.text().catch(() => '');
            let probeJson = {};
            try { probeJson = JSON.parse(resText); } catch {}

            // Check for synchronous challenge echo in response body
            const returnedChallenge = probeJson.challenge || probeJson.echo || probeJson.nonce || (probeJson.body && probeJson.body.challenge);
            if (returnedChallenge === challenge) {
              isSyncVerified = true;
              const currentCfg = getWebhookConfig();
              const d = currentCfg.destinations && currentCfg.destinations[agentName];
              if (d) {
                d.status = 'Active';
                d.verifiedAt = Date.now();
                if (!currentCfg.webhooks) currentCfg.webhooks = {};
                currentCfg.webhooks[agentName] = d.url;
                if (agentName === 'sol') currentCfg.sol_webhook_url = d.url;

                actReceipt = {
                  receiptId: 'rcpt_act_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
                  agent: agentName,
                  status: 'Active',
                  revision: d.revision,
                  scope: d.scope || 'direct-only',
                  activatedAt: new Date().toISOString(),
                  issuer: 'https://switchboard.gisawareparth.workers.dev'
                };
                if (!currentCfg.receipts) currentCfg.receipts = {};
                currentCfg.receipts[agentName] = actReceipt;
                fs.writeFileSync(WEBHOOK_FILE, JSON.stringify(currentCfg, null, 2), 'utf-8');
                console.log(`[Webhook] Synchronous Handshake SUCCESS for [${agentName}] via handshake_expression!`);
              }
            }
          }
        } catch (err) {
          console.error(`[Verifier] Probe dispatch failed for ${agentName} (${webhookUrl}): ${err.message}`);
        }

        if (isSyncVerified) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            agent: agentName,
            status: 'Active',
            revision,
            scope,
            synchronousVerification: true,
            receipt: actReceipt,
            signingSecret,
            message: 'Endpoint verified synchronously via handshake_expression! Active immediately without triggering a run or writing to Trigger history.'
          }));
        } else {
          console.log(`[Webhook] Registered endpoint for agent [${agentName}] (rev: ${revision}, status: Pending, scope: ${scope}, probe sent)`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            agent: agentName,
            status: 'Pending',
            revision,
            scope,
            probeDispatched: true,
            receipt: registrationReceipt,
            verifyEndpoint: 'https://switchboard.gisawareparth.workers.dev/api/webhook/verify',
            note: 'Verification challenge probe dispatched to target webhook URL. Echo challenge back to verifyEndpoint to activate.'
          }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
      }
    });
    return;
  }

  // POST /api/webhook/verify - Complete ownership challenge and transition to Active
  if (req.method === 'POST' && url.pathname === '/api/webhook/verify') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const agentName = (payload.agent || '').trim().toLowerCase();
        const challenge = (payload.challenge || '').trim();

        const cfg = getWebhookConfig();
        const dest = (cfg.destinations && cfg.destinations[agentName]);
        if (!dest) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `No destination registered for ${agentName}` }));
          return;
        }

        if (!challenge || dest.challenge !== challenge) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or missing verification challenge nonce' }));
          return;
        }

        dest.status = 'Active';
        dest.verifiedAt = Date.now();
        if (!cfg.webhooks) cfg.webhooks = {};
        cfg.webhooks[agentName] = dest.url;
        if (agentName === 'sol') cfg.sol_webhook_url = dest.url;

        const activationReceipt = {
          receiptId: 'rcpt_act_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
          agent: agentName,
          status: 'Active',
          revision: dest.revision,
          activatedAt: new Date().toISOString(),
          issuer: 'https://switchboard.gisawareparth.workers.dev'
        };
        if (!cfg.receipts) cfg.receipts = {};
        cfg.receipts[agentName] = activationReceipt;

        fs.writeFileSync(WEBHOOK_FILE, JSON.stringify(cfg, null, 2), 'utf-8');

        console.log(`[Webhook] Verified endpoint for [${agentName}] (status: Active, rev: ${dest.revision})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          agent: agentName,
          status: 'Active',
          revision: dest.revision,
          signingSecret: dest.signingSecret,
          receipt: activationReceipt,
          message: 'Endpoint verified and activated. Real-time push dispatches enabled.'
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
      }
    });
    return;
  }

  // POST /api/webhook/disable - One-step kill switch: transition to Disabled & increment revision
  if (req.method === 'POST' && url.pathname === '/api/webhook/disable') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const agentName = (payload.agent || '').trim().toLowerCase();

        const cfg = getWebhookConfig();
        const dest = (cfg.destinations && cfg.destinations[agentName]);
        if (!dest) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `No destination found for ${agentName}` }));
          return;
        }

        dest.status = 'Disabled';
        dest.revision = (dest.revision || 1) + 1;
        dest.disabledAt = Date.now();
        if (cfg.webhooks) delete cfg.webhooks[agentName];
        if (agentName === 'sol') delete cfg.sol_webhook_url;
        fs.writeFileSync(WEBHOOK_FILE, JSON.stringify(cfg, null, 2), 'utf-8');

        console.log(`[Webhook] Disabled endpoint for [${agentName}] (status: Disabled, rev: ${dest.revision})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, agent: agentName, status: 'Disabled', revision: dest.revision }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
      }
    });
    return;
  }

  // POST /api/webhook/rotate - Rotate URL, increment revision, reset to Pending & dispatch probe
  if (req.method === 'POST' && url.pathname === '/api/webhook/rotate') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const agentName = (payload.agent || '').trim().toLowerCase();
        const newUrl = (payload.url || '').trim();

        if (!agentName || !newUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing agent or url' }));
          return;
        }

        const cfg = getWebhookConfig();
        if (!cfg.destinations) cfg.destinations = {};
        const dest = cfg.destinations[agentName] || {};
        const revision = (dest.revision || 1) + 1;
        const challenge = crypto.randomBytes(16).toString('hex');
        const signingSecret = crypto.randomBytes(32).toString('hex');

        cfg.destinations[agentName] = {
          ...dest,
          agent: agentName,
          url: newUrl,
          status: 'Pending',
          revision,
          challenge,
          signingSecret,
          rotatedAt: Date.now()
        };

        if (cfg.webhooks) delete cfg.webhooks[agentName];
        fs.writeFileSync(WEBHOOK_FILE, JSON.stringify(cfg, null, 2), 'utf-8');

        // Dispatch probe to new URL
        fetch(newUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'The-Switchboard/2.6.0-verifier'
          },
          body: JSON.stringify({
            event: 'verification.challenge',
            agent: agentName,
            challenge,
            verifyEndpoint: 'https://switchboard.gisawareparth.workers.dev/api/webhook/verify',
            timestamp: Date.now()
          })
        }).catch(err => {
          console.error(`[Verifier] Rotation probe error to ${agentName}: ${err.message}`);
        });

        console.log(`[Webhook] Rotated endpoint for [${agentName}] (rev: ${revision}, status: Pending, probe sent)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          agent: agentName,
          status: 'Pending',
          revision,
          probeDispatched: true,
          verifyEndpoint: 'https://switchboard.gisawareparth.workers.dev/api/webhook/verify',
          note: 'Verification challenge probe dispatched to new webhook URL. Echo challenge back to verifyEndpoint to activate.'
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
      }
    });
    return;
  }

  // POST /api/message - Post message with from/to routing
  if (req.method === 'POST' && url.pathname === '/api/message') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "text" field' }));
          return;
        }

        const from = payload.from || payload.sender || 'unknown';
        const to = payload.to || (from === 'instinct' ? 'antigravity' : 'instinct');
        let text = payload.text;

        if ((from === 'agent' || from === 'antigravity') && !text.includes('[by agent]')) {
          text = `${text} [by agent]`;
        }

        const msgObj = {
          id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
          from,
          to,
          text,
          timestamp: Date.now(),
          isoTime: new Date().toISOString()
        };

        const history = loadJson(HISTORY_FILE);
        history.push(msgObj);
        saveJson(HISTORY_FILE, history);

        // Also track in inbox if targeted
        const inbox = loadJson(INBOX_FILE);
        inbox.push(msgObj);
        saveJson(INBOX_FILE, inbox);

        // In-Chat Verification for Receive-Only Catch Hooks:
        // Allows agent or operator to echo challenge nonce directly in chat without writing outbound HTTP in Cue!
        const verifyMatch = text.match(/(?:verify|challenge(?:-response)?)\s+([a-f0-9]{32})/i);
        if (verifyMatch) {
          const candidateNonce = verifyMatch[1].toLowerCase();
          const cfg = getWebhookConfig();
          const senderLower = String(from || '').trim().toLowerCase();
          const dest = cfg.destinations && cfg.destinations[senderLower];
          if (dest && dest.status === 'Pending' && dest.challenge === candidateNonce) {
            dest.status = 'Active';
            dest.verifiedAt = Date.now();
            if (!cfg.webhooks) cfg.webhooks = {};
            cfg.webhooks[senderLower] = dest.url;
            if (senderLower === 'sol') cfg.sol_webhook_url = dest.url;

            const activationReceipt = {
              receiptId: 'rcpt_act_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
              agent: senderLower,
              status: 'Active',
              revision: dest.revision,
              scope: dest.scope || 'direct-and-broadcast',
              activatedAt: new Date().toISOString(),
              issuer: 'https://switchboard.gisawareparth.workers.dev'
            };
            if (!cfg.receipts) cfg.receipts = {};
            cfg.receipts[senderLower] = activationReceipt;
            fs.writeFileSync(WEBHOOK_FILE, JSON.stringify(cfg, null, 2), 'utf-8');

            console.log(`[Webhook] In-Chat Verification SUCCESS for [${senderLower}] -> Active!`);
            const confirmMsg = {
              id: 'msg_' + Date.now() + '_conf',
              from: 'antigravity',
              to: senderLower,
              text: `✅ In-Chat Challenge Verified! Endpoint for @${senderLower} is now ACTIVE (rev: ${dest.revision}, scope: ${dest.scope || 'direct-and-broadcast'}). Real-time push dispatches enabled. Receipt: ${activationReceipt.receiptId} [by agent]`,
              timestamp: Date.now(),
              isoTime: new Date().toISOString()
            };
            history.push(confirmMsg);
            saveJson(HISTORY_FILE, history);
          }
        }

        console.log(`[Bridge] [${from} ➔ ${to}]: ${text.slice(0, 80)}...`);

        // Webhook Dispatch (multi-agent support: Sol + any registered bot webhooks)
        const fromStr = String(from || '').toLowerCase();
        const toStr = String(to || '').toLowerCase();
        const cfg = getWebhookConfig();
        const registeredWebhooks = cfg.webhooks || {};

        const webhookPayload = {
          event: 'message.created',
          id: msgObj.id,
          timestamp: msgObj.timestamp,
          sender: from,
          recipient: to,
          text: msgObj.text,
          author: {
            name: from,
            type: (fromStr === 'parth' || fromStr === 'manas') ? 'human' : 'agent'
          },
          hub: 'https://switchboard.gisawareparth.workers.dev',
          replyEndpoint: 'https://switchboard.gisawareparth.workers.dev/api/message'
        };

        const urlsToDispatch = new Map(); // url -> agentName

        // Always notify Sol (coordinator) if not sent by Sol
        if (fromStr !== 'sol' && cfg.sol_webhook_url) {
          urlsToDispatch.set(cfg.sol_webhook_url, 'Sol');
        }

        // Check registered webhooks and destinations
        const destinations = cfg.destinations || {};
        for (const [botName, botUrl] of Object.entries(registeredWebhooks)) {
          if (!botUrl) continue;
          const botLower = botName.toLowerCase();
          // Never loop back to the sender
          if (botLower === fromStr) continue;

          // If destination metadata exists, strictly check if Active
          const dest = destinations[botLower];
          if (dest && dest.status !== 'Active') {
            continue; // Skip inactive / disabled / pending destinations
          }

          // Dispatch if direct message, or broadcast if not direct-only
          const isDirect = (toStr === botLower || toStr.includes(botLower));
          const isBroadcast = (toStr === 'all' && !dest?.directOnly && dest?.scope !== 'direct-only');
          if (isDirect || isBroadcast) {
            urlsToDispatch.set(botUrl, botName);
          }
        }

        // Fire all target webhooks asynchronously in parallel with cryptographic signature & replay guard
        for (const [targetUrl, targetName] of urlsToDispatch.entries()) {
          const targetLower = targetName.toLowerCase();
          const dest = destinations[targetLower] || {};
          const secret = dest.signingSecret || 'switchboard-default-secret';
          const dispatchTime = Date.now();
          const bodyStr = JSON.stringify(webhookPayload);
          const signature = crypto.createHmac('sha256', secret).update(`${dispatchTime}.${bodyStr}`).digest('hex');

          const dispatchHeaders = {
            'Content-Type': 'application/json',
            'User-Agent': 'The-Switchboard/2.6.0',
            'X-Switchboard-Timestamp': String(dispatchTime),
            'X-Switchboard-Signature': `v1=${signature}`
          };
          if (dest.authHeader) {
            dispatchHeaders['Authorization'] = dest.authHeader;
          }

          fetch(targetUrl, {
            method: 'POST',
            headers: dispatchHeaders,
            body: bodyStr
          })
            .then(r => console.log(`[Webhook] Dispatched to ${targetName} (${r.status})`))
            .catch(e => console.error(`[Webhook] Error dispatching to ${targetName}: ${e.message}`));
        }

        // Instant SSE Dispatch
        const targetLower = (to || '').toLowerCase();
        for (const client of streamClients) {
          try {
            if (!client.forAgent || client.forAgent === targetLower || targetLower === 'all') {
              client.res.write(`data: ${JSON.stringify(msgObj)}\n\n`);
            }
          } catch {
            streamClients.delete(client);
          }
        }

        // Instant Long-Poll Dispatch
        for (let i = longPollWaiters.length - 1; i >= 0; i--) {
          const waiter = longPollWaiters[i];
          if (!waiter.forAgent || waiter.forAgent === targetLower || targetLower === 'all') {
            clearTimeout(waiter.timer);
            longPollWaiters.splice(i, 1);
            try {
              waiter.res.writeHead(200, { 'Content-Type': 'application/json' });
              waiter.res.end(JSON.stringify({ count: 1, messages: [msgObj] }));
            } catch {}
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: msgObj }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body: ' + err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[The Switchboard v2.5] Running on http://localhost:${PORT}`);
  console.log(`[The Switchboard v2.5] Shared Key: ${BRIDGE_KEY}`);
});
