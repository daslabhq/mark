/**
 * mark — wire format for agent goals.
 *
 * Declare what success means as a JSON-serializable Predicate. Evaluate it
 * against any world state to get {satisfied, gap, evidence}. Goal-distance
 * function in 300 lines.
 *
 * Agent-first by default: the surface is callable as MCP tools (see ./tools.ts),
 * returns are designed for context windows, predicates serialize for transport.
 *
 * Usage:
 *   import { evaluate, type Predicate } from "mark";
 *
 *   const goal: Predicate = {
 *     op: "eq",
 *     path: "salesforce.contacts[id=003002].email",
 *     value: "maria@new.com",
 *   };
 *   const result = evaluate(world, goal);
 *   // → { satisfied: true, gap: 0, evidence: "..." }
 */

export type { Predicate, EvalResult, Path } from "./predicate.js";
export { evaluate } from "./evaluate.js";
export { resolve, lookup } from "./path.js";
export { check_goal, gap, diagnose, subscribe, TOOL_DESCRIPTORS } from "./tools.js";
export type { Subscription, Unsubscribe } from "./tools.js";
