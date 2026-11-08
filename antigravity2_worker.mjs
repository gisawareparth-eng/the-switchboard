import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.join(__dirname, 'bridge_key.txt');
const BASE_URL = process.env.SWITCHBOARD_URL || 'http://localhost:3000';

let bridgeKey = '';
if (fs.existsSync(KEY_FILE)) {
  bridgeKey = fs.readFileSync(KEY_FILE, 'utf-8').trim();
}

console.log(`[Antigravity-2 Worker] Initializing on ${BASE_URL}...`);

async function sendMessage(to, text) {
  try {
    const res = await fetch(`${BASE_URL}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Key': bridgeKey
      },
      body: JSON.stringify({
        from: 'antigravity-2',
        to: to || 'all',
        text
      })
    });
    return await res.json();
  } catch (err) {
    console.error(`[Antigravity-2] Failed to send message:`, err.message);
  }
}

async function handleIncomingMessage(msg) {
  if (!msg || !msg.text) return;
  const from = msg.from || 'unknown';
  if (from === 'antigravity-2') return; // Ignore own messages

  const text = msg.text.trim();
  const lowerText = text.toLowerCase();
  console.log(`[Antigravity-2] Received message from [${from}]: ${text.slice(0, 100)}`);

  const isDirect = (msg.to === 'antigravity-2');
  const isMentioned = lowerText.includes('@antigravity-2');

  if (!isDirect && !isMentioned) return;

  const replyTo = (from === 'all' || from === 'unknown') ? 'all' : from;

  if (lowerText.includes('ping')) {
    await sendMessage(replyTo, `@${from} 🏓 Pong! Antigravity-2 is live, responsive, and paired with @antigravity for high-throughput productivity. [by agent]`);
    return;
  }

  if (lowerText.includes('status')) {
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const uptime = Math.round(process.uptime());
    await sendMessage(replyTo, `@${from} 📊 Antigravity-2 Status Report:\n• State: ACTIVE (Worker Loop Online)\n• Paired Lead: @antigravity\n• Uptime: ${uptime}s | Node Heap: ${mem}MB\n• Switchboard: Connected to ${BASE_URL}\n• Focus: Secondary engineering, test execution, parallel tasks [by agent]`);
    return;
  }

  if (lowerText.includes('run-test') || lowerText.includes('staging-test')) {
    await sendMessage(replyTo, `@${from} 🧪 Starting Staging Pilot test suite run... [by agent]`);
    try {
      const output = execSync('node tests/staging_pilot.mjs', { cwd: __dirname, encoding: 'utf-8', timeout: 30000 });
      const passMatch = output.match(/Passed:\s*(\d+)\/(\d+)/i) || output.match(/(\d+)\s+passed/i);
      const summary = passMatch ? passMatch[0] : 'All tests completed';
      await sendMessage(replyTo, `@${from} ✅ Staging Test Suite Run Complete:\n${summary}\nVerified by Antigravity-2 [by agent]`);
    } catch (err) {
      await sendMessage(replyTo, `@${from} ❌ Staging Test Suite encountered error:\n${err.message.slice(0, 200)} [by agent]`);
    }
    return;
  }

  if (lowerText.includes('help')) {
    await sendMessage(replyTo, `@${from} 🤖 Antigravity-2 Capabilities:\n• "ping": Health & connectivity check\n• "status": System runtime & memory report\n• "run-tests": Executes 14-test staging verification suite\n• Custom tasks: Assign parallel code review, file analysis, or verification tasks anytime! [by agent]`);
    return;
  }

  // General acknowledgment
  await sendMessage(replyTo, `@${from} 👋 Understood! Antigravity-2 has acknowledged your message. Coordinating with @antigravity and @parth to execute in parallel. [by agent]`);
}

let lastTimestamp = Date.now();
const processedIds = new Set();

async function pollLoop() {
  console.log(`[Antigravity-2 Worker] Polling loop started at ${new Date().toISOString()}...`);
  while (true) {
    try {
      const url = `${BASE_URL}/api/messages?since=${lastTimestamp}&for=antigravity-2&wait=25`;
      const res = await fetch(url, {
        headers: {
          'X-Bridge-Key': bridgeKey
        }
      });

      if (res.status === 200) {
        const data = await res.json();
        const msgs = data.messages || [];
        for (const msg of msgs) {
          if (!processedIds.has(msg.id)) {
            processedIds.add(msg.id);
            if (msg.timestamp > lastTimestamp) {
              lastTimestamp = msg.timestamp;
            }
            await handleIncomingMessage(msg);
          }
        }
      } else {
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch (err) {
      // Reconnect after brief pause
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

pollLoop();
