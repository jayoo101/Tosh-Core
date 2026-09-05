/**
 * Validate `path/File.sol:123` style anchors in the docs.
 *
 * Line-number anchors rot the moment anybody inserts a line above them, and
 * they rot SILENTLY — nothing fails, the reader is just quietly sent to the
 * wrong place. This is the cheap half of the fix: it cannot tell you that an
 * anchor now points at the wrong function (only a human knows what it meant),
 * but it can tell you the two things that are mechanically decidable:
 *
 * UPDATE 2026-09-05: "only a human knows what it meant" is true in general and
 * false in the common case — when the sentence names the function in backticks
 * beside the number, the document has already said what it meant.
 * `scripts/checkDocLineRefs.mjs` decides exactly that subset and fails on it.
 * When it was first run, 22 of the 23 citations it could judge were wrong. The
 * SOFT channel below had been printing that drift all along, and the example
 * this header uses to explain SOFT — whether `ToshFactory.sol:442` "still lands
 * anywhere near `deposit`" — was one of the broken ones. It did not.
 *
 *   HARD  the file does not exist, or the line is past end-of-file. Always a
 *         defect, always worth failing a build over.
 *   SOFT  the enclosing symbol at that line, so a reviewer can eyeball whether
 *         `ToshFactory.sol:442` still lands anywhere near `deposit`.
 *
 * Run:  node scripts/checkDocAnchors.js          report only, exit 0
 *       node scripts/checkDocAnchors.js --strict exit 1 if any HARD failure
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DOCS = ['docs/PRD-v5.0.md', 'docs/INCIDENT_RESPONSE.md', 'README.md'];

// `src/ToshFactory.sol:442-468` or `test/ToshV5.t.sol:1196`, optionally in
// backticks. The path may contain [brackets] (Next.js dynamic routes).
const ANCHOR = /((?:src|test|script|scripts|soat-frontend\/src|lib)\/[A-Za-z0-9_/[\].-]+\.(?:sol|ts|tsx|js)):(\d+)(?:-(\d+))?/g;

/** Nearest preceding declaration, so a reviewer can see where a line landed. */
function enclosingSymbol(lines, lineNo) {
  const decl =
    /^\s*(?:function|constructor|modifier|error|event|struct|contract|interface|library|abstract contract)\s+([A-Za-z0-9_]+)?/;
  for (let i = Math.min(lineNo, lines.length) - 1; i >= 0; i--) {
    const m = lines[i].match(decl);
    if (m) {
      const kind = lines[i].trim().split(/\s+/)[0];
      return `${kind} ${m[1] ?? ''}`.trim();
    }
  }
  return '(top of file)';
}

const fileCache = new Map();
function readLines(rel) {
  if (fileCache.has(rel)) return fileCache.get(rel);
  const abs = path.join(REPO, rel);
  const v = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split(/\r?\n/) : null;
  // A trailing newline (every file here has one) leaves a phantom empty element
  // on the end of the split. Left in, `lines.length` overstates the file by one
  // and an anchor pointing one line PAST the last real line reads as fine.
  if (v && v.length > 1 && v[v.length - 1] === '') v.pop();
  fileCache.set(rel, v);
  return v;
}

let hard = 0;
let total = 0;
const report = [];

for (const doc of DOCS) {
  const abs = path.join(REPO, doc);
  if (!fs.existsSync(abs)) continue;

  const docLines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);

  docLines.forEach((text, idx) => {
    for (const m of text.matchAll(ANCHOR)) {
      total++;
      const [, target, startStr, endStr] = m;
      const start = Number(startStr);
      const end = endStr ? Number(endStr) : start;

      const lines = readLines(target);
      if (lines === null) {
        hard++;
        report.push(`HARD  ${doc}:${idx + 1}  ->  ${target}:${startStr}  FILE NOT FOUND`);
        continue;
      }
      if (end > lines.length) {
        hard++;
        report.push(
          `HARD  ${doc}:${idx + 1}  ->  ${target}:${startStr}  PAST EOF (file has ${lines.length} lines)`
        );
        continue;
      }
      report.push(
        `soft  ${doc}:${idx + 1}  ->  ${target}:${startStr}  now inside: ${enclosingSymbol(lines, start)}`
      );
    }
  });
}

for (const line of report) console.log(line);

console.log(`\n${total} anchors checked · ${hard} hard failures\n`);

if (hard > 0) {
  console.log('HARD failures are anchors that cannot possibly be right: the file');
  console.log('is gone, or the line does not exist. Fix those by replacing the');
  console.log('anchor with a function or test NAME, not by renumbering it —');
  console.log('renumbering just resets the clock on the same decay.\n');
}

if (process.argv.includes('--strict') && hard > 0) process.exit(1);
