/**
 * Agent-first surface for autocheck.
 *
 * Every primitive an agent might want to call: declared as a JSON-schema'd
 * tool descriptor + a handler. Drop these into an MCP server, an Anthropic
 * tool array, an OpenAI tool array — any agent runtime calls them the same
 * way the model would call any other tool.
 *
 * The shape choices that make this *agent-first* (vs. human-first):
 *
 *   - Returns are token-efficient JSON, not pretty-printed dashboards.
 *   - `why` strings are short and structured (path + diagnostic), so they
 *     fit in context windows without truncation.
 *   - Subscriptions / callbacks are first-class (see `attachCheck()` below) —
 *     so an agent can wait for a check to flip rather than polling.
 *   - Goal-distance is a primary return value, not a derived chart.
 *
 * Humans get the same returns wrapped in a UI; the API is the source of
 * truth, the dashboard is the shell.
 */

import type { CheckExpr, Check, CheckResult } from "./check.js";
import { runCheck } from "./evaluate.js";

// ----------------------------------------------------------------------------
// Tool descriptors — JSON-schema, ready to drop into any model API tool array
// ----------------------------------------------------------------------------

/**
 * The tool catalog. Each entry is shaped for both Anthropic and OpenAI
 * tool-use formats; pick the keys you need (`name`, `description`,
 * `input_schema` or `parameters`).
 */
export const TOOL_DESCRIPTORS = {
  check_scene: {
    name: "check_scene",
    description:
      "Evaluate a check against a scene. Returns { pass, gap, why }. " +
      "Use this when you need to know whether a success criterion currently holds. " +
      "`gap` is non-negative and 0 iff pass — it's a heuristic distance to goal, " +
      "useful for planning and self-assessment.",
    input_schema: {
      type: "object",
      properties: {
        check: { description: "CheckExpr or Check. JSON-serializable." },
        scene: { description: "Scene (or structured state) to evaluate against." },
      },
      required: ["check", "scene"],
    },
  },
  gap: {
    name: "gap",
    description:
      "Return only the goal-distance (a non-negative number, 0 iff pass). " +
      "Cheaper than check_scene when you don't need diagnostics — useful for " +
      "inner loops of search or planning where you're calling the evaluator " +
      "thousands of times.",
    input_schema: {
      type: "object",
      properties: {
        check: { description: "CheckExpr or Check." },
        scene: { description: "Scene (or structured state)." },
      },
      required: ["check", "scene"],
    },
  },
  diagnose: {
    name: "diagnose",
    description:
      "Evaluate and return ONLY the diagnostic when not passing. Token-efficient: " +
      "use when you've already failed and need the agent to read why and decide " +
      "next step.",
    input_schema: {
      type: "object",
      properties: {
        check: { description: "CheckExpr or Check." },
        scene: { description: "Scene (or structured state)." },
      },
      required: ["check", "scene"],
    },
  },
} as const;

// ----------------------------------------------------------------------------
// Handlers — pure functions matching the descriptors
// ----------------------------------------------------------------------------

export function check_scene(args: { check: CheckExpr | Check; scene: unknown }): CheckResult {
  return runCheck(args.scene, args.check);
}

export function gap(args: { check: CheckExpr | Check; scene: unknown }): { gap: number } {
  const r = runCheck(args.scene, args.check);
  return { gap: r.gap };
}

export function diagnose(args: { check: CheckExpr | Check; scene: unknown }): { pass: boolean; diagnostic?: string } {
  const r = runCheck(args.scene, args.check);
  return r.pass
    ? { pass: true }
    : { pass: false, diagnostic: r.why };
}

// ----------------------------------------------------------------------------
// attachCheck — agent waits for a check to flip
// ----------------------------------------------------------------------------

export type Unsubscribe = () => void;

/**
 * Subscribe to check-status changes over a stream of scene snapshots.
 *
 * Pattern: an agent runtime feeds new scene snapshots in via `tick(scene)`;
 * the subscription fires the callback only when the check's `pass` flips,
 * not on every tick. This is the agent-first replacement for polling, and
 * the basis for the auto in autocheck — live re-evaluation per commit.
 *
 * Example:
 *
 *   const sub = attachCheck(check, (r) => console.log("flipped:", r));
 *   // ... in the agent loop, after every tool result:
 *   sub.tick(currentScene);
 *   sub.unsubscribe();
 */
export interface Subscription {
  tick: (scene: unknown) => CheckResult;
  unsubscribe: Unsubscribe;
}

export interface AttachOpts {
  /** Fire on first tick even if no transition (default false). */
  fireOnFirst?: boolean;
}

export function attachCheck(
  check: CheckExpr | Check,
  on: (r: CheckResult, scene: unknown) => void,
  opts: AttachOpts = {},
): Subscription {
  let prev: boolean | undefined;
  let active = true;
  const tick = (scene: unknown): CheckResult => {
    const r = runCheck(scene, check);
    if (!active) return r;
    const transitioned = prev === undefined ? opts.fireOnFirst === true : prev !== r.pass;
    if (transitioned) on(r, scene);
    prev = r.pass;
    return r;
  };
  return { tick, unsubscribe: () => { active = false; } };
}
