// helix.js — the Three.js layer. Two visuals share the X axis with the 2D
// overlay (worldX maps 1:1 to screen via an orthographic camera):
//   * ribbonGroup  — a glowing, gently-waving cytoband ribbon for the
//                    zoomed-out "whole chromosome" view (the continent).
//   * helixGroup   — the real B-DNA double helix (10.5 bp/turn) drawn per
//                    base pair, for the zoomed-in view (the street).
// Geometry is baked in bp-space (x = base position); each frame we only set
// scale.x / position.x to project bp -> pixels, so it never drifts from the
// nucleotide letters drawn by the 2D overlay.

import * as THREE from 'three';
import { stainColor, BASE_COLOR, FEATURE_COLOR, makeFeatureClassifier } from './genome.js';
import { baseAt } from './data.js';

const BP_PER_TURN = 10.5;      // canonical B-DNA
const HELIX_R = 70;            // helix radius in pixels
const RIBBON_SAMPLES = 320;

const _c = new THREE.Color();
function tintByZ(hex, z){       // fake depth: rungs/strand nearer the camera glow brighter
  _c.set(hex);
  const f = 0.5 + 0.5 * (z / HELIX_R * 0.5 + 0.5);
  return [_c.r * f, _c.g * f, _c.b * f];
}

export class HelixView {
  constructor(container){
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.position = 'absolute';
    this.renderer.domElement.style.top = '0';
    this.renderer.domElement.style.left = '0';

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -6000, 6000);
    this.camera.position.z = 500;

    this.ribbonGroup = new THREE.Group();
    this.helixGroup = new THREE.Group();
    this.scene.add(this.ribbonGroup, this.helixGroup);

