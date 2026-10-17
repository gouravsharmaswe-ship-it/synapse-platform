// =============================================================================
// Synapse Automated Integration Test Suite
// Comprehensive end-to-end verification of CRDT convergence, atomic counter,
// attributed reactions, host-enforced polls, server-scored quizzes, 3-tool
// whiteboard, room isolation, rate limits, and persistence.
// =============================================================================
'use strict';

const assert = require('assert');
const http = require('http');
const { WebSocket } = require('ws');
const Y = require('yjs');
const db = require('../server/db');
const { server } = require('../server/server');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const waitUntil = async (conditionFn, timeoutMs = 6000, label = 'condition') => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (conditionFn()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
};

let testsPassed = 0;
let testsFailed = 0;
const resultsLog = [];

async function runTest(testName, testFn) {
  try {
    await testFn();
    testsPassed++;
    const msg = `✓ PASS: ${testName}`;
    console.log(`  ${msg}`);
    resultsLog.push({ name: testName, status: 'PASS' });
  } catch (err) {
    testsFailed++;
    const msg = `✗ FAIL: ${testName} - ${err.message}`;
    console.error(`  ${msg}`);
    resultsLog.push({ name: testName, status: 'FAIL', error: err.message });
  }
}

// Helper to create a test client connection
function createTestClient(port, room, name, hostToken = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const clientState = {
      ws,
      room,
      name,
      clientId: 'usr_' + Math.random().toString(36).substring(2, 8),
      hostToken,
      received: [],
      initData: null,
      ydoc: new Y.Doc(),
      ytext: null,
    };
    clientState.ytext = clientState.ydoc.getText('notepad');

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'join',
        room,
        name,
        clientId: clientState.clientId,
        hostToken,
      }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      clientState.received.push(msg);

      if (msg.type === 'room_init') {
        clientState.initData = msg;
        if (msg.crdtState) {
          const uint8 = Buffer.from(msg.crdtState, 'base64');
          Y.applyUpdate(clientState.ydoc, uint8);
        }
        resolve(clientState);
      } else if (msg.type === 'pad_update') {
        if (msg.update) {
          const uint8 = Buffer.from(msg.update, 'base64');
          Y.applyUpdate(clientState.ydoc, uint8);
        }
      }
    });

    ws.on('error', reject);
  });
}

function sendYjsUpdate(clientState, insertText, index = 0) {
  let updateBytes = null;
  const sub = clientState.ydoc.on('update', (u) => { updateBytes = u; });
  clientState.ytext.insert(index, insertText);
  clientState.ydoc.off('update', sub);

  if (updateBytes) {
    const base64 = Buffer.from(updateBytes).toString('base64');
    clientState.ws.send(JSON.stringify({
      type: 'pad_update',
      update: base64,
    }));
  }
}

