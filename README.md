# Genome Earth — a "Google Earth" of the human genome (hg38, chr21)

A proof-of-concept genome browser that lets you zoom continuously from a whole
chromosome down to individual base pairs and their amino-acid translation, the
way Google Earth zooms from orbit to a street sign. Built with **Three.js**
(the 3-D double helix) and **GSAP** (the fly-to camera moves).

This first run uses **human chromosome 21** of the **hg38 / GRCh38** assembly,
with all data downloaded and pre-processed locally — no runtime network calls
to external services.

## The zoom ladder (levels of detail)

| Zoom tier | Visible span | What you see |
|-----------|--------------|--------------|
| **Chromosome** | > ~2 Mb | A 3-D **chromatin globule** — the whole chromosome drawn as a seeded, self-confining random walk tangled into a ball (a nod to the *fractal-globule* model of chromosome territories), lit and coloured by **Giemsa cytogenetic bands**. The ball **rotates so the current locus faces you** (with a glowing marker + the visible window lit bright), so panning "travels" along the folded DNA. **Zooming dives the camera into the ball toward that locus** — the tangle magnifies about your region of interest and then dissolves into the linear strand. |
| **Locus / Region** | ~2 Mb – 9 kb | **Gene models**: transcripts stacked in rows (each labelled with its RefSeq accession, since one gene has several isoforms), thick boxes = coding exons (CDS), thin boxes = UTRs, lines = introns, little arrows = strand. The cytoband ribbon tapers from the big coil to a thin waving **chromosome strand** that persists continuously until the helix takes over. |
| **Gene structure** | ~30 kb – 200 bp | The real **B-DNA double helix** (10.5 bp/turn) resolves out of the ribbon, tinted by feature (CDS / UTR / intron). Only the **active transcript** is shown (no isoform clutter). |
| **Sequence** | < ~150 bp | The helix **unwinds into a straight ladder** and actual **A/C/G/T** letters appear on both strands, each column shaded by its feature; soft-masked repeats are dimmed. |
| **Codons** | < ~90 bp | The **amino-acid translation track** appears alongside the coding strand — **above** the (+) strand for a +strand gene, **below** the (−) strand for a −strand gene — one chip per codon showing the translated triplet over the amino acid, coloured by side-chain class, in the correct reading frame and strand. |

Everything shares one projection (`bp → screen-x`), so the helix lines and the
nucleotide letters stay pixel-aligned at every zoom level.

### The chromosome overview — a condensed-chromosome coil

The zoomed-out view is a **condensed-chromosome coil**: a variable-pitch double
strand wound along the chromosome axis, with a **centromere waist** (radius dips
at the `acen` band). A **focus+context lens** at your view position both
*unwinds* the helix locally (turn-rate → 0) and *magnifies* it (fisheye), so the
region of interest stretches toward a straight strand while the rest stays a
tightly-packed condensed coil squeezed to the screen edges. The focus strength
is ~0 fully zoomed out (uniform condensed rod) and ramps up as you zoom in, until
the unwound strand hands off to the nucleotide double helix — one continuous
structure from condensed chromosome to base pairs.

### Two assemblies (A/B)

The **assembly** button in the top bar switches chr21 between **hg38** and
**T2T-CHM13 v2.0** (UCSC `hs1`, the complete telomere-to-telomere genome).
Coordinates differ between the two, so switching resets the view to the whole
chromosome. The striking difference: hg38's chr21 short arm is a ~5 Mb `N` gap,
while T2T fills it with real sequence (telomere repeats, rDNA, satellites,
centromere) — zoom into the p-arm in each to compare. Datasets live under
`data/hg38/` and `data/t2t/`; built by `preprocess.py` and `preprocess_t2t.py`.

### Finding genes

Start typing a gene name in the search box and a **type-ahead list** appears
(matching symbols, each tagged with its chromosome, e.g. `SOD1  chr21`); pick one
with the mouse or ↑/↓ + Enter to fly there. You can also type a coordinate
(`chr21:31,659,769`) or use the preset chips.

### Protein "street view" 🧬→🧊

**Double-click a coding gene** to open a 3-D protein panel (bottom-right) showing
its **AlphaFold-predicted fold**. The residues whose codons are currently visible
in the genome view are **highlighted in the fold using the same amino-acid-class
colours** as the chips; the rest of the chain is dimmed grey. As you pan along the
gene, the highlighted stretch moves along the structure — a "street view" linked
to the genomic "map". Drag to rotate, scroll to zoom the structure.

- Gene symbol → UniProt accession and UniProt → AlphaFold model are both resolved
  through the local server (`/api/uniprot`, `/api/structure`), which caches the
  PDB to `data/structures/` so repeat views are offline.
- Residue *n* in the fold = codon *n* in the genome view (both start at the
  initiator Met). **Caveat:** this assumes the displayed RefSeq transcript matches
  the canonical UniProt isoform AlphaFold modelled. For genes with multiple
  isoforms of different lengths the numbering can be offset.

#### Protein role summary (Claude, optional)

