/**
 * autocheck — scene-focused checks for agents.
 *
 * Declare what "right" looks like as a JSON-serializable CheckExpr.
 * Evaluate it against any scene (or structured state) to get
 * { pass, gap, why, anchor?, meta? }. Goal-distance function in ~300 lines.
 *
 * Live re-evaluation is first-class: attach a check to a scene and your
 * callback fires on every commit. This is the auto in autocheck.
 *
 * Usage:
 *   import { runCheck, defineCheck } from "autocheck";
 *
 *   // One-shot
 *   runCheck(scene, { op: "lte", path: "totalCost.amount", value: 60_000 });
 *
 *   // Named, reusable, with citation metadata
 *   const cap = defineCheck({
 *     id:   "warehouse-cost-cap",
 *     expr: { op: "lte", path: "totalCost.amount", value: 60_000 },
 *     meta: { references: ["Warehouse budget agreement, 2026-03"] },
 *   });
 *   runCheck(scene, cap);  // → { pass, gap, why, meta: { references: [...] } }
 */

export type {
  Path,
  CheckExpr,
  Check,
  CheckResult,
  CheckMeta,
  AnchorRef,
  Reference,
} from "./check.js";
export { defineCheck, isCheck } from "./check.js";

export { runCheck } from "./evaluate.js";

export { resolve, lookup } from "./path.js";

export {
  check_scene,
  gap,
  diagnose,
  attachCheck,
  TOOL_DESCRIPTORS,
} from "./tools.js";
export type { Subscription, Unsubscribe } from "./tools.js";