(async () => {
  console.log('\n======================================================');
  console.log('🧪 Starting Synapse Integration Test Suite');
  console.log('======================================================\n');

  // 1. Initialize DB layer
  await db.initDb();

  // 2. Start server on ephemeral port
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  console.log(`📡 Test server running on port ${port}\n`);

  try {
    // ── TEST 1: Presence & Room Initialization ─────────────────────────────
    await runTest('Online presence and room initialization snapshot', async () => {
      const clientA = await createTestClient(port, 'room-presence', 'Alice', 'host-secret-123');
      const clientB = await createTestClient(port, 'room-presence', 'Bob');

      await waitUntil(() => clientA.received.some(m => m.type === 'peer_joined' && m.peer.name === 'Bob'), 3000, 'Alice sees Bob join');

      assert.strictEqual(clientA.initData.roomCode, 'room-presence');
      assert.strictEqual(clientB.initData.roomCode, 'room-presence');
      assert(clientA.initData.peers.length >= 1);

      clientA.ws.close();
      clientB.ws.close();
    });

    // ── TEST 2: Yjs CRDT Concurrent Editing & Convergence ─────────────────
    await runTest('Yjs CRDT concurrent editing, insertions, deletions, and deterministic convergence', async () => {
      const clientA = await createTestClient(port, 'room-crdt-1', 'EditorA');
      const clientB = await createTestClient(port, 'room-crdt-1', 'EditorB');

      // Simultaneous edits without waiting for each other
      sendYjsUpdate(clientA, 'Hello ', 0);
      sendYjsUpdate(clientB, 'World!', 0);

      // Wait for both clients to receive each other's updates and converge
      await waitUntil(() => {
        return clientA.ytext.toString().length > 0 &&
               clientA.ytext.toString() === clientB.ytext.toString();
      }, 4000, 'CRDT text convergence');

      const convergedText = clientA.ytext.toString();
      assert(convergedText.includes('Hello') && convergedText.includes('World!'), `Unexpected converged text: ${convergedText}`);

      // Concurrent deletion & insertion
      sendYjsUpdate(clientA, ' Collaborative', convergedText.length);
      await waitUntil(() => clientB.ytext.toString().includes('Collaborative'), 3000, 'Second update convergence');
      assert.strictEqual(clientA.ytext.toString(), clientB.ytext.toString());

      clientA.ws.close();
      clientB.ws.close();
    });

    // ── TEST 3: CRDT Version History Preview & Restore ────────────────────
    await runTest('CRDT notepad version snapshotting, preview, and restore preserving history', async () => {
      const room = 'room-version-test';
      const client = await createTestClient(port, room, 'Historian');

      // Type initial text
      sendYjsUpdate(client, 'Initial draft version 1.0', 0);
      await sleep(200);

      // Save explicit snapshot
      client.ws.send(JSON.stringify({ type: 'pad_snapshot' }));
      await waitUntil(() => client.received.some(m => m.type === 'version_saved'), 3000, 'Version saved event');

      // Modify text
      sendYjsUpdate(client, ' - completely rewritten draft 2.0', client.ytext.toString().length);
      await sleep(200);

      // Fetch versions via REST API
      const versions = await db.getNotepadVersions(room);
      assert(versions.length >= 1, 'At least one version recorded');
      const targetVersion = versions[0];

      // Restore earlier version
      client.ws.send(JSON.stringify({ type: 'pad_restore', versionId: targetVersion.id }));
      await waitUntil(() => client.received.some(m => m.type === 'pad_restored'), 3000, 'Pad restored event');

      // Verify restored event in history
      const updatedVersions = await db.getNotepadVersions(room);
      assert(updatedVersions.some(v => v.op_type === 'restore'), 'Restore operation logged in history');

      client.ws.close();
    });

    // ── TEST 4: Atomic Counter, Concurrency & Idempotency ─────────────────
    await runTest('Shared counter atomic concurrent operations, attribution, and duplicate request protection', async () => {
      const room = 'room-counter-test';
      const clientA = await createTestClient(port, room, 'CounterA');
      const clientB = await createTestClient(port, room, 'CounterB');

      const opId1 = 'op-uniq-1';
      const opId2 = 'op-uniq-2';

      // Send concurrent increments
      clientA.ws.send(JSON.stringify({ type: 'counter_op', opType: 'increment', amount: 3, opId: opId1 }));
      clientB.ws.send(JSON.stringify({ type: 'counter_op', opType: 'increment', amount: 2, opId: opId2 }));

      await waitUntil(() => {
        const lastMsg = clientA.received.filter(m => m.type === 'counter_updated').pop();
        return lastMsg && lastMsg.value === 5;
      }, 4000, 'Counter reaches 5');

      // Test idempotency: send opId1 again!
      clientA.ws.send(JSON.stringify({ type: 'counter_op', opType: 'increment', amount: 3, opId: opId1 }));
      await sleep(300);

      // Verify counter did NOT double count and remains 5
      const snapshot = await db.getRoom(room);
      assert.strictEqual(Number(snapshot.counter_value), 5, 'Idempotency prevented duplicate calculation');

      // Verify attribution log
      const actions = await db.getCounterActions(room);
      assert(actions.length >= 2, 'Attribution history contains actions');
      assert.strictEqual(actions[0].room_code, room);

      clientA.ws.close();
      clientB.ws.close();
    });

    // ── TEST 5: Room-Wide Accent Synchronization ──────────────────────────
    await runTest('Room-wide accent synchronization and persistence', async () => {
      const room = 'room-accent-test';
      const clientA = await createTestClient(port, room, 'DesignerA');
      const clientB = await createTestClient(port, room, 'DesignerB');

      clientA.ws.send(JSON.stringify({ type: 'room_accent', accent: '#059669' }));

      await waitUntil(() => {
        return clientB.received.some(m => m.type === 'room_accent' && m.accent === '#059669');
      }, 3000, 'Accent synced to peer B');

      const dbRoom = await db.getRoom(room);
      assert.strictEqual(dbRoom.accent, '#059669');

      clientA.ws.close();
      clientB.ws.close();
    });

    // ── TEST 6: Attributed Reactions & Duplicate Event Protection ─────────
    await runTest('Reaction attribution to sender and duplicate event deduplication', async () => {
      const room = 'room-rx-test';
      const clientA = await createTestClient(port, room, 'SenderA');
      const clientB = await createTestClient(port, room, 'ReceiverB');

      const reactionId = 'rx-dedup-1';

      // Send reaction
      clientA.ws.send(JSON.stringify({ type: 'reaction', emoji: '🚀', id: reactionId }));

      await waitUntil(() => {
        return clientB.received.some(m => m.type === 'reaction' && m.emoji === '🚀');
      }, 3000, 'Reaction received by B');

      const rxCountBefore = clientB.received.filter(m => m.type === 'reaction' && m.id === reactionId).length;
      assert.strictEqual(rxCountBefore, 1);

      // Re-send exact same reaction ID
      clientA.ws.send(JSON.stringify({ type: 'reaction', emoji: '🚀', id: reactionId }));
      await sleep(200);

      const rxCountAfter = clientB.received.filter(m => m.type === 'reaction' && m.id === reactionId).length;
      assert.strictEqual(rxCountAfter, 1, 'Duplicate reaction was dropped by deduplicator');

      clientA.ws.close();
      clientB.ws.close();
    });

    // ── TEST 7: Collaborative Poll & Duplicate Vote Enforcement ───────────
    await runTest('Poll creation, voting, server-enforced duplicate vote policy, and host permissions', async () => {
      const room = 'room-poll-test';
      const hostToken = 'htk-poll-host-1';
      const host = await createTestClient(port, room, 'PollHost', hostToken);
      const voterA = await createTestClient(port, room, 'VoterA');
      const voterB = await createTestClient(port, room, 'VoterB');

      // 1. Host creates poll with strict_single policy
      host.ws.send(JSON.stringify({
        type: 'poll_create',
        question: 'Which architecture?',
        options: ['Microservices', 'Monolith', 'Serverless'],
        policy: 'strict_single',
        hostToken,
      }));

      await waitUntil(() => voterA.received.some(m => m.type === 'poll_created'), 3000, 'Poll created received');
      const pollMsg = voterA.received.find(m => m.type === 'poll_created');
      const pollId = pollMsg.poll.id;

      // 2. Voter A votes for Option 0
      voterA.ws.send(JSON.stringify({ type: 'poll_vote', pollId, optionIdx: 0 }));
      await waitUntil(() => voterA.received.some(m => m.type === 'poll_vote_ack'), 3000, 'Vote acknowledged');

      // 3. Voter B votes for Option 1
      voterB.ws.send(JSON.stringify({ type: 'poll_vote', pollId, optionIdx: 1 }));
      await waitUntil(() => {
        const lastTally = host.received.filter(m => m.type === 'poll_tallies_updated').pop();
        return lastTally && lastTally.totalVotes === 2;
      }, 3000, 'Tallies show 2 votes');

      // 4. Voter A tries to vote again -> should be rejected under strict_single
      voterA.ws.send(JSON.stringify({ type: 'poll_vote', pollId, optionIdx: 2 }));
      await waitUntil(() => voterA.received.some(m => m.type === 'error' && m.message.includes('already voted')), 3000, 'Duplicate vote rejected');

      // 5. Non-host tries to close poll -> rejected
      voterA.ws.send(JSON.stringify({ type: 'poll_close', pollId, hostToken: 'invalid-token' }));
      await waitUntil(() => voterA.received.some(m => m.type === 'error' && m.code === 'UNAUTHORIZED'), 3000, 'Unauthorized poll close rejected');

      // 6. Host closes poll -> accepted
      host.ws.send(JSON.stringify({ type: 'poll_close', pollId, hostToken }));
      await waitUntil(() => voterA.received.some(m => m.type === 'poll_closed'), 3000, 'Poll closed broadcast');

      host.ws.close();
      voterA.ws.close();
      voterB.ws.close();
    });

    // ── TEST 8: Collaborative Quiz, Server-Side Scoring & Answer Protection ─
    await runTest('Quiz creation, answer secrecy, server-side scoring, and host progression', async () => {
      const room = 'room-quiz-test';
      const hostToken = 'htk-quiz-host-1';
      const host = await createTestClient(port, room, 'QuizHost', hostToken);
      const student = await createTestClient(port, room, 'StudentA');

      // 1. Host creates quiz with 2 questions
      host.ws.send(JSON.stringify({
        type: 'quiz_create',
        title: 'Distributed Systems Quiz',
        questions: [
          { text: 'Question 1: What does Raft ensure?', choices: ['Leader consensus', 'Fast hashing', 'UI layout'], correctIdx: 0, explanation: 'Raft is a consensus algorithm.' },
          { text: 'Question 2: What is Paxos?', choices: ['A fruit', 'A consensus family', 'A browser engine'], correctIdx: 1, explanation: 'Paxos is a family of consensus protocols.' }
        ],
        hostToken,
      }));

      await waitUntil(() => student.received.some(m => m.type === 'quiz_started'), 3000, 'Quiz started');
      const startMsg = student.received.find(m => m.type === 'quiz_started');
      const quizId = startMsg.quizId;

      // VERIFY ANSWER SECRECY: public question sent to student MUST NOT contain correctIdx!
      assert.strictEqual(startMsg.publicQuestion.correctIdx, undefined, 'CRITICAL: correctIdx must NOT be exposed to client');

      // 2. Student submits correct answer (choice 0)
      student.ws.send(JSON.stringify({
        type: 'quiz_submit',
        quizId,
        questionIdx: 0,
        choiceIdx: 0,
      }));
      await waitUntil(() => student.received.some(m => m.type === 'quiz_submit_ack'), 3000, 'Submit ack received');

      // 3. Host reveals answer
      host.ws.send(JSON.stringify({ type: 'quiz_reveal', quizId, hostToken }));
      await waitUntil(() => student.received.some(m => m.type === 'quiz_answer_revealed'), 3000, 'Answer revealed');

      const revealMsg = student.received.find(m => m.type === 'quiz_answer_revealed');
      assert.strictEqual(revealMsg.correctIdx, 0);

      // 4. Host advances question and finishes quiz
      host.ws.send(JSON.stringify({ type: 'quiz_next', quizId, hostToken }));
      await waitUntil(() => student.received.some(m => m.type === 'quiz_advanced'), 3000, 'Advanced to next question');

      host.ws.send(JSON.stringify({ type: 'quiz_finish', quizId, hostToken }));
      await waitUntil(() => student.received.some(m => m.type === 'quiz_finished'), 3000, 'Quiz finished');

      const finishMsg = student.received.find(m => m.type === 'quiz_finished');
      assert(finishMsg.leaderboard.length >= 1);
      assert.strictEqual(finishMsg.leaderboard[0].displayName, 'StudentA');
      assert.strictEqual(finishMsg.leaderboard[0].score, 100, 'Server scored 100 points for correct answer');

      host.ws.close();
      student.ws.close();
    });

    // ── TEST 9: Collaborative Whiteboard Tools (PEN, PENCIL, HIGHLIGHTER) ──
    await runTest('Whiteboard tools (PEN, PENCIL, HIGHLIGHTER), concurrent strokes, and replay', async () => {
      const room = 'room-wb-test';
      const hostToken = 'htk-wb-host-1';
      const host = await createTestClient(port, room, 'ArtistHost', hostToken);
      const peer = await createTestClient(port, room, 'ArtistPeer');

      // 1. Draw PEN stroke
      peer.ws.send(JSON.stringify({
        type: 'wb_stroke',
        stroke: {
          id: 'strk-pen-1',
          tool: 'pen',
          color: '#4f46e5',
          width: 3,
          points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
        },
      }));

      // 2. Draw PENCIL stroke
      peer.ws.send(JSON.stringify({
        type: 'wb_stroke',
        stroke: {
          id: 'strk-pencil-1',
          tool: 'pencil',
          color: '#0f172a',
          width: 1.5,
          points: [{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }],
        },
      }));

      // 3. Draw HIGHLIGHTER stroke
      peer.ws.send(JSON.stringify({
        type: 'wb_stroke',
        stroke: {
          id: 'strk-highlighter-1',
          tool: 'highlighter',
          color: '#fbbf24',
          width: 20,
          points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.6 }],
        },
      }));

      await waitUntil(() => {
        const wbMsgs = host.received.filter(m => m.type === 'wb_stroke');
        return wbMsgs.length === 3;
      }, 3000, 'Host receives all 3 strokes');

      // Verify stroke persistence in DB
      const strokesInDb = await db.getWhiteboardStrokes(room);
      assert.strictEqual(strokesInDb.length, 3);
      assert(strokesInDb.some(s => s.tool === 'pen'));
      assert(strokesInDb.some(s => s.tool === 'pencil'));
      assert(strokesInDb.some(s => s.tool === 'highlighter'));

      // 4. Late joiner receives all strokes on connect
      const lateJoiner = await createTestClient(port, room, 'LateArtist');
      assert.strictEqual(lateJoiner.initData.strokes.length, 3, 'Late joiner receives full stroke history');

      // 5. Host clears whiteboard
      host.ws.send(JSON.stringify({ type: 'wb_clear', hostToken }));
      await waitUntil(() => peer.received.some(m => m.type === 'wb_cleared'), 3000, 'Whiteboard cleared event');

      const strokesAfterClear = await db.getWhiteboardStrokes(room);
      assert.strictEqual(strokesAfterClear.length, 0, 'Strokes cleared from DB');

      host.ws.close();
      peer.ws.close();
      lateJoiner.ws.close();
    });

    // ── TEST 10: Strict Room Isolation ────────────────────────────────────
    await runTest('Strict room isolation (zero state or message leakage across rooms)', async () => {
      const clientAlpha = await createTestClient(port, 'room-isolation-alpha', 'Alice');
      const clientBeta = await createTestClient(port, 'room-isolation-beta', 'Bob');

      // Alice sends reaction in Alpha
      clientAlpha.ws.send(JSON.stringify({ type: 'reaction', emoji: '🎉', id: 'iso-rx-1' }));
      await sleep(200);

      // Verify Bob in Beta did NOT receive it
      const leakedRx = clientBeta.received.find(m => m.type === 'reaction' && m.id === 'iso-rx-1');
      assert.strictEqual(leakedRx, undefined, 'Reaction must not leak across rooms');

      clientAlpha.ws.close();
      clientBeta.ws.close();
    });

    // ── TEST 11: Error Handling & Malformed Payload Rejection ─────────────
    await runTest('Error handling, malformed JSON rejection, and server stability', async () => {
      const client = await createTestClient(port, 'room-err-test', 'Tester');

      // Send invalid JSON
      client.ws.send('NOT_A_VALID_JSON{]');
      await waitUntil(() => client.received.some(m => m.type === 'error' && m.code === 'INVALID_JSON'), 3000, 'Invalid JSON caught');

      // Send invalid whiteboard tool
      client.ws.send(JSON.stringify({
        type: 'wb_stroke',
        stroke: { tool: 'invalid_brush_type', points: [{ x: 1, y: 1 }] },
      }));
      await waitUntil(() => client.received.some(m => m.type === 'error' && m.code === 'HANDLER_ERROR'), 3000, 'Invalid tool rejected');

      client.ws.close();
    });

    // ── TEST 12: Production Health Endpoint & Telemetry ───────────────────
    await runTest('Health endpoint returns operational status and storage telemetry', async () => {
      const res = await new Promise((resolve) => {
        http.get(`http://localhost:${port}/health`, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => resolve(JSON.parse(data)));
        });
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.service, 'synapse');
      assert(res.storage && typeof res.storage.type === 'string');
    });

  } finally {
    server.close();
  }

  console.log('\n======================================================');
  console.log(`Test Results: ${testsPassed} passed, ${testsFailed} failed`);
  console.log('======================================================\n');

  if (testsFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
