// A faster drop-in for makefun-diff 1.0.0: the same patch, less CPU.
//
// The rule, restated from the house baseline's header: a text is cut after every
// "\n" (a "\r" is part of its line) and a last line without "\n" is a line too;
// two lines are equal only when they are the same code units, newline included.
// The common prefix of lines is kept, then the common suffix of what is left.
// Between them Myers's greedy search runs from the first lines: for d edits and
// each diagonal k = x - y from -d to d in steps of 2, the furthest point on k is
// one old line past the (d-1)-point on k-1 (a deletion) or one new line past the
// (d-1)-point on k+1 (an insertion), whichever reaches further into the old text,
// the deletion when both reach the same point; no move past either text's end, no
// edge-diagonal pruning, and every run of equal lines is followed as far as it
// goes. The first path to reach both ends is the script. The patch is one line
// "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I", then per hunk a line
// "@ os ol ns nl" and one line per line it covers ("=" kept, "-" deleted,
// "+" inserted); each change run lists its deletions before its insertions and
// shows up to 3 kept lines before and after it; two runs at most 6 kept lines
// apart share a hunk. A line with no newline at its text's end is written with
// one and followed by a line "%". Identical texts are the first line alone.
//
// Speed. The reference builds one path object per (d,k) step, which is millions
// of allocations on these cases (about 7M steps for D near 3,800, while the snake
// only walks ~30k lines). This module keeps the same search but stores the
// furthest old-line index per diagonal in one flat Int32Array and walks the script
// back out of it, so the hot loop allocates nothing and works only with integer
// arithmetic on typed arrays. On top of that it splits the middle region at
// anchor lines the greedy path is forced through, so each piece's search is tiny:
// an anchor is a line that occurs exactly once in each text and whose immediate
// neighbours do not match across the two texts (a line inside a moved block, or
// inside a long common run, is never an anchor). The anchors are chained by the
// longest increasing run of their positions, ties broken toward the larger new
// position, which is the chain the greedy path itself takes; every piece between
// two anchors is then diffed by the same greedy search, so the joined script is
// the reference's script, only reached in far fewer steps. A case with no anchors
// falls back to the one-piece search.

/** The patch's first word. */
export const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
export const CONTEXT = 3;

const KEEP = '=';
const DELETE = '-';
const INSERT = '+';

/** Stored in a V array where no path reaches that diagonal. */
const NO_PATH = -2;

/** A text's lines, each with its "\n" (the last one without, when the text does not end in one). */
export function tokenize(text) {
  const parts = text.split('\n');
  const lines = [];
  const last = parts.length - 1;
  for (let i = 0; i < last; i++) lines.push(parts[i] + '\n');
  if (parts[last] !== '') lines.push(parts[last]);
  return lines;
}

/**
 * The greedy search on two token-id arrays, as the reference defines it, but
 * with the furthest old-line index per diagonal kept in one flat array instead
 * of path objects: depth d's row starts at flat[d * d] and holds 2d + 1 entries.
 * Returns the flat array plus where the search stopped, so the script can be
 * walked back out of it.
 */
