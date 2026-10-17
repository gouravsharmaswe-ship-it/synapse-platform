// =============================================================================
// Synapse Collaborative Quiz View Module
// Host-only controls, secret server-side scoring, instant feedback,
// answer breakdown bars, explanation cards, and final leaderboard podium.
// =============================================================================
'use strict';

class QuizView {
  constructor(containerElement, client, isHost = false) {
    this.container = containerElement;
    this.client = client;
    this.isHost = isHost;

    this.currentQuiz = null;
    this.mySubmittedChoice = null;

    this._bindClientEvents();
  }

  setHost(isHost) {
    this.isHost = isHost;
    this.render();
  }

  setQuizData(quizSnapshot) {
    if (!quizSnapshot) {
      this.currentQuiz = null;
      this.mySubmittedChoice = null;
    } else {
      this.currentQuiz = {
        quizId: quizSnapshot.quizId,
        title: quizSnapshot.title,
        currentQuestionIdx: quizSnapshot.currentQuestionIdx,
        totalQuestions: quizSnapshot.totalQuestions,
        state: quizSnapshot.state,
        publicQuestion: quizSnapshot.publicQuestion,
        leaderboard: quizSnapshot.leaderboard,
      };
      this.mySubmittedChoice = quizSnapshot.mySubmittedChoice;
    }
    this.render();
  }

  _bindClientEvents() {
    this.client.on('quiz_started', (data) => {
      this.currentQuiz = {
        quizId: data.quizId,
        title: data.title,
        currentQuestionIdx: 0,
        totalQuestions: data.totalQuestions,
        state: 'active',
        publicQuestion: data.publicQuestion,
        leaderboard: null,
      };
      this.mySubmittedChoice = null;
      this.render();
    });

    this.client.on('quiz_submit_ack', (data) => {
      this.mySubmittedChoice = data.choiceIdx;
      this.render();
    });

    this.client.on('quiz_answer_revealed', (data) => {
      if (this.currentQuiz && this.currentQuiz.quizId === data.quizId) {
        this.currentQuiz.state = 'revealed';
        this.currentQuiz.publicQuestion.correctIdx = data.correctIdx;
        this.currentQuiz.publicQuestion.explanation = data.explanation;
        this.currentQuiz.choiceCounts = data.choiceCounts;
        this.currentQuiz.totalSubmissions = data.totalSubmissions;
        this.render();
      }
    });

    this.client.on('quiz_advanced', (data) => {
      if (this.currentQuiz && this.currentQuiz.quizId === data.quizId) {
        this.currentQuiz.currentQuestionIdx = data.currentQuestionIdx;
        this.currentQuiz.state = 'active';
        this.currentQuiz.publicQuestion = data.publicQuestion;
        this.currentQuiz.choiceCounts = null;
        this.mySubmittedChoice = null;
        this.render();
      }
    });

    this.client.on('quiz_finished', (data) => {
      if (this.currentQuiz && this.currentQuiz.quizId === data.quizId) {
        this.currentQuiz.state = 'finished';
        this.currentQuiz.leaderboard = data.leaderboard;
        this.render();
      }
    });
  }

  render() {
    if (!this.currentQuiz) {
      this._renderEmptyOrCreator();
      return;
    }
    if (this.currentQuiz.state === 'finished') {
      this._renderLeaderboard();
      return;
    }
    this._renderQuestionView();
  }

