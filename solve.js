// Fast drop-in for makefun-diff 1.0.0: the same patch, computed with an
// integer-id Myers search instead of jsdiff-style path objects.
//
// Lines are interned to integer ids once (one Map per case), the common
// prefix/suffix are trimmed on ids, and the middle is searched with the
// classic Myers V arrays: for each d the furthest x reached on every
// diagonal k, stored as one compact Int32Array per d so the exact winning
// path can be walked back. Tie-break, bounds and termination order match
// makefun-diff 1.0.0 exactly: on a diagonal the deletion wins when its
// reach is >= the insertion's; a move past either text's end is no
// candidate; diagonals are pruned never; the first (d, k) in scan order
// that reaches both ends is the script.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/**
 * Split a text into lines. Returns { lines, bare }: lines are the parts
 * between "\n"s with NO newline attached (split already allocates them, so
 * no per-line concatenation), and bare is true when the last line ends the
 * text with no newline. A line's identity is (part, has-newline), which the
 * interner folds into one integer id.
 */
function tokenize(text) {
  const parts = text.split('\n');
  const last = parts[parts.length - 1];
  if (last === '') {
    parts.length -= 1;
    return { lines: parts, bare: false };
  }
  return { lines: parts, bare: true };
}

/**
 * Intern both texts' lines to ids. One shared Map from part string to a
 * base id; the final id is base*2 + (has-newline ? 1 : 0), so a line with
 * and without its "\n" are distinct ids while no new strings are built.
 * The returned string arrays keep the parts for rendering, the id arrays
 * drive every comparison.
 */
function intern(aTok, bTok) {
  const map = new Map();
  const aIds = new Int32Array(aTok.lines.length);
  const bIds = new Int32Array(bTok.lines.length);
  let next = 0;
  const aLen = aTok.lines.length;
  const bLen = bTok.lines.length;
  for (let i = 0; i < aLen; i++) {
    const s = aTok.lines[i];
    let base = map.get(s);
    if (base === undefined) { base = next++; map.set(s, base); }
    aIds[i] = base * 2 + (i < aLen - 1 || !aTok.bare ? 1 : 0);
  }
  for (let i = 0; i < bLen; i++) {
    const s = bTok.lines[i];
    let base = map.get(s);
    if (base === undefined) { base = next++; map.set(s, base); }
    bIds[i] = base * 2 + (i < bLen - 1 || !bTok.bare ? 1 : 0);
  }
  return [aIds, bIds];
}

/**
 * Myers over id arrays a[0..n), b[0..m). Returns the edit runs
 * [{kind, count}] (kind 0 keep / 1 delete / 2 insert) of the middle part,
 * identical to makefun-diff's editRuns on the same lines.
 *
 * Forward pass: hist[d] is a compact Int32Array of length d+1 holding, for
 * k = -d, -d+2, ..., d, the x (old lines consumed) reached on that diagonal
 * AFTER the snake, or -1 when the diagonal was unreachable at depth d.
 * Backtrack: at (d, k) the edit step is re-decided from hist[d-1] with the
 * same rule the forward pass used, so the snake length is x - x0 and no
 * backward scan can mistake a coincidental equal pair for a kept line.
 */
