/**
 * D1 — what does the market actually have to absorb at a given price multiple?
 *
 * Sweeps (genesis split x ladder span) and reports the release against the
 * denominator that matters: the CLAIM float.  The headline "% of GENESIS_SUPPLY"
 * figure flatters every configuration equally, because 45 % of genesis is locked
 * in the LP position forever and never trades.
 *
 * Run: node scripts/releaseCompare.js
 */

const MAX_SUPPLY = 21_000_000;
const TIER_COUNT = 4000;
const CLAIM_FRACTION = 0.55; // of genesis; the other 45 % is the locked LP

/** Shelves unlocked at price multiple R, for a geometric ladder of `span`. */
function shelvesUnlocked(multiple, span, tierCount) {
  // shelf i unlocks at STEP^i <= R, STEP = span^(1/(tierCount-1))
  const step = Math.pow(span, 1 / (tierCount - 1));
  const n = Math.floor(Math.log(multiple) / Math.log(step)) + 1;
  return Math.min(Math.max(n, 1), tierCount);
}

function evaluate(genesisPct, span, multiple) {
  const genesis = MAX_SUPPLY * genesisPct;
  const ladder = MAX_SUPPLY - genesis;
  const claim = genesis * CLAIM_FRACTION;
  const tierSize = ladder / TIER_COUNT;

  const shelves = shelvesUnlocked(multiple, span, TIER_COUNT);
  const released = shelves * tierSize;

  return {
    genesis,
    ladder,
    claim,
    tierSize,
    shelves,
    released,
    pctGenesis: (released / genesis) * 100,
    pctClaim: (released / claim) * 100,
    pctFloat: (released / (claim + released)) * 100,
  };
}

const SPLITS = [0.2, 0.3, 0.4, 0.5, 0.6];
const SPANS = [1000, 2000, 5000, 10000, 50000];

console.log('\nD1 — release at 2x, measured against the TRADEABLE float');
console.log('(current config is 40 % genesis / 2000x span)\n');

let header = 'genesis'.padEnd(9);
for (const s of SPANS) header += `${s + 'x'}`.padStart(11);
console.log(header);
console.log('-'.repeat(header.length));

for (const g of SPLITS) {
  let row = `${(g * 100).toFixed(0)}%`.padEnd(9);
  for (const s of SPANS) {
    const r = evaluate(g, s, 2);
    row += `${r.pctClaim.toFixed(1)}%`.padStart(11);
  }
  console.log(row);
}

console.log('\n\nSame grid, but as % of total float AFTER the release');
console.log('(claim + released — the denominator a holder actually sees)\n');
console.log(header);
console.log('-'.repeat(header.length));
for (const g of SPLITS) {
  let row = `${(g * 100).toFixed(0)}%`.padEnd(9);
  for (const s of SPANS) {
    const r = evaluate(g, s, 2);
    row += `${r.pctFloat.toFixed(1)}%`.padStart(11);
  }
  console.log(row);
}

console.log('\n\nCandidate configurations in detail\n');
const CANDIDATES = [
  ['CURRENT  40 % / 2000x', 0.4, 2000],
  ['         40 % / 5000x', 0.4, 5000],
  ['         40 % / 10000x', 0.4, 10000],
  ['         50 % / 2000x', 0.5, 2000],
  ['         50 % / 5000x', 0.5, 5000],
  ['         50 % / 10000x', 0.5, 10000],
  ['         60 % / 5000x', 0.6, 5000],
];

for (const [name, g, s] of CANDIDATES) {
  const r2 = evaluate(g, s, 2);
  const r5 = evaluate(g, s, 5);
  const r10 = evaluate(g, s, 10);
  console.log(name);
  console.log(
    `   genesis ${(r2.genesis / 1e6).toFixed(2)}M  ladder ${(r2.ladder / 1e6).toFixed(2)}M  ` +
      `claim float ${(r2.claim / 1e6).toFixed(2)}M  tier ${r2.tierSize.toFixed(0)}`
  );
  console.log(
    `   2x : ${r2.shelves.toString().padStart(4)} shelves  ${(r2.released / 1e6).toFixed(3)}M  ` +
      `= ${r2.pctClaim.toFixed(1)}% of claim float, ${r2.pctFloat.toFixed(1)}% of post-release float`
  );
  console.log(
    `   5x : ${r5.shelves.toString().padStart(4)} shelves  ${(r5.released / 1e6).toFixed(3)}M  ` +
      `= ${r5.pctClaim.toFixed(1)}% of claim float, ${r5.pctFloat.toFixed(1)}% of post-release float`
  );
  console.log(
    `   10x: ${r10.shelves.toString().padStart(4)} shelves  ${(r10.released / 1e6).toFixed(3)}M  ` +
      `= ${r10.pctClaim.toFixed(1)}% of claim float, ${r10.pctFloat.toFixed(1)}% of post-release float`
  );
  console.log();
}

console.log('What a bigger span costs, at the other end of the curve:\n');
for (const [name, g, s] of CANDIDATES) {
  const r = evaluate(g, s, 2);
  // Price multiple needed to clear the whole ladder is `s` by construction.
  // Report how much supply is still unreleased at 10x - the "late-stage
  // deflation" the span buys.
  const at10 = evaluate(g, s, 10);
  const unreleasedAt10 = ((r.ladder - at10.released) / r.ladder) * 100;
  console.log(`${name}   ${unreleasedAt10.toFixed(1)}% of the ladder still unsold at 10x`);
}
console.log();
