// data.js — all network access. Loads metadata + gene models once, and
// streams nucleotide windows on demand via HTTP byte-range requests against
// chr21.seq (one byte per base => byte offset == genomic coordinate).

import { reverseComplement, translate } from './genome.js';

// Datasets live under data/<assembly>/ so the viewer can A/B reference genomes.
export const ASSEMBLIES = { hg38: 'hg38', t2t: 'T2T-CHM13v2.0' };
let ASSEMBLY = 't2t';            // default to the complete telomere-to-telomere genome
const dataUrl = (file) => `data/${ASSEMBLY}/${file}`;
const SEQ_FILE = 'chr21.seq';

export const state = { meta: null, genes: [] };
export const getAssembly = () => ASSEMBLY;

// Load (or switch to) an assembly: clears caches and reloads meta + gene models.
export async function loadAssembly(name){
  if (name) ASSEMBLY = name;
  seqCache.length = 0;
  translationCache.clear();
  rnaCache.clear();
  state.meta  = await (await fetch(dataUrl('chr21.meta.json'))).json();
  state.genes = await (await fetch(dataUrl('chr21.genes.json'))).json();
  return state;
}
export const loadMeta = () => loadAssembly();

// ---- Sequence windows ----------------------------------------------------
// Simple LRU-ish cache of fetched windows. Each entry: {start, end, seq}.
const seqCache = [];
const MAX_CACHE = 40;