function myersRuns(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  // History in ONE flat buffer: row d starts at off[d], holds d+1 x values
  // for k = -d, -d+2, ..., d (or -1 when unreachable). One allocation that
  // grows by doubling beats a fresh Int32Array per d (thousands of them).
  let cap = 4096;
  let flat = new Int32Array(cap);
  let off = new Int32Array(1024);
  let offNext = 0;
  const row = (d) => {
    const start = offNext;
    offNext += d + 1;
    if (offNext > cap) {
      let nc = cap;
      while (nc < offNext) nc *= 2;
      const nf = new Int32Array(nc);
      nf.set(flat);
      flat = nf;
      cap = nc;
    }
    if (d + 1 >= off.length) {
      const no = new Int32Array(off.length * 2);
      no.set(off);
      off = no;
    }
    off[d] = start;
    return start;
  };
  // d = 0: the snake from (0, 0) on diagonal 0.
  let x = 0;
  while (x < n && x < m && a[x] === b[x]) x++;
  let r0 = row(0);
  flat[r0] = x;
  let D = 0;
  let K = 0;
  if (x >= n && x >= m) {
    // Reached both ends with no edit: a single keep run (or none).
    return x > 0 ? [{ kind: KEEP, count: x }] : [];
  }
  let prevStart = r0;
  outer: for (let d = 1; d <= n + m; d++) {
    const start = row(d);
    flat.fill(-1, start, start + d + 1);
    for (let ki = 0; ki <= d; ki++) {
      const k = ki * 2 - d;
      // Diagonal k-1 at depth d-1 sits at index ki-1; k+1 at index ki.
      const xDelPrev = ki > 0 ? flat[prevStart + ki - 1] : -1;
      const xInsPrev = ki < d ? flat[prevStart + ki] : -1;
      let xDel = -1;
      let xIns = -1;
      if (xDelPrev >= 0 && xDelPrev < n) xDel = xDelPrev + 1;
      if (xInsPrev >= 0 && xInsPrev - k <= m) xIns = xInsPrev;
      if (xDel < 0 && xIns < 0) continue;
      // Deletion wins the tie (xDel >= xIns), exactly makefun-diff's rule.
      let nx = xDel >= xIns ? xDel : xIns;
      let ny = nx - k;
      while (nx < n && ny < m && a[nx] === b[ny]) { nx++; ny++; }
      flat[start + ki] = nx;
      if (nx >= n && ny >= m) { D = d; K = k; break outer; }
    }
    prevStart = start;
  }
  // Backtrack from (D, K) at (n, m).
  const ops = []; // reversed: {kind, count} runs, merged later
  let d = D;
  let k = K;
  let cx = n;
  // cy = cx - k is implied.
  while (d > 0) {
    const pv = off[d - 1];
    // Index of diagonal k in row d is (k+d)/2 = base; k-1 in row d-1 is
    // base-1 and k+1 is base.
    const base = (k + d) >> 1;
    const xDelPrev = base > 0 ? flat[pv + base - 1] : -1;
    const xInsPrev = base < d ? flat[pv + base] : -1;
    let xDel = -1;
    let xIns = -1;
    if (xDelPrev >= 0 && xDelPrev < n) xDel = xDelPrev + 1;
    if (xInsPrev >= 0 && xInsPrev - k <= m) xIns = xInsPrev;
    const isDel = xDel >= xIns;
    const x0 = isDel ? xDel : xIns;
    const keep = cx - x0;
    if (keep > 0) ops.push({ kind: KEEP, count: keep });
    ops.push({ kind: isDel ? DELETE : INSERT, count: 1 });
    if (isDel) { cx = x0 - 1; k = k - 1; }
    else { cx = x0; k = k + 1; }
    d--;
  }
  if (cx > 0) ops.push({ kind: KEEP, count: cx });
  // Reverse and merge adjacent runs of one kind.
  const runs = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    const last = runs.length ? runs[runs.length - 1] : null;
    if (last !== null && last.kind === op.kind) last.count += op.count;
    else runs.push({ kind: op.kind, count: op.count });
  }
  return runs;
}

/** make.fun's own patch of input.old into input.new, as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const aTok = tokenize(input.old);
  const bTok = tokenize(input.new);
  const aLines = aTok.lines;
  const bLines = bTok.lines;
  const n = aLines.length;
  const m = bLines.length;
  const [aIds, bIds] = intern(aTok, bTok);
  // Common prefix, then common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  const mid = myersRuns(aIds.subarray(prefix, n - suffix), bIds.subarray(prefix, m - suffix));
  for (let i = 0; i < mid.length; i++) runs.push(mid[i]);
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // Change runs: stretches of deletions/insertions between kept lines.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.kind === KEEP) { o += r.count; p += r.count; continue; }
    let c = changes.length ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) { c.dels += r.count; o += r.count; deleted += r.count; }
    else { c.ins += r.count; p += r.count; inserted += r.count; }
  }

  // Hunks: change runs at most 6 kept lines apart share one.
  const hunks = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const h = hunks.length ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 6) h.push(c);
    else hunks.push([c]);
  }
  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (let hi = 0; hi < hunks.length; hi++) {
    const h = hunks[hi];
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = first.o - 3 > 0 ? first.o - 3 : 0;
    const newStart = first.p - (first.o - oldStart);
    const after = n - (last.o + last.dels) < 3 ? n - (last.o + last.dels) : 3;
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (let ci = 0; ci < h.length; ci++) {
      const c = h[ci];
      for (; at < c.o; at++) {
        // Kept line: op, part, then its newline (or "\n%\n" when the
        // text's last line has none). Pushed as separate pieces so no
        // intermediate string is built per line.
        out.push('=', aLines[at], at < n - 1 || !aTok.bare ? '\n' : '\n%\n');
      }
      for (let i = 0; i < c.dels; i++) {
        const j = c.o + i;
        out.push('-', aLines[j], j < n - 1 || !aTok.bare ? '\n' : '\n%\n');
      }
      for (let i = 0; i < c.ins; i++) {
        const j = c.p + i;
        out.push('+', bLines[j], j < m - 1 || !bTok.bare ? '\n' : '\n%\n');
      }
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) {
      out.push('=', aLines[at], at < n - 1 || !aTok.bare ? '\n' : '\n%\n');
    }
  }
  return out.join('');
}
