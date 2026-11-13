// Gesti: il dito sposta e ingrandisce, la penna scrive, il palmo viene ignorato.
export function attachInput(view, app) {
  const sc = view.scroller;
  const touches = new Map();
  let pinch = null;
  let pan = null; // {x, y, vx, vy, t, moved}
  let inertia = 0;
  let lastTap = null;
  let lastPen = -1e9;
  let penDown = false;
  let mouseTool = false;
  let touchTool = null;
  let frame = 0;
  let pendingZoom = null;

  const stopInertia = () => { cancelAnimationFrame(inertia); inertia = 0; };

  const startPinch = () => {
    const [a, b] = [...touches.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: view.s, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    pan = null;
    view.gesturing = true;
  };

  const flushZoom = () => {
    frame = 0;
    if (!pendingZoom) return;
    const z = pendingZoom; pendingZoom = null;
    view.setScale(z.s, { x: z.x, y: z.y });
    sc.scrollLeft -= z.dx; sc.scrollTop -= z.dy;
  };

  const down = (e) => {
    if (e.target.closest?.('.pdf-field')) return; // campo del modulo: lo gestisce il browser (tastiera, spunta, elenco)
    if (e.target.closest?.('.frame-bar')) return; // pulsanti sopra l'annotazione selezionata: non devono toglierne la selezione
    if (e.pointerType === 'touch') {
      stopInertia();
      if (penDown || performance.now() - lastPen < 500) return; // palmo appoggiato mentre si scrive
      sc.setPointerCapture(e.pointerId);
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        if (touchTool) { app.tools.cancel(view); touchTool = null; }
        startPinch();
      } else if (touches.size === 1) {
        if ((app.prefs.fingerDraw && app.tools.wantsPointer()) || app.tools.tool === 'laser') {
          touchTool = e.pointerId;
          app.tools.down(view, e);
        } else {
          pan = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, vx: 0, vy: 0, t: e.timeStamp, moved: false };
        }
      }
      e.preventDefault();
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    stopInertia();
    sc.focus({ preventScroll: true });
    sc.setPointerCapture(e.pointerId);
    if (e.pointerType === 'pen') { penDown = true; lastPen = performance.now(); }
    if (e.button === 1 || !app.tools.wantsPointer(e)) {
      pan = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, vx: 0, vy: 0, t: e.timeStamp, moved: false, mouse: true };
      sc.classList.add('grabbing');
      return;
    }
    mouseTool = true;
    app.tools.down(view, e);
    e.preventDefault();
  };

  const move = (e) => {
    if (e.pointerType === 'pen') lastPen = performance.now();
    // 0.9.4: penna sospesa sopra lo schermo (o mouse senza tasti): etichette e note si accendono.
    if (e.pointerType !== 'touch') { if (!e.buttons) app.tools.glow(view, e); else app.tools.unglow(); }
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      const t = touches.get(e.pointerId);
      t.x = e.clientX; t.y = e.clientY;
      if (touchTool === e.pointerId) { app.tools.move(view, e); return; }
      if (pinch && touches.size >= 2) {
        const [a, b] = [...touches.values()];
        const cx = (a.x + b.x) / 2; const cy = (a.y + b.y) / 2;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        pendingZoom = { s: pinch.s * (d / pinch.d), x: cx, y: cy, dx: cx - pinch.cx + (pendingZoom?.dx || 0), dy: cy - pinch.cy + (pendingZoom?.dy || 0) };
        pinch.cx = cx; pinch.cy = cy;
        if (!frame) frame = requestAnimationFrame(flushZoom);
        return;
      }
    }
    if (pan && (e.pointerType === 'touch' || pan.mouse)) {
      const dx = e.clientX - pan.x; const dy = e.clientY - pan.y;
      if (!pan.moved && Math.hypot(e.clientX - pan.sx, e.clientY - pan.sy) > 8) pan.moved = true;
      if (pan.moved) {
        sc.scrollLeft -= dx; sc.scrollTop -= dy;
        const dt = Math.max(1, e.timeStamp - pan.t);
        pan.vx = pan.vx * 0.6 + (dx / dt) * 0.4; pan.vy = pan.vy * 0.6 + (dy / dt) * 0.4;
      }
      pan.x = e.clientX; pan.y = e.clientY; pan.t = e.timeStamp;
      return;
    }
    if (mouseTool) app.tools.move(view, e);
    else if (app.tools.tool === 'laser' && e.pointerType !== 'touch') app.tools.laserMove(view, e);
    else if (e.pointerType === 'mouse' && !e.buttons) app.tools.hover(view, e);
  };

  const glide = (vx, vy) => {
    let t0 = performance.now();
    const step = (t) => {
      const dt = t - t0; t0 = t;
      sc.scrollLeft -= vx * dt; sc.scrollTop -= vy * dt;
      const k = Math.exp(-dt / 330);
      vx *= k; vy *= k;
      inertia = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
    };
    inertia = requestAnimationFrame(step);
  };

  const tap = (e) => {
    const now = e.timeStamp;
    const double = lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40;
    lastTap = double ? null : { t: now, x: e.clientX, y: e.clientY };
    if (double) {
      const fit = view.fitScale('width');
      const focus = { x: e.clientX, y: e.clientY };
      view.animateScale(Math.abs(view.s - fit) / fit < 0.08 ? fit * 2.2 : fit, focus);
      return;
    }
    app.tools.tap(view, e);
  };

  const up = (e) => {
    if (e.pointerType === 'pen') { penDown = false; lastPen = performance.now(); }
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.delete(e.pointerId);
      if (touchTool === e.pointerId) { touchTool = null; app.tools.up(view, e); return; }
      if (pinch) {
        if (touches.size < 2) {
          pinch = null;
          if (frame) { cancelAnimationFrame(frame); flushZoom(); }
          view.gesturing = false;
          view.schedule();
          if (touches.size === 1) {
            const [t] = [...touches.values()];
            pan = { x: t.x, y: t.y, sx: t.x, sy: t.y, vx: 0, vy: 0, t: e.timeStamp, moved: true };
          }
        }
        return;
      }
      if (pan) {
        const p = pan; pan = null;
        if (!p.moved && e.type === 'pointerup') tap(e);
        else if (e.timeStamp - p.t < 80 && Math.hypot(p.vx, p.vy) > 0.15) glide(p.vx, p.vy);
      }
      return;
    }
    if (pan?.mouse) {
      const p = pan; pan = null;
      sc.classList.remove('grabbing');
      if (!p.moved) app.tools.tap(view, e);
      return;
    }
    if (mouseTool) { mouseTool = false; app.tools.up(view, e); }
  };

  sc.addEventListener('pointerdown', down);
  sc.addEventListener('pointermove', move);
  sc.addEventListener('pointerup', up);
  sc.addEventListener('pointercancel', up);
  sc.addEventListener('pointerleave', () => app.tools.unglow());
  sc.addEventListener('dblclick', (e) => {
    if (e.target.closest('.an-ui')) return;
    if (!app.tools.wantsPointer({ pointerType: 'mouse' })) {
      const fit = view.fitScale('width');
      view.animateScale(Math.abs(view.s - fit) / fit < 0.08 ? fit * 2.2 : fit, { x: e.clientX, y: e.clientY });
    }
  });
  sc.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const d = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    view.setScale(view.s * Math.exp(-d * 0.0022), { x: e.clientX, y: e.clientY });
  }, { passive: false });
}
