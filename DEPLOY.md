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

## Phase 2 — AI protein summaries via a Vercel function

The summaries need a server holding `ANTHROPIC_API_KEY` (the browser must never
see it). The static site stays on GitHub Pages; we add **one Vercel function**
just for `GET /api/protein-info`. Files are already in the repo:
`api/protein-info.js`, `package.json`, `.vercelignore` (Vercel deploys only the
function, not the 92 MB of data).

1. **Deploy the function.** Go to [vercel.com](https://vercel.com) → sign in with
   GitHub → **Add New… → Project** → import `Human-Genome-Explore`. Framework
   preset **Other**, leave build/output empty. Add **Environment Variables**:
   - `ANTHROPIC_API_KEY` = `sk-ant-…` (required)
   - `MONGODB_URI` = `mongodb+srv://…` (optional — enables caching; works without)
   Click **Deploy**. Note the production domain, e.g. `human-genome-explore.vercel.app`.

2. **MongoDB Atlas (optional, for caching).** In Atlas: create a DB user, and
   under **Network Access** allow `0.0.0.0/0` (Vercel functions have dynamic IPs —
   use a strong DB password). Copy the SRV connection string into `MONGODB_URI`.
   The function uses db `genome_earth`, collection `protein_info` (auto-created).

3. **Test the function:**
   `https://<your>.vercel.app/api/protein-info?symbol=SOD1&uniprot=P00441`
   → should return JSON with a `summary`.

4. **Point the site at it.** Edit `js/config.js`:
   ```js
   window.GENOME_CONFIG = { summaryApi: 'https://<your>.vercel.app/api' };
   ```
   Commit + push. GitHub Pages redeploys (~1 min); the ℹ panel now shows real
   summaries. CORS in the function already allows the Pages origin
   (`https://remidangla.github.io`); change `ALLOWED` / set `ALLOWED_ORIGIN` if
   your Pages URL differs.

**Cost control:** each protein costs ~$0.005 once, then it's cached (in Mongo, or
forever-fresh if you skip Mongo). CORS limits casual browser abuse, but the
endpoint is public — for a shared link, consider a rate limit or a lighter model
(`claude-haiku-4-5`) via the `MODEL` constant in `api/protein-info.js`.
