// rnafold.worker.js — RNA secondary-structure prediction, off the main thread.
//
// Algorithm: Nussinov base-pair maximization (Nussinov & Jacobson, PNAS 1980,
// 77(11):6309-6313). It finds a nested structure that MAXIMIZES THE NUMBER of
// canonical base pairs — Watson–Crick (A-U, G-C) plus the G-U wobble — subject
// to a minimum hairpin loop of 3 unpaired bases.
//
// This is deliberately PARAMETER-FREE: it uses no thermodynamic free energies,
// so it produces an illustrative TOPOLOGY (stems/loops/hairpins), NOT a
// minimum-free-energy or experimentally validated structure. No energy
// constants are used or invented. For a thermodynamic fold you'd need the
// Turner parameters + a Zuker-style algorithm (e.g. ViennaRNA RNAfold).
'use strict';

const MAXLEN = 900;        // O(n^3) — keep responsive in a Web Worker
const MIN_LOOP = 3;        // min unpaired bases enclosed by a pair (no tiny hairpins)

function canPair(a, b){
  switch (a + b){
    case 'AU': case 'UA':
    case 'GC': case 'CG':
    case 'GU': case 'UG': return true;
    default: return false;
  }
}

// Returns the dot-bracket string for seq (length n). dp[i*n+j] = max pairs in i..j.
function fold(seq){
  const n = seq.length;
  const dp = new Int16Array(n * n);             // values < n/2, fits Int16
  for (let len = MIN_LOOP + 1; len < n; len++){
    for (let i = 0; i + len < n; i++){
      const j = i + len;
      let best = dp[(i + 1) * n + j];            // i unpaired
      const dj = dp[i * n + (j - 1)];            // j unpaired
      if (dj > best) best = dj;
      if (canPair(seq[i], seq[j])){              // i,j paired
        const v = dp[(i + 1) * n + (j - 1)] + 1;
        if (v > best) best = v;
      }
      for (let k = i + 1; k < j; k++){           // bifurcation
        const v = dp[i * n + k] + dp[(k + 1) * n + j];
        if (v > best) best = v;
      }
      dp[i * n + j] = best;
    }
  }
  // traceback (explicit stack — sequences can be long)
  const dot = new Array(n).fill('.');
  const stack = [[0, n - 1]];
  while (stack.length){
    const [i, j] = stack.pop();
    if (i >= j) continue;
    const here = dp[i * n + j];
    if (here === dp[(i + 1) * n + j]){ stack.push([i + 1, j]); continue; }
    if (here === dp[i * n + (j - 1)]){ stack.push([i, j - 1]); continue; }
    if (canPair(seq[i], seq[j]) && here === dp[(i + 1) * n + (j - 1)] + 1){
      dot[i] = '('; dot[j] = ')';
      stack.push([i + 1, j - 1]);
      continue;
    }
    for (let k = i + 1; k < j; k++){
      if (here === dp[i * n + k] + dp[(k + 1) * n + j]){
        stack.push([i, k]); stack.push([k + 1, j]);
        break;
      }
    }
  }
  return dot.join('');
}

self.onmessage = (e) => {
  const token = e.data && e.data.token;
  const full = String((e.data && e.data.seq) || '').toUpperCase();
  const truncated = full.length > MAXLEN;
  const seq = truncated ? full.slice(0, MAXLEN) : full;      // bases other than ACGU never pair
  const dot = seq.length ? fold(seq) : '';
  let pairs = 0;
  for (let i = 0; i < dot.length; i++) if (dot[i] === '(') pairs++;
  self.postMessage({ token, seq, dot, pairs, truncated, fullLength: full.length });
};