The **ℹ** button in the protein panel opens a collapsible panel to the left of the
3-D fold with a short, plain-language summary of the protein's **role** (function,
localisation, disease relevance). It's **generated on demand by the Claude API**
(`claude-opus-4-8`) the first time a given protein is viewed, then cached to
`data/protein_info.json` for instant future lookups.

- Requires an **`ANTHROPIC_API_KEY`** in the server's environment. Without it, the
  panel shows a friendly "set the key" message and everything else still works.
- The summary is **AI-generated** — clearly labelled as such in the panel, with a
  "verify against primary sources" note. The model is instructed to stick to
  established knowledge and not fabricate statistics or citations, but treat it as
  a starting point, not a citable source.

## Running it

```powershell
# 1. (only once) download + preprocess the chr21 data — see "Data" below
python preprocess.py

# 2. start the local server (serves files + supports HTTP byte-range requests)
python server.py 8000

# 3. open the app
#    http://localhost:8000/
```

### Controls
- **scroll** — zoom in/out (toward the cursor)
- **drag** — pan
- **click the ideogram** (top strip) — jump anywhere on the chromosome
- **search box** — a gene symbol (`SOD1`, `APP`, `DYRK1A`, `RUNX1`) or a
  coordinate (`chr21:31,659,769` or `chr21:31650000-31700000`)
- **double-click** a coding gene — open its folded protein (street view)
- **deep links** — `index.html#SOD1` or `index.html#chr21:31659775` open
  straight at that locus (shareable URLs)

## How it works

### Data is streamed like map tiles
`preprocess.py` strips the chr21 FASTA to **one byte per base, no newlines**
(`data/chr21.seq`). Because of that, a genomic coordinate *is* a byte offset, so
the browser fetches a window with a single HTTP range request:

```
Range: bytes=31659769-31659799   ->   ATGGCGACGAAGGCCGTGTGCGTGCTGAAGG
```

`server.py` is a ~70-line static server that honours those range requests, so
the 46.7 MB chromosome is never fully downloaded — only the few hundred bases
on screen.

### Files
```
preprocess.py        FASTA + cytoBand + refGene  ->  compact app data
server.py            static server with byte-range support
index.html           layout, HUD, legend, import map
css/style.css        dark theme
js/genome.js         genetic code, complement, feature classifier, palettes
js/data.js           range-fetch + cache, per-transcript splice & translate
js/helix.js          Three.js: cytoband ribbon + B-DNA double helix
js/overlay.js        Canvas2D: ideogram, ruler, gene track, bases, codons
js/protein.js        3Dmol.js protein "street view" + residue highlighting
js/main.js           zoom state, tier crossfades, GSAP fly-to, input, dbl-click
data/                generated: chr21.seq, chr21.meta.json, chr21.genes.json
data/structures/     cached AlphaFold PDBs (downloaded on demand)
data/protein_info.json  cached Claude-generated protein-role summaries
data/raw/            downloaded UCSC source files (gz)
js/vendor/           three.module.js, gsap.min.js, 3Dmol-min.js (offline-safe)
```

## Data sources (UCSC Genome Browser, hg38)
- Sequence: `goldenPath/hg38/chromosomes/chr21.fa.gz` (soft-masked; lowercase = RepeatMasker/TRF repeat, `N` = assembly gap)
- Cytogenetic bands: `goldenPath/hg38/database/cytoBand.txt.gz`
- Gene models: `goldenPath/hg38/database/refGene.txt.gz` (RefSeq, genePred format)
- Protein structures: **AlphaFold DB** (`alphafold.ebi.ac.uk`), resolved via UniProt (`rest.uniprot.org`)
- Protein-role summaries: **Claude API** (`claude-opus-4-8`), on demand, cached locally

Coordinates follow the UCSC convention: **0-based, half-open** `[start, end)`.

## Scientific notes / honest caveats
- **Translation** uses the standard genetic code (NCBI `transl_table=1`). The
  CDS is spliced in transcript order and reverse-complemented for `−`-strand
  genes before translation; it stops at the first stop codon. Verified against
  **SOD1** (`NM_000454`, +): the track reads `M-A-T-K-A-V-C-V-L-K-…`, matching
  UniProt **P00441**.
- **Helix geometry** uses the canonical **B-DNA pitch of 10.5 bp per turn**. The
  two strands are drawn antiparallel and offset by π — a faithful but
  *stylised* model (real major/minor grooves are not equal-width).
- **The coiled "wrapped" overview is artistic license.** Interphase chromosomes
  are diffuse chromatin territories, not condensed coiled bodies; the coil is a
  visual metaphor, not a structural claim.
- Only the **chr21 RefSeq** transcript set is loaded; this is not a complete
  annotation (no GENCODE alternative isoforms, no variants, no regulatory
  features). It is a proof of concept, not a production browser.

## Possible next steps
- Live UCSC/Ensembl fetching for all 24 chromosomes (the data layer is already
  isolated in `js/data.js`).
- Protein/structure view (the "amino-acids into proteins" idea set aside for v1).
- Variant tracks (ClinVar/dbSNP), conservation, GC content.
- True 3-D fly-through of the helix with a perspective camera.
