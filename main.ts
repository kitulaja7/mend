// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Section 5: matching lines at three tiers. A line of O or N knows whether it is a context line. */
interface OldNewLine {
  text: string;
  context: boolean;
}

const trimRight = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEqualAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimRight(a) === trimRight(b);
  return trimBoth(a) === trimBoth(b);
}

/** Positions where O matches lines, at one tier; occurrences may overlap. */
function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEqualAt(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs in lines at or after `from`, and its positions there. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrencesAt(lines, o, tier).filter((p) => p >= from);
    if (at.length > 0) return { tier, positions: at };
  }
  return null;
}

/** Replace the O lines at `pos` with N. A context line of N is written as the file's own matched line; at tier 2 every other line of N is re-indented. */
function replaceAt(lines: string[], o: OldNewLine[], n: OldNewLine[], tier: number, pos: number): string[] {
  const out = lines.slice(0, pos);
  const oContextAt: number[] = [];
  o.forEach((l, j) => {
    if (l.context) oContextAt.push(j);
  });
  const f = pos < lines.length ? leadingWS(lines[pos]!) : '';
  const p = o.length === 0 ? '' : leadingWS(o[0]!.text);
  let ci = 0;
  for (const l of n) {
    if (l.context) {
      out.push(lines[pos + oContextAt[ci]!]!);
      ci += 1;
    } else if (tier === 2 && l.text !== '' && l.text.trim() !== '' && l.text.startsWith(p)) {
      out.push(f + l.text.slice(p.length));
    } else {
      out.push(l.text);
    }
  }
  out.push(...lines.slice(pos + o.length));
  return out;
}

