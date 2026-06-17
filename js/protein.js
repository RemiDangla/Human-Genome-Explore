// protein.js — the "street view": a 3Dmol.js panel that shows the folded
// protein (AlphaFold model) for a gene, and highlights the residues whose codons
// are currently visible in the genome viewer. Residue number = codon index + 1
// (both start at the initiator Met).
//
// UniProt + AlphaFold are fetched directly from the browser (both send CORS
// headers), so this works on a pure static host with no backend. Only the AI
// summary needs a server (window.GENOME_CONFIG.summaryApi).

const $3Dmol = window.$3Dmol;

// Curated gene-symbol -> UniProt for the demo genes (instant, offline-safe);
// anything else is resolved live via the UniProt REST API.
const CURATED_UNIPROT = {
  SOD1: 'P00441', APP: 'P05067', DYRK1A: 'Q13627', RUNX1: 'Q01196',
  JAM2: 'P57087', NCAM2: 'O15394', ATP5PF: 'P18859', DSCAM: 'O60469', CBS: 'P35520',
};

async function resolveUniProt(symbol){
  const c = CURATED_UNIPROT[symbol.toUpperCase()];
  if (c) return c;
  const url = 'https://rest.uniprot.org/uniprotkb/search?query=gene_exact:'
    + encodeURIComponent(symbol) + '+AND+organism_id:9606+AND+reviewed:true'
    + '&fields=accession&format=json&size=1';
  const d = await (await fetch(url)).json();
  if (d.results && d.results[0]) return d.results[0].primaryAccession;
  throw new Error('no reviewed UniProt entry for ' + symbol);
}

async function fetchAlphaFoldPdb(acc){
  const meta = await (await fetch('https://alphafold.ebi.ac.uk/api/prediction/' + acc)).json();
  if (!meta[0] || !meta[0].pdbUrl) throw new Error('no AlphaFold model for ' + acc);
  return await (await fetch(meta[0].pdbUrl)).text();
}

export class ProteinViewer {
  constructor({ panel, viewport, title, status, closeBtn, spinBtn, infoText, infoToggle, infoModeEl, infoHead }){
    this.panel = panel; this.viewport = viewport;
    this.title = title; this.status = status; this.spinBtn = spinBtn;
    this.infoText = infoText; this.infoToggle = infoToggle; this.infoModeEl = infoModeEl;
    this.infoHead = infoHead;
    this.viewer = null;
    this.open = false; this.loaded = false; this.pending = null;
    this.spinning = true; this.infoLoadedFor = null;
    this.infoMode = 'simple'; this.infoData = null;   // 'simple' (Plain) | 'technical' (Expert)
    this.symbol = null; this.accession = null; this.resCount = 0;
    closeBtn.addEventListener('click', () => this.close());
    if (spinBtn) spinBtn.addEventListener('click', () => this.toggleSpin());
    // info elements are shared with the RNA viewer; only act when NOT in RNA mode
    if (infoToggle) infoToggle.addEventListener('click', () => {
      if (!this.panel.classList.contains('rna-mode')) this.toggleInfo();
    });
    if (infoModeEl) infoModeEl.addEventListener('click', (e) => {
      if (this.panel.classList.contains('rna-mode')) return;
      const btn = e.target.closest('button[data-mode]');
      if (btn) this.setInfoMode(btn.dataset.mode);
    });
  }

  setInfoMode(mode){
    this.infoMode = mode;
    if (this.infoModeEl) for (const b of this.infoModeEl.querySelectorAll('button'))
      b.classList.toggle('active', b.dataset.mode === mode);
    if (this.infoData) this.infoText.textContent = this.infoData[mode] || this.infoData.technical || this.infoData.simple || '';
  }

  toggleInfo(){
    const open = this.panel.classList.toggle('info-open');
    if (this.infoToggle) this.infoToggle.classList.toggle('active', open);
    if (open) this.loadInfo();
  }

