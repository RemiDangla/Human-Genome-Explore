#!/usr/bin/env python3
"""Build the T2T-CHM13 v2.0 (UCSC 'hs1') chr21 dataset, mirroring the layout
that preprocess.py produces for hg38 — so the viewer can A/B the two assemblies.

Sources (no special binaries needed):
  - Sequence : UCSC REST API  getData/sequence?genome=hs1;chrom=chr21  (5 Mb chunks)
  - Cytobands: UCSC REST API  getData/track?genome=hs1;track=cytoBand
  - Genes    : data/raw_t2t/hs1.ncbiRefSeq.gp.gz  (genePred, NO bin column)

Output (data/t2t/):
  chr21.seq, chr21.meta.json, chr21.genes.json   (same formats as hg38)
"""
from __future__ import annotations

import gzip
import json
import ssl
import urllib.request
from pathlib import Path

CHROM = "chr21"
GENOME = "hs1"
CHUNK = 5_000_000
OUT = Path("data/t2t")
GP = Path("data/raw_t2t/hs1.ncbiRefSeq.gp.gz")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "GenomeEarth/1.0"})
    try:
        return urllib.request.urlopen(req, timeout=90).read()
    except ssl.SSLError:
        return urllib.request.urlopen(req, timeout=90, context=ssl._create_unverified_context()).read()


def fetch_json(url):
    return json.loads(fetch(url))


def get_cytobands():
    url = f"https://api.genome.ucsc.edu/getData/track?genome={GENOME};track=cytoBand;chrom={CHROM}"
    data = fetch_json(url)
    raw = data.get("cytoBand") or data.get(CHROM) or []
    if isinstance(raw, dict):
        raw = raw.get(CHROM, [])
    bands = [{"start": b["chromStart"], "end": b["chromEnd"],
              "name": b["name"], "stain": b["gieStain"]} for b in raw]
    bands.sort(key=lambda b: b["start"])
    return bands


def get_sequence(length):
    parts = []
    pos = 0
    while pos < length:
        end = min(pos + CHUNK, length)
        url = f"https://api.genome.ucsc.edu/getData/sequence?genome={GENOME};chrom={CHROM};start={pos};end={end}"
        dna = fetch_json(url).get("dna", "")
        if len(dna) != end - pos:
            raise RuntimeError(f"chunk {pos}-{end} returned {len(dna)} bases")
        parts.append(dna)
        print(f"  fetched {end:,}/{length:,}")
        pos = end
    return "".join(parts)


def get_genes():
    genes = []
    with gzip.open(GP, "rt", encoding="ascii") as fh:
        for line in fh:
            f = line.rstrip("\n").split("\t")
            # genePredExt, NO bin: 0=name 1=chrom 2=strand 3=txStart 4=txEnd
            # 5=cdsStart 6=cdsEnd 7=exonCount 8=exonStarts 9=exonEnds 11=name2
            if f[1] != CHROM:
                continue
            starts = [int(x) for x in f[8].rstrip(",").split(",") if x != ""]
            ends = [int(x) for x in f[9].rstrip(",").split(",") if x != ""]
            cds_start, cds_end = int(f[5]), int(f[6])
            genes.append({
                "id": f[0], "symbol": f[11] if len(f) > 11 else f[0],
                "strand": f[2], "txStart": int(f[3]), "txEnd": int(f[4]),
                "cdsStart": cds_start, "cdsEnd": cds_end,
                "coding": cds_start < cds_end,
                "exons": [[s, e] for s, e in zip(starts, ends)],
            })
    genes.sort(key=lambda g: g["txStart"])
    return genes


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    print("Cytobands...")
    bands = get_cytobands()
    length = max(b["end"] for b in bands)        # bands tile the whole chromosome
    print(f"  {len(bands)} bands, chr21 length = {length:,}")

    print("Sequence (UCSC API, 5 Mb chunks)...")
    seq = get_sequence(length)
    first = next((i for i, c in enumerate(seq) if c not in "Nn"), -1)
    last = next((length - 1 - i for i, c in enumerate(reversed(seq)) if c not in "Nn"), -1)
    (OUT / "chr21.seq").write_bytes(seq.encode("ascii"))
    print(f"  wrote chr21.seq ({len(seq):,} bytes; firstNonN={first:,} lastNonN={last:,})")

    print("Genes...")
    genes = get_genes()
    coding = sum(1 for g in genes if g["coding"])
    print(f"  {len(genes)} transcripts ({coding} coding)")

    meta = {"chrom": CHROM, "assembly": "T2T-CHM13v2.0", "length": length,
            "firstBase": first, "lastBase": last, "bands": bands}
    (OUT / "chr21.meta.json").write_text(json.dumps(meta), encoding="utf-8")
    (OUT / "chr21.genes.json").write_text(json.dumps(genes), encoding="utf-8")
    print(f"Wrote {OUT}/chr21.meta.json and chr21.genes.json")


if __name__ == "__main__":
    main()