/** A file's text as its lines, its own line break, and whether it ends with one (section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}


/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, as [old, new] pairs; the section 2 output turns qualifying ones into R rows. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** Section 2 output: one line per changed path, in byte order of the paths (an R row sorts by its new path), then the ok line. Writes the files unless `check`. */
function writeAndReport(tree: Tree, check: boolean): string[] {
  const rByNew = new Map<string, string>();
  const rOld = new Set<string>();
  for (const [old, nw] of tree.moves) {
    const wasOld = tree.original(old);
    const nowOld = tree.get(old);
    const wasNew = tree.original(nw);
    const nowNew = tree.get(nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rByNew.set(nw, `R ${old} -> ${nw}`);
      rOld.add(old);
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const [nw, line] of rByNew) rows.push({ key: nw, line });
  for (const p of tree.now.keys()) {
    if (rByNew.has(p) || rOld.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 6: unified diffs. */

interface HunkBodyLine {
  kind: 'context' | 'old' | 'new' | 'backslash';
  text: string;
  rawBlank: boolean;
}

interface Hunk {
  a: number;
  body: HunkBodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNewlineAtEnd: boolean;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  /** A `\` line follows the section's last `+` line (for creations). */
  lastPlusNoNewline: boolean;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path a `--- ` or `+++ ` line names: the text after the four characters, up to the first tab, trimmed; /dev/null is no file. */
function headerPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const path = (tab < 0 ? rest : rest.slice(0, tab)).trim();
  if (path === '/dev/null') return null;
  return stripAB(path);
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let acc: {
    pairOld?: string | null;
    pairNew?: string | null;
    renameOld?: string;
    renameNew?: string;
    diffOld: string;
    diffNew: string;
    newFile: boolean;
    deletedFile: boolean;
    hunks: Hunk[];
  } | null = null;
  let hunk: Hunk | null = null;
  let state: 'out' | 'header' | 'body' | 'post' = 'out';

  const closeHunk = (): void => {
    if (hunk === null || acc === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.rawBlank) hunk.body.pop();
    let last = -1;
    for (let i = 0; i < hunk.body.length; i += 1) {
      if (hunk.body[i]!.kind === 'context' || hunk.body[i]!.kind === 'new') last = i;
    }
    hunk.noNewlineAtEnd = last >= 0 && last + 1 < hunk.body.length && hunk.body[last + 1]!.kind === 'backslash';
    acc.hunks.push(hunk);
    hunk = null;
  };

  const closeSection = (): void => {
    if (acc === null) return;
    closeHunk();
    const oldPath = acc.pairOld !== undefined ? acc.pairOld : acc.renameOld !== undefined ? acc.renameOld : acc.diffOld;
    const newPath = acc.pairNew !== undefined ? acc.pairNew : acc.renameNew !== undefined ? acc.renameNew : acc.diffNew;
    let lastPlus = false;
    outer: for (let hi = acc.hunks.length - 1; hi >= 0; hi -= 1) {
      const b = acc.hunks[hi]!.body;
      for (let i = b.length - 1; i >= 0; i -= 1) {
        if (b[i]!.kind === 'new') {
          lastPlus = i + 1 < b.length && b[i + 1]!.kind === 'backslash';
          break outer;
        }
      }
    }
    sections.push({ oldPath, newPath, newFile: acc.newFile, deletedFile: acc.deletedFile, hunks: acc.hunks, lastPlusNoNewline: lastPlus });
    acc = null;
    state = 'out';
  };

  const startSection = (diffOldPath: string, diffNewPath: string): void => {
    closeSection();
    acc = { diffOld: diffOldPath, diffNew: diffNewPath, newFile: false, deletedFile: false, hunks: [] };
    state = 'header';
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(stripAB(m[1]!), stripAB(m[2]!));
      continue;
    }
    if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      if (state === 'header' && acc !== null) {
        acc.pairOld = headerPath(line);
        acc.pairNew = headerPath(next);
      } else {
        startSection('', '');
        acc!.pairOld = headerPath(line);
        acc!.pairNew = headerPath(next);
      }
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (state === 'header') throw new Exit2(`error: parse ${i + 2}`);
      if (state === 'body' && hunk !== null) hunk.body.push({ kind: 'old', text: line.slice(1), rawBlank: false });
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (acc === null) throw new Exit2(`error: parse ${i + 1}`);
      closeHunk();
      hunk = { a: Number(m[1]), body: [], noNewlineAtEnd: false };
      state = 'body';
      continue;
    }
    if (state === 'body' && hunk !== null) {
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        const kind = line === '' || line[0] === ' ' ? 'context' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : 'backslash';
        hunk.body.push({ kind, text: line === '' ? '' : line.slice(1), rawBlank: blank(line) });
        continue;
      }
      closeHunk();
      state = 'post';
      continue;
    }
    if (state === 'header' && acc !== null) {
      if (line.startsWith('+++ ')) acc.pairNew = headerPath(line);
      else if (line.startsWith('rename from ')) acc.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) acc.renameNew = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) acc.newFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) acc.deletedFile = true;
      continue;
    }
  }
  closeSection();
  return sections;
}

