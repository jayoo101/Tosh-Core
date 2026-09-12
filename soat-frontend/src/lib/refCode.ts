// ─────────────────────────────────────────────────────────────────────────────
// Tosh Protocol — referral code vocabulary.
//
// A referral link used to carry the referrer's address: `?ref=` plus 42
// characters of hex, on a path that already ended in a 42-character project
// address. Nearly a hundred characters of path and query, pasted into bios and
// group chats, and unreadable and unspeakable at both ends.
//
// WHY THIS IS A LOOKUP AND NOT AN ENCODING. An address is 20 bytes — 160 bits.
// Encoding 160 bits losslessly into a word list costs 11 bits per word at
// BIP-39's 2048-word size, so a reversible word form of an address is FIFTEEN
// words: far longer than the hex it replaces. Short codes are therefore not
// derivable from the address by any arithmetic, and the only way to get one is
// to mint it and remember it. That is what `referral_codes` is for, and it is
// why this module generates but never decodes.
//
// DELIBERATELY NOT BIP-39. Three words from a mnemonic word list, in a URL, in
// a crypto product, is a shape users have been trained for years to read as a
// seed phrase fragment. The adjective-tone-noun grammar below cannot be
// mistaken for one: it always reads as a handle, because seed phrases do not
// have grammar.
//
// A NOTE ON THE MATH. 64 × 64 × 96 = 393,216 codes. Minting retries on the
// unique constraint, so collisions cost a round trip rather than a failure,
// but the retry budget is finite: at 50,000 issued codes roughly one mint in
// eight collides on its first try, and at 200,000 it is one in two. If the
// table ever approaches that, extend NOUNS first — it is the cheapest list to
// grow and the only one whose length does not lengthen the average code.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Position one. Character, not colour, so the three positions never read as
 * interchangeable — `swift-amber-otter` has an obvious word order and
 * `amber-swift-otter` looks wrong, which is what makes a code repeatable down
 * a phone line.
 */
const ADJECTIVES = [
  'swift', 'quiet', 'bright', 'clever', 'bold', 'calm', 'brave', 'sharp',
  'steady', 'nimble', 'quick', 'keen', 'smooth', 'gentle', 'lucid', 'solid',
  'prime', 'noble', 'vivid', 'crisp', 'plain', 'stark', 'humble', 'eager',
  'patient', 'curious', 'careful', 'honest', 'frank', 'ready', 'able', 'apt',
  'deft', 'fleet', 'hardy', 'spry', 'stout', 'sturdy', 'agile', 'alert',
  'ample', 'brisk', 'clean', 'clear', 'direct', 'early', 'easy', 'even',
  'exact', 'fair', 'fine', 'firm', 'fluid', 'fond', 'free', 'fresh',
  'cosmic', 'dapper', 'jolly', 'merry', 'placid', 'rustic', 'sunny', 'mellow',
] as const

/**
 * Position two: colours, minerals and materials. Kept disjoint from the other
 * two lists so no code ever repeats a word, which would look like a bug.
 */
const TONES = [
  'amber', 'azure', 'brass', 'bronze', 'cobalt', 'copper', 'coral', 'crimson',
  'cyan', 'ember', 'garnet', 'golden', 'indigo', 'ivory', 'jade', 'lilac',
  'linen', 'marble', 'mauve', 'ochre', 'olive', 'onyx', 'opal', 'pearl',
  'plum', 'quartz', 'russet', 'saffron', 'sage', 'sapphire', 'scarlet', 'sepia',
  'silver', 'slate', 'steel', 'teal', 'topaz', 'umber', 'velvet', 'violet',
  'walnut', 'willow', 'cedar', 'cotton', 'flint', 'frost', 'glass', 'granite',
  'hazel', 'iron', 'ivy', 'maple', 'mint', 'moss', 'oak', 'pine',
  'resin', 'sand', 'shale', 'silk', 'snow', 'stone', 'tin', 'wool',
] as const