// Returns { start, seq }. A 206 maps to the requested window; if the host
// ignores Range and returns 200 (the whole file), we report start:0 so offsets
// stay correct — the app still works on any static host (e.g. GitHub Pages),
// just paying one full-chromosome download instead of a tiny windowed one.
async function fetchRange(start, end){            // [start, end) 0-based, half-open
  start = Math.max(0, Math.floor(start));
  end   = Math.min(state.meta.length, Math.ceil(end));
  if (end <= start) return { start, seq: '' };
  const res = await fetch(dataUrl(SEQ_FILE), { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (res.status === 206) return { start, seq: await res.text() };
  if (res.status === 200) return { start: 0, seq: await res.text() };   // host ignored Range
  throw new Error('sequence fetch failed: ' + res.status);
}

// Get the sequence covering [start, end). Returns { start, seq } where seq[i]
// is the base at genomic position start + i. Fetches with margin and caches.
export async function getSequence(start, end){
  start = Math.max(0, Math.floor(start));
  end   = Math.min(state.meta.length, Math.ceil(end));
  for (const c of seqCache){
    if (start >= c.start && end <= c.end){
      return { start: c.start, seq: c.seq };
    }
  }
  const span = end - start;
  const margin = Math.min(Math.max(span, 2000), 200000); // fetch generously, cap at 200 kb
  const fs = Math.max(0, start - margin);
  const fe = Math.min(state.meta.length, end + margin);
  const r = await fetchRange(fs, fe);
  const entry = { start: r.start, end: r.start + r.seq.length, seq: r.seq };
  seqCache.unshift(entry);
  if (seqCache.length > MAX_CACHE) seqCache.pop();
  return { start: entry.start, seq: entry.seq };
}

// Synchronous lookup into an already-fetched window object.
export function baseAt(win, pos){
  const i = pos - win.start;
  return (i >= 0 && i < win.seq.length) ? win.seq[i] : null;
}

// ---- Non-coding RNA info (static, pre-generated) ------------------------
// { SYMBOL: {simple, technical, source} }. Shared across assemblies (keyed by
// gene symbol), built offline by build_rna_info.py. Loaded lazily on first use.
let rnaInfoMap = null, rnaInfoPromise = null;
export function loadRnaInfo(){
  if (rnaInfoMap) return Promise.resolve(rnaInfoMap);
  if (!rnaInfoPromise){
    rnaInfoPromise = fetch('data/rna_info.json')
      .then(r => r.json())
      .then(m => { rnaInfoMap = m; return m; });
  }
  return rnaInfoPromise;
}

// ---- Spliced transcript (mature RNA) ------------------------------------
// Assemble the spliced RNA for ANY transcript (coding or non-coding): the
// concatenated exon sequence, strand-corrected to 5'→3', with T→U. Fetches
// each exon's bases separately so we never download huge intronic spans.
// Cached by transcript id.
const rnaCache = new Map();

export async function getSplicedRna(tx){
  if (!tx) return null;
  if (rnaCache.has(tx.id)) return rnaCache.get(tx.id);

  const exons = tx.exons.slice().sort((a, b) => a[0] - b[0]);
  let genomicSeq = '';
  for (const [a, b] of exons){
    const win = await getSequence(a, b);
    for (let p = a; p < b; p++) genomicSeq += (baseAt(win, p) || 'N');
  }
  genomicSeq = genomicSeq.toUpperCase();
  const sense = tx.strand === '-' ? reverseComplement(genomicSeq) : genomicSeq;
  const seq = sense.replace(/T/g, 'U');
  const result = { seq, length: seq.length, strand: tx.strand };
  rnaCache.set(tx.id, result);
  return result;
}

// ---- Per-transcript translation -----------------------------------------
// Splice the CDS (strand-aware), translate to protein, and build maps so the
// renderer can, for any genomic position, know its codon index / frame, and
// for any codon know its three genomic positions. Cached by transcript id.
const translationCache = new Map();

export async function getTranslation(tx){
  if (!tx || !tx.coding) return null;
  if (translationCache.has(tx.id)) return translationCache.get(tx.id);

  // Collect CDS sub-intervals (exon ∩ [cdsStart,cdsEnd]) in genomic order.
  const cdsIntervals = [];
  for (const [s, e] of tx.exons){
    const a = Math.max(s, tx.cdsStart), b = Math.min(e, tx.cdsEnd);
    if (b > a) cdsIntervals.push([a, b]);
  }
  cdsIntervals.sort((p, q) => p[0] - q[0]);

  // Fetch the whole CDS span in ONE range request (was one fetch per exon,
  // which made large multi-exon genes like APP take seconds), then read out the
  // exon bases from that single window.
  const win = await getSequence(tx.cdsStart, tx.cdsEnd);
  let genomicSeq = '';
  const genomicPos = [];                 // genomicPos[k] = genome coord of genomicSeq[k]
  for (const [a, b] of cdsIntervals){
    for (let p = a; p < b; p++){
      genomicSeq += (baseAt(win, p) || 'N');
      genomicPos.push(p);
    }
  }

  // mRNA order: for '-' strand, reverse-complement and reverse the position list.
  let mrna, mrnaPos;
  if (tx.strand === '+'){
    mrna = genomicSeq.toUpperCase();
    mrnaPos = genomicPos;
  } else {
    mrna = reverseComplement(genomicSeq).toUpperCase();
    mrnaPos = genomicPos.slice().reverse();
  }

  const protein = [];                    // protein[i] = amino acid letter
  const codons = [];                     // codons[i] = the mRNA triplet, e.g. 'ATG'
  const codonToPositions = [];           // codonToPositions[i] = [g0,g1,g2]
  const posToCodon = new Map();          // genomicPos -> {codon, frame}
  for (let i = 0; i + 2 < mrna.length; i += 3){
    const codon = mrna.slice(i, i + 3);
    const aa = translate(codon);
    const ci = protein.length;
    protein.push(aa);
    codons.push(codon);
    const trip = [mrnaPos[i], mrnaPos[i + 1], mrnaPos[i + 2]];
    codonToPositions.push(trip);
    trip.forEach((g, f) => posToCodon.set(g, { codon: ci, frame: f }));
    if (aa === '*') break;               // stop translation at first stop codon
  }

  const result = { protein, codons, codonToPositions, posToCodon };
  translationCache.set(tx.id, result);
  return result;
}
