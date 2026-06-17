// main.js — orchestrator. Owns the zoom state, computes per-tier crossfade
// opacities, streams the sequence window + translation it needs, drives the
// helix + overlay each frame, and handles input (wheel zoom, drag, fly-to).

import { HelixView, pickActiveTranscript } from './helix.js';
import { Overlay } from './overlay.js';
import { ProteinViewer } from './protein.js';
import { RnaView } from './rna.js';
import { loadMeta, loadAssembly, getAssembly, ASSEMBLIES, state, getSequence, getTranslation } from './data.js';
import { makeFeatureClassifier, aaColor, fmtPos, fmtBp } from './genome.js';

const gsap = window.gsap;

const app = document.getElementById('app');
const overlayCanvas = document.getElementById('overlay');

const helix = new HelixView(app);
const overlay = new Overlay(overlayCanvas);
let protein = null;                  // ProteinViewer, created in setup()
let rnaView = null;                  // RnaView (non-coding 2D structure), created in setup()
let proteinLock = null;              // { tx, translation } the panel is locked to
let lastHighlightKey = '';

const view = {
  center: 0,
  bpPerPx: 1,
  width: 0,
  height: 0,
  minBpPerPx: 1 / 34,        // most zoomed-in: a base spans 34 px
  maxBpPerPx: 1,             // set after meta loads (whole chromosome)
};

let seqWin = null, seqReqKey = '';
let activeTx = null, translation = null, classifier = makeFeatureClassifier(null);

// ---- math helpers --------------------------------------------------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function smoothstep(e0, e1, x){
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
const span = () => view.bpPerPx * view.width;
const viewStart = () => view.center - span() / 2;
const viewEnd = () => view.center + span() / 2;

function clampView(){
  view.bpPerPx = clamp(view.bpPerPx, view.minBpPerPx, view.maxBpPerPx);
  const sp = span();
  if (sp >= state.meta.length) view.center = state.meta.length / 2;
  else view.center = clamp(view.center, sp / 2, state.meta.length - sp / 2);
}

// ---- tier crossfade opacities -------------------------------------------
function opacities(){
  const sp = span();
  const bw = 1 / view.bpPerPx;                       // px per base
  return {
    // condensed-chromosome coil — the zoomed-out overview, present from the
    // whole chromosome down until the nucleotide helix takes over
    coil:      smoothstep(4000, 12000, sp),
    ribbon:    0,                                    // flat ribbon retired; the coil is the overview
    helix:     1 - smoothstep(3500, 9000, sp),       // real DNA helix (detail)
    // gene models: present from ~3 Mb down to the base level; hidden in the
    // overview (too many transcripts) and faded once individual bases dominate
    geneTrack: (1 - smoothstep(2.5e6, 5.0e6, sp)) * (1 - smoothstep(120, 600, bw) * 0.6),
    sequence:  smoothstep(5, 10, bw),                 // nucleotide letters
    rna:       smoothstep(6, 11, bw),                  // transcribed RNA (DNA→RNA→protein middle layer)
    codon:     smoothstep(8, 13, bw),                 // amino-acid track (appears soon after bases)
  };
}
function tierName(){
  const sp = span();
  if (sp > 10e6) return 'Chromosome';
  if (sp > 1e6) return 'Region';
  if (sp > 30e3) return 'Locus';
  if (sp > 400) return 'Gene structure';
  return 'Sequence · codons';
}

// ---- data streaming ------------------------------------------------------
function ensureData(){
  const sp = span();
  // sequence window — only when zoomed in enough to need bases
  if (sp < 60000){
    const s = Math.floor(viewStart()), e = Math.ceil(viewEnd());
    const key = `${s}_${e}`;
    if (!seqWin || s < seqWin.start || e > seqWin.start + seqWin.seq.length){
      if (key !== seqReqKey){
        seqReqKey = key;
        getSequence(s, e).then(w => { seqWin = w; }).catch(() => {});
      }
    }
  } else {
    seqWin = null;
  }
  // active transcript + translation — when zoomed into a gene
  if (sp < 200000){
    const tx = pickActiveTranscript(state.genes, view.center);
    if (tx !== activeTx){
      activeTx = tx;
      classifier = makeFeatureClassifier(tx);
      translation = null;
      if (tx && tx.coding){
        const want = tx.id;
        getTranslation(tx).then(t => { if (activeTx && activeTx.id === want) translation = t; }).catch(() => {});
      }
    }
  } else if (activeTx){
    activeTx = null; translation = null; classifier = makeFeatureClassifier(null);
  }
}

