// =============================================================================
// Synapse Collaborative Poll Engine
// Host-configured polls (2-8 options), server-enforced duplicate vote policy,
// live vote tallies, late-join synchronization, and persistent storage.
// =============================================================================
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');

class PollEngine {
  /**
   * Create a new poll in the specified room.
   */
  static async createPoll(roomCode, hostClientId, question, options, policy = 'single_vote') {
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      throw new Error('Poll question cannot be empty');
    }
    if (!Array.isArray(options) || options.length < 2 || options.length > 8) {
      throw new Error('Poll must have between 2 and 8 options');
    }

    const cleanQuestion = question.trim().slice(0, 300);
    const cleanOptions = options.map((opt, i) => {
      const s = String(opt || '').trim().slice(0, 100);
      return s || `Option ${i + 1}`;
    });

    const pollId = `poll_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const poll = await db.createPoll(pollId, roomCode, hostClientId, cleanQuestion, cleanOptions, policy);

    return {
      poll,
      tallies: cleanOptions.map(() => 0),
      totalVotes: 0,
    };
  }

  /**
   * Cast a vote in a poll. Enforces server-side duplicate vote policy.
   */
  static async castVote(pollId, roomCode, clientId, displayName, optionIdx) {
    const poll = await db.getActivePollForRoom(roomCode);
    if (!poll || poll.id !== pollId) {
      throw new Error('Poll not found or inactive');
    }
    if (poll.is_closed) {
      throw new Error('This poll has been closed');
    }

    const idx = Number(optionIdx);
    const options = Array.isArray(poll.options) ? poll.options : JSON.parse(poll.options || '[]');
    if (isNaN(idx) || idx < 0 || idx >= options.length) {
      throw new Error('Invalid option index');
    }

    // Check existing votes
    const existingVotes = await db.getPollVotes(pollId);
    const existing = existingVotes.find(v => v.client_id === clientId);

    if (existing && poll.duplicate_policy === 'strict_single') {
      throw new Error('You have already voted in this poll and vote-changes are disabled');
    }

    await db.recordPollVote(pollId, roomCode, clientId, displayName, idx);

    // Compute updated tallies
    const updatedVotes = await db.getPollVotes(pollId);
    const tallies = options.map((_, oIdx) => updatedVotes.filter(v => v.option_idx === oIdx).length);
    const totalVotes = updatedVotes.length;

    return {
      pollId,
      roomCode,
      votedOptionIdx: idx,
      tallies,
      totalVotes,
      options,
    };
  }

  /**
   * Get current poll state with tallies for late joiners or reconnecting peers.
   */
  static async getPollSnapshot(roomCode, clientId = null) {
    const poll = await db.getActivePollForRoom(roomCode);
    if (!poll) return null;

    const options = Array.isArray(poll.options) ? poll.options : JSON.parse(poll.options || '[]');
    const votes = await db.getPollVotes(poll.id);
    const tallies = options.map((_, oIdx) => votes.filter(v => v.option_idx === oIdx).length);
    const userVote = clientId ? votes.find(v => v.client_id === clientId) : null;

    return {
      pollId: poll.id,
      roomCode: poll.room_code,
      question: poll.question,
      options,
      policy: poll.duplicate_policy,
      isClosed: poll.is_closed,
      tallies,
      totalVotes: votes.length,
      userVotedIdx: userVote ? userVote.option_idx : null,
    };
  }

  /**
   * Close poll (host action).
   */
  static async closePoll(pollId, roomCode) {
    await db.closePoll(pollId);
    return { pollId, roomCode, isClosed: true };
  }
}

module.exports = PollEngine;
