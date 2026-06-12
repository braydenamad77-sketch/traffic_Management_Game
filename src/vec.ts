// 2D vector + curve/polyline math. Screen coords: y grows downward, so a
// positive signed angle between headings is a RIGHT turn and perp() points
// to the right of travel.

export interface V { x: number; y: number; }

export const v = (x: number, y: number): V => ({ x, y });
export const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: V, s: number): V => ({ x: a.x * s, y: a.y * s });
export const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y;
export const cross = (a: V, b: V): number => a.x * b.y - a.y * b.x;
export const len = (a: V): number => Math.hypot(a.x, a.y);
export const dist = (a: V, b: V): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function norm(a: V): V {
  const l = len(a);
  return l < 1e-9 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Right-of-travel normal (screen coords, y down). */
export const perp = (a: V): V => ({ x: -a.y, y: a.x });

/** Signed angle from heading a to heading b, in (-PI, PI]. Positive = right turn. */
export function signedAngle(a: V, b: V): number {
  return Math.atan2(cross(a, b), dot(a, b));
}

export const angleOf = (a: V): number => Math.atan2(a.y, a.x);
export const fromAngle = (t: number): V => ({ x: Math.cos(t), y: Math.sin(t) });

export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/* ---------------- cubic bezier ---------------- */

export type Bez = [V, V, V, V];

export function bezPoint(b: Bez, t: number): V {
  const u = 1 - t;
  const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
  return {
    x: w0 * b[0].x + w1 * b[1].x + w2 * b[2].x + w3 * b[3].x,
    y: w0 * b[0].y + w1 * b[1].y + w2 * b[2].y + w3 * b[3].y,
  };
}

/** Build a bezier from endpoints + unit tangents (Hermite-style). */
export function bezFromTangents(p0: V, t0: V, p3: V, t3: V): Bez {
  const d = dist(p0, p3) / 3;
  return [p0, add(p0, mul(t0, d)), sub(p3, mul(t3, d)), p3];
}

export function sampleBez(b: Bez, n: number): V[] {
  const pts: V[] = [];
  for (let i = 0; i <= n; i++) pts.push(bezPoint(b, i / n));
  return pts;
}

/** Unit tangent of the bezier at parameter t (analytic derivative). */
export function bezTangent(b: Bez, t: number): V {
  const u = 1 - t;
  const d = {
    x: 3 * u * u * (b[1].x - b[0].x) + 6 * u * t * (b[2].x - b[1].x) + 3 * t * t * (b[3].x - b[2].x),
    y: 3 * u * u * (b[1].y - b[0].y) + 6 * u * t * (b[2].y - b[1].y) + 3 * t * t * (b[3].y - b[2].y),
  };
  if (len(d) < 1e-9) return norm(sub(b[3], b[0]));
  return norm(d);
}

/** Sample a bezier into points + analytic unit tangents. */
export function sampleBezT(b: Bez, n: number): { pts: V[]; tans: V[] } {
  const pts: V[] = [], tans: V[] = [];
  for (let i = 0; i <= n; i++) {
    pts.push(bezPoint(b, i / n));
    tans.push(bezTangent(b, i / n));
  }
  return { pts, tans };
}

/* ---------------- polylines with arc length ---------------- */

export interface Poly {
  pts: V[];
  cum: number[];  // cumulative arc length per point, cum[0] = 0
  len: number;
  /** optional analytic unit tangents per point — keeps offsets/joins exact */
  tans?: V[];
}

export function makePoly(pts: V[], tans?: V[]): Poly {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { pts, cum, len: cum[cum.length - 1], tans };
}

/** Point at arc length s (clamped). */
export function polyPoint(p: Poly, s: number): V {
  s = clamp(s, 0, p.len);
  let i = upperSeg(p, s);
  const segLen = p.cum[i + 1] - p.cum[i];
  const t = segLen < 1e-9 ? 0 : (s - p.cum[i]) / segLen;
  return lerp(p.pts[i], p.pts[i + 1], t);
}

/** Unit tangent at arc length s. */
export function polyTangent(p: Poly, s: number): V {
  s = clamp(s, 0, p.len);
  const i = upperSeg(p, s);
  if (p.tans) {
    const segLen = p.cum[i + 1] - p.cum[i];
    const t = segLen < 1e-9 ? 0 : (s - p.cum[i]) / segLen;
    const blended = add(mul(p.tans[i], 1 - t), mul(p.tans[i + 1], t));
    if (len(blended) > 1e-6) return norm(blended);
  }
  return norm(sub(p.pts[i + 1], p.pts[i]));
}

function upperSeg(p: Poly, s: number): number {
  // binary search for segment index where cum[i] <= s <= cum[i+1]
  let lo = 0, hi = p.cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.cum[mid] <= s) lo = mid; else hi = mid - 1;
  }
  return Math.min(lo, p.pts.length - 2);
}

