// =============================================================================
// Synapse Collaborative Workspace Coordinator
// Integrates Yjs CRDT binding, atomic counter, real-time reactions,
// synchronized room accent, and exactly three interactive activities:
// POLL, QUIZ, and WHITEBOARD.
// =============================================================================
'use strict';

// ---------------------------------------------------------------------------
// 1. URL & Session Setup
// ---------------------------------------------------------------------------
function getRoomCodeFromUrl() {
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  if (pathParts[0] === 'room' && pathParts[1]) {
    return pathParts[1];
  }
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('room') || 'syn-default-room';
}

const roomCode = getRoomCodeFromUrl();
let displayName = localStorage.getItem('synapse_display_name');
if (!displayName) {
  displayName = `Guest-${Math.floor(Math.random() * 899 + 100)}`;
  localStorage.setItem('synapse_display_name', displayName);
}

const savedHostToken = localStorage.getItem(`synapse_host_${roomCode}`) || null;

// Update Room Badge
const roomCodeBadge = document.getElementById('room-code-badge');
if (roomCodeBadge) roomCodeBadge.textContent = roomCode;

// ---------------------------------------------------------------------------
// 2. Client Initialization
// ---------------------------------------------------------------------------
const client = new SynapseClient({
  room: roomCode,
  name: displayName,
  hostToken: savedHostToken,
});

let isHost = Boolean(savedHostToken);

// ---------------------------------------------------------------------------
// 3. Yjs CRDT Initialization & Bidirectional Textarea Binding
// ---------------------------------------------------------------------------
const ydoc = new Y.Doc();
const ytext = ydoc.getText('notepad');
const textarea = document.getElementById('notepad-textarea');
let crdtBinding = null;

if (textarea) {
  crdtBinding = new YjsTextareaBinding(ytext, textarea);

  // Update character count
  const charCountEl = document.getElementById('notepad-char-count');
  const updateCharCount = () => {
    if (charCountEl) charCountEl.textContent = `${textarea.value.length} characters`;
  };
  textarea.addEventListener('input', updateCharCount);
  ytext.observe(updateCharCount);

  // Outgoing Yjs binary updates -> Base64 -> WebSocket
  ydoc.on('update', (update, origin) => {
    if (origin === 'remote-update') return;
    const base64Update = uint8ToBase64(update);
    client.sendPadUpdate(base64Update);
  });
}

function uint8ToBase64(uint8) {
  let binary = '';
  const len = uint8.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  return window.btoa(binary);
}

