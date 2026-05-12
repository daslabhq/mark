/**
 * Check evaluator.
 *
 * Pure function: (scene, check) → { pass, gap, why, anchor?, meta? }.
 *
 * Properties we maintain:
 *   - Deterministic: same inputs always produce same output.
 *   - Total: every CheckExpr shape is handled; no exceptions on unknown ops.
 *   - Diagnostic: failures explain themselves via `why`.
 *   - Gradient-friendly: `gap` is non-negative, 0 iff pass. For composites
 *     we sum sub-gaps so partial progress is visible — the property that
 *     makes autocheck a heuristic in the A* sense, not just a checker.
 *
 * `why` strings are intentionally short and structured — meant to land in
 * agent context windows, not human dashboards.
 */

import type { CheckExpr, CheckResult, Check } from "./check.js";
import { isCheck } from "./check.js";
import { resolve, lookup } from "./path.js";

/**
 * Evaluate a check against a scene (or any structured state).
 *
 * Accepts either a bare CheckExpr or a defined Check. When a Check is
 * passed, its `meta` is carried through to the result.
 */
export function runCheck(scene: unknown, check: CheckExpr | Check): CheckResult {
  if (isCheck(check)) {
    const r = runExpr(scene, check.expr);
    return check.meta ? { ...r, meta: check.meta } : r;
  }
  return runExpr(scene, check);
}