  // Fetch (and cache server-side) a short AI summary of the protein's role.
  async loadInfo(){
    if (!this.symbol) return;
    const want = this.accession || this.symbol;
    if (this.infoLoadedFor === want) return;     // already shown for this protein
    this.infoLoadedFor = want;
    this.infoData = null;
    const base = window.GENOME_CONFIG && window.GENOME_CONFIG.summaryApi;
    if (!base){     // static deployment with no backend — summaries need a server-side key
      this.infoText.textContent = 'AI summaries aren’t available in this deployment — they need a server holding an Anthropic API key.';
      this.infoLoadedFor = null;
      return;
    }
    this.infoText.textContent = 'Generating summaries…';
    try {
      const r = await fetch(`${base}/protein-info?symbol=${encodeURIComponent(this.symbol)}`
                            + `&uniprot=${encodeURIComponent(this.accession || '')}`);
      const j = await r.json();
      if (j.simple || j.technical || j.summary){
        this.infoData = { simple: j.simple || j.summary || '', technical: j.technical || j.summary || '' };
        this.setInfoMode(this.infoMode);          // render the current tier
      } else {
        this.infoText.textContent = j.message || j.error || 'No summary available.'; this.infoLoadedFor = null;
      }
    } catch (e){
      this.infoText.textContent = 'Summary unavailable (no backend reachable).'; this.infoLoadedFor = null;
    }
  }

  toggleSpin(){
    if (!this.viewer) return;
    this.spinning = !this.spinning;
    this.viewer.spin(this.spinning ? 'y' : false, 0.5);
    this._updateSpinBtn();
  }

  _updateSpinBtn(){
    if (!this.spinBtn) return;
    this.spinBtn.textContent = this.spinning ? '⏸' : '▶';
    this.spinBtn.title = this.spinning ? 'Pause rotation' : 'Resume rotation';
  }

  get isOpen(){ return this.open; }

  async show(symbol){
    this.open = true; this.loaded = false; this.pending = null;
    this.panel.classList.remove('hidden', 'rna-mode');   // leaving any RNA-mode view
    document.body.classList.add('pp-open');
    this.symbol = symbol;
    this.title.textContent = symbol;
    if (this.infoHead) this.infoHead.textContent = 'Protein role';
    this.status.textContent = 'resolving UniProt…';

    if (!this.viewer){
      this.viewer = $3Dmol.createViewer(this.viewport, { backgroundColor: '#0c1016' });
    }
    this.viewer.removeAllModels();
    this.viewer.render();

    try {
      const acc = await resolveUniProt(symbol);
      if (this.symbol !== symbol) return;          // superseded by a later click
      this.accession = acc;
      this.title.textContent = `${symbol} · ${acc}`;
      this.status.textContent = 'loading AlphaFold model…';
      // if the info panel is open, refresh its summary for this new protein
      this.infoLoadedFor = null;
      if (this.panel.classList.contains('info-open')) this.loadInfo();

      const pdb = await fetchAlphaFoldPdb(acc);
      // a late click on another gene may have superseded this load
      if (this.symbol !== symbol) return;

      this.viewer.removeAllModels();
      this.viewer.addModel(pdb, 'pdb');
      this.viewer.setStyle({}, { cartoon: { color: 0x39424f } });
      this.viewer.zoomTo();
      this.viewer.render();
      this.viewer.spin(this.spinning ? 'y' : false, 0.5);   // gentle auto-rotate (toggle in header)
      this._updateSpinBtn();
      this.resCount = this.viewer.getModel().selectedAtoms({ atom: 'CA' }).length;
      this.title.textContent = `${symbol} · ${acc} · ${this.resCount} aa`;
      this.status.textContent = 'AlphaFold predicted model · drag to rotate, scroll to zoom';
      this.loaded = true;
      if (this.pending){ this.setHighlight(this.pending.items); this.setStatus(this.pending.status); this.pending = null; }
    } catch (e){
      this.loaded = false;
      this.status.textContent = '⚠ ' + e.message;
    }
  }

  // items: [{ resi, color }] — colour the visible residues, grey out the rest.
  setHighlight(items){
    if (!this.viewer || !this.loaded){ this.pending = { items, status: this.pending?.status }; return; }
    this.viewer.setStyle({}, { cartoon: { color: 0x2c3543 } });   // dim base
    const byColor = {};
    for (const { resi, color } of items) (byColor[color] ||= []).push(resi);
    for (const color in byColor){
      this.viewer.setStyle({ resi: byColor[color] }, { cartoon: { color: parseInt(color.slice(1), 16) } });
    }
    this.viewer.render();
  }

  setStatus(text){
    if (!text) return;
    if (this.loaded) this.status.textContent = text;
    else if (this.pending) this.pending.status = text;
  }

  close(){
    this.open = false;
    if (this.viewer) this.viewer.spin(false);   // stop animating while hidden
    this.panel.classList.add('hidden');
    document.body.classList.remove('pp-open');
  }
}