// ---- frame loop ----------------------------------------------------------
function renderFrame(){
  clampView();
  ensureData();
  const op = opacities();
  const s = {
    viewStart: viewStart(), viewEnd: viewEnd(), bpPerPx: view.bpPerPx,
    width: view.width, height: view.height,
    meta: state.meta, genes: state.genes,
    seqWin, classifier, activeTx, translation, op,
  };
  helix.update({
    viewStart: s.viewStart, viewEnd: s.viewEnd,
    helixOpacity: op.helix, ribbonOpacity: op.ribbon, coilOpacity: op.coil,
    bands: state.meta.bands, seqWin, genes: state.genes,
    chromLength: state.meta.length, center: view.center,
  });
  helix.render();
  overlay.draw(s);
  updateHud(op);
  updateProteinHighlight();
  return { op, hasSeq: !!seqWin, activeTx: activeTx && activeTx.id, hasTranslation: !!translation, bw: 1 / view.bpPerPx };
}
function frame(){ renderFrame(); requestAnimationFrame(frame); }

// Highlight, in the folded protein, the residues whose codons are visible in
// the genome view (colour-matched to the amino-acid chips). Throttled to only
// recolour when the visible residue range actually changes.
function updateProteinHighlight(){
  if (!protein || !protein.isOpen || !proteinLock || !proteinLock.translation) return;
  const t = proteinLock.translation;
  const nRes = t.protein[t.protein.length - 1] === '*' ? t.protein.length - 1 : t.protein.length;
  const vs = viewStart(), ve = viewEnd();
  const items = [];
  let lo = Infinity, hi = -Infinity;
  for (let ci = 0; ci < nRes; ci++){             // skip the trailing stop codon
    const mid = t.codonToPositions[ci][1];        // middle base of the codon
    if (mid >= vs && mid <= ve){
      items.push({ resi: ci + 1, color: aaColor(t.protein[ci]) });
      if (ci < lo) lo = ci; if (ci > hi) hi = ci;
    }
  }
  const key = items.length ? `${lo}_${hi}` : 'none';
  if (key === lastHighlightKey) return;
  lastHighlightKey = key;
  protein.setHighlight(items);
  protein.setStatus(items.length
    ? `residues ${lo + 1}–${hi + 1} of ${nRes} shown in the genome view`
    : 'pan to the coding region to highlight residues');
}

// ---- HUD -----------------------------------------------------------------
const hud = {
  tier: document.getElementById('hud-tier'),
  pos: document.getElementById('hud-pos'),
  span: document.getElementById('hud-span'),
  gene: document.getElementById('hud-gene'),
};
function updateHud(){
  hud.tier.textContent = tierName();
  hud.pos.textContent = `${state.meta.chrom}:${fmtPos(view.center)}`;
  hud.span.textContent = fmtBp(span()) + ' across view';
  hud.gene.textContent = activeTx ? `${activeTx.symbol} · ${activeTx.id} (${activeTx.strand})` : '—';
}

