#!/usr/bin/env python3
"""Tiny static server for the Genome Viewer with HTTP byte-range support.

Range support is the whole point: the viewer fetches `chr21.seq` with a
`Range: bytes=START-END` header and gets back exactly the nucleotides for the
0-based genomic window [START, END] -- no need to download the 46 MB chromosome
to read 200 bases. This is the streaming "map tile" that powers the zoom.

Usage:
    python server.py [port]      (default 8000)
Then open http://localhost:8000/
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
STRUCT_DIR = os.path.join(ROOT, "data", "structures")
UNIPROT_CACHE = os.path.join(ROOT, "data", "uniprot_map.json")
PROTEIN_INFO_CACHE = os.path.join(ROOT, "data", "protein_info.json")

# Model + prompt for the on-demand protein-role summaries (Claude API).
INFO_MODEL = "claude-opus-4-8"
INFO_SYSTEM = (
    "You are a molecular biologist writing brief reference notes about human proteins "
    "for a genome browser. Summarize only well-established, UniProt/textbook-level knowledge. "
    "Be concise and factual; if a protein is poorly characterized, say so plainly. Do NOT "
    "fabricate specific statistics, structures, residue numbers, or citations. Respond with "
    "ONLY the summary prose — no preamble, no headings, no markdown, no reasoning."
)

# Curated gene-symbol -> UniProt accession for the demo genes, so they resolve
# instantly and work even if the UniProt API is unreachable. Anything else is
# looked up live via the UniProt REST API and cached.
CURATED_UNIPROT = {
    "SOD1": "P00441", "APP": "P05067", "DYRK1A": "Q13627", "RUNX1": "Q01196",
    "JAM2": "P57087", "NCAM2": "O15394", "ATP5PF": "P18859", "ATP5J": "P18859",
    "DSCAM": "O60469", "CBS": "P35520", "PCP4": "P48539", "TTC3": "P53804",
}


def _fetch(url, accept=None):
    """GET a URL, tolerating Windows SSL trust-store gaps for these public,
    read-only endpoints by falling back to an unverified context."""
    req = urllib.request.Request(url, headers={"User-Agent": "GenomeEarth/1.0",
                                               **({"Accept": accept} if accept else {})})
    try:
        return urllib.request.urlopen(req, timeout=25).read()
    except ssl.SSLError:
        ctx = ssl._create_unverified_context()
        return urllib.request.urlopen(req, timeout=25, context=ctx).read()


class RangeHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".seq": "text/plain",
        ".json": "application/json",
        ".js": "text/javascript",
    }

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---- JSON helper -------------------------------------------------------
    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- protein API: gene -> UniProt, and UniProt -> AlphaFold structure --
    def handle_api(self):
        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/api/uniprot":
            symbol = (q.get("symbol", [""])[0] or "").strip().upper()
            if not symbol:
                return self._json({"error": "missing symbol"}, 400)
            cache = {}
            if os.path.isfile(UNIPROT_CACHE):
                try: cache = json.load(open(UNIPROT_CACHE, encoding="utf-8"))
                except Exception: cache = {}
            acc = CURATED_UNIPROT.get(symbol) or cache.get(symbol)
            if not acc:
                try:
                    url = ("https://rest.uniprot.org/uniprotkb/search?query=gene_exact:"
                           + urllib.parse.quote(symbol)
                           + "+AND+organism_id:9606+AND+reviewed:true&fields=accession&format=json&size=1")
                    data = json.loads(_fetch(url, accept="application/json"))
                    results = data.get("results", [])
                    if results:
                        acc = results[0]["primaryAccession"]
                except Exception as e:
                    return self._json({"error": "uniprot lookup failed: " + str(e)}, 502)
            if not acc:
                return self._json({"error": "no reviewed UniProt entry for " + symbol}, 404)
            cache[symbol] = acc
            try: json.dump(cache, open(UNIPROT_CACHE, "w", encoding="utf-8"))
            except Exception: pass
            return self._json({"symbol": symbol, "accession": acc})

        if parsed.path == "/api/structure":
            acc = (q.get("uniprot", [""])[0] or "").strip().upper()
            if not acc:
                return self._json({"error": "missing uniprot"}, 400)
            os.makedirs(STRUCT_DIR, exist_ok=True)
            cached = os.path.join(STRUCT_DIR, acc + ".pdb")
            if not os.path.isfile(cached):
                try:
                    meta = json.loads(_fetch("https://alphafold.ebi.ac.uk/api/prediction/" + acc))
                    pdb_url = meta[0]["pdbUrl"]
                    pdb = _fetch(pdb_url)
                    open(cached, "wb").write(pdb)
                except Exception as e:
                    return self._json({"error": "no AlphaFold model for " + acc + ": " + str(e)}, 404)
            with open(cached, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path == "/api/protein-info":
            return self.handle_protein_info(q)

        return self._json({"error": "unknown api route"}, 404)

    # gene/UniProt -> short, Claude-generated description of the protein's role.
    # Generated on first request, cached to data/protein_info.json thereafter.
    def handle_protein_info(self, q):
        symbol = (q.get("symbol", [""])[0] or "").strip()
        acc = (q.get("uniprot", [""])[0] or "").strip().upper()
        key = acc or symbol.upper()
        if not key:
            return self._json({"error": "missing symbol/uniprot"}, 400)

        cache = {}
        if os.path.isfile(PROTEIN_INFO_CACHE):
            try: cache = json.load(open(PROTEIN_INFO_CACHE, encoding="utf-8"))
            except Exception: cache = {}
        if key in cache:
            return self._json({**cache[key], "cached": True})

        if not os.environ.get("ANTHROPIC_API_KEY"):
            return self._json({"error": "no_api_key",
                               "message": "Set ANTHROPIC_API_KEY on the server to enable AI summaries."}, 503)
        try:
            import anthropic
        except ImportError:
            return self._json({"error": "sdk_missing", "message": "Run: pip install anthropic"}, 503)

        try:
            client = anthropic.Anthropic()
            user = (f"Protein: gene {symbol or '?'}, UniProt {acc or '?'}, Homo sapiens. "
                    "In 3-4 sentences (<~90 words) describe (1) its molecular function, "
                    "(2) where/when it acts (tissue, subcellular localization, or pathway), and "
                    "(3) its biomedical significance or well-established disease associations.")
            msg = client.messages.create(
                model=INFO_MODEL, max_tokens=512,
                system=INFO_SYSTEM,
                messages=[{"role": "user", "content": user}],
            )
            text = "".join(b.text for b in msg.content if b.type == "text").strip()
        except Exception as e:
            return self._json({"error": "generation_failed", "message": str(e)}, 502)

        entry = {"symbol": symbol, "accession": acc, "summary": text, "model": INFO_MODEL}
        cache[key] = entry
        try: json.dump(cache, open(PROTEIN_INFO_CACHE, "w", encoding="utf-8"), indent=1)
        except Exception: pass
        return self._json({**entry, "cached": False})

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.handle_api()
        rng = self.headers.get("Range")
        if not rng:
            return super().do_GET()

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().do_GET()

        size = os.path.getsize(path)
        try:
            units, _, rangespec = rng.partition("=")
            if units.strip() != "bytes":
                raise ValueError
            start_s, _, end_s = rangespec.strip().partition("-")
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else size - 1
        except ValueError:
            self.send_error(400, "Bad Range header")
            return

        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return

        end = min(end, size - 1)
        length = end - start + 1
        ctype = self.guess_type(path)
        with open(path, "rb") as f:
            f.seek(start)
            data = f.read(length)
        self.send_response(206)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(ROOT)
    # threaded: the browser opens several concurrent connections (modules, JSON,
    # sequence range requests) — a single-threaded server can deadlock on one.
    httpd = ThreadingHTTPServer(("127.0.0.1", port), RangeHandler)
    httpd.daemon_threads = True
    print(f"Genome Viewer serving {ROOT}")
    print(f"  -> http://localhost:{port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
