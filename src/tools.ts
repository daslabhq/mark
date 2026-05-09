/**
 * Agent-first surface for mark.
 *
 * Every primitive an agent might want to call: declared as a JSON-schema'd
 * tool descriptor + a handler. Drop these into an MCP server, an Anthropic
 * tool array, an OpenAI tool array — any agent runtime calls them the same
 * way the model would call any other tool.
 *
 * The shape choices that make this *agent-first* (vs. human-first):
 *
 *   - Returns are token-efficient JSON, not pretty-printed dashboards.
 *   - Evidence strings are short and structured (predicate path + diagnostic),
 *     so they fit in context windows without truncation.
 *   - Subscriptions / callbacks are first-class (see `subscribe()` below) —
 *     so an agent can wait for an assertion to flip rather than polling.
 *   - Goal-distance is a primary return value, not a derived chart.
 *
 * Humans get the same returns wrapped in a UI; the API is the source of
 * truth, the dashboard is the shell.
 */

import type { Predicate, EvalResult } from "./predicate.js";
import { evaluate } from "./evaluate.js";

// ----------------------------------------------------------------------------
// Tool descriptors — JSON-schema, ready to drop into any model API tool array
// ----------------------------------------------------------------------------

/**
 * The tool catalog. Each entry is shaped for both Anthropic and OpenAI
 * tool-use formats; pick the keys you need (`name`, `description`, `input_schema`
 * or `parameters`).
 */
export const TOOL_DESCRIPTORS = {
  check_goal: {
    name: "check_goal",
    description:
      "Evaluate a goal predicate against a world state. Returns {satisfied, gap, evidence}. " +
      "Use this when you need to know whether a task's success criterion currently holds. " +
      "`gap` is non-negative and 0 iff satisfied — it's a heuristic distance to goal, " +
      "useful for planning and self-assessment.",
    input_schema: {
      type: "object",
      properties: {
        goal:  { description: "Predicate AST. JSON-serializable." },
        world: { description: "World state to evaluate against." },
      },
      required: ["goal", "world"],
    },
  },
  gap: {
    name: "gap",
    description:
      "Return only the goal-distance (a non-negative number, 0 iff satisfied). " +
      "Cheaper than check_goal when you don't need diagnostics — useful for inner " +
      "loops of search or planning where you're calling the grader thousands of times.",
    input_schema: {
      type: "object",
      properties: {
        goal:  { description: "Predicate AST." },
        world: { description: "World state." },
      },
      required: ["goal", "world"],
    },
  },
  diagnose: {
    name: "diagnose",
    description:
      "Evaluate and return ONLY the diagnostic when unsatisfied. Token-efficient: " +
      "use when you've already failed and need the agent to read why and decide next step.",
    input_schema: {
      type: "object",
      properties: {
        goal:  { description: "Predicate AST." },
        world: { description: "World state." },
      },
      required: ["goal", "world"],
    },
  },
} as const;

// ----------------------------------------------------------------------------
// Handlers — pure functions matching the descriptors
// ----------------------------------------------------------------------------

export function check_goal(args: { goal: Predicate; world: unknown }): EvalResult {
  return evaluate(args.world, args.goal);
}

export function gap(args: { goal: Predicate; world: unknown }): { gap: number } {
  const r = evaluate(args.world, args.goal);
  return { gap: r.gap };
}

export function diagnose(args: { goal: Predicate; world: unknown }): { satisfied: boolean; diagnostic?: string } {
  const r = evaluate(args.world, args.goal);
  return r.satisfied
    ? { satisfied: true }
    : { satisfied: false, diagnostic: r.evidence ?? "(no diagnostic)" };
}

// ----------------------------------------------------------------------------
// Subscription — agent waits for an assertion to flip
// ----------------------------------------------------------------------------

export type Unsubscribe = () => void;

/**
 * Subscribe to goal-status changes over a stream of world snapshots.
 *
 * Pattern: an agent runtime feeds new world snapshots in via `tick(world)`;
 * the subscription fires the callback only when the goal's satisfied flips,
 * not on every tick. This is the agent-first replacement for polling.
 *
 * Example:
 *
 *   const sub = subscribe({ goal, on: (r) => console.log("goal flipped:", r) });
 *   // ... later ...
 *   sub.tick(currentWorld);   // call after every tool result
 *   sub.unsubscribe();
 */
export interface Subscription {
  tick: (world: unknown) => EvalResult;
  unsubscribe: Unsubscribe;
}

export function subscribe(args: {
  goal: Predicate;
  on:   (r: EvalResult, world: unknown) => void;
  /** Fire on first tick even if no transition (default false). */
  fireOnFirst?: boolean;
}): Subscription {
  let prev: boolean | undefined;
  let active = true;
  const tick = (world: unknown): EvalResult => {
    const r = evaluate(world, args.goal);
    if (!active) return r;
    const transitioned = prev === undefined ? args.fireOnFirst === true : prev !== r.satisfied;
    if (transitioned) args.on(r, world);
    prev = r.satisfied;
    return r;
  };
  return { tick, unsubscribe: () => { active = false; } };
}
