#!/usr/bin/env python3
"""Build the protein-summary cache WITHOUT calling the Anthropic API.

Two stages, run as subcommands:

  python build_protein_info.py targets
      Collect every coding gene on chr21 (both assemblies), resolve its UniProt
      accession exactly as the browser client does (so Mongo keys match), and
      fetch the UniProt FUNCTION / DISEASE annotation as grounding text. Writes
      protein_targets.json — the work list for the generation step.

  # ... Claude Code then writes the Plain + Expert summaries grounded in that
  #     annotation into protein_summaries.json (no Anthropic API involved) ...

  python build_protein_info.py push
      Upsert protein_summaries.json into MongoDB Atlas using the same _id scheme
      the Vercel function uses (accession uppercased, else SYMBOL uppercased), so
      live visitors get cache hits. Reads the connection string from the
      MONGODB_URI environment variable.

Both stages are idempotent. The summaries are authored by Claude Code, grounded
in the fetched UniProt annotation — the Anthropic API key is never used.
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
GENE_FILES = [HERE / "data/t2t/chr21.genes.json", HERE / "data/hg38/chr21.genes.json"]
TARGETS_FILE = HERE / "protein_targets.json"
SUMMARIES_FILE = HERE / "protein_summaries.json"
WORKERS = 6

# Same curated map the client uses (js/protein.js) so resolved accessions match.
CURATED = {
    "SOD1": "P00441", "APP": "P05067", "DYRK1A": "Q13627", "RUNX1": "Q01196",
    "JAM2": "P57087", "NCAM2": "O15394", "ATP5PF": "P18859", "DSCAM": "O60469",
    "CBS": "P35520",
}
MODEL_TAG = "claude-opus-4-8 (Claude Code, UniProt-grounded)"
_CTX = ssl._create_unverified_context()


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "GenomeEarth-build/1.0"})
    try:
        return urllib.request.urlopen(req, timeout=60).read()
    except ssl.SSLError:
        return urllib.request.urlopen(req, timeout=60, context=_CTX).read()


def _get_json(url: str):
    return json.loads(_get(url))


# ---------------------------------------------------------------------------
# stage 1: targets
# ---------------------------------------------------------------------------
def resolve_uniprot(symbol: str):
    if symbol.upper() in CURATED:
        return CURATED[symbol.upper()]
    url = ("https://rest.uniprot.org/uniprotkb/search?query=gene_exact:"
           + urllib.parse.quote(symbol)
           + "+AND+organism_id:9606+AND+reviewed:true&fields=accession&format=json&size=1")
    try:
        r = (_get_json(url).get("results") or [])
        return r[0]["primaryAccession"] if r else None
    except Exception:
        return None


def _texts(comments, ctype):
    out = []
    for c in comments or []:
        if c.get("commentType") != ctype:
            continue
        for t in c.get("texts") or []:
            if t.get("value"):
                out.append(t["value"])
        if ctype == "DISEASE" and c.get("disease", {}).get("description"):
            out.append(c["disease"]["description"])
    return " ".join(out)


def fetch_annotation(acc: str):
    """Return {name, function, disease} from the UniProt entry (grounding text)."""
    url = (f"https://rest.uniprot.org/uniprotkb/{urllib.parse.quote(acc)}"
           "?fields=protein_name,cc_function,cc_disease&format=json")
    try:
        d = _get_json(url)
        name = (d.get("proteinDescription", {})
                 .get("recommendedName", {})
                 .get("fullName", {})
                 .get("value", ""))
        comments = d.get("comments")
        return {"name": name, "function": _texts(comments, "FUNCTION"),
                "disease": _texts(comments, "DISEASE")}
    except Exception as e:
        return {"name": "", "function": "", "disease": "", "error": str(e)}


def cmd_targets():
    syms = set()
    for f in GENE_FILES:
        for g in json.loads(f.read_text(encoding="utf-8")):
            if g.get("coding"):
                syms.add(g["symbol"])
    syms = sorted(syms)
    print(f"{len(syms)} unique coding genes; resolving UniProt accessions...", flush=True)

    acc_to_sym, unresolved = {}, []
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(resolve_uniprot, s): s for s in syms}
        for fut in as_completed(futs):
            acc = fut.result()
            (acc_to_sym.setdefault(acc, futs[fut]) if acc else unresolved.append(futs[fut]))
    print(f"resolved {len(acc_to_sym)} unique proteins; {len(unresolved)} unresolved. "
          "Fetching UniProt annotations...", flush=True)

    targets, done = [], 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(fetch_annotation, acc): (acc, sym) for acc, sym in acc_to_sym.items()}
        for fut in as_completed(futs):
            acc, sym = futs[fut]
            ann = fut.result()
            targets.append({"symbol": sym, "accession": acc, **ann})
            done += 1
            if done % 25 == 0 or done == len(futs):
                print(f"  annotations {done}/{len(futs)}", flush=True)

    for sym in sorted(unresolved):
        targets.append({"symbol": sym, "accession": None, "name": "",
                        "function": "", "disease": ""})
    targets.sort(key=lambda t: t["symbol"])
    TARGETS_FILE.write_text(json.dumps(targets, indent=2, ensure_ascii=False), encoding="utf-8")
    n_anno = sum(1 for t in targets if t.get("function"))
    print(f"\nwrote {TARGETS_FILE.name}: {len(targets)} targets "
          f"({n_anno} with a UniProt function annotation, "
          f"{len(unresolved)} unresolved/no reviewed entry)", flush=True)


# ---------------------------------------------------------------------------
# stage 2: push
# ---------------------------------------------------------------------------
def cmd_push():
    try:
        from pymongo import MongoClient
    except ImportError:
        sys.exit("pymongo not installed.  Run:  pip install \"pymongo[srv]\"")

    uri = os.environ.get("MONGODB_URI")
    if not uri:
        sys.exit("Set the MONGODB_URI environment variable to your Atlas connection string.")
    if not SUMMARIES_FILE.exists():
        sys.exit(f"{SUMMARIES_FILE.name} not found — generate summaries first.")

    rows = json.loads(SUMMARIES_FILE.read_text(encoding="utf-8"))
    col = MongoClient(uri).get_database("genome_earth").get_collection("protein_info")

    upserts = skipped = 0
    for r in rows:
        acc = (r.get("accession") or "").strip().upper()
        sym = (r.get("symbol") or "").strip()
        key = acc or sym.upper()
        simple = (r.get("simple") or "").strip()
        technical = (r.get("technical") or "").strip()
        if not key or not simple or not technical:
            skipped += 1
            continue
        col.update_one(
            {"_id": key},
            {"$set": {"_id": key, "symbol": sym, "accession": acc,
                      "simple": simple, "technical": technical, "model": MODEL_TAG}},
            upsert=True,
        )
        upserts += 1
    print(f"pushed {upserts} protein summaries to MongoDB (genome_earth.protein_info); "
          f"skipped {skipped} incomplete row(s).", flush=True)
    print(f"collection now holds {col.count_documents({})} documents.", flush=True)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "targets":
        cmd_targets()
    elif cmd == "push":
        cmd_push()
    else:
        sys.exit("usage: python build_protein_info.py [targets|push]")