// ---- input ---------------------------------------------------------------
function setup(){
  view.center = state.meta.length / 2;
  // NOTE: maxBpPerPx / bpPerPx depend on view.width, which is only known after
  // onResize() below — initialising them here (width still 0) yields Infinity
  // and a NaN first frame. They are set right after onResize().

  overlayCanvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    gsap.killTweensOf(view);
    const rect = overlayCanvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const bpAtCursor = viewStart() + mx * view.bpPerPx;
    const factor = Math.exp(ev.deltaY * 0.0015);
    view.bpPerPx = clamp(view.bpPerPx * factor, view.minBpPerPx, view.maxBpPerPx);
    // keep the base under the cursor pinned
    view.center = bpAtCursor - (mx - view.width / 2) * view.bpPerPx;
  }, { passive: false });

  let dragging = false, lastX = 0;
  overlayCanvas.addEventListener('pointerdown', (ev) => {
    // click on the ideogram minimap = jump there
    const r = overlay.ideoRect;
    if (ev.offsetY >= r.y - 4 && ev.offsetY <= r.y + r.h + 4 && ev.offsetX >= r.x && ev.offsetX <= r.x + r.w){
      const bp = ((ev.offsetX - r.x) / r.w) * state.meta.length;
      flyTo(bp, view.bpPerPx, 0.8);
      return;
    }
    dragging = true; lastX = ev.clientX; overlayCanvas.setPointerCapture(ev.pointerId);
    gsap.killTweensOf(view);
  });
  overlayCanvas.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - lastX; lastX = ev.clientX;
    view.center -= dx * view.bpPerPx;
  });
  overlayCanvas.addEventListener('pointerup', () => { dragging = false; });

  // protein "street view": double-click a coding gene to fold it
  protein = new ProteinViewer({
    panel: document.getElementById('protein-panel'),
    viewport: document.getElementById('pp-viewport'),
    title: document.getElementById('pp-title'),
    status: document.getElementById('pp-status'),
    closeBtn: document.getElementById('pp-close'),
    spinBtn: document.getElementById('pp-spin'),
    infoText: document.getElementById('pp-info-text'),
    infoToggle: document.getElementById('pp-info-toggle'),
    infoModeEl: document.getElementById('pp-info-mode'),
  });
  rnaView = new RnaView({
    panel: document.getElementById('protein-panel'),
    canvas: document.getElementById('pp-rna-canvas'),
    title: document.getElementById('pp-title'),
    status: document.getElementById('pp-status'),
    closeBtn: document.getElementById('pp-close'),
  });
  overlayCanvas.addEventListener('dblclick', (ev) => {
    if (ev.offsetY < 130) return;          // ignore the minimap / ruler strip
    const bp = viewStart() + ev.offsetX * view.bpPerPx;
    const tx = pickActiveTranscript(state.genes, bp);
    if (!tx){ flash('no gene here to fold'); return; }
    if (!tx.coding){                        // non-coding RNA → fold + show 2D structure
      if (protein.isOpen) protein.close();
      rnaView.show(tx);
      return;
    }
    if (rnaView.isOpen) rnaView.close();    // leaving RNA mode for a protein
    proteinLock = { tx, translation: null };
    lastHighlightKey = '';
    getTranslation(tx).then(t => { if (proteinLock && proteinLock.tx.id === tx.id) proteinLock.translation = t; });
    protein.show(tx.symbol);
  });

  window.addEventListener('resize', onResize);
  onResize();                              // sets view.width and view.maxBpPerPx
  view.bpPerPx = view.maxBpPerPx;          // start at the whole-chromosome view

  // search + preset chips
  const input = document.getElementById('search');
  document.getElementById('go').addEventListener('click', () => doSearch(input.value));
  rebuildGeneRegistry();
  setupGeneSearch(input);
  document.querySelectorAll('[data-gene]').forEach(btn =>
    btn.addEventListener('click', () => flyToGene(btn.dataset.gene)));
  document.getElementById('zoom-in').addEventListener('click', () => zoomBy(0.4));
  document.getElementById('zoom-out').addEventListener('click', () => zoomBy(-0.4));
  document.getElementById('reset').addEventListener('click', () => flyTo(state.meta.length / 2, view.maxBpPerPx, 1.0));
  document.getElementById('legend-toggle').addEventListener('click',
    () => document.getElementById('legend').classList.toggle('collapsed'));

  // assembly A/B switch (hg38 <-> T2T-CHM13)
  const asmBtn = document.getElementById('assembly-toggle');
  const updateAsmBtn = () => { asmBtn.textContent = getAssembly() === 'hg38' ? 'hg38' : 'T2T'; };
  updateAsmBtn();
  asmBtn.addEventListener('click', () => {
    asmBtn.disabled = true;
    applyAssembly(getAssembly() === 'hg38' ? 't2t' : 'hg38')
      .then(() => { updateAsmBtn(); flash(`assembly: ${state.meta.assembly}`); })
      .finally(() => { asmBtn.disabled = false; });
  });

  // deep link: index.html#chr21:31659775  or  #SOD1
  const applyHash = () => {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (h) setTargetInstant(h);
  };
  window.addEventListener('hashchange', applyHash);
  applyHash();

  // debug hook (handy for headless screenshotting where rAF/GSAP are throttled)
  window.__genome = { view, setTargetInstant, state, helix, overlay, renderOnce: renderFrame,
    get protein(){ return protein; }, get rnaView(){ return rnaView; },
    pickActiveTranscript: (pos) => pickActiveTranscript(state.genes, pos),
    debug: () => ({ activeTx, translation, seqStart: seqWin && seqWin.start }) };

  frame();
}

