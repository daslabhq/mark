/**
 * Predicate evaluator.
 *
 * Pure function: (world, predicate) → {satisfied, gap, evidence}.
 *
 * Properties we maintain:
 *   - Deterministic: same inputs always produce same output.
 *   - Total: every Predicate shape is handled; no exceptions on unknown ops.
 *   - Diagnostic: failures explain themselves via `evidence`.
 *   - Gradient-friendly: `gap` is non-negative, 0 iff satisfied. For composites
 *     we sum sub-gaps so partial progress is visible (this is the property
 *     that makes mark a heuristic in the A* sense, not just a checker).
 *
 * Evidence strings are intentionally short and structured — they're meant
 * to land in agent context windows, not human dashboards.
 */

import type { Predicate, EvalResult } from "./predicate.js";
import { resolve, lookup } from "./path.js";

export function evaluate(world: unknown, p: Predicate): EvalResult {
  switch (p.op) {
    case "eq": {
      const v = resolve(world, p.path);
      const ok = deepEq(v, p.value);
      return ok
        ? { satisfied: true, gap: 0, evidence: `${p.path} = ${json(v)}` }
        : { satisfied: false, gap: 1, evidence: `${p.path}: expected ${json(p.value)}, got ${json(v)}` };
    }

    case "neq": {
      const v = resolve(world, p.path);
      const ok = !deepEq(v, p.value);
      return ok
        ? { satisfied: true, gap: 0 }
        : { satisfied: false, gap: 1, evidence: `${p.path}: expected ≠ ${json(p.value)}, got ${json(v)}` };
    }

    case "contains": {
      // Defensive: if substring isn't a string the predicate is malformed.
      // Surface it instead of throwing — agents reading this can correct.
      if (typeof p.substring !== "string") {
        return { satisfied: false, gap: 1, evidence: `${p.path}: malformed substring (expected string, got ${json(p.substring)})` };
      }
      const v = resolve(world, p.path);
      if (typeof v !== "string") {
        return { satisfied: false, gap: 1, evidence: `${p.path}: expected string containing "${p.substring}", got ${json(v)}` };
      }
      const hay = p.ci ? v.toLowerCase() : v;
      const ndl = p.ci ? p.substring.toLowerCase() : p.substring;
      return hay.includes(ndl)
        ? { satisfied: true, gap: 0 }
        : { satisfied: false, gap: 1, evidence: `${p.path}: "${p.substring}" not in ${json(v).slice(0, 80)}` };
    }

    case "exists": {
      const r = lookup(world, p.path);
      return r.present
        ? { satisfied: true, gap: 0, evidence: `${p.path} present` }
        : { satisfied: false, gap: 1, evidence: `${p.path}: missing` };
    }

    case "missing": {
      const r = lookup(world, p.path);
      return !r.present
        ? { satisfied: true, gap: 0 }
        : { satisfied: false, gap: 1, evidence: `${p.path}: expected missing, got ${json(r.value)}` };
    }

    case "find": {
      const coll = resolve(world, p.collection);
      if (!Array.isArray(coll)) {
        return { satisfied: false, gap: 1, evidence: `${p.collection}: not an array` };
      }
      // Find any element where `where` is satisfied. Gap = min sub-gap across
      // elements (closest near-miss). This gives gradient signal even when
      // nothing matches yet.
      let best: EvalResult | undefined;
      for (const el of coll) {
        const r = evaluate(el, p.where);
        if (r.satisfied) return { satisfied: true, gap: 0, evidence: r.evidence };
        if (!best || r.gap < best.gap) best = r;
      }
      const gap = best ? Math.max(1, best.gap) : 1;
      return { satisfied: false, gap, evidence: `${p.collection}: no element matched` + (best?.evidence ? ` (closest: ${best.evidence})` : "") };
    }

    case "count": {
      const coll = resolve(world, p.collection);
      if (!Array.isArray(coll)) {
        return { satisfied: false, gap: 1, evidence: `${p.collection}: not an array` };
      }
      const n = p.where
        ? coll.filter(el => evaluate(el, p.where!).satisfied).length
        : coll.length;
      const checks: { ok: boolean; gap: number; msg: string }[] = [];
      if (p.eq  !== undefined) checks.push({ ok: n === p.eq,  gap: Math.abs(n - p.eq),  msg: `count = ${p.eq}` });
      if (p.gte !== undefined) checks.push({ ok: n >= p.gte, gap: Math.max(0, p.gte - n), msg: `count ≥ ${p.gte}` });
      if (p.lte !== undefined) checks.push({ ok: n <= p.lte, gap: Math.max(0, n - p.lte), msg: `count ≤ ${p.lte}` });
      if (checks.length === 0) {
        return { satisfied: true, gap: 0, evidence: `${p.collection}: ${n} elements` };
      }
      const allOk = checks.every(c => c.ok);
      const totalGap = checks.reduce((s, c) => s + c.gap, 0);
      return {
        satisfied: allOk,
        gap: totalGap,
        evidence: `${p.collection}: count=${n}, expected ${checks.map(c => c.msg).join(" & ")}`,
      };
    }

    case "and": {
      const sub = p.of.map(q => evaluate(world, q));
      const satisfied = sub.every(r => r.satisfied);
      const gap = sub.reduce((s, r) => s + r.gap, 0);
      // Surface the FIRST unsatisfied sub-evidence — most useful diagnostic.
      const firstFail = sub.find(r => !r.satisfied);
      return { satisfied, gap, evidence: firstFail?.evidence };
    }

    case "or": {
      const sub = p.of.map(q => evaluate(world, q));
      const satisfied = sub.some(r => r.satisfied);
      // Gap is the MIN sub-gap (closest to satisfaction). For OR you can win
      // by satisfying any branch, so distance is to the nearest branch.
      const gap = satisfied ? 0 : Math.min(...sub.map(r => r.gap));
      const winner = sub.find(r => r.satisfied);
      return { satisfied, gap, evidence: winner?.evidence ?? `none of ${sub.length} branches satisfied` };
    }

    case "not": {
      const r = evaluate(world, p.of);
      return r.satisfied
        ? { satisfied: false, gap: 1, evidence: `negated condition held: ${r.evidence ?? ""}` }
        : { satisfied: true, gap: 0 };
    }
  }
}

// ----------------------------------------------------------------------------
// Helpers — small, predictable, no surprises.
// ----------------------------------------------------------------------------

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEq(x, b[i]));
  }
  if (typeof a === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every(k => deepEq((a as any)[k], (b as any)[k]));
  }
  return false;
}

/** Compact JSON for evidence strings — kept short for context windows. */
function json(v: unknown): string {
  if (v === undefined) return "undefined";
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 57) + "..." : s;
  } catch {
    return String(v);
  }
}
