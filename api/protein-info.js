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
  'You write brief, accurate reference notes about human proteins for a genome browser. ' +
  'Use only well-established, UniProt/textbook-level knowledge; if a protein is poorly ' +
  'characterized, say so. Do NOT fabricate statistics, structures, residue numbers, or citations. ' +
  'Return EXACTLY two sections separated by a line containing only "###":\n' +
  'First section — PLAIN: 2-3 sentences for a curious non-scientist. No jargon; explain in ' +
  'everyday terms what the protein does and why it matters (e.g. its role in health/disease).\n' +
  'Second section — EXPERT: 3-4 sentences for a molecular biologist (molecular function, ' +
  'localization/pathway, and well-established disease associations).\n' +
  'Output only the two sections and the "###" separator — no labels, headings, markdown, or reasoning.';

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
      if (cached && cached.technical){ res.status(200).json({ ...cached, cached: true }); return; }
    }

    if (!process.env.ANTHROPIC_API_KEY){
      res.status(503).json({ error: 'no_api_key', message: 'Server is missing ANTHROPIC_API_KEY.' });
      return;
    }
    const client = new Anthropic();
    const user = `Human protein: gene ${symbol || '?'}, UniProt ${acc || '?'}. Write the two sections.`;
    const msg = await client.messages.create({
      model: MODEL, max_tokens: 900, system: SYSTEM,
      messages: [{ role: 'user', content: user }],
    });
    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const parts = text.split(/^\s*###\s*$/m).map(s => s.trim()).filter(Boolean);
    const simple = parts[0] || text;
    const technical = parts[1] || parts[0] || text;

    const entry = { _id: key, symbol, accession: acc, simple, technical, model: MODEL };
    if (col) await col.updateOne({ _id: key }, { $set: entry }, { upsert: true });
    res.status(200).json({ ...entry, cached: false });
  } catch (e){
    res.status(502).json({ error: 'generation_failed', message: String((e && e.message) || e) });
  }
}
