import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, 'chat_history.json');
const CONFIG_FILE = path.join(__dirname, 'webhook_config.json');

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

const checkInterval = setInterval(() => {
  // Check for chat messages
  const currentMsgs = getMessages();
  for (const msg of currentMsgs) {
    if (!initialIds.has(msg.id)) {
      if (msg.from !== 'antigravity' && msg.from !== 'antigravity-2') {
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

  // Check for webhook registrations/updates
  const currentConfig = getConfig();
  const currentDests = currentConfig.destinations || {};
  for (const [agent, dest] of Object.entries(currentDests)) {
    if (!initialDestKeys.has(agent) || (initialConfig.destinations[agent] && initialConfig.destinations[agent].status !== dest.status)) {
      clearInterval(checkInterval);
      console.log(`\n========================================`);
      console.log(`🎉 WEBHOOK EVENT DETECTED FOR AGENT [${agent}]!`);
      console.log(`Status: ${dest.status}, Revision: ${dest.revision}`);
      console.log(`Payload Mode: ${dest.payloadMode || 'full'}, Scope: ${dest.scope || 'all'}`);
      console.log(`URL: ${dest.url}`);
      console.log(`========================================\n`);
      process.exit(0);
    }
  }

  // Check for new receipts
  const currentReceipts = currentConfig.receipts || {};
  for (const [agent, r] of Object.entries(currentReceipts)) {
    if (!initialReceiptKeys.has(agent)) {
      clearInterval(checkInterval);
      console.log(`\n========================================`);
      console.log(`🧾 NEW RECEIPT MINTED FOR [${agent}]!`);
      console.log(`Receipt ID: ${r.receiptId}`);
      console.log(`Status: ${r.status}`);
      console.log(`========================================\n`);
      process.exit(0);
    }
  }
}, 500);
