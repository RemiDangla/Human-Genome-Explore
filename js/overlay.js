// overlay.js — the 2D information layer drawn on a canvas above the WebGL
// helix. Everything uses the same projection sx(bp) = (bp-viewStart)/bpPerPx
// so labels sit exactly on the helix. Lanes fade in/out per zoom tier.

import {
  stainColor, BASE_COLOR, FEATURE_COLOR, aaColor, AA_3LETTER,
  makeFeatureClassifier, complement, isRepeat, fmtPos, fmtBp,
} from './genome.js';
import { baseAt } from './data.js';

export class Overlay {
  constructor(canvas){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 1; this.height = 1; this.dpr = Math.min(window.devicePixelRatio, 2);
    // screen rects for hit-testing (filled during draw)
    this.ideoRect = { x: 140, y: 72, w: 0, h: 22 };
  }

  resize(w, h){
    this.width = w; this.height = h;
    this.canvas.width = w * this.dpr; this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ideoRect.x = 140;
    this.ideoRect.y = 72;
    this.ideoRect.w = Math.max(120, w - 380);   // leave room for left label + right legend
  }

  draw(s){
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    this.sx = (bp) => (bp - s.viewStart) / s.bpPerPx;
    this.s = s;

    this.drawIdeogram(s);
    this.drawRuler(s);
    if (s.op.geneTrack > 0.01) this.drawGeneTrack(s);
    if (s.op.sequence > 0.01) this.drawSequence(s);
    if (s.op.codon > 0.01) this.drawCodonTrack(s);
    this.drawCrosshair(s);
  }