function base64ToUint8(base64) {
  const binary = window.atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// 4. Activity View Modules Initialization
// ---------------------------------------------------------------------------
const whiteboardCanvas = document.getElementById('whiteboard-canvas');
const whiteboardView = whiteboardCanvas ? new WhiteboardView(whiteboardCanvas, client) : null;

const pollViewRoot = document.getElementById('poll-view-root');
const pollView = pollViewRoot ? new PollView(pollViewRoot, client, isHost) : null;
window.__pollView = pollView;

const quizViewRoot = document.getElementById('quiz-view-root');
const quizView = quizViewRoot ? new QuizView(quizViewRoot, client, isHost) : null;
window.__quizView = quizView;

let currentSelectedActivity = null;

// ---------------------------------------------------------------------------
// 5. Incoming Real-Time WebSocket Events
// ---------------------------------------------------------------------------
client.on('connected', () => {
  setConnectionStatus(true);
});

client.on('disconnected', () => {
  setConnectionStatus(false);
});

client.on('room_init', (data) => {
  // Update host state
  if (data.isHost) {
    isHost = true;
    if (data.hostToken) {
      localStorage.setItem(`synapse_host_${roomCode}`, data.hostToken);
      client.hostToken = data.hostToken;
    }
  } else {
    isHost = Boolean(savedHostToken);
  }

  if (pollView) pollView.setHost(isHost);
  if (quizView) quizView.setHost(isHost);

  // Apply room accent
  if (data.accent) applyThemeAccent(data.accent);

  // Apply initial Yjs document state
  if (data.crdtState) {
    try {
      const stateBytes = base64ToUint8(data.crdtState);
      Y.applyUpdate(ydoc, stateBytes, 'remote-update');
    } catch (err) {
      console.warn('Initial CRDT state error:', err);
    }
  }

  // Update peer list
  if (data.peers) renderParticipantList(data.peers);

  // Update counter
  if (data.counter) {
    updateCounterDisplay(data.counter.value);
    renderCounterHistory(data.counter.history);
  }

  // Update activities
  if (data.poll && pollView) pollView.setPollData(data.poll);
  if (data.quiz && quizView) quizView.setQuizData(data.quiz);
  if (data.strokes && whiteboardView) whiteboardView.setStrokes(data.strokes);

  // Update storage telemetry badge
  if (data.storage) {
    const badge = document.getElementById('storage-status-badge');
    const text = document.getElementById('storage-status-text');
    if (badge && text) {
      badge.style.display = 'inline-flex';
      text.textContent = `Storage: ${data.storage.type}`;
    }
  }

  // Restore active activity if specified
  if (data.activeActivity) {
    selectActivity(data.activeActivity, false);
  }
});

client.on('peer_joined', (data) => {
  addParticipant(data.peer);
  showToast(`${data.peer.name} joined the room 👋`);
});

client.on('peer_left', (data) => {
  removeParticipant(data.peer.id);
  showToast(`${data.peer.name} left the room`);
});

// CRDT update from peer
client.on('pad_update', (data) => {
  if (data.update) {
    try {
      const bytes = base64ToUint8(data.update);
      Y.applyUpdate(ydoc, bytes, 'remote-update');
    } catch (err) {
      console.warn('Error applying remote CRDT update:', err);
    }
  }
});

// Version restored
client.on('pad_restored', (data) => {
  if (data.crdtState) {
    try {
      const bytes = base64ToUint8(data.crdtState);
      Y.applyUpdate(ydoc, bytes, 'remote-update');
    } catch (err) {}
  }
  showToast(`Restored version #${data.versionId} by ${data.by.name} ⏱️`);
});

client.on('version_saved', (data) => {
  showToast(`Version snapshot saved by ${data.by.name} 💾`);
});

// Counter updated
client.on('counter_updated', (data) => {
  updateCounterDisplay(data.value);
  if (data.action) prependCounterHistory(data.action);
});

// Attributed reactions
client.on('reaction', (data) => {
  spawnFloatingReaction(data.emoji);
  showToast(`${data.sender.name} reacted with ${data.emoji}`);
});

// Room accent sync
client.on('room_accent', (data) => {
  applyThemeAccent(data.accent);
  showToast(`Room accent updated by ${data.by.name} 🎨`);
});

// Activity switched by peer
client.on('activity_switched', (data) => {
  if (data.activity) {
    selectActivity(data.activity, false);
    showToast(`Activity switched to ${data.activity} by ${data.by.name} ⚡`);
  }
});

// ---------------------------------------------------------------------------
// 6. UI Interaction Handlers
// ---------------------------------------------------------------------------
function switchMainTab(tabName) {
  const wsBtn = document.getElementById('tab-btn-workspace');
  const actBtn = document.getElementById('tab-btn-activities');
  const wsView = document.getElementById('view-workspace');
  const actView = document.getElementById('view-activities');

  if (tabName === 'workspace') {
    wsBtn.classList.add('active');
    actBtn.classList.remove('active');
    wsView.style.display = 'flex';
    actView.style.display = 'none';
  } else {
    wsBtn.classList.remove('active');
    actBtn.classList.add('active');
    wsView.style.display = 'none';
    actView.style.display = 'block';

    // Auto-select first activity if none active
    if (!currentSelectedActivity) {
      selectActivity('POLL');
    }
  }
}

function selectActivity(activityName, broadcast = true) {
  currentSelectedActivity = activityName;

  const cardPoll = document.getElementById('card-act-poll');
  const cardQuiz = document.getElementById('card-act-quiz');
  const cardWb = document.getElementById('card-act-whiteboard');

  const container = document.getElementById('active-activity-container');
  const panelPoll = document.getElementById('activity-panel-poll');
  const panelQuiz = document.getElementById('activity-panel-quiz');
  const panelWb = document.getElementById('activity-panel-whiteboard');

  [cardPoll, cardQuiz, cardWb].forEach(c => c && c.classList.remove('active'));
  [panelPoll, panelQuiz, panelWb].forEach(p => p && (p.style.display = 'none'));

  if (container) container.style.display = 'block';

  if (activityName === 'POLL') {
    if (cardPoll) cardPoll.classList.add('active');
    if (panelPoll) panelPoll.style.display = 'block';
    if (pollView) pollView.render();
  } else if (activityName === 'QUIZ') {
    if (cardQuiz) cardQuiz.classList.add('active');
    if (panelQuiz) panelQuiz.style.display = 'block';
    if (quizView) quizView.render();
  } else if (activityName === 'WHITEBOARD') {
    if (cardWb) cardWb.classList.add('active');
    if (panelWb) panelWb.style.display = 'block';
    if (whiteboardView) whiteboardView._handleResize();
  }

  if (broadcast) {
    client.sendActivitySwitch(activityName);
  }
}

// ---------------------------------------------------------------------------
// 7. Counter, Reactions & Accent Actions
// ---------------------------------------------------------------------------
function mutateCounter(opType, amount = 1) {
  const opId = 'op_' + Math.random().toString(36).substring(2, 10);
  client.sendCounterOp(opType, amount, opId);
}

function updateCounterDisplay(num) {
  const el = document.getElementById('counter-value');
  if (el) {
    el.textContent = num;
    el.style.transform = 'scale(1.1)';
    setTimeout(() => { el.style.transform = 'scale(1)'; }, 150);
  }
}

function renderCounterHistory(actions) {
  const list = document.getElementById('counter-history-list');
  if (!list) return;
  list.innerHTML = '';
  if (!actions || actions.length === 0) {
    list.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted); padding: 8px;">No counter operations yet.</div>';
    return;
  }
  actions.slice(0, 30).forEach(a => prependCounterHistory(a));
}

