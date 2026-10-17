// =============================================================================
// Synapse Collaborative Poll View Module
// Host configuration (2-8 options), duplicate-vote policy enforcement,
// animated live percentage bars, submission feedback, and late-join state sync.
// =============================================================================
'use strict';

class PollView {
  constructor(containerElement, client, isHost = false) {
    this.container = containerElement;
    this.client = client;
    this.isHost = isHost;

    this.currentPoll = null;
    this.userVotedIdx = null;

    this._bindClientEvents();
  }

  setHost(isHost) {
    this.isHost = isHost;
    this.render();
  }

  setPollData(pollSnapshot) {
    if (!pollSnapshot) {
      this.currentPoll = null;
      this.userVotedIdx = null;
    } else {
      this.currentPoll = {
        id: pollSnapshot.pollId,
        question: pollSnapshot.question,
        options: pollSnapshot.options,
        policy: pollSnapshot.policy,
        isClosed: pollSnapshot.isClosed,
        tallies: pollSnapshot.tallies,
        totalVotes: pollSnapshot.totalVotes,
      };
      this.userVotedIdx = pollSnapshot.userVotedIdx;
    }
    this.render();
  }

  _bindClientEvents() {
    this.client.on('poll_created', (data) => {
      this.currentPoll = {
        id: data.poll.id,
        question: data.poll.question,
        options: Array.isArray(data.poll.options) ? data.poll.options : JSON.parse(data.poll.options || '[]'),
        policy: data.poll.duplicate_policy,
        isClosed: false,
        tallies: data.tallies,
        totalVotes: data.totalVotes,
      };
      this.userVotedIdx = null;
      this.render();
    });

    this.client.on('poll_vote_ack', (data) => {
      this.userVotedIdx = data.optionIdx;
      this.render();
    });

    this.client.on('poll_tallies_updated', (data) => {
      if (this.currentPoll && this.currentPoll.id === data.pollId) {
        this.currentPoll.tallies = data.tallies;
        this.currentPoll.totalVotes = data.totalVotes;
        this.render();
      }
    });

    this.client.on('poll_closed', () => {
      if (this.currentPoll) {
        this.currentPoll.isClosed = true;
        this.render();
      }
    });
  }

  render() {
    if (!this.currentPoll) {
      this._renderEmptyOrCreator();
      return;
    }
    this._renderActivePoll();
  }

  _renderEmptyOrCreator() {
    if (!this.isHost) {
      this.container.innerHTML = `
        <div style="text-align: center; padding: 48px 20px; color: var(--text-secondary);">
          <div style="font-size: 2.5rem; margin-bottom: 12px;">🗳️</div>
          <h3 style="font-size: 1.15rem; font-weight: 700; color: var(--text-primary); margin-bottom: 6px;">No Active Poll</h3>
          <p style="font-size: 0.9rem;">The room host hasn't launched a poll yet. Live results will appear here as soon as a poll is started.</p>
        </div>
      `;
      return;
    }

    // Host Creator Form
    this.container.innerHTML = `
      <div style="max-width: 600px; margin: 0 auto;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px;">
          <h3 style="font-size: 1.2rem; font-weight: 800; color: var(--text-primary);">Create Collaborative Poll</h3>
          <span class="badge badge-accent">Host Control</span>
        </div>

        <form id="poll-create-form" onsubmit="window.__pollView.handleCreatePoll(event)">
          <div class="input-group">
            <label class="input-label" for="poll-question">Poll Question</label>
            <input type="text" id="poll-question" class="input-field" placeholder="e.g., Which feature should we prioritize next?" required maxlength="250">
          </div>

          <div class="input-group">
            <label class="input-label">Voting Options (2–8 choices)</label>
            <div id="poll-options-container" style="display: flex; flex-direction: column; gap: 8px;">
              <input type="text" class="input-field poll-opt-input" placeholder="Option 1" required maxlength="100" value="Option A">
              <input type="text" class="input-field poll-opt-input" placeholder="Option 2" required maxlength="100" value="Option B">
            </div>
            <div style="display: flex; gap: 8px; margin-top: 8px;">
              <button type="button" class="btn btn-secondary btn-sm" onclick="window.__pollView.addOptionField()">+ Add Option</button>
              <button type="button" class="btn btn-ghost btn-sm" onclick="window.__pollView.removeOptionField()">- Remove Option</button>
            </div>
          </div>

          <div class="input-group">
            <label class="input-label" for="poll-policy">Duplicate Vote Policy</label>
            <select id="poll-policy" class="input-field">
              <option value="single_vote">Single Vote (Allow changing vote)</option>
              <option value="strict_single">Strict Single (Lock vote upon submit)</option>
            </select>
          </div>

          <button type="submit" class="btn btn-primary" style="margin-top: 12px; width: 100%;">
            Launch Live Poll to Room 🚀
          </button>
        </form>
      </div>
    `;
  }

