// =============================================================================
// Synapse CRDT Engine (Powered by Yjs)
// Character-level concurrent editing, deterministic convergence,
// offline reconnection merge, and debounced version snapshotting.
// =============================================================================
'use strict';

const Y = require('yjs');
const db = require('./db');

const roomDocs = new Map(); // roomCode -> { doc, yText, debounceTimer, lastEditor, lastClientId, lastSavedText }

function getRoomDoc(roomCode) {
  let entry = roomDocs.get(roomCode);
  if (!entry) {
    const doc = new Y.Doc();
    const yText = doc.getText('notepad');
    entry = {
      doc,
      yText,
      debounceTimer: null,
      lastEditor: 'Initial',
      lastClientId: 'system',
      lastSavedText: '',
    };
    roomDocs.set(roomCode, entry);
  }
  return entry;
}

/**
 * Applies a Yjs binary update (Uint8Array or Buffer) to a room document.
 * Returns the updated plain text and triggers debounced version persistence.
 */
function applyUpdate(roomCode, updateBuffer, editorName = 'Anonymous', clientId = 'unknown') {
  const entry = getRoomDoc(roomCode);
  entry.lastEditor = editorName;
  entry.lastClientId = clientId;

  const uint8 = new Uint8Array(updateBuffer);
  Y.applyUpdate(entry.doc, uint8);

  const currentText = entry.yText.toString();

  // Debounced version persistence (3.5 seconds of quiet)
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  entry.debounceTimer = setTimeout(async () => {
    try {
      if (currentText !== entry.lastSavedText && currentText.trim().length > 0) {
        entry.lastSavedText = currentText;
        await db.addNotepadVersion(roomCode, currentText, entry.lastEditor, entry.lastClientId, 'edit');
        const encodedDoc = Buffer.from(Y.encodeStateAsUpdate(entry.doc)).toString('base64');
        await db.saveNotepadState(roomCode, encodedDoc);
      }
    } catch (err) {
      console.error(`⚠️ [CRDT] Debounced snapshot error in ${roomCode}:`, err.message);
    }
  }, 3500);

  return currentText;
}

/**
 * Returns full Yjs document state as a Base64 string for initial sync / late joiners.
 */
function getEncodedState(roomCode) {
  const entry = getRoomDoc(roomCode);
  const state = Y.encodeStateAsUpdate(entry.doc);
  return Buffer.from(state).toString('base64');
}

/**
 * Returns current plain text of the notepad.
 */
function getPlainText(roomCode) {
  const entry = getRoomDoc(roomCode);
  return entry.yText.toString();
}

/**
 * Restores a specific version into the live CRDT document.
 * Creates a new 'restore' version record and preserves all intervening history.
 */
async function restoreVersion(roomCode, restoredText, editorName = 'Host', clientId = 'host') {
  const entry = getRoomDoc(roomCode);
  const currentLength = entry.yText.length;

  entry.doc.transact(() => {
    if (currentLength > 0) {
      entry.yText.delete(0, currentLength);
    }
    if (restoredText.length > 0) {
      entry.yText.insert(0, restoredText);
    }
  });

  entry.lastEditor = editorName;
  entry.lastClientId = clientId;
  entry.lastSavedText = restoredText;

  // Persist restore event immediately in version history
  const ver = await db.addNotepadVersion(roomCode, restoredText, editorName, clientId, 'restore');
  const encodedDoc = Buffer.from(Y.encodeStateAsUpdate(entry.doc)).toString('base64');
  await db.saveNotepadState(roomCode, encodedDoc);

  return {
    version: ver,
    text: restoredText,
    updateBase64: Buffer.from(Y.encodeStateAsUpdate(entry.doc)).toString('base64'),
  };
}

/**
 * Explicit manual snapshot creation.
 */
async function createManualSnapshot(roomCode, editorName, clientId) {
  const entry = getRoomDoc(roomCode);
  const text = entry.yText.toString();
  entry.lastSavedText = text;
  const ver = await db.addNotepadVersion(roomCode, text, editorName, clientId, 'snapshot');
  const encodedDoc = Buffer.from(Y.encodeStateAsUpdate(entry.doc)).toString('base64');
  await db.saveNotepadState(roomCode, encodedDoc);
  return ver;
}

module.exports = {
  getRoomDoc,
  applyUpdate,
  getEncodedState,
  getPlainText,
  restoreVersion,
  createManualSnapshot,
};