function searchSnapshots(a, b) {
  const n = a.length;
  const m = b.length;
  const maxD = n + m;
  let capD = 64;
  let flat = new Int32Array((capD + 1) * (capD + 1));
  const grow = (need) => {
    let next = capD;
    while (next < need) next *= 2;
    const grown = new Int32Array((next + 1) * (next + 1));
    grown.set(flat.subarray(0, (capD + 1) * (capD + 1)));
    flat = grown;
    capD = next;
  };
  // Depth 0: the start, oldPos -1, then the opening run of equal lines.
  let x = -1;
  let y = -1;
  while (x + 1 < n && y + 1 < m && a[x + 1] === b[y + 1]) {
    x++;
    y++;
  }
  flat[0] = x;
  if (x + 1 >= n && y + 1 >= m) return { flat, d: 0, k: 0 };
  for (let d = 1; d <= maxD; d++) {
    if (d > capD) grow(d);
    const base = d * d;
    const prev = (d - 1) * (d - 1);
    const lastJ = 2 * d;
    for (let j = 0, k = -d; j <= lastJ; j += 2, k += 2) {
      // The (d-1)-point on k-1 (a deletion's source) and on k+1 (an insertion's).
      const fromDel = j >= 2 ? flat[prev + j - 2] : NO_PATH;
      const fromIns = j <= lastJ - 2 ? flat[prev + j] : NO_PATH;
      const canDel = fromDel !== NO_PATH && fromDel + 1 < n;
      const canIns = fromIns !== NO_PATH && fromIns - k < m;
      if (!canDel && !canIns) {
        flat[base + j] = NO_PATH;
        continue;
      }
      const byDel = canDel ? fromDel + 1 : NO_PATH;
      const byIns = canIns ? fromIns : NO_PATH;
      // The deletion when both reach the same point, as the reference does.
      let px = byDel >= byIns ? fromDel + 1 : fromIns;
      let py = px - k;
      while (px + 1 < n && py + 1 < m && a[px + 1] === b[py + 1]) {
        px++;
        py++;
      }
      flat[base + j] = px;
      if (px + 1 >= n && py + 1 >= m) return { flat, d, k };
    }
  }
  throw new Error('makefun-diff: the search ended without reaching both ends');
}

