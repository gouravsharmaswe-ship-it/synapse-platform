// =============================================================================
// Synapse Shared Counter Engine
// Atomic concurrency serialization, idempotency deduplication,
// attributed operation logging, and persistent snapshotting.
// =============================================================================
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const roomLocks = new Map(); // roomCode -> Promise queue for atomic operation serialization

class CounterEngine {
  /**
   * Applies a counter operation atomically with idempotency protection.
   */
  static async applyOperation(roomCode, clientId, displayName, opType, amount = 1, clientOpId = null) {
    const opId = clientOpId || `op_${uuidv4().replace(/-/g, '').slice(0, 12)}`;

    // Serialize operations per room using a lightweight promise lock
    let lock = roomLocks.get(roomCode) || Promise.resolve();

    const resultPromise = lock.then(async () => {
      // 1. Fetch current room state
      const room = await db.getRoom(roomCode);
      const currentValue = room ? Number(room.counter_value || 0) : 0;
      let nextValue = currentValue;
      const numAmount = Math.max(1, Math.min(Number(amount) || 1, 1000));

      switch (opType) {
        case 'increment':
          nextValue = currentValue + numAmount;
          break;
        case 'decrement':
          nextValue = currentValue - numAmount;
          break;
        case 'reset':
          nextValue = 0;
          break;
        default:
          throw new Error(`Unsupported counter operation: ${opType}`);
      }

      // 2. Record operation in DB with idempotency
      const record = await db.recordCounterAction(
        opId,
        roomCode,
        opType,
        numAmount,
        currentValue,
        nextValue,
        String(displayName || 'Guest').slice(0, 32),
        clientId
      );

      return {
        opId,
        roomCode,
        opType,
        amount: numAmount,
        prevValue: currentValue,
        resultValue: record ? record.result_value : nextValue,
        displayName,
        clientId,
        createdAt: record ? record.created_at : new Date().toISOString(),
      };
    });

    roomLocks.set(roomCode, resultPromise.catch(() => {}));
    return resultPromise;
  }

  /**
   * Get current counter value and recent history for late joiners.
   */
  static async getSnapshot(roomCode) {
    const room = await db.getRoom(roomCode);
    const actions = await db.getCounterActions(roomCode, 50);
    return {
      roomCode,
      value: room ? Number(room.counter_value || 0) : 0,
      history: actions.map(a => ({
        id: a.id,
        opType: a.op_type,
        amount: a.amount,
        prevValue: a.prev_value,
        resultValue: a.result_value,
        displayName: a.display_name,
        clientId: a.client_id,
        createdAt: a.created_at,
      })),
    };
  }
}

module.exports = CounterEngine;