  _renderEmptyOrCreator() {
    if (!this.isHost) {
      this.container.innerHTML = `
        <div style="text-align: center; padding: 48px 20px; color: var(--text-secondary);">
          <div style="font-size: 2.5rem; margin-bottom: 12px;">🧠</div>
          <h3 style="font-size: 1.15rem; font-weight: 700; color: var(--text-primary); margin-bottom: 6px;">No Active Quiz</h3>
          <p style="font-size: 0.9rem;">The room host hasn't launched a quiz yet. Questions and leaderboard will appear here once started.</p>
        </div>
      `;
      return;
    }

    // Host Quiz Creator
    this.container.innerHTML = `
      <div style="max-width: 640px; margin: 0 auto;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px;">
          <h3 style="font-size: 1.2rem; font-weight: 800; color: var(--text-primary);">Create Collaborative Quiz</h3>
          <span class="badge badge-accent">Host Control</span>
        </div>

        <div style="margin-bottom: 20px; padding: 12px 16px; background: var(--bg-subtle); border-radius: var(--radius-md); display: flex; align-items: center; justify-content: space-between;">
          <span style="font-size: 0.85rem; color: var(--text-secondary);">Want to quickly test a pre-built computer science trivia set?</span>
          <button type="button" class="btn btn-secondary btn-sm" onclick="window.__quizView.loadTriviaPreset()">
            ⚡ Load CS Trivia Set
          </button>
        </div>

        <form id="quiz-create-form" onsubmit="window.__quizView.handleCreateQuiz(event)">
          <div class="input-group">
            <label class="input-label" for="quiz-title">Quiz Title</label>
            <input type="text" id="quiz-title" class="input-field" value="Real-Time Systems & Distributed Trivia" required maxlength="100">
          </div>

          <div id="quiz-questions-list" style="display: flex; flex-direction: column; gap: 16px;">
            <!-- Questions dynamically populated -->
          </div>

          <div style="display: flex; gap: 10px; margin-top: 16px;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.__quizView.addQuestionField()">
              + Add Another Question
            </button>
          </div>

          <button type="submit" class="btn btn-primary" style="margin-top: 24px; width: 100%;">
            Launch Quiz to All Participants 🚀
          </button>
        </form>
      </div>
    `;

    this._populateInitialQuestions();
  }

  _populateInitialQuestions() {
    const list = document.getElementById('quiz-questions-list');
    if (!list) return;
    list.innerHTML = '';
    this.addQuestionField('What does CRDT stand for in collaborative systems?', [
      'Conflict-free Replicated Data Type',
      'Centralized Real-time Database Transaction',
      'Concurrent Redundant Document Tree',
      'Cryptographic Reliable Data Transmission'
    ], 0, 'CRDTs guarantee mathematical convergence without centralized locking.');
  }

  loadTriviaPreset() {
    const list = document.getElementById('quiz-questions-list');
    if (!list) return;
    list.innerHTML = '';

    this.addQuestionField(
      'What does CRDT stand for in real-time systems?',
      ['Conflict-free Replicated Data Type', 'Concurrent Real-time Data Table', 'Centralized Redundant Document Thread', 'Client Replicated Delta Token'],
      0,
      'CRDTs mathematically guarantee eventual consistency without requiring centralized locking.'
    );

    this.addQuestionField(
      'Which WebSocket frame op-code is reserved for client-to-server heartbeat ping?',
      ['0x1', '0x8', '0x9', '0xA'],
      2,
      'RFC 6455 specifies 0x9 as Ping and 0xA as Pong control frames.'
    );

    this.addQuestionField(
      'Why is Yjs preferred over naive Operational Transformation for decentralized editing?',
      ['Supports binary delta vectors and avoids central OT transform matrix', 'Requires a single SQL write per keystroke', 'Disables concurrent writes', 'Limits document size to 10 lines'],
      0,
      'Yjs provides lightning-fast binary state vector reconciliation and deterministic conflict resolution.'
    );
  }