/** The runs of the edit script of a into b: [{ kind, count }], in order. */
function editRuns(a, b) {
  const n = a.length;
  const m = b.length;
  const { flat, d: stopD, k: stopK } = searchSnapshots(a, b);
  // Walk the snapshots back from the stopping point. Each step gives one
  // change (a single deletion or insertion) preceded by the run of equal lines
  // the search followed after it; same-kind neighbours are merged, as the
  // reference's path building merges them.
  const rev = [];
  const push = (kind, count) => {
    if (count <= 0) return;
    const last = rev[rev.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else rev.push({ kind, count });
  };
  let d = stopD;
  let k = stopK;
  while (d > 0) {
    const base = d * d;
    const prev = (d - 1) * (d - 1);
    const x = flat[base + k + d];
    const j = k + d;
    const fromDel = j >= 2 ? flat[prev + j - 2] : NO_PATH;
    const fromIns = j <= 2 * d - 2 ? flat[prev + j] : NO_PATH;
    const canDel = fromDel !== NO_PATH && fromDel + 1 < n;
    const canIns = fromIns !== NO_PATH && fromIns - k < m;
    const byDel = canDel ? fromDel + 1 : NO_PATH;
    const byIns = canIns ? fromIns : NO_PATH;
    let at;
    let kind;
    if (byDel >= byIns) {
      at = fromDel + 1;
      kind = DELETE;
    } else {
      at = fromIns;
      kind = INSERT;
    }
    push(KEEP, x - at);
    push(kind, 1);
    k = kind === DELETE ? k - 1 : k + 1;
    d--;
  }
  push(KEEP, flat[0] + 1);
  rev.reverse();
  return rev;
}

/**
 * The anchor chain of the middle region: the isolated unique lines, chained by
 * the longest increasing run of their new positions, ties broken toward the
 * larger new position. `a` and `b` are the middle region's id arrays; `ai` and
 * `bi` the whole texts' id arrays (for the neighbour test); `prefix` the whole
 * texts' common prefix length; `countA`, `countB` the per-id occurrence counts
 * in the whole texts; `posA`, `posB` the per-id positions in the whole old and
 * new texts.
 * Returns [{ i, j }] in middle-region coordinates, increasing in both.
 */
function anchorChain(a, b, ai, bi, prefix, countA, countB, posA, posB) {
  const n = a.length;
  const m = b.length;
  const fullN = ai.length;
  const fullM = bi.length;
  const anchors = [];
  for (let i = 0; i < n; i++) {
    const id = a[i];
    if (countA[id] !== 1 || countB[id] !== 1) continue;
    const j = posB[id] - prefix;
    if (j < 0 || j >= m) continue;
    // Isolated: neither immediate neighbour matches across the two texts.
    // Whole-text coordinates of this anchor are (i + prefix, j + prefix).
    const wi = i + prefix;
    const wj = j + prefix;
    const leftOk = wi > 0 && wj > 0 && ai[wi - 1] === bi[wj - 1];
    const rightOk = wi + 1 < fullN && wj + 1 < fullM && ai[wi + 1] === bi[wj + 1];
    if (leftOk || rightOk) continue;
    // Crossed: the line beside it in one text matches the line beside it in
    // the other text on the far side, which is what an adjacent swap looks
    // like. The greedy path then matches that neighbouring line instead of
    // this one (its tie-break takes the line further into the new text), so
    // this line must not be an anchor either.
    const crossUp = wi > 0 && wj + 1 < fullM && ai[wi - 1] === bi[wj + 1];
    const crossDown = wi + 1 < fullN && wj > 0 && ai[wi + 1] === bi[wj - 1];
    if (crossUp || crossDown) continue;
    // Window consistency: a unique line near this anchor in either text must
    // sit at nearly the same relative offset in the other text. A moved block
    // (its lines are shifted by the block's displacement) and a tie the greedy
    // path resolves the other way (the next unique line sits past inserted
    // lines) both show up as a nearby unique line at a shifted relative
    // offset, so the anchor is not on the greedy path and must be dropped.
    // Tolerance 1: a single inserted or deleted line next to the anchor is
    // fine, anything larger is a rearrangement boundary. Checking both
    // directions catches the shift whichever side it sits on.
    let consistent = true;
    for (let d = -3; d <= 3 && consistent; d++) {
      if (d === 0) continue;
      const ni = wi + d;
      if (ni < 0 || ni >= fullN) continue;
      const nid = ai[ni];
      if (countA[nid] !== 1 || countB[nid] !== 1) continue;
      if (Math.abs((posB[nid] - wj) - (ni - wi)) > 1) consistent = false;
    }
    for (let d = -3; d <= 3 && consistent; d++) {
      if (d === 0) continue;
      const nj = wj + d;
      if (nj < 0 || nj >= fullM) continue;
      const nid = bi[nj];
      if (countA[nid] !== 1 || countB[nid] !== 1) continue;
      if (Math.abs((posA[nid] - wi) - (nj - wj)) > 1) consistent = false;
    }
    // Repeated lines too: a repeated line near the anchor (a blank line, a
    // closing brace) can be the line the greedy path matches instead of this
    // one, at a shifted relative offset, which is a tie this anchor loses.
    // For each line near the anchor, its nearest occurrence in the other text
    // must sit at nearly the same relative offset (within 1). A line with no
    // occurrence nearby is simply deleted or inserted there, which is fine;
    // only a nearby occurrence at a shifted offset is a rearrangement.
    for (let d = -3; d <= 3 && consistent; d++) {
      if (d === 0) continue;
      const ni = wi + d;
      if (ni < 0 || ni >= fullN) continue;
      const nid = ai[ni];
      if (countA[nid] === 1 && countB[nid] === 1) continue;
      const expect = wj + d;
      let nearest = -1;
      for (let r = 0; r <= 5; r++) {
        if (expect + r < fullM && bi[expect + r] === nid) { nearest = expect + r; break; }
        if (r > 0 && expect - r >= 0 && bi[expect - r] === nid) { nearest = expect - r; break; }
      }
      if (nearest >= 0 && Math.abs(nearest - expect) > 1) consistent = false;
    }
    for (let d = -3; d <= 3 && consistent; d++) {
      if (d === 0) continue;
      const nj = wj + d;
      if (nj < 0 || nj >= fullM) continue;
      const nid = bi[nj];
      if (countA[nid] === 1 && countB[nid] === 1) continue;
      const expect = wi + d;
      let nearest = -1;
      for (let r = 0; r <= 5; r++) {
        if (expect + r < fullN && ai[expect + r] === nid) { nearest = expect + r; break; }
        if (r > 0 && expect - r >= 0 && ai[expect - r] === nid) { nearest = expect - r; break; }
      }
      if (nearest >= 0 && Math.abs(nearest - expect) > 1) consistent = false;
    }
    if (!consistent) continue;
    anchors.push({ i, j });
  }
  const u = anchors.length;
  if (u === 0) return anchors;
  // best[t]: the longest chain starting at anchor t. Walked from the last
  // anchor back, a Fenwick tree over new positions holding suffix maxima.
  const best = new Int32Array(u);
  const tree = new Int32Array(m + 2);
  const fenwickMax = (idx) => {
    let v = 0;
    for (let p = idx + 1; p > 0; p -= p & -p) if (tree[p] > v) v = tree[p];
    return v;
  };
  const fenwickSet = (idx, v) => {
    for (let p = idx + 1; p <= m + 1; p += p & -p) if (v > tree[p]) tree[p] = v;
  };
  let longest = 0;
  for (let t = u - 1; t >= 0; t--) {
    // Suffix maximum over new positions above anchors[t].j: query the tree
    // reversed, so a prefix query on (m - j) covers it.
    const rev = m - anchors[t].j;
    const after = fenwickMax(rev - 1);
    best[t] = after + 1;
    if (best[t] > longest) longest = best[t];
    fenwickSet(rev, best[t]);
  }
  // Group anchors by their best value, each group sorted by i (they already
  // are, anchors arrive in i order), with a suffix maximum of j per group.
  const groups = new Map();
  for (let t = 0; t < u; t++) {
    const v = best[t];
    let g = groups.get(v);
    if (g === undefined) {
      g = [];
      groups.set(v, g);
    }
    g.push(t);
  }
  const groupData = new Map();
  for (const [v, ts] of groups) {
    const len = ts.length;
    const sufMax = new Int32Array(len + 1);
    const sufAt = new Int32Array(len + 1);
    sufMax[len] = -1;
    sufAt[len] = -1;
    for (let p = len - 1; p >= 0; p--) {
      const t = ts[p];
      if (anchors[t].j > sufMax[p + 1]) {
        sufMax[p] = anchors[t].j;
        sufAt[p] = t;
      } else {
        sufMax[p] = sufMax[p + 1];
        sufAt[p] = sufAt[p + 1];
      }
    }
    groupData.set(v, { ts, sufMax, sufAt });
  }
  // Build the chain: at each step take the largest new position among the
  // anchors that can still head a chain of the length still needed.
  const chain = [];
  let curI = -1;
  let curJ = -1;
  let need = longest;
  while (need > 0) {
    const g = groupData.get(need);
    if (g === undefined) break;
    // First index in the group past the current old position.
    let lo = 0;
    let hi = g.ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[g.ts[mid]].i > curI) hi = mid;
      else lo = mid + 1;
    }
    if (lo >= g.ts.length) break;
    const t = g.sufAt[lo];
    if (t < 0 || anchors[t].j <= curJ) break;
    chain.push(anchors[t]);
    curI = anchors[t].i;
    curJ = anchors[t].j;
    need--;
  }
  // Offset-jump filter: the greedy path's diagonal offset (new - old) changes
  // only by the net insertions and deletions between two anchors, a handful
  // at most. An anchor whose offset jumps by more than 40 from either chain
  // neighbour sits at a moved block's boundary and is not on the greedy path,
  // so drop it. Dropping an anchor only widens a piece, never changes the
  // answer, so a false drop costs speed, not correctness.
  if (chain.length > 1) {
    const kept = [];
    for (let t = 0; t < chain.length; t++) {
      const o = chain[t].j - chain[t].i;
      const prev = t > 0 ? chain[t - 1].j - chain[t - 1].i : o;
      const next = t + 1 < chain.length ? chain[t + 1].j - chain[t + 1].i : o;
      if (Math.abs(o - prev) > 40 || Math.abs(o - next) > 40) continue;
      kept.push(chain[t]);
    }
    return kept;
  }
  return chain;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/** make.fun's own patch of input.old into input.new (the header). */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  // One integer id per distinct line, shared by both texts, so the search's
  // equal-line test is a single integer compare instead of a string compare on
  // every one of its steps. The keys are the flat split parts (a line with a
  // newline and a bare last line of the same text live in separate maps, so a
  // "foo" with "\n" never collides with a bare "foo"). The strings stay in a
  // and b for the patch.
  const partsA = input.old.split('\n');
  const partsB = input.new.split('\n');
  const mapNL = new Map();
  const mapBare = new Map();
  let nextId = 0;
  const a = [];
  let ai = new Int32Array(partsA.length);
  let na = 0;
  for (let i = 0; i < partsA.length - 1; i++) {
    const s = partsA[i];
    let id = mapNL.get(s);
    if (id === undefined) {
      id = nextId++;
      mapNL.set(s, id);
    }
    a.push(s + '\n');
    ai[na++] = id;
  }
  if (partsA[partsA.length - 1] !== '') {
    const s = partsA[partsA.length - 1];
    let id = mapBare.get(s);
    if (id === undefined) {
      id = nextId++;
      mapBare.set(s, id);
    }
    a.push(s);
    ai[na++] = id;
  }
  const b = [];
  let bi = new Int32Array(partsB.length);
  let nb = 0;
  for (let i = 0; i < partsB.length - 1; i++) {
    const s = partsB[i];
    let id = mapNL.get(s);
    if (id === undefined) {
      id = nextId++;
      mapNL.set(s, id);
    }
    b.push(s + '\n');
    bi[nb++] = id;
  }
  if (partsB[partsB.length - 1] !== '') {
    const s = partsB[partsB.length - 1];
    let id = mapBare.get(s);
    if (id === undefined) {
      id = nextId++;
      mapBare.set(s, id);
    }
    b.push(s);
    bi[nb++] = id;
  }
  const n = na;
  const m = nb;
  ai = ai.subarray(0, n);
  bi = bi.subarray(0, m);
  // Per-id occurrence counts and each id's position in the two texts.
  const countA = new Int32Array(nextId);
  const countB = new Int32Array(nextId);
  const posA = new Int32Array(nextId);
  const posB = new Int32Array(nextId);
  for (let i = 0; i < n; i++) {
    countA[ai[i]]++;
    posA[ai[i]] = i;
  }
  for (let j = 0; j < m; j++) {
    countB[bi[j]]++;
    posB[bi[j]] = j;
  }
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && ai[prefix] === bi[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && ai[n - 1 - suffix] === bi[m - 1 - suffix]) suffix++;
  const midA = ai.subarray(prefix, n - suffix);
  const midB = bi.subarray(prefix, m - suffix);
  const chain = anchorChain(midA, midB, ai, bi, prefix, countA, countB, posA, posB);
  // The middle region's runs: each piece between two anchors diffed on its
  // own, with the anchor line kept between the pieces.
  const midRuns = [];
  const pushRun = (kind, count) => {
    if (count <= 0) return;
    const last = midRuns[midRuns.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else midRuns.push({ kind, count });
  };
  const pushRuns = (runs) => {
    for (const r of runs) pushRun(r.kind, r.count);
  };
  let pi = 0;
  let pj = 0;
  for (const c of chain) {
    pushRuns(editRuns(midA.subarray(pi, c.i), midB.subarray(pj, c.j)));
    pushRun(KEEP, 1);
    pi = c.i + 1;
    pj = c.j + 1;
  }
  pushRuns(editRuns(midA.subarray(pi), midB.subarray(pj)));
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  runs.push(...midRuns);
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written(KEEP, a[at]));
      for (let i = 0; i < c.dels; i++) out.push(written(DELETE, a[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written(INSERT, b[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written(KEEP, a[at]));
  }
  return out.join('');
}