/** Apply one hunk to a file's lines and final-break state; d is the drift of the hunks applied so far. */
function applyUnifiedHunk(lines: string[], final: boolean, h: Hunk, strict: boolean, d: number, path: string): { lines: string[]; final: boolean; delta: number } {
  const o: OldNewLine[] = [];
  const n: OldNewLine[] = [];
  for (const l of h.body) {
    if (l.kind === 'context') {
      o.push({ text: l.text, context: true });
      n.push({ text: l.text, context: true });
    } else if (l.kind === 'old') o.push({ text: l.text, context: false });
    else if (l.kind === 'new') n.push({ text: l.text, context: false });
  }
  if (o.length === 0) {
    const at = Math.min(h.a + d, lines.length);
    const inserted = n.map((l) => l.text);
    const out = [...lines.slice(0, at), ...inserted, ...lines.slice(at)];
    const newFinal = at === lines.length ? !h.noNewlineAtEnd : final;
    return { lines: out, final: newFinal, delta: n.length };
  }
  const found = findTier(lines, o.map((l) => l.text), strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.positions[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const out = replaceAt(lines, o, n, found.tier, best);
  const matchedToEnd = best + o.length === lines.length;
  const newFinal = matchedToEnd ? !h.noNewlineAtEnd : final;
  return { lines: out, final: newFinal, delta: n.length - o.length };
}

function unifiedSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.oldPath === null || sec.newFile) {
      const p = sec.newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      for (const h of sec.hunks) for (const l of h.body) if (l.kind === 'new') out.push(l.text);
      tree.now.set(p, joinFile(out, '\n', !sec.lastPlusNoNewline));
      return;
    }
    if (sec.newPath === null || sec.deletedFile) {
      const p = sec.oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldPath!;
    const newP = sec.newPath!;
    const isMove = oldP !== newP;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = splitFile(before);
    let lines = f.lines;
    let final = f.final;
    let d = 0;
    for (const h of sec.hunks) {
      const applied = applyUnifiedHunk(lines, final, h, strict, d, oldP);
      lines = applied.lines;
      final = applied.final;
      d += applied.delta;
    }
    const out = joinFile(lines, f.br, final);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedSectionEdit(sec, strict));
}

/** Section 7: SEARCH/REPLACE blocks. */

interface SearchBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SearchBlock[] {
  const blocks: SearchBlock[] = [];
  let i = 0;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevReplaceEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchAt + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchAt + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevReplaceEnd = end;
    i = end + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((block) => {
    return (tree) => {
      const p = block.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (block.oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile(block.newLines, '\n', true));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, block.oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const o: OldNewLine[] = block.oldLines.map((t) => ({ text: t, context: false }));
      const n: OldNewLine[] = block.newLines.map((t) => ({ text: t, context: false }));
      const out = replaceAt(f.lines, o, n, found.tier, found.positions[0]!);
      tree.now.set(p, joinFile(out, f.br, f.final));
    };
  });
}

/** Section 8: V4A patches. */

interface V4aChunk {
  anchor: string | null;
  body: HunkBodyLine[];
  endOfFile: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: Array<{ text: string; rawBlank: boolean }>;
  chunks: V4aChunk[];
  lineNo: number;
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let sec: V4aSection | null = null;
  let chunk: V4aChunk | null = null;
  let moveSeen = false;
  let chunkStarted = false;
  let secHasContent = false;

  const closeChunk = (): void => {
    if (chunk === null || sec === null) return;
    sec.chunks.push(chunk);
    chunk = null;
  };