/**
 * Position three: animals and landmarks, every one concrete enough to picture.
 * Capped at seven characters so the longest possible code stays inside a
 * readable link — see `MAX_CODE_LENGTH`.
 */
const NOUNS = [
  'otter', 'falcon', 'heron', 'badger', 'beaver', 'marmot', 'weasel', 'bison',
  'jaguar', 'ocelot', 'lynx', 'ibex', 'gecko', 'osprey', 'raven', 'robin',
  'finch', 'wren', 'magpie', 'egret', 'puffin', 'tern', 'gull', 'crane',
  'stork', 'ibis', 'owl', 'kite', 'merlin', 'harrier', 'walrus', 'narwhal',
  'beluga', 'orca', 'dolphin', 'manatee', 'marlin', 'tarpon', 'salmon', 'turtle',
  'anchor', 'arbor', 'atlas', 'basin', 'beacon', 'bridge', 'cabin', 'canyon',
  'cavern', 'chapel', 'cinder', 'cirrus', 'comet', 'compass', 'cove', 'crater',
  'delta', 'dune', 'fjord', 'forge', 'garden', 'gateway', 'glacier', 'grotto',
  'harbor', 'harvest', 'hollow', 'island', 'jetty', 'lagoon', 'lantern', 'ledge',
  'meadow', 'mesa', 'meteor', 'orchard', 'outpost', 'pasture', 'pillar', 'plateau',
  'prairie', 'quarry', 'ravine', 'reef', 'ridge', 'river', 'saddle', 'summit',
  'temple', 'thicket', 'tundra', 'valley', 'vault', 'vista', 'wharf', 'zenith',
] as const

/** How many distinct codes the vocabulary can express. Exported for the test
 *  that asserts the collision math in the header is still true. */
export const CODE_SPACE = ADJECTIVES.length * TONES.length * NOUNS.length

/**
 * Test seam. The three properties this module promises in prose — the lists
 * are internally unique, mutually disjoint, and within the length bound — are
 * facts about the lists themselves, and sampling generated codes cannot prove
 * any of them. A single overlapping word would show up in roughly one code in
 * six thousand, which no reasonable number of draws would catch reliably.
 */
export const REF_CODE_LISTS = { ADJECTIVES, TONES, NOUNS } as const

/** Longest code the lists can produce, for the column bound and the URL. */
export const MAX_CODE_LENGTH = 3 * 12 + 2

/**
 * SHAPE ONLY, AND ON PURPOSE — this does not check list membership.
 *
 * The database is the authority on which codes exist; this is the cheap filter
 * that keeps junk off it. Checking the words against the lists above would
 * make every issued code a hostage to the lists never changing, and the one
 * promise a referral link has to keep is that it still resolves years after it
 * was pasted somewhere. Growing NOUNS would retroactively invalidate nothing,
 * and reordering or pruning a list must not either.
 */
export function isRefCodeShape(raw: string): boolean {
  return /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$/.test(raw)
}

/**
 * A uniformly distributed index below `n`, by rejection sampling.
 *
 * `getRandomValues() % n` is the obvious version and is biased whenever `n`
 * does not divide 2^32 — which is the case for NOUNS at 96. The bias is tiny
 * and completely harmless for a referral code, but the correction is four
 * lines, and an unexplained `% n` in a crypto codebase is a thing every future
 * reader has to stop and re-derive.
 */
function randomIndex(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < limit) return buf[0] % n
  }
}

/**
 * A fresh random code. Never derived from the address it will point at.
 *
 * Randomness is the anti-squatting property, not just a convenience: codes are
 * assigned rather than chosen precisely so that nobody can mint
 * `tosh-official-team` or a lookalike of somebody else's handle and paste it
 * into a group chat. The referral programme pays a share of real deposits, so
 * a chooseable code would be an impersonation surface on the one artifact of
 * this product designed to be forwarded by strangers.
 */
export function generateRefCode(): string {
  return [
    ADJECTIVES[randomIndex(ADJECTIVES.length)],
    TONES[randomIndex(TONES.length)],
    NOUNS[randomIndex(NOUNS.length)],
  ].join('-')
}
