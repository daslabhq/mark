/**
 * Predicate language for mark.
 *
 * A predicate is a JSON-serializable specification of a condition over a
 * world state. It evaluates deterministically against any JSON tree.
 *
 * Predicates compose via `and`, `or`, `not`. Leaf operators query the world
 * tree via path strings (see `./path.ts` for the path syntax).
 *
 * Design constraints:
 *   - Predicates serialize as plain JSON. No lambdas, no closures, no code.
 *     This is what makes mark a wire format and not a library.
 *   - Every predicate evaluates to {satisfied, gap, evidence}. Bool is too
 *     thin; we want the gradient (gap) and the diagnostic (evidence) too.
 *   - Composability is first-class. A task's success criterion is a single
 *     predicate, possibly nested. There's no flat-list-of-assertions concept.
 */

/** Path string into a JSON tree. See ./path.ts for grammar. */
export type Path = string;

/** Predicate AST. Discriminated union — one shape per `op`. */
export type Predicate =
  | { op: "eq";       path: Path; value: unknown }
  | { op: "neq";      path: Path; value: unknown }
  | { op: "contains"; path: Path; substring: string; ci?: boolean }
  | { op: "exists";   path: Path }
  | { op: "missing";  path: Path }
  | { op: "find";     collection: Path; where: Predicate }
  | { op: "count";    collection: Path; where?: Predicate; eq?: number; gte?: number; lte?: number }
  | { op: "and";      of: Predicate[] }
  | { op: "or";       of: Predicate[] }
  | { op: "not";      of: Predicate };

/**
 * Result of evaluating a predicate against a world state.
 *
 * `satisfied`: did the predicate hold?
 * `gap`: a non-negative number; 0 iff satisfied. Higher means "further from
 *        satisfaction." For atoms this is binary (0 or 1). For composites
 *        like `and` we sum sub-gaps so partial progress is visible.
 * `evidence`: optional human-and-agent-readable explanation. For failures,
 *             this is the diagnostic ("expected X at path Y, got Z"). For
 *             successes it's the supporting value found. Token-efficient.
 */
export interface EvalResult {
  satisfied: boolean;
  gap:       number;
  evidence?: string;
}