function onResize(){
  view.width = app.clientWidth; view.height = app.clientHeight;
  helix.resize(view.width, view.height);
  overlay.resize(view.width, view.height);
  view.maxBpPerPx = (state.meta.length / view.width) * 1.05;
}

function zoomBy(amount){
  gsap.killTweensOf(view);
  flyTo(view.center, clamp(view.bpPerPx * Math.exp(-amount * 2), view.minBpPerPx, view.maxBpPerPx), 0.5);
}

// ---- fly-to (GSAP) -------------------------------------------------------
// Tween centre linearly and zoom in log-space (so it feels multiplicative).
function flyTo(center, bpPerPx, duration = 1.4){
  bpPerPx = clamp(bpPerPx, view.minBpPerPx, view.maxBpPerPx);
  const proxy = { c: view.center, lz: Math.log(view.bpPerPx) };
  gsap.killTweensOf(view); gsap.killTweensOf(proxy);
  gsap.to(proxy, {
    c: center, lz: Math.log(bpPerPx), duration, ease: 'power3.inOut',
    onUpdate(){ view.center = proxy.c; view.bpPerPx = Math.exp(proxy.lz); },
  });
}

function geneExtent(symbol){
  const matches = state.genes.filter(g => g.symbol.toUpperCase() === symbol.toUpperCase());
  if (!matches.length) return null;
  const txStart = Math.min(...matches.map(g => g.txStart));
  const txEnd = Math.max(...matches.map(g => g.txEnd));
  return { txStart, txEnd, gene: matches.find(g => g.coding) || matches[0] };
}

// Resolve a query (gene symbol or coordinate) to a target {center, bpPerPx}.
// Returns null if it can't be parsed / found. No animation here.
function resolveTarget(q){
  q = (q || '').trim();
  if (!q) return null;
  const m = q.replace(/,/g, '').match(/^(?:chr21:)?(\d+)(?:-(\d+))?$/i);
  if (m){
    const a = +m[1], b = m[2] ? +m[2] : null;
    if (b) return { center: (a + b) / 2, bpPerPx: ((b - a) * 1.2) / view.width };
    return { center: a, bpPerPx: 1 / 14 };            // land at codon-level zoom
  }
  const ext = geneExtent(q);
  if (!ext) return null;
  const len = ext.txEnd - ext.txStart;
  return { center: (ext.txStart + ext.txEnd) / 2, bpPerPx: (len * 1.3) / view.width };
}

function flyToGene(symbol){
  const t = resolveTarget(symbol);
  if (!t){ flash(`gene "${symbol}" not found on ${state.meta.chrom}`); return; }
  flyTo(t.center, t.bpPerPx, 1.6);
}

function doSearch(q){
  const t = resolveTarget(q);
  if (!t){ flash(`"${q}" not found on ${state.meta.chrom}`); return; }
  flyTo(t.center, t.bpPerPx, 1.6);
}

