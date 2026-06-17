#!/usr/bin/env python3
"""Build the non-coding-RNA info cache (the ncRNA equivalent of the protein
summaries), shipped as a STATIC json the client loads directly — no backend.

Two stages:

  python build_rna_info.py targets
      Collect every non-coding gene on chr21 (both assemblies). For NAMED
      ncRNAs (miRNAs, snoRNAs, lncRNAs, antisense, …) fetch grounding from NCBI
      Gene (the curated description + RefSeq/Alliance summary). The predicted
      LOC###### tail is NOT fetched — it has no curated function and gets an
      honest templated note at bake time. Writes rna_targets.json.

  # ... Claude Code then writes Plain + Expert summaries for the named set,
  #     grounded in that text + well-established knowledge (hedged, and saying
  #     "uncharacterized" when unsure), into .rna_batches/out_*.json ...

  python build_rna_info.py bake
      Merge the generated summaries with honest templated notes for the LOC tail
      and any named ncRNA left ungenerated, and write data/rna_info.json
      ({ SYMBOL: {simple, technical, source} }) — keyed by gene symbol so the
      browser can look it up directly.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
GENE_FILES = [HERE / "data/t2t/chr21.genes.json", HERE / "data/hg38/chr21.genes.json"]
TARGETS_FILE = HERE / "rna_targets.json"
BATCH_DIR = HERE / ".rna_batches"
OUT_FILE = HERE / "data/rna_info.json"
EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
TOOL = "GenomeEarth"
THROTTLE = 0.36                  # >= 1/3 s between calls: stay under NCBI's 3 req/s anon limit

_last = [0.0]


def _get_json(url):
    # sequential throttle so we never exceed NCBI's anonymous rate limit (the
    # reason a naive concurrent fetch silently 429s and looks like "no data").
    dt = time.monotonic() - _last[0]
    if dt < THROTTLE:
        time.sleep(THROTTLE - dt)
    _last[0] = time.monotonic()
    req = urllib.request.Request(url + f"&tool={TOOL}",
                                 headers={"User-Agent": "GenomeEarth-rna/1.0"})
    return json.loads(urllib.request.urlopen(req, timeout=45).read())


def fetch_ncbi(symbol):
    """Return {description, summary} from NCBI Gene, or empties on miss. Retries."""
    for attempt in range(4):
        try:
            es = _get_json(f"{EUTILS}/esearch.fcgi?db=gene&retmode=json&term="
                           + urllib.parse.quote(f"{symbol}[sym] AND Homo sapiens[orgn]"))
            ids = es.get("esearchresult", {}).get("idlist", [])
            if not ids:
                return {"description": "", "summary": ""}
            su = _get_json(f"{EUTILS}/esummary.fcgi?db=gene&retmode=json&id={ids[0]}")
            d = su["result"][ids[0]]
            return {"description": d.get("description", ""), "summary": (d.get("summary") or "").strip()}
        except Exception:
            time.sleep(0.8 * (attempt + 1))      # back off on 429 / transient error
    return {"description": "", "summary": "", "error": "fetch failed"}


def collect_symbols():
    syms = set()
    for f in GENE_FILES:
        for g in json.loads(f.read_text(encoding="utf-8")):
            if not g.get("coding"):
                syms.add(g["symbol"])
    return sorted(syms)


def cmd_targets():
    syms = collect_symbols()
    named = [s for s in syms if not s.startswith("LOC")]
    loc = [s for s in syms if s.startswith("LOC")]
    print(f"{len(syms)} non-coding genes: {len(named)} named (fetch NCBI grounding), "
          f"{len(loc)} LOC predicted (templated). Fetching...", flush=True)

    grounded, with_summary, with_desc = [], 0, 0
    for done, s in enumerate(named, 1):
        ann = fetch_ncbi(s)
        if ann.get("summary"):
            with_summary += 1
        if ann.get("description"):
            with_desc += 1
        grounded.append({"symbol": s, "kind": "named",
                         "description": ann.get("description", ""),
                         "summary": ann.get("summary", "")})
        if done % 25 == 0 or done == len(named):
            print(f"  ncbi {done}/{len(named)}  (desc: {with_desc}, curated summary: {with_summary})", flush=True)

    grounded.sort(key=lambda t: t["symbol"])
    targets = {"named": grounded, "loc": sorted(loc)}
    TARGETS_FILE.write_text(json.dumps(targets, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nwrote {TARGETS_FILE.name}: {len(grounded)} named "
          f"({with_summary} with a curated NCBI summary), {len(loc)} LOC predicted loci", flush=True)


def cmd_bake():
    targets = json.loads(TARGETS_FILE.read_text(encoding="utf-8"))
    info = {}

    # 1) generated summaries for the named set
    generated = {}
    if BATCH_DIR.exists():
        for f in sorted(BATCH_DIR.glob("out_*.json")):
            for r in json.loads(f.read_text(encoding="utf-8")):
                sym = (r.get("symbol") or "").strip()
                if sym and r.get("simple") and r.get("technical"):
                    generated[sym.upper()] = {"simple": r["simple"].strip(),
                                              "technical": r["technical"].strip(),
                                              "source": "claude-code (NCBI/established, hedged)"}
    info.update(generated)

    # 2) honest note for any named ncRNA that wasn't generated
    for t in targets.get("named", []):
        key = t["symbol"].upper()
        if key in info:
            continue
        desc = t.get("description") or t["symbol"]
        info[key] = {
            "simple": f"{t['symbol']} ({desc}) is a non-coding RNA. Its specific biological "
                      "role is not well established in the current literature.",
            "technical": f"{t['symbol']} ({desc}) is annotated as a non-coding RNA with no "
                         "curated functional summary in NCBI Gene/Alliance. No molecular "
                         "function, mechanism, or disease association can be reliably stated.",
            "source": "no curated annotation",
        }

    # 3) templated note for the predicted LOC tail
    for sym in targets.get("loc", []):
        key = sym.upper()
        if key in info:
            continue
        info[key] = {
            "simple": f"{sym} is a predicted (computationally annotated) gene locus. Little is "
                      "established about whether it produces a functional RNA, and it has no "
                      "curated functional characterization.",
            "technical": f"{sym} is a predicted, uncharacterized locus (RefSeq model prediction) "
                         "with no curated functional annotation. Any function is unknown.",
            "source": "predicted locus",
        }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(info, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_gen = sum(1 for v in info.values() if v["source"].startswith("claude"))
    print(f"wrote {OUT_FILE.relative_to(HERE)}: {len(info)} ncRNAs "
          f"({n_gen} with generated summaries, {len(info) - n_gen} honest notes)", flush=True)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "targets":
        cmd_targets()
    elif cmd == "bake":
        cmd_bake()
    else:
        sys.exit("usage: python build_rna_info.py [targets|bake]")
