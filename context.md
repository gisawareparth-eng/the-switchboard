# The Switchboard • Operational Handover & System Context

**Document Version:** 2.6.13  
**Generated At:** 2026-11-08T22:56:00+05:30 (Local) / 17:26:00 UTC  
**Workspaces:** `c:\Users\Hp\Desktop\isthumus` (local project) & `C:\Users\Hp\Desktop\the-switchboard` (git repo)  
**Host / Owner:** Parth (`Parth (Human)`)  
**Lead Pair-Programmer / Author:** Antigravity  

---

## 1. Executive Summary & Purpose

**The Switchboard** is a local-first, high-speed communication and event mesh designed to coordinate humans and autonomous AI agent fleets in real time. It unifies:
- **Parth (Host):** Interacting via the web cockpit UI.
- **Cue Fleet (21+ specialist bots):** Managed by **Sol** (Lead Coordinator) and **email-drafter** (Communications Lead), running inside Cue / Manus infrastructure.
- **Instinct & OpenCode Bots:** Parth's personal assistant and code execution agents.
- **Priyanka's Fleet:** External backend, security, DevOps, and QA agents.
- **Antigravity (Local Pair-Programming Agent):** Host engineer, system builder, and lead coordinator.
- **Antigravity-2 (Secondary Engineering Agent):** Parallel engineering pair, test verification, and productivity acceleration.

The system provides instant sub-100ms push dispatches via Webhook Triggers, Server-Sent Events (SSE), and long-polling, with cryptographic HMAC-SHA256 signatures, replay protection, and privacy-preserving `metadata-only` delivery.

---

## 2. Live Infrastructure & Network Topology

```
                       [ Parth's Web Browser ]
                                  │
                                  ▼
                    [ Permanent Cloudflare Worker ]
             https://switchboard.gisawareparth.workers.dev
                                  │
                                  ▼
                       [ Cloudflare Tunnel ]
       https://asn-transaction-outlined-intersection.trycloudflare.com
                                  │
                                  ▼
                   [ The Switchboard Node.js Engine ]
                     http://localhost:3000 (v2.6.13)
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
 [ Local UI Cockpit ]    [ Webhook Dispatcher ]     [ Real-Time SSE Stream ]
 (Chat, Badges, Polls)   (Sol, email-drafter, etc.)   (GET /api/stream)
```

### Key Endpoints:
- **Permanent Cloudflare Worker:** `https://switchboard.gisawareparth.workers.dev`
- **Active Public Cloudflare Tunnel:** `https://asn-transaction-outlined-intersection.trycloudflare.com`
- **Local Engine Port:** `http://localhost:3000`
- **Public Health Check:** `GET /api/health` -> `{"status":"healthy","version":"2.6.13"}`
- **Self-Documenting OpenAPI/Docs:** `GET /api/docs` (Unauthenticated, returns complete schema)
- **Public Audit Receipts:** `GET /api/webhook/receipts` (Non-sensitive activation audit)
- **Message Send Endpoint:** `POST /api/message` (Strict key auth: `X-Bridge-Key` or `?key=`)
- **Messages Poll/Fetch:** `GET /api/messages?since=<timestamp>&for=<agent>` (Strict key auth)

---

## 3. GitHub Repository (Zero-Secrets Enforced)

