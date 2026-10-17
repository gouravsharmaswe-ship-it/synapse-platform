// =============================================================================
// Synapse Client Library
// Resilient WebSocket connection, automatic exponential-backoff reconnect,
// protocol serialization, event emitter, and real-time state synchronization.
// =============================================================================
'use strict';

class SynapseClient {
  constructor(options = {}) {
    this.options = options;
    this.room = options.room;
    this.name = options.name || 'Anonymous';
    this.clientId = options.clientId || this._generateClientId();
    this.hostToken = options.hostToken || null;
    this.url = options.url || this._getDefaultWsUrl();

    this.ws = null;
    this.isConnected = false;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 25;
    this.reconnectDelay = 1000;
    this.listeners = new Map();
    this.pendingQueue = [];

    this._connect();
  }

  _generateClientId() {
    return 'usr_' + Math.random().toString(36).substring(2, 10);
  }

  _getDefaultWsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }

  _connect() {
    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;

        // Send initial join packet
        this._sendRaw({
          type: 'join',
          room: this.room,
          name: this.name,
          clientId: this.clientId,
          hostToken: this.hostToken,
        });

        // Flush any queued messages
        while (this.pendingQueue.length > 0) {
          const item = this.pendingQueue.shift();
          this._sendRaw(item);
        }

        this._emit('connected', { room: this.room, clientId: this.clientId });
      };

      this.ws.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        if (data && data.type) {
          this._emit(data.type, data);
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this._emit('disconnected', { attempts: this.reconnectAttempts });
        this._scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        this._emit('error', err);
      };
    } catch (err) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.isReconnecting || this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.isReconnecting = true;
    this.reconnectAttempts++;

    const delay = Math.min(this.reconnectDelay * 1.5, 10000);
    this.reconnectDelay = delay;

    setTimeout(() => {
      this.isReconnecting = false;
      this._connect();
    }, delay);
  }

  _sendRaw(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    } else {
      this.pendingQueue.push(obj);
    }
  }

  // ---------------------------------------------------------------------------
  // Event Emitter
  // ---------------------------------------------------------------------------
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const set = this.listeners.get(event);
    if (set) set.delete(callback);
  }

  _emit(event, payload) {
    const set = this.listeners.get(event);
    if (set) {
      for (const cb of set) {
        try { cb(payload); } catch (e) { console.error('Listener error:', e); }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Domain Action Senders
  // ---------------------------------------------------------------------------
  sendPadUpdate(base64Update) {
    this._sendRaw({ type: 'pad_update', update: base64Update });
  }

  sendPadRestore(versionId) {
    this._sendRaw({ type: 'pad_restore', versionId, hostToken: this.hostToken });
  }

  sendPadSnapshot() {
    this._sendRaw({ type: 'pad_snapshot' });
  }

  sendCounterOp(opType, amount = 1, opId = null) {
    this._sendRaw({ type: 'counter_op', opType, amount, opId });
  }

  sendReaction(emoji) {
    this._sendRaw({ type: 'reaction', emoji, id: 'rx_' + Math.random().toString(36).substring(2, 10) });
  }

  sendAccent(accent) {
    this._sendRaw({ type: 'room_accent', accent });
  }

  sendActivitySwitch(activity) {
    this._sendRaw({ type: 'activity_switch', activity });
  }

  sendPollCreate(question, options, policy = 'single_vote') {
    this._sendRaw({ type: 'poll_create', question, options, policy, hostToken: this.hostToken });
  }

  sendPollVote(pollId, optionIdx) {
    this._sendRaw({ type: 'poll_vote', pollId, optionIdx });
  }

  sendPollClose(pollId) {
    this._sendRaw({ type: 'poll_close', pollId, hostToken: this.hostToken });
  }

  sendQuizCreate(title, questions) {
    this._sendRaw({ type: 'quiz_create', title, questions, hostToken: this.hostToken });
  }

  sendQuizSubmit(quizId, questionIdx, choiceIdx) {
    this._sendRaw({ type: 'quiz_submit', quizId, questionIdx, choiceIdx });
  }

  sendQuizReveal(quizId) {
    this._sendRaw({ type: 'quiz_reveal', quizId, hostToken: this.hostToken });
  }

  sendQuizNext(quizId) {
    this._sendRaw({ type: 'quiz_next', quizId, hostToken: this.hostToken });
  }

  sendQuizFinish(quizId) {
    this._sendRaw({ type: 'quiz_finish', quizId, hostToken: this.hostToken });
  }

  sendWhiteboardStroke(stroke) {
    this._sendRaw({ type: 'wb_stroke', stroke });
  }

  sendWhiteboardClear() {
    this._sendRaw({ type: 'wb_clear', hostToken: this.hostToken });
  }

  sendCursor(x, y) {
    this._sendRaw({ type: 'cursor', x, y });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

window.SynapseClient = SynapseClient;
