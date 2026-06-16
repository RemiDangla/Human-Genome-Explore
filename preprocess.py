#!/usr/bin/env python3
"""Preprocess UCSC hg38 chr21 raw data into compact files the browser app loads.

Inputs  (data/raw/):
    chr21.fa.gz       soft-masked FASTA (lowercase = RepeatMasker/TRF repeat, N = assembly gap)
    cytoBand.txt.gz   genome-wide Giemsa-stain ideogram bands
    refGene.txt.gz    genome-wide RefSeq gene models in UCSC genePred format (with bin column)

Outputs (data/):
    chr21.seq         raw bases, ONE BYTE PER BASE, no header, no newlines.
                      => an HTTP byte-range request `bytes=S-E` returns exactly the
                         sequence for the 0-based genomic window [S, E].  This is the
                         "map tile" mechanism that lets the viewer stream nucleotides.
    chr21.meta.json   { chrom, length, firstBase, lastBase, bands[] }
    chr21.genes.json  chr21 transcripts: { id, symbol, strand, txStart, txEnd,
                                           cdsStart, cdsEnd, coding, exons[[s,e]...] }

Coordinates follow the UCSC convention: 0-based, half-open [start, end).
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path

CHROM = "chr21"
RAW = Path("data/raw")
OUT = Path("data")


def build_sequence() -> tuple[int, int, int]:
    """Strip the FASTA to a single contiguous byte-per-base file. Case preserved
    (lowercase = repeat-masked). Returns (length, firstNonN, lastNonN)."""
    src = RAW / "chr21.fa.gz"
    dst = OUT / "chr21.seq"
    length = 0
    first_base = -1   # first non-N position (telomere/centromere gaps are huge here)
    last_base = -1
    with gzip.open(src, "rt", encoding="ascii") as fh, open(dst, "wb") as out:
        for line in fh:
            if line.startswith(">"):
                continue
            seq = line.rstrip("\n")
            for i, ch in enumerate(seq):
                if ch not in ("N", "n"):
                    pos = length + i
                    if first_base < 0:
                        first_base = pos
                    last_base = pos
            out.write(seq.encode("ascii"))
            length += len(seq)
    return length, first_base, last_base


def build_cytobands() -> list[dict]:
    bands = []
    with gzip.open(RAW / "cytoBand.txt.gz", "rt", encoding="ascii") as fh:
        for line in fh:
            f = line.rstrip("\n").split("\t")
            if f[0] != CHROM:
                continue
            bands.append(
                {"start": int(f[1]), "end": int(f[2]), "name": f[3], "stain": f[4]}
            )
    bands.sort(key=lambda b: b["start"])
    return bands


def build_genes() -> list[dict]:
    genes = []
    with gzip.open(RAW / "refGene.txt.gz", "rt", encoding="ascii") as fh:
        for line in fh:
            f = line.rstrip("\n").split("\t")
            # genePred + bin: 0=bin 1=name 2=chrom 3=strand 4=txStart 5=txEnd
            # 6=cdsStart 7=cdsEnd 8=exonCount 9=exonStarts 10=exonEnds 12=name2
            if f[2] != CHROM:
                continue
            starts = [int(x) for x in f[9].rstrip(",").split(",") if x != ""]
            ends = [int(x) for x in f[10].rstrip(",").split(",") if x != ""]
            cds_start, cds_end = int(f[6]), int(f[7])
            genes.append(
                {
                    "id": f[1],
                    "symbol": f[12],
                    "strand": f[3],
                    "txStart": int(f[4]),
                    "txEnd": int(f[5]),
                    "cdsStart": cds_start,
                    "cdsEnd": cds_end,
                    "coding": cds_start < cds_end,
                    "exons": [[s, e] for s, e in zip(starts, ends)],
                }
            )
    genes.sort(key=lambda g: g["txStart"])
    return genes


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    print("Building sequence (one byte per base)...")
    length, first_base, last_base = build_sequence()
    print(f"  length={length:,}  firstNonN={first_base:,}  lastNonN={last_base:,}")

    bands = build_cytobands()
    print(f"Cytobands: {len(bands)}")

    genes = build_genes()
    coding = sum(1 for g in genes if g["coding"])
    print(f"Transcripts: {len(genes)} ({coding} coding, {len(genes) - coding} non-coding)")

    meta = {
        "chrom": CHROM,
        "assembly": "hg38",
        "length": length,
        "firstBase": first_base,
        "lastBase": last_base,
        "bands": bands,
    }
    (OUT / "chr21.meta.json").write_text(
        json.dumps(meta), encoding="utf-8"
    )
    (OUT / "chr21.genes.json").write_text(
        json.dumps(genes), encoding="utf-8"
    )
    print("Wrote chr21.seq, chr21.meta.json, chr21.genes.json")


if __name__ == "__main__":
    main()
