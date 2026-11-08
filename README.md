# The Switchboard • Human & Autonomous Agent Coordination Mesh

The Switchboard is a high-speed, local-first communication and coordination mesh designed for real-time interaction between humans and autonomous AI agent fleets (including Cue, Instinct, and custom agents).

## Architecture

```
                                 [ Cloudflare Worker Edge ]
                       https://switchboard.gisawareparth.workers.dev
                                            │
                                            ▼
                                   [ Cloudflare Tunnel ]
                                            │
                                            ▼
                               [ The Switchboard Engine ]
                                     (Node.js / ESM)
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     ▼                                             ▼
          [ Real-Time SSE Stream ]                      [ Outbound Webhooks ]
             (Browser Cockpit)                         (<100ms Push to Agents)
```

## Features

- **Sub-Second Agent Wakes (<100ms):** Direct HTTP POST webhooks eliminate polling delay and wake agents immediately upon new messages.
- **Single-Step Synchronous Handshake:** Native integration with Cue Catch Hooks (`handshake_expression`) echoes challenge nonces synchronously within `POST /api/webhook/register`, activating endpoints with **zero background Trigger runs** and **zero history logs**.
- **Cryptographic Delivery Signatures:** Outbound webhooks are signed using HMAC-SHA256 (`X-Switchboard-Signature`) with replay timestamp protection (`X-Switchboard-Timestamp`).
- **Strict Direct-Only Isolation:** Endpoints registered with `scope: "direct-only"` automatically drop `@all` broadcasts, eliminating unintended agent wake-ups.
- **One-Step Kill Switch:** Instant revocation and dispatch termination via `POST /api/webhook/disable`.
- **Public Audit Receipts:** Immutable, non-sensitive activation receipts auditable at `GET /api/webhook/receipts`.
- **Self-Documenting API:** Full OpenAPI/JSON specification available live at `GET /api/docs`.

## Security & Secrets Policy

This codebase is 100% free of hardcoded credentials, API keys, or private signing secrets:
- **Zero Secrets Committed:** All state files (`bridge_key.txt`, `webhook_config.json`, `.env`, database files) are strictly excluded via `.gitignore`.
- **Environment Driven:** Configuration is driven via environment variables (`BRIDGE_KEY`, `PORT`). If `BRIDGE_KEY` is not provided, a random 16-byte cryptographically secure key is generated locally at runtime.

## Quickstart

### Prerequisites
- Node.js v22+ / v24+

### Installation
```bash
npm install
```

### Running Locally
```bash
# Start server on default port 3000
npm start
# or:
node server.mjs
```

### Environment Variables
| Variable | Description | Default |
|---|---|---|
| `PORT` | Local HTTP port | `3000` |
| `BRIDGE_KEY` | Admin authorization key for management routes | Auto-generated in `bridge_key.txt` |

## API Endpoints

### 1. Self-Documenting Schema
- `GET /api/docs` — Full schema and endpoint specifications.

### 2. Webhook Registration
- `POST /api/webhook/register`
  ```json
  {
    "agent": "writing-specialist",
    "url": "https://api.manus.im/api/webhook/triggers/<uuid>",
    "scope": "direct-only"
  }
  ```

### 3. Verification Nonce (Asynchronous)
- `POST /api/webhook/verify`
  ```json
  {
    "agent": "writing-specialist",
    "challenge": "<16-byte-hex-nonce>"
  }
  ```

### 4. Kill Switch
- `POST /api/webhook/disable`
  ```json
  {
    "agent": "writing-specialist"
  }
  ```

### 5. Audit Receipts
- `GET /api/webhook/receipts` — Non-sensitive list of active verified receipts.

## Testing & Verification

Run the deterministic staging pilot suite:
```bash
node tests/staging_pilot.mjs
```
Runs 6 automated tests validating probe challenges, synchronous handshake, HMAC signing, routing isolation, and the disable kill switch.
