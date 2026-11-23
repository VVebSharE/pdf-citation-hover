// Resolves an internal PDF link (e.g. a citation) to the text of the
// bibliography entry it points at, and extracts the paper title from it.
// Environment-agnostic: works with any PDF.js PDFDocumentProxy.

// Named destinations that are clearly not bibliography entries (hyperref etc.).
const NON_CITE_DEST =
  /^(page|part|chapter|section|subsection|subsubsection|paragraph|subparagraph|appendix|figure|subfigure|table|subtable|equation|AMS|Item|Hfootnote|footnote|lstlisting|lstnumber|algorithm|algocf|ALG@line|theorem|lemma|definition|corollary|proposition|remark|example|assumption|claim|note|doc-start|Doc-Start)[.*@-]/i;

const LABEL_RE = /^\s*(\[[^\]]{1,12}\]|\d{1,4}\.\s)/;
const YEAR_RE = /\b(1[89]|20)\d{2}[a-z]?\b/;

export class CitationResolver {
  constructor(pdfDocument) {
    this.doc = pdfDocument;
    this.annotations = new Map(); // pageIndex -> Promise<annotations[]>
    this.segments = new Map(); // pageIndex -> Promise<segments[]>
    this.results = new Map(); // dest key -> Promise<result|null>
    this.namedDests = null; // Promise<object|null>
  }

  /** Resolve the link annotation `annotationId` on 1-based `pageNumber`. */
  async resolveAnnotation(pageNumber, annotationId) {
    const idx = pageNumber - 1;
    if (!this.annotations.has(idx)) {
      this.annotations.set(
        idx,
        this.doc.getPage(pageNumber).then((p) => p.getAnnotations())
      );
    }
    const annots = await this.annotations.get(idx);
    const a = annots.find((x) => x.id === annotationId);
    if (!a || a.dest == null || a.url) return null;
    return this.resolveDest(a.dest);
  }

  /** Resolve a destination (name string or explicit array). */
  resolveDest(dest) {
    const key = typeof dest === "string" ? "n:" + dest : "e:" + JSON.stringify(dest);
    if (!this.results.has(key)) {
      this.results.set(key, this.#resolve(dest).catch(() => null));
    }
    return this.results.get(key);
  }

  async #resolve(dest) {
    const name = typeof dest === "string" ? dest : null;
    if (name && NON_CITE_DEST.test(name)) return null;
    const explicit = name ? await this.doc.getDestination(name) : dest;
    if (!Array.isArray(explicit)) return null;

    const target = await this.#destToTarget(explicit);
    if (target == null) return null;

    const text = await this.#extractEntry(target);
    if (!text) return null;
    const isCite = !!name && /^cite[.:]/i.test(name);
    if (!isCite && !looksLikeReference(text)) return null;
    return { title: extractTitle(text), text };
  }

