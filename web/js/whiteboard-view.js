// =============================================================================
// Synapse Collaborative Whiteboard Canvas Engine
// Shared drawing canvas with exactly 3 tools: PEN, PENCIL, HIGHLIGHTER.
// DPR scaling, mouse/touch/stylus pointer support, and real-time stroke streaming.
// =============================================================================
'use strict';

class WhiteboardView {
  constructor(canvasElement, client, options = {}) {
    this.canvas = canvasElement;
    this.client = client;
    this.ctx = this.canvas.getContext('2d');

    this.currentTool = 'pen';       // 'pen' | 'pencil' | 'highlighter'
    this.currentColor = '#1e293b';  // default ink color
    this.baseWidth = 3;             // base stroke width

    this.isDrawing = false;
    this.currentPoints = [];
    this.strokes = [];              // all active strokes in memory

    this._initCanvasDimensions();
    this._bindPointerEvents();
    this._bindClientEvents();

    window.addEventListener('resize', () => this._handleResize());
  }

  _initCanvasDimensions() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    this.width = rect.width;
    this.height = Math.max(rect.height, 500);

    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;

    this.ctx.scale(dpr, dpr);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
  }

  _handleResize() {
    this._initCanvasDimensions();
    this.redrawAll();
  }

  setTool(tool) {
    if (['pen', 'pencil', 'highlighter'].includes(tool)) {
      this.currentTool = tool;
    }
  }

  setColor(color) {
    this.currentColor = color;
  }

  setWidth(width) {
    this.baseWidth = Number(width) || 3;
  }

  _bindPointerEvents() {
    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { this.canvas.setPointerCapture(e.pointerId); } catch {}

      this.isDrawing = true;
      const pt = this._getCanvasPoint(e);
      this.currentPoints = [pt];

      this.ctx.save();
      this._applyToolStyle(this.currentTool, this.currentColor, this.baseWidth);
      this.ctx.beginPath();
      this.ctx.moveTo(pt.x * this.width, pt.y * this.height);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.isDrawing) return;
      e.preventDefault();

      const pt = this._getCanvasPoint(e);
      this.currentPoints.push(pt);

      const px = pt.x * this.width;
      const py = pt.y * this.height;

      this.ctx.lineTo(px, py);
      this.ctx.stroke();
    });

    const finishStroke = (e) => {
      if (!this.isDrawing) return;
      this.isDrawing = false;
      this.ctx.closePath();
      this.ctx.restore();

      if (this.currentPoints.length > 0) {
        const stroke = {
          id: 'strk_' + Math.random().toString(36).substring(2, 10),
          tool: this.currentTool,
          color: this.currentColor,
          width: this.baseWidth,
          points: this.currentPoints,
          clientName: this.client.name,
          clientId: this.client.clientId,
        };

        this.strokes.push(stroke);
        this.client.sendWhiteboardStroke(stroke);
      }
      this.currentPoints = [];
    };

    this.canvas.addEventListener('pointerup', finishStroke);
    this.canvas.addEventListener('pointercancel', finishStroke);
  }

  _getCanvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));

    // Store points normalized (0..1) so canvas resizing doesn't distort drawings
    return {
      x: x / rect.width,
      y: y / rect.height,
    };
  }

  _applyToolStyle(tool, color, width) {
    if (tool === 'pencil') {
      // PENCIL: thin, visually distinct, subtle crisp texture
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = Math.max(1, width * 0.45);
      this.ctx.globalAlpha = 0.85;
      this.ctx.lineCap = 'butt';
      this.ctx.lineJoin = 'miter';
      this.ctx.globalCompositeOperation = 'source-over';
    } else if (tool === 'highlighter') {
      // HIGHLIGHTER: thick, translucent, smooth marker overlay
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = Math.max(18, width * 4.5);
      this.ctx.globalAlpha = 0.32;
      this.ctx.lineCap = 'square';
      this.ctx.lineJoin = 'bevel';
      this.ctx.globalCompositeOperation = 'source-over';
    } else {
      // PEN: smooth freehand strokes with round caps
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = width;
      this.ctx.globalAlpha = 1.0;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.globalCompositeOperation = 'source-over';
    }
  }

  drawStroke(stroke) {
    if (!stroke || !Array.isArray(stroke.points) || stroke.points.length === 0) return;

    this.ctx.save();
    this._applyToolStyle(stroke.tool, stroke.color, stroke.width);

    this.ctx.beginPath();
    const first = stroke.points[0];
    this.ctx.moveTo(first.x * this.width, first.y * this.height);

    for (let i = 1; i < stroke.points.length; i++) {
      const p = stroke.points[i];
      this.ctx.lineTo(p.x * this.width, p.y * this.height);
    }

    this.ctx.stroke();
    this.ctx.restore();
  }

  redrawAll() {
    this.ctx.clearRect(0, 0, this.width, this.height);
    for (const stroke of this.strokes) {
      this.drawStroke(stroke);
    }
  }

  setStrokes(strokes) {
    this.strokes = strokes || [];
    this.redrawAll();
  }

  addRemoteStroke(stroke) {
    this.strokes.push(stroke);
    this.drawStroke(stroke);
  }

  clearCanvas() {
    this.strokes = [];
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  exportAsPng() {
    return this.canvas.toDataURL('image/png');
  }

  _bindClientEvents() {
    this.client.on('wb_stroke', (data) => {
      if (data && data.stroke) {
        this.addRemoteStroke(data.stroke);
      }
    });

    this.client.on('wb_cleared', () => {
      this.clearCanvas();
    });
  }
}

window.WhiteboardView = WhiteboardView;