  addOptionField() {
    const list = document.getElementById('poll-options-container');
    if (!list) return;
    const count = list.querySelectorAll('.poll-opt-input').length;
    if (count >= 8) {
      alert('Maximum 8 options allowed.');
      return;
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input-field poll-opt-input';
    input.placeholder = `Option ${count + 1}`;
    input.required = true;
    input.maxLength = 100;
    list.appendChild(input);
  }

  removeOptionField() {
    const list = document.getElementById('poll-options-container');
    if (!list) return;
    const inputs = list.querySelectorAll('.poll-opt-input');
    if (inputs.length <= 2) {
      alert('Minimum 2 options required.');
      return;
    }
    list.removeChild(inputs[inputs.length - 1]);
  }

  handleCreatePoll(e) {
    e.preventDefault();
    const q = document.getElementById('poll-question').value.trim();
    const inputs = document.querySelectorAll('.poll-opt-input');
    const options = Array.from(inputs).map(inp => inp.value.trim()).filter(Boolean);
    const policy = document.getElementById('poll-policy').value;

    if (!q || options.length < 2) return;

    this.client.sendPollCreate(q, options, policy);
  }

  _renderActivePoll() {
    const p = this.currentPoll;
    const total = p.totalVotes || 0;

    let optionsHtml = '';
    p.options.forEach((opt, idx) => {
      const votes = (p.tallies && p.tallies[idx]) || 0;
      const pct = total > 0 ? Math.round((votes / total) * 100) : 0;
      const isSelected = this.userVotedIdx === idx;
      const isClosed = p.isClosed;

      optionsHtml += `
        <div style="position: relative; margin-bottom: 12px;">
          <button type="button"
            onclick="window.__pollView.handleVote(${idx})"
            ${isClosed ? 'disabled' : ''}
            style="width: 100%; text-align: left; background: var(--bg-surface); border: 2px solid ${isSelected ? 'var(--accent)' : 'var(--border-light)'}; border-radius: var(--radius-md); padding: 14px 18px; cursor: ${isClosed ? 'default' : 'pointer'}; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: space-between; transition: all 0.2s;"
          >
            <!-- Background progress bar -->
            <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${pct}%; background-color: var(--accent-light); opacity: 0.65; z-index: 1; transition: width 0.4s ease-out;"></div>

            <div style="position: relative; z-index: 2; display: flex; align-items: center; gap: 10px;">
              <span style="display: inline-flex; width: 22px; height: 22px; border-radius: 50%; border: 2px solid ${isSelected ? 'var(--accent)' : 'var(--border-subtle)'}; background: ${isSelected ? 'var(--accent)' : 'transparent'}; color: #fff; font-size: 0.75rem; align-items: center; justify-content: center; font-weight: 700;">
                ${isSelected ? '✓' : ''}
              </span>
              <span style="font-weight: 600; color: var(--text-primary);">${this._escapeHtml(opt)}</span>
            </div>

            <div style="position: relative; z-index: 2; font-weight: 700; font-family: var(--font-mono); color: var(--text-secondary); font-size: 0.9rem;">
              ${pct}% <span style="font-size: 0.75rem; font-weight: 500; color: var(--text-muted);">(${votes})</span>
            </div>
          </button>
        </div>
      `;
    });

    let hostActions = '';
    if (this.isHost) {
      hostActions = `
        <div style="display: flex; gap: 10px; margin-top: 20px; border-top: 1px solid var(--border-light); padding-top: 16px;">
          ${!p.isClosed ? `
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.__pollView.handleClosePoll()">
              🔒 Close Poll
            </button>
          ` : ''}
          <button type="button" class="btn btn-primary btn-sm" onclick="window.__pollView.handleResetPoll()">
            + Create Another Poll
          </button>
        </div>
      `;
    }

    this.container.innerHTML = `
      <div style="max-width: 640px; margin: 0 auto;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <span class="badge ${p.isClosed ? 'badge-danger' : 'badge-success'}">
            ${p.isClosed ? '🔒 Poll Closed' : '🟢 Live Voting Active'}
          </span>
          <span style="font-size: 0.85rem; color: var(--text-muted); font-weight: 500;">
            Total Votes: <strong>${total}</strong>
          </span>
        </div>

        <h3 style="font-size: 1.35rem; font-weight: 800; color: var(--text-primary); margin-bottom: 20px; line-height: 1.35;">
          ${this._escapeHtml(p.question)}
        </h3>

        ${this.userVotedIdx !== null ? `
          <div style="margin-bottom: 16px; padding: 10px 14px; background: var(--success-bg); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: var(--radius-md); font-size: 0.85rem; color: var(--success); font-weight: 600; display: flex; align-items: center; gap: 8px;">
            <span>✓</span> Your vote is recorded. Live tallies update automatically.
          </div>
        ` : ''}

        ${optionsHtml}
        ${hostActions}
      </div>
    `;
  }

  handleVote(optionIdx) {
    if (!this.currentPoll || this.currentPoll.isClosed) return;
    this.client.sendPollVote(this.currentPoll.id, optionIdx);
  }

  handleClosePoll() {
    if (!this.currentPoll) return;
    this.client.sendPollClose(this.currentPoll.id);
  }

  handleResetPoll() {
    this.currentPoll = null;
    this.userVotedIdx = null;
    this.render();
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

window.PollView = PollView;
