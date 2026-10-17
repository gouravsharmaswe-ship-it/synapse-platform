// =============================================================================
// Synapse Database & Persistence Layer
// Handles PostgreSQL with pool/SSL and resilient in-memory fallback.
// Clearly exposes storage durability status (durable vs in-memory fallback).
// =============================================================================
'use strict';

const { Pool } = require('pg');

let pool = null;
let isConnected = false;
let connectionError = null;

// ---------------------------------------------------------------------------
// In-Memory Storage Fallback (used when DATABASE_URL is not set or unreachable)
// ---------------------------------------------------------------------------
const mem = {
  rooms: new Map(),          // roomCode -> { room_code, accent, host_token, counter_value, notepad_state, created_at, updated_at }
  notepadVersions: new Map(),// roomCode -> [ { id, room_code, content, editor_name, client_id, op_type, created_at } ]
  counterActions: new Map(), // roomCode -> [ { id, room_code, op_type, amount, prev_value, result_value, display_name, client_id, created_at } ]
  polls: new Map(),          // pollId -> { id, room_code, host_client_id, question, options, duplicate_policy, is_closed, created_at }
  pollVotes: new Map(),      // pollId -> Map(clientId -> { id, poll_id, room_code, client_id, display_name, option_idx, created_at })
  quizzes: new Map(),        // quizId -> { id, room_code, host_client_id, title, questions, current_question_idx, state, created_at }
  quizSubmissions: new Map(),// quizId -> Map('qIdx:clientId' -> { id, quiz_id, room_code, question_idx, client_id, display_name, choice_idx, is_correct, created_at })
  strokes: new Map(),        // roomCode -> [ { id, room_code, client_id, client_name, tool, color, width, points, created_at } ]
  seq: 1,
};

function getNextSeq() {
  return mem.seq++;
}

// ---------------------------------------------------------------------------
// Database Initialization & Migrations
// ---------------------------------------------------------------------------
async function initDb() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log('ℹ️  [DB] DATABASE_URL not set — Synapse is running with in-memory fallback (ephemeral).');
    return false;
  }

  try {
    const isProd = process.env.NODE_ENV === 'production' ||
                   dbUrl.includes('render.com') ||
                   dbUrl.includes('sslmode=require');

    pool = new Pool({
      connectionString: dbUrl,
      ssl: isProd ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('⚠️  [DB] PostgreSQL pool error:', err.message);
    });

    const client = await pool.connect();
    try {
      await runMigrations(client);
      isConnected = true;
      connectionError = null;
      console.log('✅ [DB] PostgreSQL connected and schema verified.');
      return true;
    } finally {
      client.release();
    }
  } catch (err) {
    connectionError = err.message;
    console.warn(`⚠️  [DB] PostgreSQL connection failed (${err.message}) — operating with in-memory fallback.`);
    isConnected = false;
    return false;
  }
}