  async #destToTarget(explicit) {
    const [ref, kind, ...args] = explicit;
    let pageIndex;
    if (Number.isInteger(ref)) pageIndex = ref;
    else if (ref && typeof ref === "object") pageIndex = await this.doc.getPageIndex(ref);
    else return null;
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
    let x = null;
    let y = null;
    switch (kind?.name) {
      case "XYZ": x = num(args[0]); y = num(args[1]); break;
      case "FitH": case "FitBH": y = num(args[0]); break;
      case "FitV": case "FitBV": x = num(args[0]); break;
      case "FitR": x = num(args[0]); y = num(args[3]); break;
    }
    return { pageIndex, x, y, ref };
  }

  // ---- page text as positioned line segments ---------------------------

  #getSegments(pageIndex) {
    if (!this.segments.has(pageIndex)) {
      this.segments.set(pageIndex, this.#buildSegments(pageIndex));
    }
    return this.segments.get(pageIndex);
  }

  async #buildSegments(pageIndex) {
    const page = await this.doc.getPage(pageIndex + 1);
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (typeof it.str !== "string" || it.str === "") continue;
      const t = it.transform;
      if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue; // rotated
      const h = Math.abs(t[3]) || it.height || 10;
      items.push({ x: t[4], y: t[5], w: it.width || 0, h, str: it.str });
    }
    items.sort((a, b) => b.y - a.y || a.x - b.x);

    // Group items into rows by baseline.
    const rows = [];
    for (const it of items) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row.y - it.y) <= Math.max(1, 0.35 * Math.min(row.h, it.h))) {
        row.items.push(it);
        row.h = Math.max(row.h, it.h);
      } else {
        rows.push({ y: it.y, h: it.h, items: [it] });
      }
    }

    // Split rows into segments at large horizontal gaps (columns).
    const segs = [];
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      let cur = null;
      const parts = [];
      for (const it of row.items) {
        if (cur && it.x - cur.x1 > Math.max(8, 1.0 * row.h)) {
          parts.push(cur);
          cur = null;
        }
        if (!cur) {
          cur = { x0: it.x, x1: it.x + it.w, y: row.y, h: it.h, text: it.str };
        } else {
          const gap = it.x - cur.x1;
          if (gap > 0.12 * it.h && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += " ";
          cur.text += it.str;
          cur.x1 = Math.max(cur.x1, it.x + it.w);
          cur.h = Math.max(cur.h, it.h);
        }
      }
      if (cur) parts.push(cur);
      // Re-attach short labels like "[12]" that got separated from their text.
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const next = parts[i + 1];
        if (next && /^\s*\[?[\w.]{1,6}\]?\.?\s*$/.test(p.text) && next.x0 - p.x1 < 4 * row.h) {
          next.text = p.text.trim() + " " + next.text;
          next.labelX = p.x0;
          continue;
        }
        p.text = p.text.replace(/\s+/g, " ").trim();
        if (p.text) segs.push(p);
      }
    }
    return segs;
  }

  // ---- other named destinations on a page (entry boundaries) -------------

  async #boundaries(target) {
    if (!this.namedDests) {
      this.namedDests = this.doc.getDestinations().catch(() => null);
    }
    const dests = await this.namedDests;
    if (!dests) return [];
    const page = await this.doc.getPage(target.pageIndex + 1);
    const pref = page.ref;
    const out = [];
    for (const [name, d] of Object.entries(dests)) {
      if (!Array.isArray(d) || /^page\./i.test(name)) continue;
      const r = d[0];
      const onPage = Number.isInteger(r)
        ? r === target.pageIndex
        : r && pref && r.num === pref.num && r.gen === pref.gen;
      if (!onPage) continue;
      const kind = d[1]?.name;
      let x = null;
      let y = null;
      if (kind === "XYZ") { x = d[2]; y = d[3]; }
      else if (kind === "FitH" || kind === "FitBH") y = d[2];
      else if (kind === "FitR") { x = d[2]; y = d[5]; }
      if (typeof y !== "number") continue;
      out.push({ x: typeof x === "number" ? x : null, y });
    }
    return out;
  }

  // ---- find the entry's lines -------------------------------------------

  async #extractEntry(target) {
    const segs = await this.#getSegments(target.pageIndex);
    if (!segs.length) return null;

    const inColumn = (s) =>
      target.x == null || (s.x1 >= target.x - 2 && (s.labelX ?? s.x0) <= target.x + 40);

    // Starting line: closest line just below the destination's top.
    let start = null;
    if (target.y == null) {
      start = segs.find(inColumn) || null;
    } else {
      const pick = (lo, hiMul) => {
        let best = null;
        let bestScore = Infinity;
        for (const s of segs) {
          if (!inColumn(s)) continue;
          const dy = target.y - s.y;
          if (dy < lo * s.h || dy > hiMul * s.h + 6) continue;
          const score = dy + (target.x != null ? 0.05 * Math.abs(s.x0 - target.x) : 0);
          if (score < bestScore) { bestScore = score; best = s; }
        }
        return best;
      };
      start = pick(0.15, 3) || pick(-0.6, 3);
      if (start && !LABEL_RE.test(start.text)) {
        // Destination at the baseline: the line just above may be the real start.
        const above = segs.find(
          (s) => s !== start && inColumn(s) && s.y > start.y &&
            target.y - s.y >= -0.6 * s.h && target.y - s.y < 0.15 * s.h && LABEL_RE.test(s.text)
        );
        if (above) start = above;
      }
    }
    if (!start) return null;

    const boundaries = (await this.#boundaries(target)).filter(
      (b) => !(Math.abs(b.y - (target.y ?? NaN)) < 0.5 &&
        (b.x == null || target.x == null || Math.abs(b.x - target.x) < 0.5))
    );
    const colL = start.labelX ?? start.x0;
    const colR = start.x1;
    const sameColumn = (b) =>
      b.x == null || (target.x != null ? Math.abs(b.x - target.x) < 30 : b.x >= colL - 30 && b.x <= colR);

    const below = segs
      .filter((s) => s.y < start.y - 0.3 * start.h && s.x0 >= colL - 3 && s.x0 < colR - 5 && s.x1 > colL + 5)
      .sort((a, b) => b.y - a.y || a.x0 - b.x0);

    const lines = [start];
    const startHasLabel = LABEL_RE.test(start.text);
    const h = start.h;
    let prev = start;
    let firstGap = null;
    let contX = null;
    for (const s of below) {
      const gap = prev.y - s.y;
      if (gap < 0.3 * h) continue;
      if (gap > 1.9 * h) break;
      if (firstGap == null ? gap > 1.45 * h : gap > firstGap + 0.25 * h) break;
      if (startHasLabel && LABEL_RE.test(s.text)) break;
      if (contX != null && contX > colL + 2 && Math.abs(s.x0 - colL) < 1.5) break; // back at hanging indent
      if (boundaries.some((b) => sameColumn(b) && b.y > s.y + 0.3 * h && b.y <= prev.y + 0.3 * h)) break;
      if (firstGap == null) { firstGap = gap; contX = s.x0; }
      lines.push(s);
      prev = s;
      if (lines.length >= 8) break;
    }

    let text = "";
    for (const l of lines) {
      const t = l.text.trim();
      if (!text) text = t;
      else if (/\p{L}-$/u.test(text)) text += t; // keep hyphen: compounds ("high-fidelity") are common in titles
      else text += " " + t;
    }
    return text.replace(/\s+/g, " ").trim().slice(0, 1200);
  }
}

