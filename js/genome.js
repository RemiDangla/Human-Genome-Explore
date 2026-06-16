// genome.js — pure genomics logic: genetic code, complementation, feature
// classification, and the colour palettes. No rendering, no DOM, no network.

// --- Standard genetic code (NCBI transl_table=1) -------------------------
export const CODON_TABLE = {
  TTT:'F',TTC:'F',TTA:'L',TTG:'L', CTT:'L',CTC:'L',CTA:'L',CTG:'L',
  ATT:'I',ATC:'I',ATA:'I',ATG:'M', GTT:'V',GTC:'V',GTA:'V',GTG:'V',
  TCT:'S',TCC:'S',TCA:'S',TCG:'S', CCT:'P',CCC:'P',CCA:'P',CCG:'P',
  ACT:'T',ACC:'T',ACA:'T',ACG:'T', GCT:'A',GCC:'A',GCA:'A',GCG:'A',
  TAT:'Y',TAC:'Y',TAA:'*',TAG:'*', CAT:'H',CAC:'H',CAA:'Q',CAG:'Q',
  AAT:'N',AAC:'N',AAA:'K',AAG:'K', GAT:'D',GAC:'D',GAA:'E',GAG:'E',
  TGT:'C',TGC:'C',TGA:'*',TGG:'W', CGT:'R',CGC:'R',CGA:'R',CGG:'R',
  AGT:'S',AGC:'S',AGA:'R',AGG:'R', GGT:'G',GGC:'G',GGA:'G',GGG:'G',
};

export const AA_3LETTER = {
  A:'Ala',R:'Arg',N:'Asn',D:'Asp',C:'Cys',E:'Glu',Q:'Gln',G:'Gly',
  H:'His',I:'Ile',L:'Leu',K:'Lys',M:'Met',F:'Phe',P:'Pro',S:'Ser',
  T:'Thr',W:'Trp',Y:'Tyr',V:'Val','*':'Stop',
};

export const AA_NAME = {
  A:'Alanine',R:'Arginine',N:'Asparagine',D:'Aspartate',C:'Cysteine',
  E:'Glutamate',Q:'Glutamine',G:'Glycine',H:'Histidine',I:'Isoleucine',
  L:'Leucine',K:'Lysine',M:'Methionine',F:'Phenylalanine',P:'Proline',
  S:'Serine',T:'Threonine',W:'Tryptophan',Y:'Tyrosine',V:'Valine','*':'Stop',
};

// Side-chain property classes (used for amino-acid colouring).
const AA_CLASS = {
  A:'hydrophobic',V:'hydrophobic',L:'hydrophobic',I:'hydrophobic',
  M:'hydrophobic',F:'hydrophobic',W:'hydrophobic',
  S:'polar',T:'polar',N:'polar',Q:'polar',Y:'polar',
  D:'acidic',E:'acidic',
  K:'basic',R:'basic',H:'basic',
  G:'special',P:'special',C:'special',
  '*':'stop',
};

export const AA_CLASS_COLOR = {
  hydrophobic:'#f0b54a', polar:'#74cc8a', acidic:'#ff6b6b',
  basic:'#5da9ff', special:'#c792ea', stop:'#555b66',
};

export function aaColor(aa){ return AA_CLASS_COLOR[AA_CLASS[aa] || 'special']; }

// --- Nucleotides ---------------------------------------------------------
export const BASE_COLOR = { A:'#3ddc84', T:'#ff5c5c', G:'#ffb13d', C:'#4d9dff' };
const COMPLEMENT = { A:'T', T:'A', G:'C', C:'G', N:'N', a:'t', t:'a', g:'c', c:'g', n:'n' };

export function complement(b){ return COMPLEMENT[b] || 'N'; }
export function reverseComplement(seq){
  let out = '';
  for (let i = seq.length - 1; i >= 0; i--) out += complement(seq[i]);
  return out;
}
export function translate(codon){ return CODON_TABLE[codon.toUpperCase()] || 'X'; }
export function isRepeat(base){ return base >= 'a' && base <= 'z'; } // soft-mask = lowercase

// --- Cytogenetic band stain → colour ------------------------------------
export const STAIN_COLOR = {
  gneg:'#e9edf2', gpos25:'#c6cdd6', gpos50:'#969fab', gpos75:'#5f6873',
  gpos100:'#2b3038', acen:'#c0392b', gvar:'#8fb8d8', stalk:'#5fb3a3',
};
export function stainColor(s){ return STAIN_COLOR[s] || '#aab2bd'; }

// --- Feature styling -----------------------------------------------------
// Class names map to colours used both for nucleotide backgrounds and helix tint.
export const FEATURE_COLOR = {
  cds:      '#ffd54a', // coding exon — the protein-coding payload
  utr5:     '#56c2c2', // 5' untranslated
  utr3:     '#3a8f8f', // 3' untranslated
  exon_nc:  '#9b8cff', // exon of a non-coding transcript
  intron:   '#3b4250', // spliced out
  intergenic:'#262b34',// between genes
};

// Build a function pos -> feature class for the active transcript.
// Everything outside the transcript is "intergenic"; inside but between
// exons is "intron"; inside an exon it is cds / utr5 / utr3 (coding tx) or
// exon_nc (non-coding tx). Strand decides which UTR is 5' vs 3'.
export function makeFeatureClassifier(tx){
  if (!tx) return () => 'intergenic';
  const { txStart, txEnd, cdsStart, cdsEnd, coding, exons, strand } = tx;
  return (pos) => {
    if (pos < txStart || pos >= txEnd) return 'intergenic';
    let inExon = false;
    for (const [s, e] of exons){ if (pos >= s && pos < e){ inExon = true; break; } }
    if (!inExon) return 'intron';
    if (!coding) return 'exon_nc';
    if (pos >= cdsStart && pos < cdsEnd) return 'cds';
    // UTR: which end depends on strand
    const isUpstream = pos < cdsStart; // genomically left of CDS
    if (strand === '+') return isUpstream ? 'utr5' : 'utr3';
    return isUpstream ? 'utr3' : 'utr5';
  };
}

// --- Coordinate formatting ----------------------------------------------
export function fmtBp(n){
  n = Math.round(n);
  if (n >= 1e6) return (n/1e6).toFixed(2) + ' Mb';
  if (n >= 1e3) return (n/1e3).toFixed(1) + ' kb';
  return n + ' bp';
}
export function fmtPos(n){ return Math.round(n).toLocaleString('en-US'); }