/** Sub-polyline between arc lengths s0..s1 (carries tangents if present). */
export function subPoly(p: Poly, s0: number, s1: number): Poly {
  s0 = clamp(s0, 0, p.len); s1 = clamp(s1, s0, p.len);
  const pts: V[] = [polyPoint(p, s0)];
  const tans: V[] | undefined = p.tans ? [polyTangent(p, s0)] : undefined;
  for (let i = 0; i < p.pts.length; i++) {
    if (p.cum[i] > s0 + 1e-6 && p.cum[i] < s1 - 1e-6) {
      pts.push(p.pts[i]);
      if (tans) tans.push(p.tans![i]);
    }
  }
  pts.push(polyPoint(p, s1));
  if (tans) tans.push(polyTangent(p, s1));
  return makePoly(pts, tans);
}

/** Offset a polyline laterally (positive = right of travel). */
export function offsetPoly(p: Poly, off: number): V[] {
  const n = p.pts.length;
  if (p.tans) {
    // analytic normals: ends of adjoining curves offset identically
    return p.pts.map((pt, i) => add(pt, mul(perp(p.tans![i]), off)));
  }
  const out: V[] = [];
  for (let i = 0; i < n; i++) {
    const tPrev = i > 0 ? norm(sub(p.pts[i], p.pts[i - 1])) : norm(sub(p.pts[1], p.pts[0]));
    const tNext = i < n - 1 ? norm(sub(p.pts[i + 1], p.pts[i])) : tPrev;
    const m = norm(add(tPrev, tNext));        // miter direction basis
    const cosHalf = Math.sqrt(Math.max(0.2, (1 + dot(tPrev, tNext)) / 2));
    out.push(add(p.pts[i], mul(perp(m), off * Math.min(1 / cosHalf, 2.2))));
  }
  return out;
}

/** Closest point on polyline; returns arc length + distance. */
export function projectOnPoly(p: Poly, q: V): { s: number; d: number; pt: V } {
  let best = { s: 0, d: Infinity, pt: p.pts[0] };
  for (let i = 0; i < p.pts.length - 1; i++) {
    const a = p.pts[i], b = p.pts[i + 1];
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 < 1e-9 ? 0 : clamp(dot(sub(q, a), ab) / l2, 0, 1);
    const pt = lerp(a, b, t);
    const d = dist(q, pt);
    if (d < best.d) best = { s: p.cum[i] + Math.sqrt(l2) * t, d, pt };
  }
  return best;
}

/** All intersections between two polylines: arc positions on each. */
export function polyIntersections(a: Poly, b: Poly): { sa: number; sb: number; pt: V }[] {
  const hits: { sa: number; sb: number; pt: V }[] = [];
  for (let i = 0; i < a.pts.length - 1; i++) {
    for (let j = 0; j < b.pts.length - 1; j++) {
      const h = segIntersect(a.pts[i], a.pts[i + 1], b.pts[j], b.pts[j + 1]);
      if (h) {
        hits.push({
          sa: a.cum[i] + h.t * (a.cum[i + 1] - a.cum[i]),
          sb: b.cum[j] + h.u * (b.cum[j + 1] - b.cum[j]),
          pt: h.pt,
        });
      }
    }
  }
  return hits;
}

function segIntersect(p1: V, p2: V, p3: V, p4: V): { t: number; u: number; pt: V } | null {
  const d1 = sub(p2, p1), d2 = sub(p4, p3);
  const denom = cross(d1, d2);
  if (Math.abs(denom) < 1e-9) return null;
  const t = cross(sub(p3, p1), d2) / denom;
  const u = cross(sub(p3, p1), d1) / denom;
  if (t < 1e-4 || t > 1 - 1e-4 || u < 1e-4 || u > 1 - 1e-4) return null;
  return { t, u, pt: lerp(p1, p2, t) };
}

export function pointInPolygon(q: V, poly: V[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}
