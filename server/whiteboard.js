// =============================================================================
// Synapse Collaborative Whiteboard Engine
// Shared drawing canvas with exactly 3 tools: PEN, PENCIL, HIGHLIGHTER.
// Incremental stroke streaming, stable ordering, DPR resilience, and persistent replay.
// =============================================================================
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const ALLOWED_TOOLS = new Set(['pen', 'pencil', 'highlighter']);

class WhiteboardEngine {
  /**
   * Validates and persists an incremental stroke.
   */
  static async recordStroke(roomCode, clientId, clientName, strokeData) {
    if (!strokeData || typeof strokeData !== 'object') {
      throw new Error('Invalid stroke payload');
    }

    const tool = String(strokeData.tool || 'pen').toLowerCase();
    if (!ALLOWED_TOOLS.has(tool)) {
      throw new Error(`Invalid whiteboard tool: ${tool}. Allowed tools: pen, pencil, highlighter`);
    }

    const color = String(strokeData.color || '#1e293b').slice(0, 32);
    const width = Math.max(0.5, Math.min(Number(strokeData.width) || 3, 60));

    if (!Array.isArray(strokeData.points) || strokeData.points.length === 0) {
      throw new Error('Stroke must contain at least one coordinate point');
    }

    // Sanitize points to prevent payload bloating (max 2500 points per stroke)
    const points = strokeData.points.slice(0, 2500).map(p => ({
      x: Math.round(Number(p.x || 0) * 1000) / 1000,
      y: Math.round(Number(p.y || 0) * 1000) / 1000,
    }));

    const strokeId = strokeData.id || `strk_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const cleanName = String(clientName || 'Anonymous').slice(0, 32);

    const saved = await db.addWhiteboardStroke(
      strokeId,
      roomCode,
      clientId,
      cleanName,
      tool,
      color,
      width,
      points
    );

    return saved;
  }

  /**
   * Retrieves all ordered strokes for late joiners or page refresh.
   */
  static async getStrokes(roomCode, limit = 2000) {
    const strokes = await db.getWhiteboardStrokes(roomCode, limit);
    return strokes.map(s => ({
      id: s.id,
      roomCode: s.room_code,
      clientId: s.client_id,
      clientName: s.client_name,
      tool: s.tool,
      color: s.color,
      width: s.width,
      points: Array.isArray(s.points) ? s.points : JSON.parse(s.points || '[]'),
      createdAt: s.created_at,
    }));
  }

  /**
   * Clears the whiteboard canvas for the room.
   */
  static async clearWhiteboard(roomCode) {
    await db.clearWhiteboardStrokes(roomCode);
    return { roomCode, cleared: true, clearedAt: new Date().toISOString() };
  }
}

module.exports = WhiteboardEngine;
