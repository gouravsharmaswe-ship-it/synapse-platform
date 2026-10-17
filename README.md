# Synapse — Real-Time Multiplayer Collaboration Platform

![Synapse Architecture](https://img.shields.io/badge/Architecture-CRDT%20%7C%20WebSocket%20%7C%20PostgreSQL-indigo)
![Tests](https://img.shields.io/badge/Tests-12%2F12%20Passing-brightgreen)
![License](https://img.shields.io/badge/License-MIT-blue)

Synapse is a high-performance, real-time multiplayer collaboration workspace built from the ground up to guarantee mathematical convergence, zero data loss, durable persistence, and rock-solid multi-user engagement.

---

## ⚡ Core Features (100% Implemented & Verified)

### 1. Collaborative Shared Notepad (Yjs CRDT)
- **Mathematical Convergence:** Powered by Yjs state vectors, ensuring character-level concurrent editing, insertions, and deletions merge deterministically without a central transformation matrix.
- **Cursor Selection Preservation:** Zero cursor jumping or flicker when remote peers type.
- **Offline & Reconnect Resilience:** Unsent local edits are preserved and automatically integrated upon reconnection.
- **Version History & Restore:** Batched database snapshotting (every 3.5s of quiet typing or on manual snapshot). Participants can preview previous versions and restore any revision. Restoring creates a new chronological history entry while preserving all intervening versions.

### 2. Atomic Shared Counter & Attribution
- **Serialized Concurrency:** Asynchronous promise-chain lock prevents race conditions during simultaneous updates.
- **Duplicate Request Protection:** Unique `opId` idempotency keys ensure network retries never double-count.
- **Attributed History:** Every action records participant display name, client ID, previous value, resulting value, and precise timestamp.

### 3. Room-Wide Synchronized Accent
- One-click theme switcher featuring 6 curated aesthetic colors (Indigo, Emerald, Amber, Rose, Cyan, Violet).
- Instantly updates CSS custom properties (`--accent`, `--accent-glow`, `--accent-light`) across all connected clients.

### 4. Attributed Emoji Reactions
- Live reaction palette: 🎉, ❤️, 🚀, 🔥, 👏, 💡, 🤯, 🎯.
- Reactions rise and float on screen with sender attribution and duplicate-event suppression.

### 5. Interactive Activities Hub (Exactly 3 Choices)
1. **POLL:**
   - Host configures question + 2 to 8 choices.
   - Server-enforced duplicate-vote policies (`single_vote` with vote change or `strict_single`).
   - Animated live percentage bars and participant counts.
2. **QUIZ:**
   - Host-created multiple-choice questions with answer explanations.
   - **Answer Secrecy:** Correct answers and scoring are strictly held on the server; clients never receive the answer key during the question phase.
   - Host controls: "Reveal Answer", "Next Question", and "Finish Quiz".
   - Final leaderboard podium with points and medals.
3. **WHITEBOARD:**
   - Shared drawing canvas featuring **exactly three tools**:
     - `PEN`: Smooth freehand strokes with round joints.
     - `PENCIL`: Thin (1.5px), crisp, visually distinct strokes.
     - `HIGHLIGHTER`: Thick (20px), translucent (alpha 0.35) marker strokes.
   - Real-time stroke streaming (not heavy full-canvas screenshots).
   - Mouse, touch, and stylus support with Device Pixel Ratio (DPR) scaling.
   - Server-side host authorization for canvas clearing.

---

## 🏗️ Architecture & Technologies

```
┌───────────────────────────────────────────────────────────┐
│                    Synapse Web Client                     │
│  HTML5 · Vanilla CSS Design System · Yjs CRDT · Canvas     │
└──────────────────────────┬────────────────────────────────┘
                           │ WebSocket (JSON / Base64 Binary)
┌──────────────────────────▼────────────────────────────────┐
│                   Synapse Node.js Server                  │
│  HTTP Router · WebSocket Hub · Yjs Engine · Rate Limiter   │
│  Poll Engine · Quiz Engine · Whiteboard Engine · Counter   │
└──────────────────────────┬────────────────────────────────┘
                           │ Parameterized SQL Queries
┌──────────────────────────▼────────────────────────────────┐
│               PostgreSQL Database / Fallback              │
│  synapse_rooms · synapse_notepad_versions                 │
│  synapse_counter_actions · synapse_polls                  │
│  synapse_poll_votes · synapse_quizzes                     │
│  synapse_quiz_submissions · synapse_whiteboard_strokes    │
└───────────────────────────────────────────────────────────┘
```

- **Frontend:** Pure HTML5, CSS custom properties, vanilla ES6+ JavaScript, bundled standalone Yjs CRDT library (91 KB, zero external CDNs required).
- **Backend:** Node.js, `ws` (WebSockets), `yjs` (CRDT document engine), `pg` (PostgreSQL client with pooling).
- **Security:** Cryptographic host session tokens, parameterized SQL queries, payload size limits (64 KB max), per-socket rate limiting token buckets, and safe HTML escaping.

---

## 💾 Database Schema & Storage Telemetry

When `DATABASE_URL` is configured, Synapse connects via `pg.Pool` and automatically runs idempotent schema migrations:

1. `synapse_rooms`: Room codes, accents, host tokens, counter values, and encoded notepad states.
2. `synapse_notepad_versions`: Chronological snapshot history with editor names and operation types (`edit`, `snapshot`, `restore`).
3. `synapse_counter_actions`: Idempotent operation log with previous and new counter values.
4. `synapse_polls` & `synapse_poll_votes`: Questions, options, duplicate policies, and unique votes per participant.
5. `synapse_quizzes` & `synapse_quiz_submissions`: Quiz configuration, hidden correct answers, and participant submissions.
6. `synapse_whiteboard_strokes`: Vector stroke points, tools, colors, widths, and author attribution.

### Storage Durability & Retention Limits
- **PostgreSQL Mode:** Fully durable across server restarts, deployments, and reboots. Daily automated backups via Render PostgreSQL service.
- **In-Memory Fallback Mode:** Operates automatically when `DATABASE_URL` is absent or unreachable. Data is ephemeral to the server process lifetime. The server and `/health` endpoint clearly disclose this status (`storage: { type: 'in-memory-fallback', isDurable: false }`).

---

## 🚀 Local Development Setup

### Prerequisites
- Node.js v18+ (tested on Node.js v24)
- npm v9+

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/gouravsharmaswe-ship-it/synapse-platform.git
cd synapse-platform
npm install
```

### 2. Optional: Configure PostgreSQL
If you have PostgreSQL running locally:
```bash
export DATABASE_URL="postgres://postgres:password@localhost:5432/synapse"
```
*(If omitted, Synapse runs seamlessly with its in-memory storage fallback)*

### 3. Run Automated Integration Tests
```bash
npm test
```

### 4. Start Local Dev Server
```bash
npm start
```
Open [http://localhost:3000](http://localhost:3000) in your browser. Open multiple tabs or invite peers on the same local network to test real-time collaboration.

---

## 🧪 Automated Integration Test Evidence

The automated test suite runs against the real HTTP server, live WebSocket hub, and database layer:

```text
======================================================
🧪 Starting Synapse Integration Test Suite
======================================================

📡 Test server running on port 53199

  ✓ PASS: Online presence and room initialization snapshot
  ✓ PASS: Yjs CRDT concurrent editing, insertions, deletions, and deterministic convergence
  ✓ PASS: CRDT notepad version snapshotting, preview, and restore preserving history
  ✓ PASS: Shared counter atomic concurrent operations, attribution, and duplicate request protection
  ✓ PASS: Room-wide accent synchronization and persistence
  ✓ PASS: Reaction attribution to sender and duplicate event deduplication
  ✓ PASS: Poll creation, voting, server-enforced duplicate vote policy, and host permissions
  ✓ PASS: Quiz creation, answer secrecy, server-side scoring, and host progression
  ✓ PASS: Whiteboard tools (PEN, PENCIL, HIGHLIGHTER), concurrent strokes, and replay
  ✓ PASS: Strict room isolation (zero state or message leakage across rooms)
  ✓ PASS: Error handling, malformed JSON rejection, and server stability
  ✓ PASS: Health endpoint returns operational status and storage telemetry

======================================================
Test Results: 12 passed, 0 failed
======================================================
```

---

## 🌐 Deployment Instructions (Render)

This repository includes a native [`render.yaml`](./render.yaml) blueprint:

1. Log in to [Render Dashboard](https://dashboard.render.com).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub repository: `gouravsharmaswe-ship-it/synapse-platform`.
4. Render will provision:
   - **PostgreSQL Database:** `synapse-db` (Free tier)
   - **Node.js Web Service:** `synapse-platform` (Free tier) with WebSockets enabled and automatic connection to `DATABASE_URL`.
5. Click **Apply**. Render builds and deploys your live collaboration platform.

### Required Environment Variables
| Variable | Description | Default (Local) |
|---|---|---|
| `PORT` | HTTP/WS server port | `3000` (Render sets `10000`) |
| `NODE_ENV` | Environment mode | `development` / `production` |
| `DATABASE_URL` | PostgreSQL connection URI | Ephemeral in-memory fallback |

---

## 🔒 Security Assumptions & Known Limitations

- **Guest Identity Model:** Participants enter display names. Cryptographic host tokens are stored in `localStorage` upon room creation to verify host permissions (quiz progression, poll closing, whiteboard clearing). Displays names are not treated as cryptographic identities.
- **Canvas Scaling:** Stroke coordinates are normalized (0 to 1) relative to canvas dimensions. If participant screens have drastically different aspect ratios, strokes maintain proportional placement.
- **Render Free Tier Spin-Down:** On Render's free tier, idle web services spin down after 15 minutes of inactivity; initial connection after spin-down may take ~45 seconds to wake up.