  addQuestionField(text = '', choices = ['Choice 1', 'Choice 2', 'Choice 3', 'Choice 4'], correctIdx = 0, explanation = '') {
    const list = document.getElementById('quiz-questions-list');
    if (!list) return;
    const qCount = list.children.length + 1;

    const div = document.createElement('div');
    div.className = 'card quiz-q-card';
    div.style.padding = '16px';
    div.style.backgroundColor = 'var(--bg-subtle)';

    div.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
        <span style="font-weight: 700; font-size: 0.9rem; color: var(--text-primary);">Question ${qCount}</span>
        ${qCount > 1 ? `<button type="button" class="btn btn-ghost btn-sm" onclick="this.closest('.quiz-q-card').remove()">Remove</button>` : ''}
      </div>
      <div class="input-group" style="margin-bottom: 12px;">
        <input type="text" class="input-field q-text" placeholder="Question prompt..." value="${this._escapeHtml(text)}" required maxlength="250">
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;">
        ${choices.map((c, i) => `
          <div style="display: flex; align-items: center; gap: 8px;">
            <input type="radio" name="correct_for_q_${qCount}" value="${i}" ${i === correctIdx ? 'checked' : ''} title="Mark as correct answer">
            <input type="text" class="input-field q-choice" style="flex: 1;" placeholder="Choice ${i + 1}" value="${this._escapeHtml(c)}" required maxlength="120">
          </div>
        `).join('')}
      </div>
      <div class="input-group" style="margin-bottom: 0;">
        <input type="text" class="input-field q-exp" placeholder="Explanation for correct answer (revealed later)..." value="${this._escapeHtml(explanation)}" maxlength="200">
      </div>
    `;

    list.appendChild(div);
  }

  handleCreateQuiz(e) {
    e.preventDefault();
    const title = document.getElementById('quiz-title').value.trim();
    const qCards = document.querySelectorAll('.quiz-q-card');
    const questions = [];

    qCards.forEach((card, qIdx) => {
      const text = card.querySelector('.q-text').value.trim();
      const choiceInputs = card.querySelectorAll('.q-choice');
      const choices = Array.from(choiceInputs).map(inp => inp.value.trim()).filter(Boolean);
      const radio = card.querySelector(`input[name="correct_for_q_${qIdx + 1}"]:checked`);
      const correctIdx = radio ? Number(radio.value) : 0;
      const explanation = card.querySelector('.q-exp').value.trim();

      if (text && choices.length >= 2) {
        questions.push({ text, choices, correctIdx, explanation });
      }
    });

    if (questions.length === 0) return;

    this.client.sendQuizCreate(title, questions);
  }

  _renderQuestionView() {
    const q = this.currentQuiz;
    const pubQ = q.publicQuestion;
    const isRevealed = q.state === 'revealed';
    const isFinished = q.state === 'finished';

    let choicesHtml = '';
    pubQ.choices.forEach((choice, idx) => {
      const isSelected = this.mySubmittedChoice === idx;
      let borderStyle = 'var(--border-light)';
      let bgStyle = 'var(--bg-surface)';
      let badge = '';

      if (isSelected) {
        borderStyle = 'var(--accent)';
        bgStyle = 'var(--accent-light)';
      }

      if (isRevealed) {
        if (idx === pubQ.correctIdx) {
          borderStyle = 'var(--success)';
          bgStyle = 'var(--success-bg)';
          badge = `<span style="color: var(--success); font-weight: 700; margin-left: auto;">✓ Correct Answer</span>`;
        } else if (isSelected) {
          borderStyle = 'var(--danger)';
          bgStyle = 'var(--danger-bg)';
          badge = `<span style="color: var(--danger); font-weight: 700; margin-left: auto;">✗ Your Choice</span>`;
        }
      }

      const voteCount = (q.choiceCounts && q.choiceCounts[idx]) || 0;
      const votePct = (q.totalSubmissions && q.totalSubmissions > 0) ? Math.round((voteCount / q.totalSubmissions) * 100) : 0;

      choicesHtml += `
        <div style="margin-bottom: 10px;">
          <button type="button"
            onclick="window.__quizView.handleSubmitAnswer(${idx})"
            ${(isRevealed || isFinished || this.mySubmittedChoice !== null) ? 'disabled' : ''}
            style="width: 100%; text-align: left; background: ${bgStyle}; border: 2px solid ${borderStyle}; border-radius: var(--radius-md); padding: 14px 18px; cursor: ${(isRevealed || this.mySubmittedChoice !== null) ? 'default' : 'pointer'}; display: flex; align-items: center; gap: 12px; transition: all 0.2s;"
          >
            <span style="width: 28px; height: 28px; border-radius: 50%; background: var(--bg-subtle); display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.85rem; color: var(--text-secondary);">
              ${String.fromCharCode(65 + idx)}
            </span>
            <span style="font-weight: 600; color: var(--text-primary); font-size: 0.95rem;">
              ${this._escapeHtml(choice)}
            </span>
            ${badge}
          </button>
          ${isRevealed ? `
            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px; margin-left: 12px;">
              ${votePct}% answered this (${voteCount} votes)
            </div>
          ` : ''}
        </div>
      `;
    });

    let explanationCard = '';
    if (isRevealed && pubQ.explanation) {
      explanationCard = `
        <div style="margin-top: 16px; padding: 14px 18px; background: var(--bg-subtle); border-left: 4px solid var(--accent); border-radius: var(--radius-md);">
          <div style="font-weight: 700; font-size: 0.85rem; color: var(--text-primary); margin-bottom: 4px;">Explanation</div>
          <div style="font-size: 0.9rem; color: var(--text-secondary); line-height: 1.5;">${this._escapeHtml(pubQ.explanation)}</div>
        </div>
      `;
    }

    let hostBar = '';
    if (this.isHost) {
      hostBar = `
        <div style="display: flex; gap: 10px; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border-light); justify-content: flex-end;">
          ${!isRevealed ? `
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.__quizView.handleRevealAnswer()">
              👁️ Reveal Answer
            </button>
          ` : `
            <button type="button" class="btn btn-primary btn-sm" onclick="window.__quizView.handleNextQuestion()">
              ${(q.currentQuestionIdx + 1 >= q.totalQuestions) ? '🏆 View Final Leaderboard' : 'Next Question →'}
            </button>
          `}
        </div>
      `;
    }

    this.container.innerHTML = `
      <div style="max-width: 640px; margin: 0 auto;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <span class="badge badge-accent">Question ${q.currentQuestionIdx + 1} of ${q.totalQuestions}</span>
          <span style="font-size: 0.85rem; color: var(--text-muted); font-weight: 600;">${this._escapeHtml(q.title)}</span>
        </div>

        <h3 style="font-size: 1.35rem; font-weight: 800; color: var(--text-primary); margin-bottom: 24px; line-height: 1.35;">
          ${this._escapeHtml(pubQ.text)}
        </h3>

        ${this.mySubmittedChoice !== null && !isRevealed ? `
          <div style="margin-bottom: 16px; padding: 10px 14px; background: var(--info-bg); border: 1px solid rgba(14, 165, 233, 0.3); border-radius: var(--radius-md); font-size: 0.85rem; color: var(--info); font-weight: 600;">
            ✓ Your answer is locked in. Waiting for host to reveal results...
          </div>
        ` : ''}

        ${choicesHtml}
        ${explanationCard}
        ${hostBar}
      </div>
    `;
  }

  _renderLeaderboard() {
    const q = this.currentQuiz;
    const leaderboard = q.leaderboard || [];

    let podiumHtml = '';
    leaderboard.forEach((entry, idx) => {
      const medals = ['🥇', '🥈', '🥉'];
      const medal = medals[idx] || `#${idx + 1}`;

      podiumHtml += `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; background: var(--bg-surface); border: 1px solid var(--border-light); border-radius: var(--radius-md); margin-bottom: 8px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span style="font-size: 1.25rem;">${medal}</span>
            <span style="font-weight: 700; color: var(--text-primary); font-size: 0.95rem;">${this._escapeHtml(entry.displayName)}</span>
          </div>
          <div style="font-weight: 800; font-family: var(--font-mono); color: var(--accent); font-size: 1.05rem;">
            ${entry.score} pts
          </div>
        </div>
      `;
    });

    this.container.innerHTML = `
      <div style="max-width: 600px; margin: 0 auto; text-align: center;">
        <div style="font-size: 3rem; margin-bottom: 8px;">🏆</div>
        <h3 style="font-size: 1.5rem; font-weight: 800; color: var(--text-primary); margin-bottom: 6px;">Quiz Completed!</h3>
        <p style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 24px;">Here are the final standings for ${this._escapeHtml(q.title)}:</p>

        <div style="margin-bottom: 24px;">
          ${podiumHtml || '<p style="color: var(--text-muted);">No submissions recorded.</p>'}
        </div>

        ${this.isHost ? `
          <button type="button" class="btn btn-primary" onclick="window.__quizView.handleResetQuiz()">
            + Create New Quiz Challenge
          </button>
        ` : ''}
      </div>
    `;
  }

  handleSubmitAnswer(choiceIdx) {
    if (!this.currentQuiz || this.currentQuiz.state !== 'active') return;
    this.client.sendQuizSubmit(this.currentQuiz.quizId, this.currentQuiz.currentQuestionIdx, choiceIdx);
  }

  handleRevealAnswer() {
    if (!this.currentQuiz) return;
    this.client.sendQuizReveal(this.currentQuiz.quizId);
  }

  handleNextQuestion() {
    if (!this.currentQuiz) return;
    this.client.sendQuizNext(this.currentQuiz.quizId);
  }

  handleResetQuiz() {
    this.currentQuiz = null;
    this.mySubmittedChoice = null;
    this.render();
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

window.QuizView = QuizView;