function runExpr(scene: unknown, p: CheckExpr): CheckResult {
  switch (p.op) {
    case "eq": {
      const v = resolve(scene, p.path);
      const ok = deepEq(v, p.value);
      return ok
        ? { pass: true,  gap: 0, why: `${p.path} = ${json(v)}` }
        : { pass: false, gap: 1, why: `${p.path}: expected ${json(p.value)}, got ${json(v)}` };
    }

    case "neq": {
      const v = resolve(scene, p.path);
      const ok = !deepEq(v, p.value);
      return ok
        ? { pass: true,  gap: 0, why: `${p.path} ≠ ${json(p.value)}` }
        : { pass: false, gap: 1, why: `${p.path}: expected ≠ ${json(p.value)}, got ${json(v)}` };
    }

    case "gte": {
      // gap is the actual numeric shortfall — the property that makes
      // autocheck a heuristic in the A* sense for continuous quantities.
      // Non-numeric values fail with gap=1.
      const v = resolve(scene, p.path);
      if (typeof v !== "number") {
        return { pass: false, gap: 1, why: `${p.path}: expected number ≥ ${p.value}, got ${json(v)}` };
      }
      const gap = Math.max(0, p.value - v);
      return gap === 0
        ? { pass: true,  gap: 0,   why: `${p.path} = ${num(v)} ≥ ${num(p.value)}` }
        : { pass: false, gap,      why: `${p.path}: expected ≥ ${num(p.value)}, got ${num(v)} (short by ${num(gap)})` };
    }

    case "lte": {
      const v = resolve(scene, p.path);
      if (typeof v !== "number") {
        return { pass: false, gap: 1, why: `${p.path}: expected number ≤ ${p.value}, got ${json(v)}` };
      }
      const gap = Math.max(0, v - p.value);
      return gap === 0
        ? { pass: true,  gap: 0,   why: `${p.path} = ${num(v)} ≤ ${num(p.value)}` }
        : { pass: false, gap,      why: `${p.path}: expected ≤ ${num(p.value)}, got ${num(v)} (over by ${num(gap)})` };
    }

    case "contains": {
      // Defensive: if substring isn't a string the check is malformed.
      // Surface it instead of throwing — agents reading this can correct.
      if (typeof p.substring !== "string") {
        return { pass: false, gap: 1, why: `${p.path}: malformed substring (expected string, got ${json(p.substring)})` };
      }
      const v = resolve(scene, p.path);
      if (typeof v !== "string") {
        return { pass: false, gap: 1, why: `${p.path}: expected string containing "${p.substring}", got ${json(v)}` };
      }
      const hay = p.ci ? v.toLowerCase() : v;
      const ndl = p.ci ? p.substring.toLowerCase() : p.substring;
      return hay.includes(ndl)
        ? { pass: true,  gap: 0, why: `${p.path} contains "${p.substring}"` }
        : { pass: false, gap: 1, why: `${p.path}: "${p.substring}" not in ${json(v).slice(0, 80)}` };
    }

    case "exists": {
      const r = lookup(scene, p.path);
      return r.present
        ? { pass: true,  gap: 0, why: `${p.path} present` }
        : { pass: false, gap: 1, why: `${p.path}: missing` };
    }

    case "missing": {
      const r = lookup(scene, p.path);
      return !r.present
        ? { pass: true,  gap: 0, why: `${p.path}: absent (as required)` }
        : { pass: false, gap: 1, why: `${p.path}: expected missing, got ${json(r.value)}` };
    }

    case "find": {
      const coll = resolve(scene, p.collection);
      if (!Array.isArray(coll)) {
        return { pass: false, gap: 1, why: `${p.collection}: not an array` };
      }
      // Find any element where `where` is satisfied. Gap = min sub-gap across
      // elements (closest near-miss). Gradient signal even when nothing matches.
      let best: CheckResult | undefined;
      for (const el of coll) {
        const r = runExpr(el, p.where);
        if (r.pass) return { pass: true, gap: 0, why: r.why };
        if (!best || r.gap < best.gap) best = r;
      }
      const gap = best ? Math.max(1, best.gap) : 1;
      return { pass: false, gap, why: `${p.collection}: no element matched` + (best?.why ? ` (closest: ${best.why})` : "") };
    }

    case "count": {
      const coll = resolve(scene, p.collection);
      if (!Array.isArray(coll)) {
        return { pass: false, gap: 1, why: `${p.collection}: not an array` };
      }
      const n = p.where
        ? coll.filter(el => runExpr(el, p.where!).pass).length
        : coll.length;
      const checks: { ok: boolean; gap: number; msg: string }[] = [];
      if (p.eq  !== undefined) checks.push({ ok: n === p.eq,  gap: Math.abs(n - p.eq),  msg: `count = ${p.eq}` });
      if (p.gte !== undefined) checks.push({ ok: n >= p.gte, gap: Math.max(0, p.gte - n), msg: `count ≥ ${p.gte}` });
      if (p.lte !== undefined) checks.push({ ok: n <= p.lte, gap: Math.max(0, n - p.lte), msg: `count ≤ ${p.lte}` });
      if (checks.length === 0) {
        return { pass: true, gap: 0, why: `${p.collection}: ${n} elements` };
      }
      const allOk = checks.every(c => c.ok);
      const totalGap = checks.reduce((s, c) => s + c.gap, 0);
      return {
        pass: allOk,
        gap:  totalGap,
        why:  `${p.collection}: count=${n}, expected ${checks.map(c => c.msg).join(" & ")}`,
      };
    }

    case "and": {
      const sub = p.of.map(q => runExpr(scene, q));
      const pass = sub.every(r => r.pass);
      const gap = sub.reduce((s, r) => s + r.gap, 0);
      // Surface the FIRST unsatisfied sub-`why` — most useful diagnostic.
      const firstFail = sub.find(r => !r.pass);
      return { pass, gap, why: firstFail?.why ?? "all sub-checks pass" };
    }

    case "or": {
      const sub = p.of.map(q => runExpr(scene, q));
      const pass = sub.some(r => r.pass);
      // Gap is the MIN sub-gap (closest to satisfaction). For OR you can win
      // by satisfying any branch, so distance is to the nearest branch.
      const gap = pass ? 0 : Math.min(...sub.map(r => r.gap));
      const winner = sub.find(r => r.pass);
      return { pass, gap, why: winner?.why ?? `none of ${sub.length} branches satisfied` };
    }

    case "not": {
      const r = runExpr(scene, p.of);
      return r.pass
        ? { pass: false, gap: 1, why: `negated condition held: ${r.why ?? ""}` }
        : { pass: true,  gap: 0, why: `negated condition did not hold` };
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

/** Compact JSON for `why` strings — kept short for context windows. */
function json(v: unknown): string {
  if (v === undefined) return "undefined";
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 57) + "..." : s;
  } catch {
    return String(v);
  }
}

/** Numeric formatter — integers without decimals, floats trimmed to 2dp. */
function num(n: number): string {
  if (!isFinite(n)) return String(n);
  return Number.isInteger(n) ? n.toString() : n.toFixed(2).replace(/\.?0+$/, "");
}
