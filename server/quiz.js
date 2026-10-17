// =============================================================================
// Synapse Collaborative Quiz Engine
// Host-only controls, hidden server-side answers, server-side scoring,
// duplicate-submission protection, and live leaderboard tallying.
// =============================================================================
'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');

class QuizEngine {
  /**
   * Host creates a new quiz with an array of questions.
   * questions: [ { text: "...", choices: ["A", "B", ...], correctIdx: 0, explanation?: "..." } ]
   */
  static async createQuiz(roomCode, hostClientId, title, questions) {
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('Quiz must contain at least one question');
    }

    const validatedQuestions = questions.map((q, qIndex) => {
      const text = String(q.text || '').trim().slice(0, 300);
      if (!text) throw new Error(`Question ${qIndex + 1} has no text`);

      if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 6) {
        throw new Error(`Question ${qIndex + 1} must have between 2 and 6 choices`);
      }

      const choices = q.choices.map((c, cIdx) => String(c || `Choice ${cIdx + 1}`).trim().slice(0, 150));
      const correctIdx = Number(q.correctIdx);
      if (isNaN(correctIdx) || correctIdx < 0 || correctIdx >= choices.length) {
        throw new Error(`Question ${qIndex + 1} has invalid correct index`);
      }

      return {
        id: `q_${qIndex + 1}`,
        text,
        choices,
        correctIdx,
        explanation: q.explanation ? String(q.explanation).trim().slice(0, 300) : '',
      };
    });

    const quizId = `quiz_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const cleanTitle = String(title || 'Synapse Collaborative Quiz').trim().slice(0, 100);
    const quiz = await db.createQuiz(quizId, roomCode, hostClientId, cleanTitle, validatedQuestions);

    return {
      quizId: quiz.id,
      roomCode,
      title: cleanTitle,
      totalQuestions: validatedQuestions.length,
      currentQuestionIdx: 0,
      state: 'active',
      publicQuestion: QuizEngine.sanitizeQuestionForPublic(validatedQuestions[0], 0, false),
    };
  }

  /**
   * Strips correctIdx and sensitive fields before sending question to participants.
   */
  static sanitizeQuestionForPublic(questionObj, index, isRevealed) {
    if (!questionObj) return null;
    const base = {
      index,
      id: questionObj.id,
      text: questionObj.text,
      choices: questionObj.choices,
    };
    if (isRevealed) {
      base.correctIdx = questionObj.correctIdx;
      base.explanation = questionObj.explanation;
    }
    return base;
  }

  /**
   * Participant submits an answer. Server checks correctness and enforces single submission.
   */
  static async submitAnswer(quizId, roomCode, questionIdx, clientId, displayName, choiceIdx) {
    const quiz = await db.getActiveQuizForRoom(roomCode);
    if (!quiz || quiz.id !== quizId) {
      throw new Error('Active quiz not found');
    }
    if (quiz.state !== 'active') {
      throw new Error('Answers cannot be submitted in the current quiz state');
    }

    const qIdx = Number(questionIdx);
    if (qIdx !== quiz.current_question_idx) {
      throw new Error('Submissions are only accepted for the current question');
    }

    const questions = Array.isArray(quiz.questions) ? quiz.questions : JSON.parse(quiz.questions || '[]');
    const qObj = questions[qIdx];
    if (!qObj) throw new Error('Question does not exist');

    const cIdx = Number(choiceIdx);
    if (isNaN(cIdx) || cIdx < 0 || cIdx >= qObj.choices.length) {
      throw new Error('Invalid choice index');
    }

    const isCorrect = (cIdx === qObj.correctIdx);

    const submission = await db.recordQuizSubmission(
      quizId,
      roomCode,
      qIdx,
      clientId,
      displayName,
      cIdx,
      isCorrect
    );

    if (!submission) {
      throw new Error('You have already submitted an answer for this question');
    }

    // Return submission feedback (does not broadcast full answer until host reveals)
    return {
      quizId,
      roomCode,
      questionIdx: qIdx,
      choiceIdx: cIdx,
      submitted: true,
    };
  }

  /**
   * Host reveals the answer for the current question.
   */
  static async revealAnswer(quizId, roomCode) {
    const quiz = await db.getActiveQuizForRoom(roomCode);
    if (!quiz || quiz.id !== quizId) throw new Error('Quiz not found');

    const qIdx = quiz.current_question_idx;
    const questions = Array.isArray(quiz.questions) ? quiz.questions : JSON.parse(quiz.questions || '[]');
    const qObj = questions[qIdx];
    if (!qObj) throw new Error('Question not found');

    await db.updateQuizState(quizId, qIdx, 'revealed');

    // Get submissions for breakdown
    const allSubs = await db.getQuizSubmissions(quizId);
    const qSubs = allSubs.filter(s => s.question_idx === qIdx);

    const choiceCounts = qObj.choices.map((_, i) => qSubs.filter(s => s.choice_idx === i).length);

    return {
      quizId,
      roomCode,
      questionIdx: qIdx,
      correctIdx: qObj.correctIdx,
      explanation: qObj.explanation,
      totalSubmissions: qSubs.length,
      choiceCounts,
      state: 'revealed',
    };
  }

  /**
   * Host advances to next question.
   */
  static async nextQuestion(quizId, roomCode) {
    const quiz = await db.getActiveQuizForRoom(roomCode);
    if (!quiz || quiz.id !== quizId) throw new Error('Quiz not found');

    const questions = Array.isArray(quiz.questions) ? quiz.questions : JSON.parse(quiz.questions || '[]');
    const nextIdx = quiz.current_question_idx + 1;

    if (nextIdx >= questions.length) {
      return QuizEngine.finishQuiz(quizId, roomCode);
    }

    await db.updateQuizState(quizId, nextIdx, 'active');

    return {
      quizId,
      roomCode,
      currentQuestionIdx: nextIdx,
      totalQuestions: questions.length,
      state: 'active',
      publicQuestion: QuizEngine.sanitizeQuestionForPublic(questions[nextIdx], nextIdx, false),
    };
  }

  /**
   * Host finishes quiz and triggers leaderboard.
   */
  static async finishQuiz(quizId, roomCode) {
    const quiz = await db.getActiveQuizForRoom(roomCode);
    if (!quiz || quiz.id !== quizId) throw new Error('Quiz not found');

    await db.updateQuizState(quizId, quiz.current_question_idx, 'finished');

    const leaderboard = await QuizEngine.getLeaderboard(quizId);

    return {
      quizId,
      roomCode,
      state: 'finished',
      leaderboard,
    };
  }

  /**
   * Calculates score per participant.
   */
  static async getLeaderboard(quizId) {
    const subs = await db.getQuizSubmissions(quizId);
    const scores = new Map(); // clientId -> { clientId, displayName, score, total }

    for (const s of subs) {
      let entry = scores.get(s.client_id);
      if (!entry) {
        entry = {
          clientId: s.client_id,
          displayName: s.display_name,
          score: 0,
          totalAnswered: 0,
        };
        scores.set(s.client_id, entry);
      }
      entry.totalAnswered++;
      if (s.is_correct) {
        entry.score += 100;
      }
    }

    return Array.from(scores.values()).sort((a, b) => b.score - a.score);
  }

  /**
   * Returns snapshot for late joiners or page refresh.
   */
  static async getQuizSnapshot(roomCode, clientId = null) {
    const quiz = await db.getActiveQuizForRoom(roomCode);
    if (!quiz) return null;

    const questions = Array.isArray(quiz.questions) ? quiz.questions : JSON.parse(quiz.questions || '[]');
    const qIdx = quiz.current_question_idx;
    const isRevealed = quiz.state === 'revealed' || quiz.state === 'finished';
    const currentQ = questions[qIdx];

    const subs = await db.getQuizSubmissions(quiz.id);
    const mySub = clientId ? subs.find(s => s.question_idx === qIdx && s.client_id === clientId) : null;
    const leaderboard = quiz.state === 'finished' ? await QuizEngine.getLeaderboard(quiz.id) : null;

    return {
      quizId: quiz.id,
      roomCode: quiz.room_code,
      title: quiz.title,
      currentQuestionIdx: qIdx,
      totalQuestions: questions.length,
      state: quiz.state,
      publicQuestion: QuizEngine.sanitizeQuestionForPublic(currentQ, qIdx, isRevealed),
      mySubmittedChoice: mySub ? mySub.choice_idx : null,
      leaderboard,
    };
  }
}

module.exports = QuizEngine;