  const closeSection = (): void => {
    if (sec === null) return;
    if (chunk !== null) {
      while (chunk.body.length > 0 && chunk.body[chunk.body.length - 1]!.rawBlank) chunk.body.pop();
      sec.chunks.push(chunk);
      chunk = null;
    }
    if (sec.kind === 'add') {
      while (sec.addLines.length > 0 && sec.addLines[sec.addLines.length - 1]!.rawBlank) sec.addLines.pop();
    }
    if (sec.kind === 'update' && sec.chunks.length === 0 && sec.moveTo === null) {
      throw new Exit2(`error: parse ${sec.lineNo}`);
    }
    sections.push(sec);
    sec = null;
  };

  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      closeSection();
      const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      sec = { kind, path: line.slice(prefix.length).trim(), moveTo: null, addLines: [], chunks: [], lineNo: i + 1 };
      chunk = null;
      moveSeen = false;
      chunkStarted = false;
      secHasContent = false;
      continue;
    }
    if (sec === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (sec.kind === 'add') {
      if (line.startsWith('+')) {
        sec.addLines.push({ text: line.slice(1), rawBlank: false });
        secHasContent = true;
        continue;
      }
      if (blank(line)) {
        sec.addLines.push({ text: '', rawBlank: true });
        secHasContent = true;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (sec.kind === 'delete') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (line.startsWith('*** Move to: ')) {
      if (secHasContent || moveSeen) throw new Exit2(`error: parse ${i + 1}`);
      sec.moveTo = line.slice('*** Move to: '.length).trim();
      moveSeen = true;
      secHasContent = true;
      continue;
    }
    if (line === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
      chunk.endOfFile = true;
      closeChunk();
      secHasContent = true;
      continue;
    }
    if (line.startsWith('@@')) {
      closeChunk();
      const anchorText = line.slice(2).trim();
      chunk = { anchor: anchorText === '' ? null : anchorText, body: [], endOfFile: false };
      chunkStarted = true;
      secHasContent = true;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || blank(line)) {
      if (chunk === null) {
        if (chunkStarted) {
          if (blank(line)) continue;
          throw new Exit2(`error: parse ${i + 1}`);
        }
        chunk = { anchor: null, body: [], endOfFile: false };
        chunkStarted = true;
      }
      const isPrefix = line.startsWith(' ') || line.startsWith('-') || line.startsWith('+');
      const kind = blank(line) ? 'context' : line[0] === ' ' ? 'context' : line[0] === '-' ? 'old' : 'new';
      chunk.body.push({ kind, text: isPrefix ? line.slice(1) : '', rawBlank: blank(line) });
      secHasContent = true;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  closeSection();
  return sections;
}

/** Apply one V4A chunk to a file's lines, from the cursor; returns the new lines and cursor. */
function applyV4aChunk(lines: string[], ch: V4aChunk, strict: boolean, cursor: number, path: string): { lines: string[]; cursor: number } {
  let cur = cursor;
  if (ch.anchor !== null) {
    const tiers = strict ? [0] : [0, 1, 2];
    let foundAt = -1;
    for (const tier of tiers) {
      for (let i = cur; i < lines.length; i += 1) {
        if (lineEqualAt(lines[i]!, ch.anchor, tier)) {
          foundAt = i;
          break;
        }
      }
      if (foundAt >= 0) break;
    }
    if (foundAt < 0) throw new Fail('no-match', path);
    cur = foundAt + 1;
  }
  const o: OldNewLine[] = [];
  const n: OldNewLine[] = [];
  for (const l of ch.body) {
    if (l.kind === 'context') {
      o.push({ text: l.text, context: true });
      n.push({ text: l.text, context: true });
    } else if (l.kind === 'old') o.push({ text: l.text, context: false });
    else if (l.kind === 'new') n.push({ text: l.text, context: false });
  }
  if (o.length === 0) {
    const at = ch.endOfFile ? lines.length : cur;
    const inserted = n.map((l) => l.text);
    const out = [...lines.slice(0, at), ...inserted, ...lines.slice(at)];
    return { lines: out, cursor: at + inserted.length };
  }
  const oTexts = o.map((l) => l.text);
  let found: { tier: number; positions: number[] } | null = null;
  if (ch.endOfFile) {
    const pos = lines.length - o.length;
    if (pos >= cur) {
      const tiers = strict ? [0] : [0, 1, 2];
      for (const tier of tiers) {
        let ok = true;
        for (let j = 0; j < o.length; j += 1) {
          if (!lineEqualAt(lines[pos + j]!, oTexts[j]!, tier)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          found = { tier, positions: [pos] };
          break;
        }
      }
    }
  } else {
    found = findTier(lines, oTexts, strict, cur);
  }
  if (found === null) throw new Fail('no-match', path);
  const pos = found.positions[0]!;
  const out = replaceAt(lines, o, n, found.tier, pos);
  return { lines: out, cursor: pos + n.length };
}

function v4aSectionEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinFile(sec.addLines.map((l) => l.text), '\n', true));
      return;
    }
    if (sec.kind === 'delete') {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of sec.chunks) {
      const applied = applyV4aChunk(lines, ch, strict, cursor, p);
      lines = applied.lines;
      cursor = applied.cursor;
    }
    const out = joinFile(lines, f.br, f.final);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((sec) => v4aSectionEdit(sec, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  return { code: 0, out: writeAndReport(tree, check) };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
