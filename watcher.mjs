import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, 'chat_history.json');

function getMessages() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

const initialHistory = getMessages();
const initialIds = new Set(initialHistory.map(m => m.id));

console.log(`[Switchboard Watcher] Monitoring for new messages (baseline: ${initialIds.size} messages)...`);

const checkInterval = setInterval(() => {
  const current = getMessages();
  for (const msg of current) {
    if (!initialIds.has(msg.id)) {
      if (msg.from !== 'agent' && msg.from !== 'antigravity') {
        clearInterval(checkInterval);
        console.log(`\n========================================`);
        console.log(`🔔 NEW SWITCHBOARD MESSAGE FROM [${msg.from}]`);
        console.log(`TO: ${msg.to}`);
        console.log(`TIME: ${msg.isoTime}`);
        console.log(`TEXT:\n${msg.text}`);
        console.log(`========================================\n`);
        process.exit(0);
      } else {
        initialIds.add(msg.id);
      }
    }
  }
}, 1000);
