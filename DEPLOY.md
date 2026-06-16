# Deploying Genome Earth online (chr21, Phase 1 — static / GitHub Pages)

Phase 1 puts the **whole viewer + protein structure** online as a pure static
site — no server, no secrets. The genome data is served as static files
(byte-range streamed), and AlphaFold/UniProt are called directly from the
browser. The **AI protein-role summaries** are *not* in Phase 1 (they need a
server-side API key — see Phase 2 at the bottom).

## What gets deployed
- `index.html`, `css/`, `js/` (including `js/vendor/` and `js/config.js`)
- `.nojekyll`
- The per-assembly datasets (two reference genomes, switchable in the UI):
  - `data/hg38/chr21.{seq,meta.json,genes.json}` (seq ~47 MB)
  - `data/t2t/chr21.{seq,meta.json,genes.json}` (seq ~45 MB)
  - Each `.seq` is under GitHub's 100 MB file limit; you'll see a size warning on
    push, which is fine. Repo total ~92 MB.

Everything else (`data/raw/`, `data/raw_t2t/`, caches, `server.py`,
`preprocess*.py`) is excluded by `.gitignore` and isn't needed by the static site.

> If the datasets don't exist yet: `python preprocess.py` (hg38) and
> `python preprocess_t2t.py` (T2T).

## Steps

**1. Turn off the AI-summary feature for the static build.**
Edit `js/config.js` and set:
```js
window.GENOME_CONFIG = { summaryApi: null };
```
(With `null`, the ℹ panel shows a friendly "needs a server" note. Leave it as
`'api'` only when running locally with `server.py`. Phase 2 sets it to a URL.)

**2. Create the repo and push.** From the project folder:
```powershell
cd "C:/Users/u118877/Claude sandbox/GenomeViewer"
git init
git add index.html css js .nojekyll data/hg38 data/t2t .gitignore DEPLOY.md README.md
git commit -m "Genome Earth - chr21 static site"
gh repo create genome-earth --public --source=. --push
```
(No `gh` CLI? Create an empty repo on github.com, then:
`git remote add origin https://github.com/<you>/genome-earth.git` →
`git branch -M main` → `git push -u origin main`.)

**3. Enable GitHub Pages.**
Repo → **Settings → Pages** → **Source: Deploy from a branch** →
Branch **`main`**, folder **`/ (root)`** → **Save**. Wait ~1 minute.

**4. Open it.**
`https://<you>.github.io/genome-earth/`
Deep links work too: `.../genome-earth/#chr21:31659778` (SOD1 start) or `#APP`.

## Notes & gotchas
- **Byte-range streaming:** GitHub Pages (Fastly CDN) honours `Range` requests,
  so the 47 MB chromosome streams in small windows. If a host ever ignores
  `Range`, the app falls back to a one-time full-file download and still works
  correctly (handled in `js/data.js`).
- **Relative paths:** all data/asset URLs are relative, so the project-page
  subpath (`/genome-earth/`) works without configuration.
- **Bandwidth:** GitHub Pages has a ~100 GB/month soft limit — ample for
  personal use.
- **Data licensing:** RefSeq (public domain), UCSC tracks (open), AlphaFold
  (CC-BY-4.0). Fine to host; attribute AlphaFold.

## Phase 2 — re-enable AI summaries (later)
The summaries need a tiny backend holding `ANTHROPIC_API_KEY` (the browser must
never see the key). Plan:
1. Deploy a serverless function (Vercel / Netlify / Cloudflare Worker) that
   implements `GET /protein-info?symbol=&uniprot=` — same logic as
   `handle_protein_info` in `server.py` — using your **MongoDB Atlas** cluster
   as the cache (in place of `protein_info.json`).
2. Add the function's CORS allow-origin for your Pages URL.
3. Set `summaryApi` in `js/config.js` to the function's base URL and redeploy
   the static site.