async function runMigrations(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS synapse_rooms (
      room_code       VARCHAR(32) PRIMARY KEY,
      accent          VARCHAR(16) DEFAULT '#4f46e5',
      host_token      VARCHAR(64) NOT NULL,
      counter_value   INTEGER DEFAULT 0,
      notepad_state   TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS synapse_notepad_versions (
      id              SERIAL PRIMARY KEY,
      room_code       VARCHAR(32) NOT NULL REFERENCES synapse_rooms(room_code) ON DELETE CASCADE,
      content         TEXT NOT NULL,
      editor_name     VARCHAR(64) NOT NULL,
      client_id       VARCHAR(64) NOT NULL,
      op_type         VARCHAR(16) NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_notepad_versions_room ON synapse_notepad_versions(room_code, created_at DESC);

    CREATE TABLE IF NOT EXISTS synapse_counter_actions (
      id              VARCHAR(64) PRIMARY KEY,
      room_code       VARCHAR(32) NOT NULL REFERENCES synapse_rooms(room_code) ON DELETE CASCADE,
      op_type         VARCHAR(16) NOT NULL,
      amount          INTEGER NOT NULL DEFAULT 1,
      prev_value      INTEGER NOT NULL,
      result_value    INTEGER NOT NULL,
      display_name    VARCHAR(64) NOT NULL,
      client_id       VARCHAR(64) NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_counter_actions_room ON synapse_counter_actions(room_code, created_at DESC);

    CREATE TABLE IF NOT EXISTS synapse_polls (
      id               VARCHAR(64) PRIMARY KEY,
      room_code        VARCHAR(32) NOT NULL REFERENCES synapse_rooms(room_code) ON DELETE CASCADE,
      host_client_id   VARCHAR(64) NOT NULL,
      question         TEXT NOT NULL,
      options          JSONB NOT NULL,
      duplicate_policy VARCHAR(32) NOT NULL DEFAULT 'one_vote_per_user',
      is_closed        BOOLEAN NOT NULL DEFAULT FALSE,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS synapse_poll_votes (
      id           SERIAL PRIMARY KEY,
      poll_id      VARCHAR(64) NOT NULL REFERENCES synapse_polls(id) ON DELETE CASCADE,
      room_code    VARCHAR(32) NOT NULL,
      client_id    VARCHAR(64) NOT NULL,
      display_name VARCHAR(64) NOT NULL,
      option_idx   INTEGER NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT uq_poll_vote UNIQUE (poll_id, client_id)
    );

    CREATE TABLE IF NOT EXISTS synapse_quizzes (
      id                   VARCHAR(64) PRIMARY KEY,
      room_code            VARCHAR(32) NOT NULL REFERENCES synapse_rooms(room_code) ON DELETE CASCADE,
      host_client_id       VARCHAR(64) NOT NULL,
      title                VARCHAR(128) NOT NULL DEFAULT 'Synapse Quiz',
      questions            JSONB NOT NULL,
      current_question_idx INTEGER NOT NULL DEFAULT 0,
      state                VARCHAR(24) NOT NULL DEFAULT 'active',
      created_at           TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS synapse_quiz_submissions (
      id           SERIAL PRIMARY KEY,
      quiz_id      VARCHAR(64) NOT NULL REFERENCES synapse_quizzes(id) ON DELETE CASCADE,
      room_code    VARCHAR(32) NOT NULL,
      question_idx INTEGER NOT NULL,
      client_id    VARCHAR(64) NOT NULL,
      display_name VARCHAR(64) NOT NULL,
      choice_idx   INTEGER NOT NULL,
      is_correct   BOOLEAN NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT uq_quiz_submission UNIQUE (quiz_id, question_idx, client_id)
    );

    CREATE TABLE IF NOT EXISTS synapse_whiteboard_strokes (
      id          VARCHAR(64) PRIMARY KEY,
      room_code   VARCHAR(32) NOT NULL REFERENCES synapse_rooms(room_code) ON DELETE CASCADE,
      client_id   VARCHAR(64) NOT NULL,
      client_name VARCHAR(64) NOT NULL,
      tool        VARCHAR(16) NOT NULL,
      color       VARCHAR(32) NOT NULL,
      width       REAL NOT NULL,
      points      JSONB NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_whiteboard_strokes_room ON synapse_whiteboard_strokes(room_code, created_at ASC);
  `);
}

// ---------------------------------------------------------------------------
// Health & Telemetry Status
// ---------------------------------------------------------------------------
function getStorageStatus() {
  return {
    isDurable: isConnected,
    type: isConnected ? 'PostgreSQL' : 'in-memory-fallback',
    connected: isConnected,
    error: connectionError,
    backupPolicy: isConnected
      ? 'Render managed PostgreSQL automated daily snapshots'
      : 'In-memory fallback: ephemeral to server lifetime, reset on restart',
    retention: isConnected
      ? 'Persistent across deployments'
      : 'Session memory only',
  };
}

// ---------------------------------------------------------------------------
// Room Operations
// ---------------------------------------------------------------------------
async function upsertRoom(roomCode, hostToken, accent = '#4f46e5', counterValue = 0) {
  if (isConnected) {
    const res = await pool.query(`
      INSERT INTO synapse_rooms (room_code, host_token, accent, counter_value, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (room_code) DO UPDATE
      SET updated_at = NOW()
      RETURNING *;
    `, [roomCode, hostToken, accent, counterValue]);
    return res.rows[0];
  }

  let r = mem.rooms.get(roomCode);
  if (!r) {
    r = {
      room_code: roomCode,
      host_token: hostToken,
      accent,
      counter_value: counterValue,
      notepad_state: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    mem.rooms.set(roomCode, r);
  } else {
    r.updated_at = new Date();
  }
  return r;
}

async function getRoom(roomCode) {
  if (isConnected) {
    const res = await pool.query('SELECT * FROM synapse_rooms WHERE room_code = $1', [roomCode]);
    return res.rows[0] || null;
  }
  return mem.rooms.get(roomCode) || null;
}

async function updateRoomAccent(roomCode, accent) {
  if (isConnected) {
    await pool.query('UPDATE synapse_rooms SET accent = $1, updated_at = NOW() WHERE room_code = $2', [accent, roomCode]);
    return;
  }
  const r = mem.rooms.get(roomCode);
  if (r) {
    r.accent = accent;
    r.updated_at = new Date();
  }
}

async function updateRoomCounter(roomCode, value) {
  if (isConnected) {
    await pool.query('UPDATE synapse_rooms SET counter_value = $1, updated_at = NOW() WHERE room_code = $2', [value, roomCode]);
    return;
  }
  const r = mem.rooms.get(roomCode);
  if (r) {
    r.counter_value = value;
    r.updated_at = new Date();
  }
}

async function saveNotepadState(roomCode, stateBase64) {
  if (isConnected) {
    await pool.query('UPDATE synapse_rooms SET notepad_state = $1, updated_at = NOW() WHERE room_code = $2', [stateBase64, roomCode]);
    return;
  }
  const r = mem.rooms.get(roomCode);
  if (r) {
    r.notepad_state = stateBase64;
    r.updated_at = new Date();
  }
}

// ---------------------------------------------------------------------------
// Notepad Version History Operations
// ---------------------------------------------------------------------------
async function addNotepadVersion(roomCode, content, editorName, clientId, opType = 'edit') {
  if (isConnected) {
    const res = await pool.query(`
      INSERT INTO synapse_notepad_versions (room_code, content, editor_name, client_id, op_type, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *;
    `, [roomCode, content, editorName, clientId, opType]);
    return res.rows[0];
  }

  const ver = {
    id: getNextSeq(),
    room_code: roomCode,
    content,
    editor_name: editorName,
    client_id: clientId,
    op_type: opType,
    created_at: new Date().toISOString(),
  };
  const list = mem.notepadVersions.get(roomCode) || [];
  list.unshift(ver);
  if (list.length > 200) list.pop();
  mem.notepadVersions.set(roomCode, list);
  return ver;
}

async function getNotepadVersions(roomCode, limit = 50) {
  if (isConnected) {
    const res = await pool.query(`
      SELECT * FROM synapse_notepad_versions
      WHERE room_code = $1
      ORDER BY created_at DESC
      LIMIT $2;
    `, [roomCode, limit]);
    return res.rows;
  }
  const list = mem.notepadVersions.get(roomCode) || [];
  return list.slice(0, limit);
}

async function getNotepadVersionById(id) {
  if (isConnected) {
    const res = await pool.query('SELECT * FROM synapse_notepad_versions WHERE id = $1', [id]);
    return res.rows[0] || null;
  }
  for (const list of mem.notepadVersions.values()) {
    const found = list.find(v => v.id === Number(id));
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Counter Action History Operations (Idempotent)
// ---------------------------------------------------------------------------
async function recordCounterAction(opId, roomCode, opType, amount, prevValue, resultValue, displayName, clientId) {
  if (isConnected) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(`
        INSERT INTO synapse_counter_actions (id, room_code, op_type, amount, prev_value, result_value, display_name, client_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (id) DO NOTHING
        RETURNING *;
      `, [opId, roomCode, opType, amount, prevValue, resultValue, displayName, clientId]);

      await client.query('UPDATE synapse_rooms SET counter_value = $1, updated_at = NOW() WHERE room_code = $2', [resultValue, roomCode]);
      await client.query('COMMIT');
      return res.rows[0] || null;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // In-memory check for idempotency
  const list = mem.counterActions.get(roomCode) || [];
  const existing = list.find(a => a.id === opId);
  if (existing) return existing;

  const action = {
    id: opId,
    room_code: roomCode,
    op_type: opType,
    amount,
    prev_value: prevValue,
    result_value: resultValue,
    display_name: displayName,
    client_id: clientId,
    created_at: new Date().toISOString(),
  };
  list.unshift(action);
  if (list.length > 200) list.pop();
  mem.counterActions.set(roomCode, list);

  const r = mem.rooms.get(roomCode);
  if (r) {
    r.counter_value = resultValue;
    r.updated_at = new Date();
  }
  return action;
}

async function getCounterActions(roomCode, limit = 50) {
  if (isConnected) {
    const res = await pool.query(`
      SELECT * FROM synapse_counter_actions
      WHERE room_code = $1
      ORDER BY created_at DESC
      LIMIT $2;
    `, [roomCode, limit]);
    return res.rows;
  }
  const list = mem.counterActions.get(roomCode) || [];
  return list.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Poll Operations
// ---------------------------------------------------------------------------
async function createPoll(pollId, roomCode, hostClientId, question, options, policy = 'one_vote_per_user') {
  if (isConnected) {
    const res = await pool.query(`
      INSERT INTO synapse_polls (id, room_code, host_client_id, question, options, duplicate_policy, is_closed, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, false, NOW())
      RETURNING *;
    `, [pollId, roomCode, hostClientId, question, JSON.stringify(options), policy]);
    return res.rows[0];
  }

  const poll = {
    id: pollId,
    room_code: roomCode,
    host_client_id: hostClientId,
    question,
    options,
    duplicate_policy: policy,
    is_closed: false,
    created_at: new Date().toISOString(),
  };
  mem.polls.set(pollId, poll);
  mem.pollVotes.set(pollId, new Map());
  return poll;
}

async function getActivePollForRoom(roomCode) {
  if (isConnected) {
    const res = await pool.query(`
      SELECT * FROM synapse_polls
      WHERE room_code = $1
      ORDER BY created_at DESC
      LIMIT 1;
    `, [roomCode]);
    return res.rows[0] || null;
  }
  for (const p of [...mem.polls.values()].reverse()) {
    if (p.room_code === roomCode) return p;
  }
  return null;
}

async function recordPollVote(pollId, roomCode, clientId, displayName, optionIdx) {
  if (isConnected) {
    const res = await pool.query(`
      INSERT INTO synapse_poll_votes (poll_id, room_code, client_id, display_name, option_idx, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (poll_id, client_id) DO UPDATE
      SET option_idx = EXCLUDED.option_idx, created_at = NOW()
      RETURNING *;
    `, [pollId, roomCode, clientId, displayName, optionIdx]);
    return res.rows[0];
  }

  let votesMap = mem.pollVotes.get(pollId);
  if (!votesMap) {
    votesMap = new Map();
    mem.pollVotes.set(pollId, votesMap);
  }
  const vote = {
    id: getNextSeq(),
    poll_id: pollId,
    room_code: roomCode,
    client_id: clientId,
    display_name: displayName,
    option_idx: optionIdx,
    created_at: new Date().toISOString(),
  };
  votesMap.set(clientId, vote);
  return vote;
}

async function getPollVotes(pollId) {
  if (isConnected) {
    const res = await pool.query('SELECT * FROM synapse_poll_votes WHERE poll_id = $1', [pollId]);
    return res.rows;
  }
  const votesMap = mem.pollVotes.get(pollId);
  return votesMap ? Array.from(votesMap.values()) : [];
}

async function closePoll(pollId) {
  if (isConnected) {
    await pool.query('UPDATE synapse_polls SET is_closed = true WHERE id = $1', [pollId]);
    return;
  }
  const p = mem.polls.get(pollId);
  if (p) p.is_closed = true;
}

// ---------------------------------------------------------------------------
// Quiz Operations
// ---------------------------------------------------------------------------
async function createQuiz(quizId, roomCode, hostClientId, title, questions) {
  if (isConnected) {
    const res = await pool.query(`
      INSERT INTO synapse_quizzes (id, room_code, host_client_id, title, questions, current_question_idx, state, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, 0, 'active', NOW())
      RETURNING *;
    `, [quizId, roomCode, hostClientId, title, JSON.stringify(questions)]);
    return res.rows[0];
  }

  const quiz = {
    id: quizId,
    room_code: roomCode,
    host_client_id: hostClientId,
    title,
    questions,
    current_question_idx: 0,
    state: 'active',
    created_at: new Date().toISOString(),
  };
  mem.quizzes.set(quizId, quiz);
  mem.quizSubmissions.set(quizId, new Map());
  return quiz;
}

async function getActiveQuizForRoom(roomCode) {
  if (isConnected) {
    const res = await pool.query(`
      SELECT * FROM synapse_quizzes
      WHERE room_code = $1
      ORDER BY created_at DESC
      LIMIT 1;
    `, [roomCode]);
    return res.rows[0] || null;
  }
  for (const q of [...mem.quizzes.values()].reverse()) {
    if (q.room_code === roomCode) return q;
  }
  return null;
}

async function updateQuizState(quizId, currentQIdx, state) {
  if (isConnected) {
    await pool.query(`
      UPDATE synapse_quizzes
      SET current_question_idx = $1, state = $2
      WHERE id = $3;
    `, [currentQIdx, state, quizId]);
    return;
  }
  const q = mem.quizzes.get(quizId);
  if (q) {
    q.current_question_idx = currentQIdx;
    q.state = state;
  }
}

async function recordQuizSubmission(quizId, roomCode, questionIdx, clientId, displayName, choiceIdx, isCorrect) {
  if (isConnected) {
    const res = await pool.query(`
      INSERT INTO synapse_quiz_submissions (quiz_id, room_code, question_idx, client_id, display_name, choice_idx, is_correct, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (quiz_id, question_idx, client_id) DO NOTHING
      RETURNING *;
    `, [quizId, roomCode, questionIdx, clientId, displayName, choiceIdx, isCorrect]);
    return res.rows[0] || null;
  }

  let subsMap = mem.quizSubmissions.get(quizId);
  if (!subsMap) {
    subsMap = new Map();
    mem.quizSubmissions.set(quizId, subsMap);
  }
  const key = `${questionIdx}:${clientId}`;
  if (subsMap.has(key)) return null; // duplicate submission prevented

  const sub = {
    id: getNextSeq(),
    quiz_id: quizId,
    room_code: roomCode,
    question_idx: questionIdx,
    client_id: clientId,
    display_name: displayName,
    choice_idx: choiceIdx,
    is_correct: isCorrect,
    created_at: new Date().toISOString(),
  };
  subsMap.set(key, sub);
  return sub;
}

async function getQuizSubmissions(quizId) {
  if (isConnected) {
    const res = await pool.query('SELECT * FROM synapse_quiz_submissions WHERE quiz_id = $1 ORDER BY created_at ASC', [quizId]);
    return res.rows;
  }
  const subsMap = mem.quizSubmissions.get(quizId);
  return subsMap ? Array.from(subsMap.values()) : [];
}

// ---------------------------------------------------------------------------
// Whiteboard Stroke Operations
// ---------------------------------------------------------------------------
async function addWhiteboardStroke(strokeId, roomCode, clientId, clientName, tool, color, width, points) {
  if (isConnected) {
    const res = await pool.query(`
      INSERT INTO synapse_whiteboard_strokes (id, room_code, client_id, client_name, tool, color, width, points, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
      ON CONFLICT (id) DO NOTHING
      RETURNING *;
    `, [strokeId, roomCode, clientId, clientName, tool, color, width, JSON.stringify(points)]);
    return res.rows[0] || null;
  }

  const stroke = {
    id: strokeId,
    room_code: roomCode,
    client_id: clientId,
    client_name: clientName,
    tool,
    color,
    width,
    points,
    created_at: new Date().toISOString(),
  };
  const list = mem.strokes.get(roomCode) || [];
  list.push(stroke);
  if (list.length > 5000) list.shift();
  mem.strokes.set(roomCode, list);
  return stroke;
}

async function getWhiteboardStrokes(roomCode, limit = 2000) {
  if (isConnected) {
    const res = await pool.query(`
      SELECT * FROM synapse_whiteboard_strokes
      WHERE room_code = $1
      ORDER BY created_at ASC
      LIMIT $2;
    `, [roomCode, limit]);
    return res.rows;
  }
  const list = mem.strokes.get(roomCode) || [];
  return list.slice(0, limit);
}

async function clearWhiteboardStrokes(roomCode) {
  if (isConnected) {
    await pool.query('DELETE FROM synapse_whiteboard_strokes WHERE room_code = $1', [roomCode]);
    return;
  }
  mem.strokes.set(roomCode, []);
}

module.exports = {
  initDb,
  getStorageStatus,
  upsertRoom,
  getRoom,
  updateRoomAccent,
  updateRoomCounter,
  saveNotepadState,
  addNotepadVersion,
  getNotepadVersions,
  getNotepadVersionById,
  recordCounterAction,
  getCounterActions,
  createPoll,
  getActivePollForRoom,
  recordPollVote,
  getPollVotes,
  closePoll,
  createQuiz,
  getActiveQuizForRoom,
  updateQuizState,
  recordQuizSubmission,
  getQuizSubmissions,
  addWhiteboardStroke,
  getWhiteboardStrokes,
  clearWhiteboardStrokes,
};
