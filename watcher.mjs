import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, 'chat_history.json');
const CONFIG_FILE = path.join(__dirname, 'webhook_config.json');
const KEY_FILE = path.join(__dirname, 'bridge_key.txt');

let bridgeKey = '';
if (fs.existsSync(KEY_FILE)) {
  bridgeKey = fs.readFileSync(KEY_FILE, 'utf-8').trim();
}

function getMessages() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return { destinations: {}, receipts: {} };
  }
}

const initialHistory = getMessages();
const initialIds = new Set(initialHistory.map(m => m.id));

const initialConfig = getConfig();
const initialDestKeys = new Set(Object.keys(initialConfig.destinations || {}));
const initialReceiptKeys = new Set(Object.keys(initialConfig.receipts || {}));

console.log(`[Switchboard Watcher] Monitoring chat (${initialIds.size} msgs) & webhooks (${initialDestKeys.size} dests, ${initialReceiptKeys.size} receipts)...`);

let exiting = false;
const sseAbortController = new AbortController();

function exitWithMessage(msg) {
  if (exiting) return;
  exiting = true;
  clearInterval(checkInterval);
  try { sseAbortController.abort(); } catch {}
  console.log(`\n========================================`);
  console.log(`🔔 NEW SWITCHBOARD MESSAGE FROM [${msg.from}]`);
  console.log(`TO: ${msg.to}`);
  console.log(`TIME: ${msg.isoTime || new Date().toISOString()}`);
  console.log(`TEXT:\n${msg.text}`);
  console.log(`========================================\n`);
  process.exit(0);
}

function exitWithWebhookEvent(title, lines) {
  if (exiting) return;
  exiting = true;
  clearInterval(checkInterval);
  try { sseAbortController.abort(); } catch {}
  console.log(`\n========================================`);
  console.log(title);
  lines.forEach(l => console.log(l));
  console.log(`========================================\n`);
  process.exit(0);
}

// Connect to real-time SSE stream as antigravity listener
async function connectSSE() {
  try {
    const sseUrl = `http://localhost:3000/api/stream?for=antigravity&key=${encodeURIComponent(bridgeKey)}`;
    const res = await fetch(sseUrl, {
      signal: sseAbortController.signal,
      headers: { 'Accept': 'text/event-stream' }
    });
    if (!res.ok) {
      console.log(`[Switchboard Watcher] SSE connection returned ${res.status}, continuing with file polling fallback`);
      return;
    }
    console.log(`[Switchboard Watcher] Connected to /api/stream?for=antigravity (SSE active listener)`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (!exiting) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data && data.text && data.from !== 'antigravity' && data.from !== 'antigravity-2') {
              exitWithMessage(data);
              return;
            }
          } catch {}
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError' && !exiting) {
      // Keep going with polling
    }
  }
}
connectSSE();

// File-polling fallback every 500ms
const checkInterval = setInterval(() => {
  if (exiting) return;

  // Check for chat messages
  const currentMsgs = getMessages();
  for (const msg of currentMsgs) {
    if (!initialIds.has(msg.id)) {
      if (msg.from !== 'antigravity' && msg.from !== 'antigravity-2') {
        exitWithMessage(msg);
        return;
      } else {
        initialIds.add(msg.id);
      }
    }
  }

  // Check for webhook registrations/updates
  const currentConfig = getConfig();
  const currentDests = currentConfig.destinations || {};
  for (const [agent, dest] of Object.entries(currentDests)) {
    if (!initialDestKeys.has(agent) || (initialConfig.destinations[agent] && initialConfig.destinations[agent].status !== dest.status)) {
      exitWithWebhookEvent(`🎉 WEBHOOK EVENT DETECTED FOR AGENT [${agent}]!`, [
        `Status: ${dest.status}, Revision: ${dest.revision}`,
        `Payload Mode: ${dest.payloadMode || 'full'}, Scope: ${dest.scope || 'all'}`,
        `URL: ${dest.url}`
      ]);
      return;
    }
  }

  // Check for new receipts
  const currentReceipts = currentConfig.receipts || {};
  for (const [agent, r] of Object.entries(currentReceipts)) {
    if (!initialReceiptKeys.has(agent)) {
      exitWithWebhookEvent(`🧾 NEW RECEIPT MINTED FOR [${agent}]!`, [
        `Receipt ID: ${r.receiptId}`,
        `Status: ${r.status}`
      ]);
      return;
    }
  }
}, 500);