// Switch reference assembly (hg38 <-> T2T). Coordinates differ between them, so
// reset the view to the whole chromosome and clear all position-tied state.
async function applyAssembly(name){
  gsap.killTweensOf(view);
  await loadAssembly(name);
  rebuildGeneRegistry();
  view.maxBpPerPx = (state.meta.length / view.width) * 1.05;
  view.bpPerPx = view.maxBpPerPx;
  view.center = state.meta.length / 2;
  seqWin = null; seqReqKey = '';
  activeTx = null; translation = null; classifier = makeFeatureClassifier(null);
  proteinLock = null; lastHighlightKey = '';
  helix._acen = null;                 // coil caches the centromere band — invalidate
  helix.resize(view.width, view.height);
  if (protein && protein.isOpen) protein.close();
}

// Gene-symbol registry for the type-ahead, rebuilt whenever the loaded data
// changes (e.g. switching assembly). For a future whole-genome build this would
// be a genome-wide index, filtered to the chromosome in view once inside one.
let geneRegistry = [];
function rebuildGeneRegistry(){
  const seen = new Set();
  geneRegistry = [];
  for (const g of state.genes) if (!seen.has(g.symbol)){ seen.add(g.symbol); geneRegistry.push(g.symbol); }
  geneRegistry.sort((a, b) => a.localeCompare(b));
}

// Type-ahead gene search (shown as "SYMBOL  chrN").
function setupGeneSearch(input){
  const box = document.getElementById('gene-suggest');
  let matches = [], active = -1;

  const matchList = (q) => {
    q = q.trim().toUpperCase();
    if (!q) return [];
    const pre = [], sub = [];
    for (const s of geneRegistry){
      const u = s.toUpperCase();
      if (u.startsWith(q)) pre.push(s);
      else if (u.includes(q)) sub.push(s);
    }
    return pre.concat(sub).slice(0, 12);
  };
  const render = () => {
    if (!matches.length){ box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.innerHTML = matches.map((s, i) =>
      `<div class="gs-row${i === active ? ' active' : ''}" data-i="${i}"><b>${s}</b><span class="gs-chr">${state.meta.chrom}</span></div>`).join('');
    box.classList.remove('hidden');
  };
  const close = () => { matches = []; active = -1; render(); };
  const choose = (s) => { input.value = s; close(); doSearch(s); input.blur(); };

  input.addEventListener('input', () => { matches = matchList(input.value); active = matches.length ? 0 : -1; render(); });
  input.addEventListener('keydown', (e) => {
    const open = !box.classList.contains('hidden') && matches.length;
    if (!open){ if (e.key === 'Enter') doSearch(input.value); return; }
    if (e.key === 'ArrowDown'){ active = Math.min(active + 1, matches.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp'){ active = Math.max(active - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter'){ e.preventDefault(); choose(matches[active >= 0 ? active : 0]); }
    else if (e.key === 'Escape'){ close(); }
  });
  box.addEventListener('mousedown', (e) => {           // mousedown fires before input blur
    const row = e.target.closest('.gs-row');
    if (!row) return;
    e.preventDefault();
    choose(matches[+row.dataset.i]);
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

// Apply a target instantly (used for deep-link hashes like #chr21:31659775).
function setTargetInstant(q){
  const t = resolveTarget(q);
  if (!t) return false;
  view.center = t.center;
  view.bpPerPx = clamp(t.bpPerPx, view.minBpPerPx, view.maxBpPerPx);
  clampView();
  return true;
}

function flash(msg){
  const el = document.getElementById('flash');
  el.textContent = msg; el.style.opacity = '1';
  gsap.killTweensOf(el); gsap.to(el, { opacity: 0, delay: 1.8, duration: 0.6 });
}

// ---- boot ----------------------------------------------------------------
loadMeta().then(setup).catch(err => {
  document.getElementById('flash').textContent = 'Failed to load data: ' + err.message;
  document.getElementById('flash').style.opacity = '1';
  console.error(err);
});