  // --- persistent minimap of the whole chromosome -------------------------
  drawIdeogram(s){
    const ctx = this.ctx, r = this.ideoRect, L = s.meta.length;
    const toX = (bp) => r.x + (bp / L) * r.w;
    ctx.save();
    // band blocks
    for (const b of s.meta.bands){
      const x0 = toX(b.start), x1 = toX(b.end);
      ctx.fillStyle = stainColor(b.stain);
      if (b.stain === 'acen'){            // centromere as a notch
        ctx.beginPath();
        const mid = (x0 + x1) / 2, yT = r.y, yB = r.y + r.h, yM = r.y + r.h / 2;
        if (b.name.startsWith('p')){ ctx.moveTo(x0, yT); ctx.lineTo(x1, yM); ctx.lineTo(x0, yB); }
        else { ctx.moveTo(x1, yT); ctx.lineTo(x0, yM); ctx.lineTo(x1, yB); }
        ctx.closePath(); ctx.fill();
      } else {
        ctx.fillRect(x0, r.y, Math.max(1, x1 - x0), r.h);
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // current viewport window indicator
    const vx0 = toX(s.viewStart), vx1 = toX(s.viewEnd);
    ctx.fillStyle = 'rgba(120,200,255,0.25)';
    ctx.fillRect(vx0, r.y - 3, Math.max(2, vx1 - vx0), r.h + 6);
    ctx.strokeStyle = '#7cc6ff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx0, r.y - 3, Math.max(2, vx1 - vx0), r.h + 6);

    // label: assembly + current band, to the LEFT of the ideogram
    const mid = (s.viewStart + s.viewEnd) / 2;
    const band = s.meta.bands.find(b => mid >= b.start && mid < b.end);
    ctx.fillStyle = '#cdd6e2'; ctx.font = '12px ui-monospace, monospace'; ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(`${s.meta.chrom}${band ? ' ' + band.name : ''}`, 10, r.y + r.h / 2);
    ctx.restore();
  }

  // --- coordinate ruler ---------------------------------------------------
  drawRuler(s){
    const ctx = this.ctx, y = 108, span = s.viewEnd - s.viewStart;
    const target = span / 9;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const mult = [1, 2, 5, 10].find(m => m * pow >= target) || 10;
    const step = mult * pow;
    const first = Math.ceil(s.viewStart / step) * step;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.fillStyle = '#8b97a8';
    ctx.font = '11px ui-monospace, monospace'; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.width, y); ctx.stroke();
    for (let bp = first; bp < s.viewEnd; bp += step){
      const x = this.sx(bp);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 6); ctx.stroke();
      ctx.fillText(fmtPos(bp), x, y + 8);
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = '#5f6a7a';
    ctx.fillText('span ' + fmtBp(span), this.width - 8, y + 8);
    ctx.restore();
  }

  // --- gene models --------------------------------------------------------
  drawGeneTrack(s){
    const ctx = this.ctx, laneY = this.height * 0.26;
    const op = s.op.geneTrack;
    const span = s.viewEnd - s.viewStart;
    ctx.save(); ctx.globalAlpha = op;

    // Once zoomed inside a gene, show ONLY the active transcript (one row) —
    // stacking every overlapping isoform here is just clutter. At the wider
    // locus/region view, stack transcripts (capped) so you can compare them.
    const MAX_ROWS = 7;
    let placed, hidden = 0;
    if (span < 40000 && s.activeTx){
      placed = [{ g: s.activeTx, row: 0 }];
    } else {
      const overlapping = s.genes
        .filter(g => g.txEnd > s.viewStart && g.txStart < s.viewEnd)
        .sort((a, b) => a.txStart - b.txStart);
      const rows = [];
      placed = [];
      for (const g of overlapping){
        let row = 0;
        while (rows[row] !== undefined && rows[row] > g.txStart) row++;
        if (row >= MAX_ROWS){ hidden++; continue; }
        rows[row] = g.txEnd;
        placed.push({ g, row });
      }
    }
    const rowH = 34;
    for (const { g, row } of placed){
      const y = laneY + row * rowH;
      const x0 = this.sx(g.txStart), x1 = this.sx(g.txEnd);
      // intron line
      ctx.strokeStyle = g.coding ? '#6f7b8c' : '#7d6fb0';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(Math.max(-5, x0), y); ctx.lineTo(Math.min(this.width + 5, x1), y); ctx.stroke();
      // strand arrows along the intron
      ctx.fillStyle = 'rgba(180,190,205,0.5)';
      const ax0 = Math.max(8, x0), ax1 = Math.min(this.width - 8, x1);
      for (let x = ax0 + 14; x < ax1; x += 22){
        ctx.beginPath();
        if (g.strand === '+'){ ctx.moveTo(x - 3, y - 4); ctx.lineTo(x + 3, y); ctx.lineTo(x - 3, y + 4); }
        else { ctx.moveTo(x + 3, y - 4); ctx.lineTo(x - 3, y); ctx.lineTo(x + 3, y + 4); }
        ctx.fill();
      }
      // exons
      for (const [es, ee] of g.exons){
        const ex0 = this.sx(es), ex1 = this.sx(ee);
        if (ex1 < 0 || ex0 > this.width) continue;
        // split each exon into CDS (tall) vs UTR (short)
        const segs = g.coding
          ? [
              [Math.max(es, g.cdsStart), Math.min(ee, g.cdsEnd), 'cds'],
              [es, Math.min(ee, g.cdsStart), g.strand === '+' ? 'utr5' : 'utr3'],
              [Math.max(es, g.cdsEnd), ee, g.strand === '+' ? 'utr3' : 'utr5'],
            ]
          : [[es, ee, 'exon_nc']];
        for (const [a, b, fc] of segs){
          if (b <= a) continue;
          const bx0 = this.sx(a), bx1 = this.sx(b);
          const h = fc === 'cds' ? 16 : 9;
          ctx.fillStyle = FEATURE_COLOR[fc];
          ctx.fillRect(bx0, y - h / 2, Math.max(1.2, bx1 - bx0), h);
        }
      }
      // label
      const lx = Math.max(6, Math.min(x0, this.width - 90));
      ctx.fillStyle = '#e8edf4'; ctx.font = 'bold 12px ui-sans-serif, system-ui';
      ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
      // always show the transcript accession: stacked rows are alternative
      // isoforms of the same gene, so the symbol alone looks like duplicates
      const label = `${g.symbol} · ${g.id}${g.coding ? '' : ' (nc)'}`;
      ctx.fillText(label, lx, y - 11);
    }
    if (hidden > 0){
      ctx.fillStyle = '#8b97a8'; ctx.font = '11px ui-sans-serif, system-ui';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`+${hidden} more transcript${hidden > 1 ? 's' : ''}`, 8, laneY + MAX_ROWS * rowH + 4);
    }
    ctx.restore();
  }

