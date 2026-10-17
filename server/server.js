// =============================================================================
// Synapse Multiplayer Collaboration Platform Server
// Unified HTTP/WS server · Yjs CRDT · Shared Counter · Attributed Reactions
// Host-Enforced Polls · Server-Scored Quizzes · 3-Tool Whiteboard · PostgreSQL
// =============================================================================
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const crdt = require('./crdt');
const PollEngine = require('./poll');
const QuizEngine = require('./quiz');
const WhiteboardEngine = require('./whiteboard');
const CounterEngine = require('./counter');

const PORT = process.env.PORT || 3000;
const WEB_DIR = path.join(__dirname, '..', 'web');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

// Curated avatar colors
const AVATAR_COLORS = [
  '#4f46e5', '#059669', '#d97706', '#db2777',
  '#0284c7', '#7c3aed', '#dc2626', '#16a34a',
  '#0891b2', '#ea580c',
];

function pickColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// ---------------------------------------------------------------------------
// Room State in Server Memory
// ---------------------------------------------------------------------------
// roomCode -> {
//   code,
//   hostToken,
//   accent,
//   activeActivity, // 'POLL' | 'QUIZ' | 'WHITEBOARD' | null
//   peers: Map(socket -> { id, name, color, isHost, buckets: {} }),
//   recentReactions: Set(reactionId),
// }
const rooms = new Map();

function getOrCreateRoom(roomCode, hostToken = null) {
  let r = rooms.get(roomCode);
  if (!r) {
    const token = hostToken || `htk_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    r = {
      code: roomCode,
      hostToken: token,
      accent: '#4f46e5',
      activeActivity: null,
      peers: new Map(),
      recentReactions: new Set(),
    };
    rooms.set(roomCode, r);
  }
  return r;
}

function broadcastToRoom(room, messageObj, excludeSocket = null) {
  const data = JSON.stringify(messageObj);
  for (const [ws, peer] of room.peers.entries()) {
    if (ws !== excludeSocket && ws.readyState === 1 /* WebSocket.OPEN */) {
      ws.send(data);
    }
  }
}

function checkRateLimit(peer, kind, maxPerSec) {
  const now = Date.now();
  const bucket = peer.buckets[kind] || (peer.buckets[kind] = { t: now, count: 0 });
  if (now - bucket.t >= 1000) {
    bucket.t = now;
    bucket.count = 0;
  }
  return ++bucket.count <= maxPerSec;
}

// ---------------------------------------------------------------------------
// HTTP Request Routing
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Host-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. Health & Storage Status Endpoint
  if (pathname === '/health') {
    let totalParticipants = 0;
    for (const r of rooms.values()) totalParticipants += r.peers.size;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      service: 'synapse',
      version: '1.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      roomsActive: rooms.size,
      participantsActive: totalParticipants,
      storage: db.getStorageStatus(),
      timestamp: new Date().toISOString(),
    }));
  }

  // 2. Room Creation REST API: POST /api/room/create
  if (req.method === 'POST' && pathname === '/api/room/create') {
    try {
      const body = await parseJsonBody(req);
      const hostToken = `htk_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      const customCode = body.roomCode ? String(body.roomCode).trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) : null;
      const roomCode = customCode || `syn-${Math.random().toString(36).substring(2, 6)}-${Math.random().toString(36).substring(2, 6)}`;
      const accent = body.accent || '#4f46e5';

      await db.upsertRoom(roomCode, hostToken, accent, 0);
      const room = getOrCreateRoom(roomCode, hostToken);
      room.accent = accent;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        roomCode,
        hostToken,
        accent,
        joinUrl: `/room/${roomCode}`,
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // 3. Room Status API: GET /api/room/:code/status
  if (pathname.startsWith('/api/room/') && pathname.endsWith('/status')) {
    const parts = pathname.split('/');
    const code = parts[3];
    const room = await db.getRoom(code);
    const memRoom = rooms.get(code);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      exists: Boolean(room || memRoom),
      roomCode: code,
      accent: room ? room.accent : (memRoom ? memRoom.accent : '#4f46e5'),
      counterValue: room ? room.counter_value : 0,
      activePeers: memRoom ? memRoom.peers.size : 0,
      storage: db.getStorageStatus(),
    }));
  }

  // 4. Notepad History API: GET /api/room/:code/notepad-versions
  if (pathname.startsWith('/api/room/') && pathname.endsWith('/notepad-versions')) {
    const parts = pathname.split('/');
    const code = parts[3];
    const versions = await db.getNotepadVersions(code, 50);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, roomCode: code, versions }));
  }

  // 5. Counter History API: GET /api/room/:code/counter-history
  if (pathname.startsWith('/api/room/') && pathname.endsWith('/counter-history')) {
    const parts = pathname.split('/');
    const code = parts[3];
    const snapshot = await CounterEngine.getSnapshot(code);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, snapshot }));
  }

  // 6. Whiteboard Strokes API: GET /api/room/:code/strokes
  if (pathname.startsWith('/api/room/') && pathname.endsWith('/strokes')) {
    const parts = pathname.split('/');
    const code = parts[3];
    const strokes = await WhiteboardEngine.getStrokes(code);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, strokes }));
  }

  // 7. Route `/room/:code` -> Serves `web/app.html`
  if (pathname.startsWith('/room/')) {
    return serveStaticFile(path.join(WEB_DIR, 'app.html'), res);
  }

  // 8. Static File Server for `web/`
  let relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = path.join(WEB_DIR, relativePath);

  // Security check: prevent directory traversal
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Access Denied');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback for single page navigation or missing files
      if (pathname.startsWith('/room')) {
        return serveStaticFile(path.join(WEB_DIR, 'app.html'), res);
      }
      return serveStaticFile(path.join(WEB_DIR, 'index.html'), res);
    }
    serveStaticFile(filePath, res);
  });
});

function serveStaticFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 64) req.destroy(new Error('Payload too large'));
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Malformed JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// WebSocket Server & Real-Time Protocol Handler
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentPeer = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return ws.send(JSON.stringify({ type: 'error', code: 'INVALID_JSON', message: 'Malformed JSON payload' }));
    }

    const { type } = msg;

    try {
      // ── 1. JOIN ROOM ────────────────────────────────────────────────────────
      if (type === 'join') {
        const roomCode = String(msg.room || '').trim().slice(0, 32);
        if (!roomCode) {
          return ws.send(JSON.stringify({ type: 'error', code: 'INVALID_ROOM', message: 'Room code required' }));
        }

        const clientId = String(msg.clientId || uuidv4().replace(/-/g, '').slice(0, 16)).slice(0, 32);
        const name = String(msg.name || 'Anonymous Guest').trim().slice(0, 32);
        const color = pickColor(clientId);

        // Fetch or create DB room record
        let dbRoom = await db.getRoom(roomCode);
        const initialToken = (dbRoom && dbRoom.host_token) || msg.hostToken || null;
        const memRoom = getOrCreateRoom(roomCode, initialToken);

        if (!dbRoom) {
          dbRoom = await db.upsertRoom(roomCode, memRoom.hostToken, memRoom.accent, 0);
        } else {
          memRoom.accent = dbRoom.accent;
          if (dbRoom.host_token) memRoom.hostToken = dbRoom.host_token;
        }

        // Host verification: first peer in room or token match
        let isHost = false;
        if (memRoom.peers.size === 0) {
          isHost = true;
          if (msg.hostToken) {
            memRoom.hostToken = msg.hostToken;
          }
        } else if (msg.hostToken && msg.hostToken === memRoom.hostToken) {
          isHost = true;
        }

        currentRoom = memRoom;
        currentPeer = {
          id: clientId,
          name,
          color,
          isHost,
          buckets: {},
        };

        currentRoom.peers.set(ws, currentPeer);

        // Prepare full initial state snapshot for late joiner
        const crdtStateBase64 = crdt.getEncodedState(roomCode);
        const counterSnapshot = await CounterEngine.getSnapshot(roomCode);
        const pollSnapshot = await PollEngine.getPollSnapshot(roomCode, clientId);
        const quizSnapshot = await QuizEngine.getQuizSnapshot(roomCode, clientId);
        const whiteboardStrokes = await WhiteboardEngine.getStrokes(roomCode);

        // Gather peer list
        const peerList = [];
        for (const p of currentRoom.peers.values()) {
          peerList.push({ id: p.id, name: p.name, color: p.color, isHost: p.isHost });
        }

        // Send room initialization payload to joining client
        ws.send(JSON.stringify({
          type: 'room_init',
          roomCode,
          peer: { id: currentPeer.id, name: currentPeer.name, color: currentPeer.color, isHost: currentPeer.isHost },
          isHost: currentPeer.isHost,
          hostToken: currentPeer.isHost ? currentRoom.hostToken : undefined,
          accent: currentRoom.accent,
          activeActivity: currentRoom.activeActivity,
          peers: peerList,
          crdtState: crdtStateBase64,
          counter: counterSnapshot,
          poll: pollSnapshot,
          quiz: quizSnapshot,
          strokes: whiteboardStrokes,
          storage: db.getStorageStatus(),
        }));

        // Broadcast peer_joined to other room peers
        broadcastToRoom(currentRoom, {
          type: 'peer_joined',
          peer: { id: currentPeer.id, name: currentPeer.name, color: currentPeer.color, isHost: currentPeer.isHost },
        }, ws);

        return;
      }

      // All subsequent events require an active room and peer
      if (!currentRoom || !currentPeer) {
        return ws.send(JSON.stringify({ type: 'error', code: 'NOT_IN_ROOM', message: 'Must join room first' }));
      }

      // ── 2. CRDT NOTEPAD SYNC (YJS UPDATE) ──────────────────────────────────
      if (type === 'pad_update') {
        if (!checkRateLimit(currentPeer, 'pad', 80)) return;
        if (!msg.update || typeof msg.update !== 'string') return;

        const updateBuffer = Buffer.from(msg.update, 'base64');
        crdt.applyUpdate(currentRoom.code, updateBuffer, currentPeer.name, currentPeer.id);

        // Broadcast to other peers in room
        broadcastToRoom(currentRoom, {
          type: 'pad_update',
          update: msg.update,
          editor: { id: currentPeer.id, name: currentPeer.name },
        }, ws);
        return;
      }

      // ── 3. NOTEPAD VERSION RESTORE & SNAPSHOT ─────────────────────────────
      if (type === 'pad_restore') {
        const versionId = Number(msg.versionId);
        const version = await db.getNotepadVersionById(versionId);
        if (!version || version.room_code !== currentRoom.code) {
          return ws.send(JSON.stringify({ type: 'error', code: 'VERSION_NOT_FOUND', message: 'Version does not exist' }));
        }

        const restoreResult = await crdt.restoreVersion(
          currentRoom.code,
          version.content,
          currentPeer.name,
          currentPeer.id
        );

        // Broadcast state reset and version restored event to all room participants
        broadcastToRoom(currentRoom, {
          type: 'pad_restored',
          versionId,
          restoredText: restoreResult.text,
          crdtState: restoreResult.updateBase64,
          by: { id: currentPeer.id, name: currentPeer.name },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (type === 'pad_snapshot') {
        const ver = await crdt.createManualSnapshot(currentRoom.code, currentPeer.name, currentPeer.id);
        broadcastToRoom(currentRoom, {
          type: 'version_saved',
          version: ver,
          by: { id: currentPeer.id, name: currentPeer.name },
        });
        return;
      }

      // ── 4. SHARED COUNTER OPERATIONS (ATOMIC & IDEMPOTENT) ─────────────────
      if (type === 'counter_op') {
        if (!checkRateLimit(currentPeer, 'counter', 20)) return;

        const opType = String(msg.opType || 'increment');
        const amount = Number(msg.amount || 1);
        const opId = msg.opId || `op_${uuidv4().replace(/-/g, '').slice(0, 12)}`;

        const opResult = await CounterEngine.applyOperation(
          currentRoom.code,
          currentPeer.id,
          currentPeer.name,
          opType,
          amount,
          opId
        );

        // Broadcast updated counter and attribution entry to all room peers (including sender)
        broadcastToRoom(currentRoom, {
          type: 'counter_updated',
          value: opResult.resultValue,
          action: opResult,
        });
        return;
      }

      // ── 5. ATTRIBUTED EMOJI REACTIONS ─────────────────────────────────────
      if (type === 'reaction') {
        if (!checkRateLimit(currentPeer, 'reaction', 10)) return;

        const reactionId = msg.id || uuidv4();
        // Prevent duplicate broadcast if duplicate frame is sent
        if (currentRoom.recentReactions.has(reactionId)) return;
        currentRoom.recentReactions.add(reactionId);
        if (currentRoom.recentReactions.size > 200) {
          const firstKey = currentRoom.recentReactions.values().next().value;
          currentRoom.recentReactions.delete(firstKey);
        }

        const emoji = String(msg.emoji || '🎉').slice(0, 8);

        // Broadcast to ALL peers including sender with attribution
        broadcastToRoom(currentRoom, {
          type: 'reaction',
          id: reactionId,
          emoji,
          sender: { id: currentPeer.id, name: currentPeer.name, color: currentPeer.color },
          timestamp: Date.now(),
        });
        return;
      }

      // ── 6. ROOM ACCENT SYNCHRONIZATION ────────────────────────────────────
      if (type === 'room_accent') {
        const accent = String(msg.accent || '#4f46e5').slice(0, 16);
        currentRoom.accent = accent;
        await db.updateRoomAccent(currentRoom.code, accent);

        // Broadcast to ALL peers including sender
        broadcastToRoom(currentRoom, {
          type: 'room_accent',
          accent,
          by: { id: currentPeer.id, name: currentPeer.name },
        });
        return;
      }

      // ── 7. ACTIVITY SWITCH (POLL | QUIZ | WHITEBOARD) ──────────────────────
      if (type === 'activity_switch') {
        const activity = msg.activity ? String(msg.activity).toUpperCase() : null;
        if (activity && !['POLL', 'QUIZ', 'WHITEBOARD'].includes(activity)) return;

        currentRoom.activeActivity = activity;
        broadcastToRoom(currentRoom, {
          type: 'activity_switched',
          activity,
          by: { id: currentPeer.id, name: currentPeer.name },
        });
        return;
      }

      // ── 8. COLLABORATIVE POLL ─────────────────────────────────────────────
      if (type === 'poll_create') {
        if (!currentPeer.isHost && msg.hostToken !== currentRoom.hostToken) {
          return ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Only room host can create polls' }));
        }

        const pollResult = await PollEngine.createPoll(
          currentRoom.code,
          currentPeer.id,
          msg.question,
          msg.options,
          msg.policy || 'single_vote'
        );

        broadcastToRoom(currentRoom, {
          type: 'poll_created',
          poll: pollResult.poll,
          tallies: pollResult.tallies,
          totalVotes: pollResult.totalVotes,
          by: { id: currentPeer.id, name: currentPeer.name },
        });
        return;
      }

      if (type === 'poll_vote') {
        if (!checkRateLimit(currentPeer, 'vote', 8)) return;

        const voteResult = await PollEngine.castVote(
          msg.pollId,
          currentRoom.code,
          currentPeer.id,
          currentPeer.name,
          msg.optionIdx
        );

        // Acknowledge to voter
        ws.send(JSON.stringify({
          type: 'poll_vote_ack',
          pollId: voteResult.pollId,
          optionIdx: voteResult.votedOptionIdx,
        }));

        // Broadcast updated vote tallies to all peers
        broadcastToRoom(currentRoom, {
          type: 'poll_tallies_updated',
          pollId: voteResult.pollId,
          tallies: voteResult.tallies,
          totalVotes: voteResult.totalVotes,
        });
        return;
      }

      if (type === 'poll_close') {
        if (!currentPeer.isHost && msg.hostToken !== currentRoom.hostToken) {
          return ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Only room host can close polls' }));
        }

        await PollEngine.closePoll(msg.pollId, currentRoom.code);
        broadcastToRoom(currentRoom, {
          type: 'poll_closed',
          pollId: msg.pollId,
          by: { id: currentPeer.id, name: currentPeer.name },
        });
        return;
      }

      // ── 9. COLLABORATIVE QUIZ (HOST ACTIONS & SERVER SCORING) ─────────────
      if (type === 'quiz_create') {
        if (!currentPeer.isHost && msg.hostToken !== currentRoom.hostToken) {
          return ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Only room host can create quizzes' }));
        }

        const quizData = await QuizEngine.createQuiz(
          currentRoom.code,
          currentPeer.id,
          msg.title,
          msg.questions
        );

        broadcastToRoom(currentRoom, {
          type: 'quiz_started',
          quizId: quizData.quizId,
          title: quizData.title,
          totalQuestions: quizData.totalQuestions,
          currentQuestionIdx: 0,
          publicQuestion: quizData.publicQuestion,
          state: 'active',
          by: { id: currentPeer.id, name: currentPeer.name },
        });
        return;
      }

      if (type === 'quiz_submit') {
        const subResult = await QuizEngine.submitAnswer(
          msg.quizId,
          currentRoom.code,
          msg.questionIdx,
          currentPeer.id,
          currentPeer.name,
          msg.choiceIdx
        );

        ws.send(JSON.stringify({
          type: 'quiz_submit_ack',
          quizId: subResult.quizId,
          questionIdx: subResult.questionIdx,
          choiceIdx: subResult.choiceIdx,
        }));

        // Notify room of submission counter increment (without revealing answer)
        broadcastToRoom(currentRoom, {
          type: 'quiz_submission_count',
          quizId: subResult.quizId,
          questionIdx: subResult.questionIdx,
          participantName: currentPeer.name,
        });
        return;
      }

      if (type === 'quiz_reveal') {
        if (!currentPeer.isHost && msg.hostToken !== currentRoom.hostToken) {
          return ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Only room host can reveal quiz answers' }));
        }

        const revealResult = await QuizEngine.revealAnswer(msg.quizId, currentRoom.code);
        broadcastToRoom(currentRoom, {
          type: 'quiz_answer_revealed',
          ...revealResult,
        });
        return;
      }

      if (type === 'quiz_next') {
        if (!currentPeer.isHost && msg.hostToken !== currentRoom.hostToken) {
          return ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Only room host can advance questions' }));
        }

        const advanceResult = await QuizEngine.nextQuestion(msg.quizId, currentRoom.code);
        if (advanceResult.state === 'finished') {
          broadcastToRoom(currentRoom, {
            type: 'quiz_finished',
            ...advanceResult,
          });
        } else {
          broadcastToRoom(currentRoom, {
            type: 'quiz_advanced',
            ...advanceResult,
          });
        }
        return;
      }

      if (type === 'quiz_finish') {
        if (!currentPeer.isHost && msg.hostToken !== currentRoom.hostToken) {
          return ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Only room host can finish quiz' }));
        }

        const finishResult = await QuizEngine.finishQuiz(msg.quizId, currentRoom.code);
        broadcastToRoom(currentRoom, {
          type: 'quiz_finished',
          ...finishResult,
        });
        return;
      }

      // ── 10. COLLABORATIVE WHITEBOARD (PEN, PENCIL, HIGHLIGHTER) ───────────
      if (type === 'wb_stroke') {
        if (!checkRateLimit(currentPeer, 'stroke', 40)) return;

        const saved = await WhiteboardEngine.recordStroke(
          currentRoom.code,
          currentPeer.id,
          currentPeer.name,
          msg.stroke
        );

        // Broadcast new stroke to other room peers
        broadcastToRoom(currentRoom, {
          type: 'wb_stroke',
          stroke: saved,
        }, ws);
        return;
      }

      if (type === 'wb_clear') {
        if (!currentPeer.isHost && msg.hostToken !== currentRoom.hostToken) {
          return ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Only room host can clear whiteboard' }));
        }

        await WhiteboardEngine.clearWhiteboard(currentRoom.code);
        broadcastToRoom(currentRoom, {
          type: 'wb_cleared',
          by: { id: currentPeer.id, name: currentPeer.name },
        });
        return;
      }

      // ── 11. LIVE CURSORS ──────────────────────────────────────────────────
      if (type === 'cursor') {
        if (!checkRateLimit(currentPeer, 'cursor', 50)) return;

        broadcastToRoom(currentRoom, {
          type: 'cursor',
          id: currentPeer.id,
          name: currentPeer.name,
          color: currentPeer.color,
          x: msg.x,
          y: msg.y,
        }, ws);
        return;
      }

    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', code: 'HANDLER_ERROR', message: err.message }));
    }
  });

  ws.on('close', () => {
    if (currentRoom && currentPeer) {
      currentRoom.peers.delete(ws);
      broadcastToRoom(currentRoom, {
        type: 'peer_left',
        peer: { id: currentPeer.id, name: currentPeer.name },
      });
      if (currentRoom.peers.size === 0) {
        // Room clean-up could happen after idle timeout
      }
    }
  });

  ws.on('error', (err) => {
    console.warn('⚠️ WebSocket client error:', err.message);
  });
});

// Periodic heartbeat to drop stale connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

// ---------------------------------------------------------------------------
// Server Bootstrap
// ---------------------------------------------------------------------------
async function startServer() {
  await db.initDb();

  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`\n======================================================`);
      console.log(`🚀 Synapse Real-Time Collaboration Server running on port ${PORT}`);
      console.log(`🌐 Local Web UI: http://localhost:${PORT}`);
      console.log(`💾 Persistence:  ${db.getStorageStatus().type} (${db.getStorageStatus().backupPolicy})`);
      console.log(`======================================================\n`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().catch(err => {
    console.error('Fatal server boot error:', err);
    process.exit(1);
  });
}

module.exports = { server, wss, startServer, rooms };