    // helix line objects (rebuilt on window change)
    const mat = (op) => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true,
                                                      opacity: op, blending: THREE.AdditiveBlending });
    this.strandA = new THREE.Line(new THREE.BufferGeometry(), mat(1));
    this.strandB = new THREE.Line(new THREE.BufferGeometry(), mat(1));
    this.rungs   = new THREE.LineSegments(new THREE.BufferGeometry(), mat(0.9));
    this.helixGroup.add(this.strandA, this.strandB, this.rungs);
    // ortho camera + we always know what's on screen -> no frustum culling,
    // which also avoids bounding-sphere NaN warnings on empty/initial geometry.
    for (const o of [this.strandA, this.strandB, this.rungs]) o.frustumCulled = false;

    // ribbon mesh
    this.ribbonMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide })
    );
    this.ribbonMesh.frustumCulled = false;
    this.ribbonGroup.add(this.ribbonMesh);

    // condensed-chromosome coil (the zoomed-out overview): a variable-pitch
    // double strand along X with a focus+context fisheye centred on the view.
    this.coilGroup = new THREE.Group();
    this.scene.add(this.coilGroup);
    const cmat = () => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0 });
    this.coilA = new THREE.Line(new THREE.BufferGeometry(), cmat());
    this.coilB = new THREE.Line(new THREE.BufferGeometry(), cmat());
    for (const o of [this.coilA, this.coilB]) o.frustumCulled = false;
    this.coilGroup.add(this.coilA, this.coilB);
    this._coilArrays = null; this._acen = null;

    this._built = null;        // {start, end} of currently-baked helix window
    this.width = 1; this.height = 1; this.cy = 0;
  }

  resize(w, h){
    this.width = w; this.height = h; this.cy = 0;
    this.renderer.setSize(w, h);   // updateStyle:true so the canvas CSS size is w×h
                                   // (NOT the drawing-buffer size) — keeps it aligned
                                   // vertically with the 2D overlay's centre line
    // world (0..w) x (-h/2..h/2); screenY = h/2 - worldY
    this.camera.left = 0; this.camera.right = w;
    this.camera.top = h / 2; this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();
    this._built = null;        // force rebuild (scale.x depends on width only via mapping, geom is bp-space)
  }

  // ---- ribbon (overview) -------------------------------------------------
  buildRibbon(viewStart, viewEnd, bands, opacity){
    if (opacity <= 0.01){ this.ribbonMesh.visible = false; return; }
    this.ribbonMesh.visible = true;
    const span = viewEnd - viewStart;
    const N = RIBBON_SAMPLES;
    const pos = new Float32Array(N * 2 * 3);
    const col = new Float32Array(N * 2 * 3);
    const idx = [];
    // Taper from a big wavy coil (whole-chromosome overview) down to a thin,
    // flat chromosome strand by the locus scale, so the ribbon stays present
    // continuously until the nucleotide helix takes over (no bare zoom gap),
    // without becoming a giant monochrome slab when only one band is in view.
    const big = smoothstep(50000, 2000000, span);   // 0 at 50 kb, 1 at 2 Mb
    // floors keep a gently-waving, visibly-thick strand in the mid-range so it
    // reads as the chromosome body (not a hairline, not a slab) and blends into
    // the twisting helix as that fades in
    const half = 16 + (Math.min(this.height * 0.14, 70) - 16) * big;
    const waveAmp = 12 + (Math.min(this.height * 0.18, 110) - 12) * big;
    const colorAt = (bp) => {
      for (const b of bands) if (bp >= b.start && bp < b.end) return stainColor(b.stain);
      return '#aab2bd';
    };
    for (let i = 0; i < N; i++){
      const bp = viewStart + span * (i / (N - 1));
      const x = (bp - viewStart) / bpPerPx(span, this.width);
      const wave = Math.sin(bp / span * Math.PI * 6) * waveAmp;   // gentle large coil
      _c.set(colorAt(bp));
      for (let k = 0; k < 2; k++){
        const o = (i * 2 + k) * 3;
        pos[o] = x; pos[o + 1] = wave + (k ? -half : half); pos[o + 2] = 0;
        const shade = k ? 0.6 : 1.0;                              // top edge brighter
        col[o] = _c.r * shade; col[o + 1] = _c.g * shade; col[o + 2] = _c.b * shade;
      }
      if (i < N - 1){
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = this.ribbonMesh.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e9);
    this.ribbonMesh.material.opacity = opacity;
    this.ribbonGroup.position.x = 0;     // ribbon baked directly in screen-x
    this.ribbonGroup.scale.x = 1;
  }

  // ---- helix (detail) ----------------------------------------------------
  // Bake helix vertices for [start,end) in bp-space. x = bp, y/z = twist (px).
  // `straighten` (0..1) unwinds the twist into a clean straight ladder so that
  // at the deepest zoom the DNA reads as a plain string of base pairs (the
  // twisting helix is the zoomed-out motif, the ladder is the street view).
  bakeHelix(start, end, seqWin, classifier, straighten){
    start = Math.floor(start); end = Math.ceil(end);
    const span = end - start;
    const s = straighten;
    const RAIL = 62;   // straight-ladder rail height ~ the letter rows (±70),
                       // so each rung visually links a base to its complement
    // helix point at base-position bp -> {y,z} for the given strand sign
    const pt = (bp, sign) => {
      const th = 2 * Math.PI * bp / BP_PER_TURN;
      return {
        y: (1 - s) * sign * HELIX_R * Math.sin(th) + s * sign * RAIL,
        z: (1 - s) * sign * HELIX_R * Math.cos(th),
      };
    };
    const step = span < 800 ? 0.25 : span / 3000;       // smoothness of backbone curve
    const nPts = Math.floor(span / step) + 1;
    const aPos = new Float32Array(nPts * 3), aCol = new Float32Array(nPts * 3);
    const bPos = new Float32Array(nPts * 3), bCol = new Float32Array(nPts * 3);

    for (let i = 0; i < nPts; i++){
      const bp = start + i * step;
      const A = pt(bp, 1), B = pt(bp, -1);
      const fc = classifier ? classifier(Math.floor(bp)) : 'intergenic';
      const tint = FEATURE_COLOR[fc] || '#cfd6e0';
      const ca = tintByZ(tint, A.z), cb = tintByZ(tint, B.z);
      let o = i * 3;
      aPos[o] = bp; aPos[o + 1] = A.y; aPos[o + 2] = A.z; aCol[o] = ca[0]; aCol[o + 1] = ca[1]; aCol[o + 2] = ca[2];
      bPos[o] = bp; bPos[o + 1] = B.y; bPos[o + 2] = B.z; bCol[o] = cb[0]; bCol[o + 1] = cb[1]; bCol[o + 2] = cb[2];
    }
    this._setLine(this.strandA, aPos, aCol);
    this._setLine(this.strandB, bPos, bCol);

    // rungs: one per integer base pair (vertical & parallel once straightened)
    const nR = span;
    const rPos = new Float32Array(nR * 2 * 3), rCol = new Float32Array(nR * 2 * 3);
    for (let i = 0; i < nR; i++){
      const bp = start + i;
      const A = pt(bp + 0.5, 1), B = pt(bp + 0.5, -1);
      const base = seqWin ? (baseAt(seqWin, bp) || 'N').toUpperCase() : 'N';
      const hex = BASE_COLOR[base] || '#6b7280';
      const c1 = tintByZ(hex, A.z), c2 = tintByZ(hex, B.z);
      let o = i * 2 * 3;
      rPos[o] = bp + 0.5; rPos[o + 1] = A.y; rPos[o + 2] = A.z;
      rPos[o + 3] = bp + 0.5; rPos[o + 4] = B.y; rPos[o + 5] = B.z;
      rCol[o] = c1[0]; rCol[o + 1] = c1[1]; rCol[o + 2] = c1[2];
      rCol[o + 3] = c2[0]; rCol[o + 4] = c2[1]; rCol[o + 5] = c2[2];
    }
    this._setLine(this.rungs, rPos, rCol);
    this._built = { start, end };
    this._builtStraighten = s;
  }

  _setLine(line, pos, col){
    const g = line.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // give it a non-null bounding sphere so three never auto-computes one
    // (which warns if a transient frame ever produced a non-finite vertex)
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e9);
  }

  // ---- condensed-chromosome coil -----------------------------------------
  // One coiled rod for the whole chromosome. A Gaussian focus kernel at the
  // view centre both UNWINDS the helix locally (turn-rate -> 0) and EXPANDS its
  // screen space (fisheye), so the region of interest stretches toward a
  // straight strand while the rest stays a tight, condensed coil squeezed to
  // the edges. Radius dips at the centromere (acen) for the constricted waist.
  updateCoil(s){
    const op = s.coilOpacity || 0;
    const on = op > 0.01;
    this.coilA.visible = this.coilB.visible = on;
    if (!on) return;
    this.coilA.material.opacity = op; this.coilB.material.opacity = op;

    const N = 2600, L = s.chromLength;
    if (!this._coilArrays){
      const mk = () => ({ pos: new Float32Array((N + 1) * 3), col: new Float32Array((N + 1) * 3) });
      this._coilArrays = { a: mk(), b: mk() };
      for (const [line, arr] of [[this.coilA, this._coilArrays.a], [this.coilB, this._coilArrays.b]]){
        line.geometry.setAttribute('position', new THREE.BufferAttribute(arr.pos, 3));
        line.geometry.setAttribute('color', new THREE.BufferAttribute(arr.col, 3));
        line.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      }
    }
    if (!this._acen){
      const ac = s.bands.filter(b => b.stain === 'acen');
      if (ac.length){
        const a0 = Math.min(...ac.map(b => b.start)), a1 = Math.max(...ac.map(b => b.end));
        this._acen = { u: (a0 + a1) / 2 / L, w: (a1 - a0) / L };
      } else this._acen = { u: -1, w: 0.02 };
    }

    const span = s.viewEnd - s.viewStart;
    const u0 = Math.min(1, Math.max(0, s.center / L));
    const sigma = Math.min(0.5, Math.max(0.0045, (span / L) * 0.55));   // focus width: narrows on zoom
    // focus strength: 0 at the whole-chromosome view (uniform condensed coil),
    // ramping to 1 as you zoom in (center unwinds + magnifies)
    const FS = 1 - smoothstep(2e6, 40e6, span);
    const Aexp = Math.min(600, Math.max(2, (L / span) * 0.6)) * FS;     // focus magnification: grows on zoom
    // just before the coil hands off to the bases, slide the off-focus coils
    // outward off the left/right edges (so the sides leave before the fade).
    const pushProg = 1 - smoothstep(7000, 14000, span);
    const TURNS = 200;                                                  // total turns when fully condensed
    const Rbase = Math.min(this.width, this.height) * 0.11;
    const margin = 40, xspan = this.width - 2 * margin;
    const du = 1 / N;
    const A = this._coilArrays.a, B = this._coilArrays.b;

    // pass 1: focus kernel, cumulative screen-density, cumulative turn phase
    const foc = new Float32Array(N + 1), cumG = new Float32Array(N + 1), theta = new Float32Array(N + 1);
    let gAcc = 0, tAcc = 0;
    for (let i = 0; i <= N; i++){
      const u = i * du, d = (u - u0) / sigma;
      const f = Math.exp(-d * d);
      foc[i] = f;
      gAcc += (1 + Aexp * f) * du; cumG[i] = gAcc;          // screen space density
      theta[i] = 2 * Math.PI * tAcc;
      tAcc += TURNS * (1 - FS * f) * du;                     // turns unwind near the focus (strength FS)
    }
    const i0 = Math.round(u0 * N), gu0 = cumG[i0], total = cumG[N] || 1;

    // pass 2: positions + cytoband colours (two antiparallel strands)
    // At the focus the two strands DON'T collapse to the axis — they unwind into
    // two flat parallel rails at ±RAIL (the nucleotide-helix ladder separation),
    // so the colored base pairs phase in right between the widening wires. Away
    // from the focus the strands keep their full helical winding (the tight coil).
    const RAIL = 62;                          // matches the straight-ladder rail in bakeHelix
    const col = new THREE.Color();
    for (let i = 0; i <= N; i++){
      const u = i * du, f = foc[i], th = theta[i];
      let x = this.width / 2 + ((cumG[i] - gu0) / total) * xspan;
      x += (x >= this.width / 2 ? 1 : -1) * (1 - f) * pushProg * this.width;   // slide context off-screen
      const dip = 1 - 0.62 * Math.exp(-(((u - this._acen.u) / (this._acen.w * 0.9)) ** 2));
      const R = Rbase * dip;
      const st = FS * f;                      // local straighten: 0 (coil) -> 1 (flat rails)
      const ca = Math.cos(th), sa = Math.sin(th);
      const yA = (1 - st) * (R * ca) + st * RAIL,  zA = (1 - st) * (R * sa);
      const yB = (1 - st) * (-R * ca) - st * RAIL, zB = (1 - st) * (-R * sa);
      // context (off-focus) fades faster than the focus as the whole coil fades
      // out (op -> 0), so the side coils push off / disappear before the rails do.
      const bright = f + (1 - f) * op;
      const invR = R > 1e-6 ? 1 / R : 0;
      const shA = (0.55 + 0.45 * (zA * invR * 0.5 + 0.5)) * bright;
      const shB = (0.55 + 0.45 * (zB * invR * 0.5 + 0.5)) * bright;
      col.set(stainColor(bandAt(s.bands, u * L)));
      const o = i * 3;
      A.pos[o] = x; A.pos[o + 1] = yA; A.pos[o + 2] = zA;
      B.pos[o] = x; B.pos[o + 1] = yB; B.pos[o + 2] = zB;
      A.col[o] = col.r * shA; A.col[o + 1] = col.g * shA; A.col[o + 2] = col.b * shA;
      B.col[o] = col.r * shB; B.col[o + 1] = col.g * shB; B.col[o + 2] = col.b * shB;
    }
    this.coilA.geometry.attributes.position.needsUpdate = true;
    this.coilA.geometry.attributes.color.needsUpdate = true;
    this.coilB.geometry.attributes.position.needsUpdate = true;
    this.coilB.geometry.attributes.color.needsUpdate = true;
  }

  // ---- per-frame update --------------------------------------------------
  update(s){
    const { viewStart, viewEnd, helixOpacity, ribbonOpacity, bands, seqWin, genes } = s;
    const span = viewEnd - viewStart;
    const ppb = bpPerPx(span, this.width);

    this.updateCoil(s);
    this.buildRibbon(viewStart, viewEnd, bands, ribbonOpacity);

    // helix only meaningful (and cheap) for small windows
    this.helixGroup.visible = helixOpacity > 0.01;
    if (this.helixGroup.visible){
      const bw = this.width / span;                     // px per base
      // unwind into a flat ladder by the time letters are readable, so the
      // deepest zoom reads as a plain straight string of base pairs
      const straighten = smoothstep(7, 13, bw);
      const pad = span * 0.35;
      const needStart = viewStart - pad, needEnd = viewEnd + pad;
      const b = this._built;
      const stale = !b || b.start > needStart || b.end < needEnd || (b.end - b.start) > span * 4
                    || Math.abs((this._builtStraighten ?? -1) - straighten) > 0.03;
      if (stale){
        const tx = pickActiveTranscript(genes, (viewStart + viewEnd) / 2);
        const classifier = makeFeatureClassifier(tx);
        this.bakeHelix(viewStart - pad, viewEnd + pad, seqWin, classifier, straighten);
      }
      // project bp -> screen-x: x_screen = (bp - viewStart)/ppb
      this.helixGroup.scale.x = 1 / ppb;
      this.helixGroup.position.x = -viewStart / ppb;
      this.strandA.material.opacity = helixOpacity;
      this.strandB.material.opacity = helixOpacity;
      this.rungs.material.opacity = helixOpacity * 0.7;
    }
  }

  render(){ this.renderer.render(this.scene, this.camera); }
}

function bpPerPx(span, width){ return span / width; }
function smoothstep(e0, e1, x){ const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

function bandAt(bands, pos){
  for (const b of bands) if (pos >= b.start && pos < b.end) return b.stain;
  return 'gneg';
}

// Choose the transcript whose body contains `pos`, preferring coding and the
// most exon-rich; falls back to the nearest. Used to tint the helix by feature.
export function pickActiveTranscript(genes, pos){
  if (!genes || !genes.length) return null;
  let best = null, bestScore = -1;
  for (const g of genes){
    if (pos >= g.txStart && pos < g.txEnd){
      const score = (g.coding ? 1000 : 0) + g.exons.length;
      if (score > bestScore){ bestScore = score; best = g; }
    }
  }
  return best;
}
