// rna.js — the non-coding "street view": a 2D secondary-structure panel for
// RNA genes (lncRNAs, miRNA host genes, snoRNAs, …). Unlike proteins, most
// ncRNAs have NO experimental 3D structure and no fetchable predicted model,
// so we show their secondary structure instead — the standard representation
// for RNA. The spliced transcript is folded locally (Nussinov, in a Web
// Worker) and drawn as an arc diagram: the sequence on a baseline with a
// semicircle joining every base pair. Fully self-contained — no external API.

import { getSplicedRna } from './data.js';
import { RNA_BASE_COLOR } from './genome.js';

const ARC_COLOR = { GC: '#4d9dff', AU: '#3ddc84', GU: '#c792ea' };  // by pair type
function pairKind(a, b){
  const s = a + b;
  if (s === 'GC' || s === 'CG') return 'GC';
  if (s === 'AU' || s === 'UA') return 'AU';
  return 'GU';                                   // wobble
}

export class RnaView {
  constructor({ panel, canvas, title, status, closeBtn }){
    this.panel = panel; this.canvas = canvas; this.title = title; this.status = status;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio, 2);
    this.open = false; this.token = 0; this.foldToken = -1;
    this.worker = null; this.last = null;
    closeBtn.addEventListener('click', () => this.close());
  }

  get isOpen(){ return this.open; }

  ensureWorker(){
    if (!this.worker){
      this.worker = new Worker(new URL('./rnafold.worker.js', import.meta.url));
      this.worker.onmessage = (e) => this.onFold(e.data);
    }
    return this.worker;
  }

  async show(tx){
    this.open = true; this.tx = tx;
    const tok = ++this.token;
    this.panel.classList.remove('hidden', 'info-open');
    this.panel.classList.add('rna-mode');
    document.body.classList.add('pp-open');
    this.title.textContent = `${tx.symbol} · ${tx.id} (ncRNA)`;
    this.status.textContent = 'assembling spliced transcript…';
    this.clearCanvas();

    let rna;
    try { rna = await getSplicedRna(tx); }
    catch (e){ if (this.token === tok) this.status.textContent = '⚠ ' + e.message; return; }
    if (!this.open || this.token !== tok) return;          // superseded / closed

    if (!rna.length){ this.status.textContent = '⚠ no sequence for this transcript'; return; }
    this.status.textContent = `folding ${rna.length.toLocaleString()} nt…`;
    this.foldToken = tok;
    this.ensureWorker().postMessage({ seq: rna.seq, token: tok });
  }

  onFold(d){
    if (d.token !== this.token || !this.open) return;       // stale fold
    this.last = d;
    this.draw(d);
    const note = d.truncated
      ? ` · first ${d.seq.length.toLocaleString()} of ${d.fullLength.toLocaleString()} nt`
      : '';
    this.status.textContent = `predicted 2D · ${d.pairs} base pairs · Nussinov${note}`;
  }

  // ---- drawing -----------------------------------------------------------
  resize(){
    const w = this.canvas.clientWidth || 360, h = this.canvas.clientHeight || 360;
    this.canvas.width = w * this.dpr; this.canvas.height = h * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.W = w; this.H = h;
  }
  clearCanvas(){ this.resize(); this.ctx.clearRect(0, 0, this.W, this.H); }

  draw(d){
    this.resize();
    const ctx = this.ctx, W = this.W, H = this.H;
    ctx.clearRect(0, 0, W, H);
    const seq = d.seq, dot = d.dot, n = seq.length;
    const padX = 16, baseY = H - 48, topPad = 22;
    const step = (W - 2 * padX) / Math.max(1, n - 1);
    const x = (i) => padX + i * step;
    const maxArc = baseY - topPad;

    // pairs from dot-bracket
    const st = [], pairs = [];
    for (let i = 0; i < n; i++){
      if (dot[i] === '(') st.push(i);
      else if (dot[i] === ')'){ const o = st.pop(); if (o != null) pairs.push([o, i]); }
    }

    // arcs (semi-ellipses above the baseline)
    ctx.lineWidth = Math.max(0.6, Math.min(1.6, step * 0.6));
    ctx.globalAlpha = 0.72;
    for (const [i, j] of pairs){
      const xi = x(i), xj = x(j), cx = (xi + xj) / 2, rx = (xj - xi) / 2;
      const ry = Math.min(maxArc, rx);            // compress long-range arcs to fit
      ctx.strokeStyle = ARC_COLOR[pairKind(seq[i], seq[j])];
      ctx.beginPath();
      ctx.ellipse(cx, baseY, rx, ry, 0, Math.PI, 2 * Math.PI);   // upper half
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // baseline
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.moveTo(padX, baseY); ctx.lineTo(W - padX, baseY); ctx.stroke();

    // bases — letters when there's room, otherwise coloured ticks
    const showLetters = step >= 7;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fs = Math.max(7, Math.min(step * 0.9, 13));
    ctx.font = `${fs}px ui-monospace, monospace`;
    for (let i = 0; i < n; i++){
      const xi = x(i);
      ctx.fillStyle = RNA_BASE_COLOR[seq[i]] || '#9aa3af';
      if (showLetters) ctx.fillText(seq[i], xi, baseY + 12);
      else ctx.fillRect(xi - Math.max(0.5, step * 0.4), baseY + 5, Math.max(1, step * 0.8), 6);
    }

    // 5'/3' ends + method caption
    ctx.fillStyle = '#8b97a8'; ctx.font = '10px ui-monospace, monospace'; ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left'; ctx.fillText("5'", padX - 4, baseY + 26);
    ctx.textAlign = 'right'; ctx.fillText("3'", W - padX + 4, baseY + 26);
    ctx.textAlign = 'left'; ctx.fillStyle = '#6f7b8c'; ctx.font = '9px ui-sans-serif, system-ui';
    ctx.fillText('Predicted topology · Nussinov base-pair maximization · not a thermodynamic fold', padX, 13);
  }

  close(){
    this.open = false;
    this.panel.classList.add('hidden');
    this.panel.classList.remove('rna-mode');
    document.body.classList.remove('pp-open');
  }
}