- **URL:** [`https://github.com/gisawareparth-eng/the-switchboard`](https://github.com/gisawareparth-eng/the-switchboard)
- **Local Git Clone:** `C:\Users\Hp\Desktop\the-switchboard` (on `main`)
- **Canonical Release Commit:** [`407c1f8`](https://github.com/gisawareparth-eng/the-switchboard/commit/407c1f8) (`feat(security): Switchboard v2.6.13 with 13-test staging suite, broadcast suppression, replay guard, and private-IP SSRF protection`)
- **Zero-Secrets Policy:** `.gitignore` strictly protects `bridge_key.txt`, `webhook_config.json`, `chat_history.json`, `inbox.json`, `.env`, `node_modules/`, and logs. All automated leak audits passed 0 leaks.

---

## 4. Current Agent Registration Census

| Agent / Bot | Fleet / Role | Status | Scope | Payload Mode | Verification Notes |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **`Antigravity`** | Host Engineering Lead | **ACTIVE** | `direct-and-broadcast` | Full | Primary pair programmer, local runtime & system builder. |
| **`Antigravity-2`** | Secondary Engineering Pair | **ACTIVE** | `direct-and-broadcast` | Full | Parallel task worker, test runner, and productivity engine. |
| **`Sol`** | Cue Lead Coordinator | **ACTIVE** | Broadcast | Full | Pre-existing inbound Catch Hook (`7590b462-...`). Processes all mesh events. |
| **`email-drafter`** | Cue Communications | **ACTIVE** | `direct-and-broadcast` | `metadata-only` | **First Specialist Certified!** Receipt `rcpt_act_1794156543411_2a2ab3e7`. **6 total Trigger runs in Cue, 0 failed**. |
| **`priyanka-backend`** | Priyanka Fleet | **PENDING** | `direct-only` | Full | Hook registered (`ebbef0ec-...`); awaiting challenge echo. |
| **`Task Planner`** | Cue Workflow Lead | *On Deck* | `direct-and-broadcast` | `metadata-only` | Bot #2 in the pipeline. Queued to register. |
| **`software-builder`** | Cue Engineering Lead | *Queued* | `direct-and-broadcast` | `metadata-only` | Bot #3 in the pipeline. |
| **11 Other Specialists** | Cue Fleet | *Queued* | `direct-and-broadcast` | `metadata-only` | `travel-planner`, `writing-specialist`, `budget-organizer`, `idea-strategist`, `visual-designer`, `scheduling-coordinator`, `Knowledge Curator`, `editor`, `product-researcher`, etc. |

---

## 5. The Proven Specialist Onboarding Blueprint

Every Cue specialist should execute this **exact 3-step sequence** to activate:

### Step 1: Create Catch Hook in Cue
Create a webhook trigger with the single-step **handshake response expression**:
```json
{ "challenge": request.body.challenge }
```
*(This guarantees zero Cue Trigger runs during Switchboard's verification probe!)*

### Step 2: Register with The Switchboard
Send an HTTP POST request to the direct tunnel:
- **URL:** `https://asn-transaction-outlined-intersection.trycloudflare.com/api/webhook/register`
- **Headers:** `Content-Type: application/json`
- **Body:**
```json
{
  "agent": "<specialist-name>",
  "url": "https://api.manus.im/api/webhook/triggers/<uuid>",
  "scope": "direct-and-broadcast",
  "payloadMode": "metadata-only"
}
```

### Step 3: Immediate Verification & Active Receipt
Switchboard probes the trigger URL with a 16-byte nonce challenge. Cue's handshake expression echoes the nonce synchronously (`<500ms`). Switchboard verifies the match and mints an active receipt (`rcpt_act_...`) in the same HTTP call.

---

## 6. Technical Lessons & Resolved Blockers

1. **Cloudflare Worker Error 1010 (Browser Integrity Check):**
   - Cloudflare's WAF blocks datacenter IPs (like Cue's AWS/GCP servers) when using non-browser User-Agents.
   - **Solution:** Cue bots MUST send their registration requests to the direct tunnel URL:  
     `https://asn-transaction-outlined-intersection.trycloudflare.com/api/webhook/register`  
     *(Or pass a browser User-Agent if calling `switchboard.gisawareparth.workers.dev`).*

2. **Cue Catch Hook Privacy (`payloadMode: "metadata-only"`):**
   - Cue Trigger runs retain payload previews in history.
   - In v2.6.10, registering with `"payloadMode": "metadata-only"` strips the plaintext `text` field from outbound dispatches. Cue only receives `{ id, timestamp, isoTime, sender, recipient, type: "direct_message", payloadMode: "metadata-only", hub, replyEndpoint }`.

3. **Loopback Guard:**
   - Switchboard explicitly drops webhook dispatches if `botLower === fromStr`. If an agent sends a message to itself, it will NOT receive it. Testing requires a message from a different sender (e.g. `@antigravity` or `@parth`).

4. **Capability URL Security Model:**
   - In Cue, Catch Hooks rely on 128-bit unguessable UUID capability URLs. HMAC validator configuration in Cue Trigger settings is **optional and unnecessary**.

5. **Stale Challenge Invalidation:**
   - Disabling an endpoint via `POST /api/webhook/disable` clears `dest.challenge = null` and mints `rcpt_dis_...`, completely blocking replay reactivations.

6. **Browser Translation ("Sol" -> "Soil"):**
   - Edge automatically translated "Sol" to "Soil". Fixed by wrapping badges in `<html class="notranslate" translate="no">` and `notranslate` spans.

7. **Strict Auth Guard & Loopback Bypass Elimination (v2.6.11 / Commit f492cc3):**
   - `instinct` uncovered that `cloudflared` reverse-proxy connections from `localhost` inherited loopback socket permissions, bypassing operational auth on tunnel traffic.
   - Fixed by removing `isLocalRequest` from `isAuthenticated`. All operational endpoints (`GET /api/messages`, `GET /api/stream`, `POST /api/message`) now strictly return HTTP 401 Unauthorized for missing or invalid keys. Verified in Test 10 of `tests/staging_pilot.mjs`.

---

## 7. Running Background Daemons

The following processes must remain running (checked via `manage_task`):
1. **Switchboard Server Engine:** `node agent-bridge/server.mjs` (Listening on port 3000).
2. **Cloudflare Tunnel Daemon:** `.\agent-bridge\node_modules\cloudflared\bin\cloudflared.exe tunnel --url http://localhost:3000` (Origin: `https://asn-transaction-outlined-intersection.trycloudflare.com`).
3. **Reactive Watcher Daemon:** `node agent-bridge/watcher.mjs` (Monitors `chat_history.json` and wakes the agent on new chat events).

---

## 8. Immediate Next Actions for the Incoming Agent

1. **Check for Task Planner's Registration:**
   - Task Planner is on deck. Inspect `agent-bridge/webhook_config.json` to see if their hook was submitted.
   - If registered, send a synthetic direct ping from `antigravity` to `Task Planner` to verify live receipt.
2. **Queue Bot #3 (`software-builder`):**
   - Once Task Planner confirms their Cue trigger execution, invite `software-builder` to register using the same blueprint.
3. **Coordinate with Sol:**
   - Sol is monitoring registration progress. Continue providing concise, verified status reports citing receipts.
4. **Begin Project Work (Isthumus):**
   - Once `Task Planner` and `software-builder` are online, initiate the first engineering tasks on the Isthumus reverse-engineering codebase.
