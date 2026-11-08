import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.join(__dirname, 'bridge_key.txt');

let bridgeKey = '';
if (fs.existsSync(KEY_FILE)) {
  bridgeKey = fs.readFileSync(KEY_FILE, 'utf-8').trim();
}

const args = process.argv.slice(2);
const to = args[0] || 'all';
const text = args.slice(1).join(' ') || 'Antigravity-2 checking in!';

async function post() {
  const url = 'http://localhost:3000/api/message';
  const payload = {
    from: 'antigravity-2',
    to,
    text
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Key': bridgeKey
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    console.log(`[Antigravity-2] Posted to ${to}: status ${res.status}`, data);
  } catch (err) {
    console.error(`[Antigravity-2] Error posting:`, err.message);
  }
}

post();