function prependCounterHistory(a) {
  const list = document.getElementById('counter-history-list');
  if (!list) return;

  const item = document.createElement('div');
  item.className = 'history-item';

  const opSymbols = { increment: '+', decrement: '−', reset: '↺' };
  const symbol = opSymbols[a.opType] || a.opType;

  item.innerHTML = `
    <div>
      <strong>${escapeHtml(a.displayName)}</strong>
      <span style="color: var(--text-secondary); margin: 0 4px;">performed</span>
      <span style="font-weight: 700; color: var(--accent);">${symbol}${a.amount > 1 ? a.amount : ''}</span>
      <span style="font-size: 0.75rem; color: var(--text-muted); margin-left: 6px;">(${a.prevValue} → ${a.resultValue})</span>
    </div>
    <span style="font-size: 0.75rem; color: var(--text-muted);">
      ${new Date(a.createdAt || Date.now()).toLocaleTimeString()}
    </span>
  `;

  list.insertBefore(item, list.firstChild);
}

function sendReaction(emoji) {
  client.sendReaction(emoji);
}

function spawnFloatingReaction(emoji) {
  const overlay = document.getElementById('reaction-overlay');
  if (!overlay) return;

  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = emoji;

  // Random horizontal position
  const x = Math.random() * (window.innerWidth - 80) + 40;
  const y = window.innerHeight - 80;

  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  overlay.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function changeRoomAccent(color) {
  applyThemeAccent(color);
  client.sendAccent(color);
}

function applyThemeAccent(color) {
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-glow', `${color}33`);
  document.documentElement.style.setProperty('--accent-light', `${color}14`);
  document.documentElement.style.setProperty('--accent-border', `${color}40`);

  // Update active swatch state
  document.querySelectorAll('.accent-picker .accent-swatch').forEach(s => {
    if (s.style.backgroundColor === color || rgbToHex(s.style.backgroundColor) === color) {
      s.classList.add('active');
    } else {
      s.classList.remove('active');
    }
  });
}

function rgbToHex(rgb) {
  if (!rgb || !rgb.startsWith('rgb')) return rgb;
  const parts = rgb.match(/\d+/g);
  if (!parts || parts.length < 3) return rgb;
  return '#' + parts.slice(0, 3).map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// 8. Whiteboard Toolbar Controls
// ---------------------------------------------------------------------------
function setWbTool(tool) {
  if (!whiteboardView) return;
  whiteboardView.setTool(tool);

  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  const activeBtn = document.getElementById(`wb-tool-${tool}`);
  if (activeBtn) activeBtn.classList.add('active');
}

function setWbColor(color, swatchEl) {
  if (!whiteboardView) return;
  whiteboardView.setColor(color);

  swatchEl.parentElement.querySelectorAll('.accent-swatch').forEach(s => s.classList.remove('active'));
  swatchEl.classList.add('active');
}

function setWbWidth(width) {
  if (!whiteboardView) return;
  whiteboardView.setWidth(Number(width));
}

function clearWhiteboard() {
  if (!confirm('Clear all strokes from the collaborative whiteboard for everyone?')) return;
  client.sendWhiteboardClear();
}

function exportWhiteboardPng() {
  if (!whiteboardView) return;
  const dataUrl = whiteboardView.exportAsPng();
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `synapse-whiteboard-${roomCode}-${Date.now()}.png`;
  a.click();
}

// ---------------------------------------------------------------------------
// 9. Version History & Snapshot Handlers
// ---------------------------------------------------------------------------
function saveManualSnapshot() {
  client.sendPadSnapshot();
}

async function openVersionDrawer() {
  const modal = document.getElementById('version-modal');
  const listContainer = document.getElementById('version-list-container');
  if (!modal || !listContainer) return;

  modal.classList.add('open');
  listContainer.innerHTML = '<div style="text-align: center; padding: 20px;">Loading version history...</div>';

  try {
    const res = await fetch(`/api/room/${encodeURIComponent(roomCode)}/notepad-versions`);
    const data = await res.json();

    if (!data.ok || !data.versions || data.versions.length === 0) {
      listContainer.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-muted);">No snapshots saved yet. Changes are automatically batched.</div>';
      return;
    }

    listContainer.innerHTML = '';
    data.versions.forEach(v => {
      const item = document.createElement('div');
      item.className = 'version-item';

      const opBadge = v.op_type === 'restore' ? 'badge-accent' : (v.op_type === 'snapshot' ? 'badge-success' : '');

      item.innerHTML = `
        <div>
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
            <strong style="font-size: 0.9rem; color: var(--text-primary);">#${v.id}</strong>
            <span class="badge ${opBadge}">${v.op_type.toUpperCase()}</span>
            <span style="font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(v.editor_name)}</span>
          </div>
          <div style="font-size: 0.75rem; color: var(--text-muted);">
            ${new Date(v.created_at).toLocaleString()} · ${v.content.length} characters
          </div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="previewVersion(${v.id}, ${JSON.stringify(v.editor_name)}, ${JSON.stringify(v.created_at)}, ${JSON.stringify(v.content)})">
            Preview
          </button>
          <button type="button" class="btn btn-primary btn-sm" onclick="restoreVersion(${v.id})">
            Restore
          </button>
        </div>
      `;

      listContainer.appendChild(item);
    });
  } catch (err) {
    listContainer.innerHTML = `<div style="color: var(--danger); padding: 20px;">Failed to load history: ${err.message}</div>`;
  }
}

function closeVersionDrawer() {
  const modal = document.getElementById('version-modal');
  if (modal) modal.classList.remove('open');
}

let activePreviewVersionId = null;

function previewVersion(id, editor, dateStr, text) {
  activePreviewVersionId = id;
  const modal = document.getElementById('preview-modal');
  const meta = document.getElementById('preview-meta');
  const textArea = document.getElementById('preview-text');
  const confirmBtn = document.getElementById('btn-confirm-restore');

  if (meta) meta.textContent = `Version #${id} saved by ${editor} on ${new Date(dateStr).toLocaleString()}`;
  if (textArea) textArea.value = text;

  if (confirmBtn) {
    confirmBtn.onclick = () => {
      restoreVersion(activePreviewVersionId);
      closePreviewModal();
    };
  }

  if (modal) modal.classList.add('open');
}

function closePreviewModal() {
  const modal = document.getElementById('preview-modal');
  if (modal) modal.classList.remove('open');
}

function restoreVersion(versionId) {
  if (!confirm(`Restore Version #${versionId}? This will safely create a new restore event and preserve all intervening history.`)) return;
  client.sendPadRestore(versionId);
  closeVersionDrawer();
  closePreviewModal();
}

// ---------------------------------------------------------------------------
// 10. Presence & Helpers
// ---------------------------------------------------------------------------
const activePeers = new Map();

function renderParticipantList(peers) {
  activePeers.clear();
  peers.forEach(p => activePeers.set(p.id, p));
  updateAvatarStack();
}

function addParticipant(peer) {
  activePeers.set(peer.id, peer);
  updateAvatarStack();
}

function removeParticipant(peerId) {
  activePeers.delete(peerId);
  updateAvatarStack();
}

function updateAvatarStack() {
  const container = document.getElementById('participant-avatars');
  if (!container) return;

  container.innerHTML = '';
  const peersArr = Array.from(activePeers.values());

  peersArr.slice(0, 5).forEach(p => {
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.backgroundColor = p.color || '#4f46e5';
    av.textContent = (p.name || 'A').charAt(0).toUpperCase();
    av.title = `${p.name} ${p.isHost ? '(Host)' : ''}`;
    container.appendChild(av);
  });

  if (peersArr.length > 5) {
    const more = document.createElement('div');
    more.className = 'avatar';
    more.style.backgroundColor = '#64748b';
    more.textContent = `+${peersArr.length - 5}`;
    container.appendChild(more);
  }
}

function setConnectionStatus(connected) {
  const badge = document.getElementById('connection-status-badge');
  const dot = document.getElementById('connection-dot');
  const text = document.getElementById('connection-status-text');

  if (connected) {
    if (badge) badge.className = 'badge badge-success';
    if (dot) dot.className = 'dot dot-online';
    if (text) text.textContent = 'Connected';
  } else {
    if (badge) badge.className = 'badge badge-danger';
    if (dot) dot.className = 'dot';
    if (text) text.textContent = 'Reconnecting...';
  }
}

function copyShareableLink() {
  const shareUrl = window.location.origin + `/room/${encodeURIComponent(roomCode)}`;
  navigator.clipboard.writeText(shareUrl).then(() => {
    showToast('Shareable room link copied to clipboard! 📋');
  }).catch(() => {
    prompt('Copy this link to invite teammates:', shareUrl);
  });
}

function showToast(message) {
  const existing = document.querySelector('.reaction-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'reaction-toast';
  toast.innerHTML = `<span>⚡</span> <span>${escapeHtml(message)}</span>`;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 2800);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
