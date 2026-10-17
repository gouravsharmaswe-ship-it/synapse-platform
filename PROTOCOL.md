# Synapse Real-Time WebSocket Protocol Specification

This document details the client-server message frames, concurrency guarantees, authentication, and error codes for **Synapse**.

---

## 1. Connection Lifecycle

Clients connect to the root WebSocket path (`ws://` or `wss://`):

```
Client  ------------------ HTTP Upgrade (WebSocket) -----------------> Server
Client  ------------------ { type: 'join', ... } --------------------> Server
Server  <----------------- { type: 'room_init', ... } ---------------- Client
Server  ================== Periodic Ping / Pong (30s) =============== Client
```

---

## 2. Frame Specifications

### 2.1 Join & Presence

#### Client `join`
```json
{
  "type": "join",
  "room": "syn-design-room",
  "name": "Alex Rivers",
  "clientId": "usr_9f8a2b",
  "hostToken": "htk_optional_host_secret"
}
```

#### Server `room_init` (Full Room Snapshot)
```json
{
  "type": "room_init",
  "roomCode": "syn-design-room",
  "peer": { "id": "usr_9f8a2b", "name": "Alex Rivers", "color": "#4f46e5", "isHost": true },
  "isHost": true,
  "hostToken": "htk_secret_if_host",
  "accent": "#4f46e5",
  "activeActivity": "POLL",
  "peers": [
    { "id": "usr_9f8a2b", "name": "Alex Rivers", "color": "#4f46e5", "isHost": true }
  ],
  "crdtState": "base64_encoded_yjs_state_vector",
  "counter": { "value": 42, "history": [] },
  "poll": { ... },
  "quiz": { ... },
  "strokes": [ ... ],
  "storage": { "type": "PostgreSQL", "isDurable": true }
}
```

---

### 2.2 Shared Notepad (Yjs CRDT)

Synapse uses **Yjs** for character-level conflict-free document convergence.

- **`pad_update` (Client -> Server & Broadcast to Peers)**:
  ```json
  {
    "type": "pad_update",
    "update": "<base64_encoded_yjs_binary_chunk>"
  }
  ```
- **`pad_restore` (Client -> Server)**:
  ```json
  {
    "type": "pad_restore",
    "versionId": 14,
    "hostToken": "htk_secret"
  }
  ```
- **`pad_restored` (Server Broadcast)**:
  ```json
  {
    "type": "pad_restored",
    "versionId": 14,
    "restoredText": "Document content...",
    "crdtState": "<base64_full_state_vector>",
    "by": { "id": "usr_9f8a2b", "name": "Alex Rivers" },
    "timestamp": "2026-10-17T18:00:00.000Z"
  }
  ```

---

### 2.3 Shared Atomic Counter

Guaranteed atomic operations with duplicate request protection via unique `opId`.

- **`counter_op` (Client -> Server)**:
  ```json
  {
    "type": "counter_op",
    "opType": "increment",
    "amount": 1,
    "opId": "op_9f8a2b1c"
  }
  ```
  *(Supported `opType`: `'increment'`, `'decrement'`, `'reset'`)*

- **`counter_updated` (Server Broadcast to All Peers)**:
  ```json
  {
    "type": "counter_updated",
    "value": 43,
    "action": {
      "opId": "op_9f8a2b1c",
      "roomCode": "syn-design-room",
      "opType": "increment",
      "amount": 1,
      "prevValue": 42,
      "resultValue": 43,
      "displayName": "Alex Rivers",
      "clientId": "usr_9f8a2b",
      "createdAt": "2026-10-17T18:00:00.000Z"
    }
  }
  ```

---

### 2.4 Attributed Emoji Reactions

- **`reaction` (Client -> Server & Broadcast)**:
  ```json
  {
    "type": "reaction",
    "id": "rx_8f2a1b",
    "emoji": "🚀",
    "sender": { "id": "usr_9f8a2b", "name": "Alex Rivers", "color": "#4f46e5" },
    "timestamp": 1729188000000
  }
  ```

---

### 2.5 Collaborative Poll

- **`poll_create` (Host -> Server)**:
  ```json
  {
    "type": "poll_create",
    "question": "Which architecture?",
    "options": ["Monolith", "Microservices", "Event-Driven"],
    "policy": "single_vote",
    "hostToken": "htk_secret"
  }
  ```
  *(Policies: `'single_vote'` allows vote changing; `'strict_single'` locks upon submission)*

- **`poll_vote` (Client -> Server)**:
  ```json
  {
    "type": "poll_vote",
    "pollId": "poll_12345",
    "optionIdx": 1
  }
  ```

- **`poll_tallies_updated` (Server Broadcast)**:
  ```json
  {
    "type": "poll_tallies_updated",
    "pollId": "poll_12345",
    "tallies": [3, 8, 2],
    "totalVotes": 13
  }
  ```

---

### 2.6 Collaborative Quiz

- **`quiz_create` (Host -> Server)**:
  ```json
  {
    "type": "quiz_create",
    "title": "Systems Trivia",
    "questions": [
      {
        "text": "What does CRDT stand for?",
        "choices": ["Conflict-free Replicated Data Type", "..."],
        "correctIdx": 0,
        "explanation": "..."
      }
    ],
    "hostToken": "htk_secret"
  }
  ```
  *Note: The server stores `correctIdx` secretly and NEVER transmits it to participants while the question is active.*

- **`quiz_submit` (Participant -> Server)**:
  ```json
  {
    "type": "quiz_submit",
    "quizId": "quiz_12345",
    "questionIdx": 0,
    "choiceIdx": 0
  }
  ```

- **`quiz_reveal` (Host -> Server)**:
  Triggers broadcast of `quiz_answer_revealed` including `correctIdx`, explanation, and choice breakdown.

---

### 2.7 Collaborative Whiteboard

Supports exactly three distinct tools:
1. `pen`: Smooth freehand line with round joints.
2. `pencil`: Thin (1.5px), crisp, visually distinct stroke.
3. `highlighter`: Thick (20px), translucent (alpha 0.35) marker stroke.

- **`wb_stroke` (Client -> Server & Broadcast)**:
  ```json
  {
    "type": "wb_stroke",
    "stroke": {
      "id": "strk_9f8a",
      "tool": "pen",
      "color": "#4f46e5",
      "width": 3,
      "points": [{ "x": 0.12, "y": 0.45 }, { "x": 0.14, "y": 0.48 }]
    }
  }
  ```

- **`wb_clear` (Host -> Server)**: Clears all canvas strokes across room peers.

---

## 3. Rate Limits & Security

| Action | Rate Limit | Payload Size Limit |
|---|---|---|
| Yjs Pad Edits | 80 ops/sec | 64 KB binary |
| Counter Ops | 20 ops/sec | 1 KB JSON |
| Reactions | 10 events/sec | 512 bytes |
| Whiteboard Strokes | 40 strokes/sec | 2500 points / stroke |
| Poll Votes | 8 votes/sec | 1 KB |
