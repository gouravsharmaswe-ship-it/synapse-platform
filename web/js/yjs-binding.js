// =============================================================================
// Synapse Yjs Textarea Binding
// Real-time bidirectional binding between Y.Text CRDT and HTML <textarea>.
// Character-level diff calculation, zero-flicker cursor position preservation,
// and simultaneous multi-user typing convergence.
// =============================================================================
'use strict';

class YjsTextareaBinding {
  constructor(yText, textarea) {
    this.yText = yText;
    this.textarea = textarea;
    this.doc = yText.doc;
    this._isApplyingRemote = false;

    // Initialize textarea content
    this.textarea.value = this.yText.toString();

    // Listen to local user typing
    this._onInput = this._handleLocalInput.bind(this);
    this.textarea.addEventListener('input', this._onInput);

    // Listen to remote Yjs CRDT changes
    this._onYTextChange = this._handleYTextChange.bind(this);
    this.yText.observe(this._onYTextChange);
  }

  _handleLocalInput() {
    if (this._isApplyingRemote) return;

    const oldText = this.yText.toString();
    const newText = this.textarea.value;

    if (oldText === newText) return;

    // Find common prefix
    let prefix = 0;
    while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) {
      prefix++;
    }

    // Find common suffix
    let suffix = 0;
    while (
      suffix < (oldText.length - prefix) &&
      suffix < (newText.length - prefix) &&
      oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
    ) {
      suffix++;
    }

    const deleteCount = oldText.length - prefix - suffix;
    const insertStr = newText.slice(prefix, newText.length - suffix);

    this.doc.transact(() => {
      if (deleteCount > 0) {
        this.yText.delete(prefix, deleteCount);
      }
      if (insertStr.length > 0) {
        this.yText.insert(prefix, insertStr);
      }
    }, 'local-editor');
  }

  _handleYTextChange(event) {
    if (event.transaction.origin === 'local-editor') return;

    this._isApplyingRemote = true;

    let selStart = this.textarea.selectionStart;
    let selEnd = this.textarea.selectionEnd;

    // Adjust cursor position based on changes
    let currentIdx = 0;
    for (const op of event.changes.delta) {
      if (op.retain) {
        currentIdx += op.retain;
      } else if (op.insert) {
        const len = typeof op.insert === 'string' ? op.insert.length : 1;
        if (currentIdx <= selStart) selStart += len;
        if (currentIdx <= selEnd) selEnd += len;
        currentIdx += len;
      } else if (op.delete) {
        const len = op.delete;
        if (currentIdx < selStart) {
          selStart -= Math.min(len, selStart - currentIdx);
        }
        if (currentIdx < selEnd) {
          selEnd -= Math.min(len, selEnd - currentIdx);
        }
      }
    }

    this.textarea.value = this.yText.toString();
    try {
      this.textarea.setSelectionRange(selStart, selEnd);
    } catch {
      // In case textarea is unfocused or out of range
    }

    this._isApplyingRemote = false;
  }

  destroy() {
    this.textarea.removeEventListener('input', this._onInput);
    this.yText.unobserve(this._onYTextChange);
  }
}

window.YjsTextareaBinding = YjsTextareaBinding;