export function looksLikeReference(text) {
  return (
    text.length > 30 &&
    (YEAR_RE.test(text) || /arXiv|doi|Proceedings|Journal|Conference/i.test(text)) &&
    !/^(fig(ure)?|table|tab\.|eq(uation)?|algorithm|section|appendix|theorem|lemma)\b/i.test(text)
  );
}

// ---- title extraction -----------------------------------------------------

const ABBREV = /^(vs|Jr|Sr|St|Dr|Mr|Ms|Mrs|Prof|no|No|vol|Vol|pp|ed|eds|Ed|Eds|Proc|Conf|Int|Intl|Trans|Univ|Dept|Fig|Eq|e\.g|i\.e|cf|approx)$/;

function isAbbrev(tok) {
  tok = tok.replace(/^[(\["“]+/, "");
  if (/^(\p{Lu}\.)*-?\p{Lu}$/u.test(tok)) return true; // initials: A, J.-P, U.S
  if (/^\p{Lu}\.-\p{Lu}$/u.test(tok)) return true;
  return ABBREV.test(tok);
}

export function splitSentences(s) {
  const out = [];
  let start = 0;
  const re = /([.?!])(["”’)]?)\s+(?=\S)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] === ".") {
      const before = s.slice(start, m.index);
      const lastTok = before.split(/\s+/).pop() || "";
      if (isAbbrev(lastTok)) continue;
    }
    out.push(s.slice(start, m.index + 1 + m[2].length).trim());
    start = re.lastIndex;
  }
  if (start < s.length) out.push(s.slice(start).trim());
  return out.filter(Boolean);
}

function cleanTitle(t) {
  if (!t) return null;
  t = t.replace(/^[\s"“”'‘’]+|[\s"“”'‘’,.;:]+$/g, "").replace(/\s+/g, " ");
  t = t.replace(/,\s*(1[89]|20)\d{2}[a-z]?$/, ""); // trailing ", 2025"
  if (t.length < 4) return null;
  return t.length > 300 ? t.slice(0, 297) + "…" : t;
}

export function extractTitle(raw) {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/^(\[[^\]]{1,12}\]|\(\d{1,4}\)|\d{1,4}\.(?=\s))\s*/, "");

  // IEEE / ACM style: title in quotes.
  const q = s.match(/[“"]\s*([^“”"]{8,}?)\s*[”"]/);
  if (q) return cleanTitle(q[1]);

  // Springer LNCS style: "Wang, A., Ai, B.: Title. In: ..."
  const lncs = s.match(/(\p{Lu}\.|et al\.):\s+/u);
  if (lncs && lncs.index < s.length * 0.6) {
    return cleanTitle(splitSentences(s.slice(lncs.index + lncs[0].length))[0]);
  }

  const sents = splitSentences(s);
  if (sents.length < 2) return null;
  let i = 1;
  // ACL/natbib style "Authors. 2025. Title." -> skip the bare year sentence.
  if (/^\(?(1[89]|20)\d{2}[a-z]?\)?\.?$/.test(sents[1])) i = 2;
  return cleanTitle(sents[i]);
}