  // --- nucleotide letters -------------------------------------------------
  drawSequence(s){
    if (!s.seqWin) return;
    const ctx = this.ctx, cy = this.height / 2, op = s.op.sequence;
    const bw = 1 / s.bpPerPx;                       // pixels per base
    const topY = cy - 70, botY = cy + 70;
    const i0 = Math.max(0, Math.floor(s.viewStart) - 1);
    const i1 = Math.min(s.meta.length - 1, Math.ceil(s.viewEnd) + 1);
    const classifier = s.classifier || (() => 'intergenic');
    ctx.save(); ctx.globalAlpha = op;
    const fs = Math.max(9, Math.min(bw * 0.8, 26));
    ctx.font = `${fs}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    for (let p = i0; p <= i1; p++){
      const x = this.sx(p + 0.5);
      if (x < -bw || x > this.width + bw) continue;
      const raw = baseAt(s.seqWin, p);
      if (!raw) continue;
      const base = raw.toUpperCase();
      const fc = classifier(p);
      // feature chip behind the column
      ctx.fillStyle = hexA(FEATURE_COLOR[fc] || '#30363f', 0.22);
      ctx.fillRect(x - bw / 2, topY - fs, bw, (botY) - (topY - fs) + fs);
      // top strand (reference, + strand)
      ctx.globalAlpha = op * (isRepeat(raw) ? 0.55 : 1);
      ctx.fillStyle = BASE_COLOR[base] || '#9aa3af';
      ctx.textBaseline = 'middle';
      ctx.fillText(base, x, topY);
      // complement (bottom strand)
      const comp = complement(base);
      ctx.fillStyle = hexA(BASE_COLOR[comp] || '#9aa3af', 0.85);
      ctx.fillText(comp, x, botY);
      ctx.globalAlpha = op;
    }
    // strand labels
    ctx.globalAlpha = op * 0.6; ctx.fillStyle = '#8b97a8';
    ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText("5'→ (+ strand)", 8, topY - fs - 6);
    ctx.fillText("3'← (− strand)", 8, botY + fs);
    ctx.restore();
  }

  // --- amino-acid translation track --------------------------------------
  drawCodonTrack(s){
    if (!s.translation || !s.activeTx) return;
    const ctx = this.ctx, cy = this.height / 2, op = s.op.codon;
    const bw = 1 / s.bpPerPx;
    const minus = s.activeTx.strand === '-';
    // put the protein next to the strand that encodes it: above the top (+)
    // strand for a +strand gene, below the bottom (−) strand for a −strand gene
    const aaY = minus ? cy + 132 : cy - 132;
    const { codonToPositions, protein, codons } = s.translation;
    ctx.save(); ctx.globalAlpha = op;
    ctx.textAlign = 'center';
    // find codons intersecting the view
    for (let ci = 0; ci < protein.length; ci++){
      const trip = codonToPositions[ci];
      if (!trip) continue;
      // centre on the codon's MIDDLE base and use a fixed 3-base width. This
      // keeps the chip aligned to its 3 nucleotide columns for normal codons
      // and avoids drawing a giant bar when a codon is split across an intron.
      const cx = this.sx(trip[1] + 0.5);
      if (cx < -bw * 3 || cx > this.width + bw * 3) continue;
      const aa = protein[ci];
      const codon = codons ? codons[ci] : '';
      const w = 3 * bw;
      // chip
      ctx.fillStyle = aaColor(aa);
      roundRect(ctx, cx - w / 2 + 1, aaY - 15, w - 2, 30, 5); ctx.fill();
      // text: the translated mRNA triplet (strand-corrected) over the AA, so
      // it reads codon -> amino acid even on the minus strand
      ctx.fillStyle = aa === '*' ? '#e8edf4' : '#15181d';
      ctx.textBaseline = 'middle';
      if (w > 42){
        ctx.font = 'bold 12px ui-sans-serif, system-ui';
        ctx.fillText(AA_3LETTER[aa] || aa, cx, aaY - 4);
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillText(codon, cx, aaY + 9);
      } else {
        ctx.font = 'bold 14px ui-sans-serif, system-ui';
        ctx.fillText(aa, cx, aaY);
      }
    }
    // track label + protein name + direction
    ctx.globalAlpha = op * 0.85;
    ctx.fillStyle = '#cdd6e2'; ctx.font = 'bold 12px ui-sans-serif, system-ui';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const dir = minus ? '−strand · N→C reads ◄ (codons on lower strand)'
                      : '+strand · N→C reads ► (codons on upper strand)';
    ctx.fillText(`protein ${s.activeTx.symbol}   ${dir}`, 8, aaY - 28);
    ctx.restore();
  }

  drawCrosshair(s){
    if (s.op.sequence < 0.2 && s.op.codon < 0.2) return;
    const ctx = this.ctx, x = this.width / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 70); ctx.lineTo(x, this.height); ctx.stroke();
    ctx.restore();
  }
}

function hexA(hex, a){
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function roundRect(ctx, x, y, w, h, r){
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
