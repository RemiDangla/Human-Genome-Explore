// Vercel serverless function: GET /api/protein-info?symbol=&uniprot=
// Returns a short AI summary of a protein's role. The Anthropic API key lives
// here (server-side, in Vercel env vars) — never in the browser. Results are
// cached in MongoDB Atlas when MONGODB_URI is set (optional; works without it).
//
// Env vars (set in the Vercel dashboard):
//   ANTHROPIC_API_KEY   (required)  sk-ant-...
//   MONGODB_URI         (optional)  mongodb+srv://user:pass@cluster/...  → enables caching
//   ALLOWED_ORIGIN      (optional)  override the CORS allow-origin

import Anthropic from '@anthropic-ai/sdk';
import { MongoClient } from 'mongodb';

const MODEL = 'claude-opus-4-8';
const SYSTEM =
  'You are a molecular biologist writing brief reference notes about human proteins ' +
  'for a genome browser. Summarize only well-established, UniProt/textbook-level knowledge. ' +
  'Be concise and factual; if a protein is poorly characterized, say so plainly. Do NOT ' +
  'fabricate specific statistics, structures, residue numbers, or citations. Respond with ' +
  'ONLY the summary prose — no preamble, no headings, no markdown, no reasoning.';

const ALLOWED = new Set([
  'https://remidangla.github.io',
  'http://localhost:8000',
]);

// Reuse the Mongo connection across warm invocations.
let mongoPromise = null;
function getCollection(){
  if (!process.env.MONGODB_URI) return Promise.resolve(null);
  if (!mongoPromise) mongoPromise = new MongoClient(process.env.MONGODB_URI).connect();
  return mongoPromise.then(c => c.db('genome_earth').collection('protein_info'));
}

export default async function handler(req, res){
  const origin = req.headers.origin;
  const allow = process.env.ALLOWED_ORIGIN
    || (ALLOWED.has(origin) ? origin : 'https://remidangla.github.io');
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS'){ res.status(204).end(); return; }

  const symbol = String(req.query.symbol || '').trim();
  const acc = String(req.query.uniprot || '').trim().toUpperCase();
  const key = acc || symbol.toUpperCase();
  if (!key){ res.status(400).json({ error: 'missing symbol/uniprot' }); return; }

  try {
    const col = await getCollection();
    if (col){
      const cached = await col.findOne({ _id: key });
      if (cached){ res.status(200).json({ ...cached, cached: true }); return; }
    }

    if (!process.env.ANTHROPIC_API_KEY){
      res.status(503).json({ error: 'no_api_key', message: 'Server is missing ANTHROPIC_API_KEY.' });
      return;
    }
    const client = new Anthropic();
    const user =
      `Protein: gene ${symbol || '?'}, UniProt ${acc || '?'}, Homo sapiens. ` +
      'In 3-4 sentences (<~90 words) describe (1) its molecular function, ' +
      '(2) where/when it acts (tissue, subcellular localization, or pathway), and ' +
      '(3) its biomedical significance or well-established disease associations.';
    const msg = await client.messages.create({
      model: MODEL, max_tokens: 512, system: SYSTEM,
      messages: [{ role: 'user', content: user }],
    });
    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

    const entry = { _id: key, symbol, accession: acc, summary: text, model: MODEL };
    if (col) await col.updateOne({ _id: key }, { $set: entry }, { upsert: true });
    res.status(200).json({ ...entry, cached: false });
  } catch (e){
    res.status(502).json({ error: 'generation_failed', message: String((e && e.message) || e) });
  }
}
