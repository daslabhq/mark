/**
 * Check expressions for autocheck.
 *
 * A CheckExpr is a JSON-serializable specification of a condition over a
 * structured state (typically a scene). It evaluates deterministically
 * against any JSON tree.
 *
 * Checks compose via `and`, `or`, `not`. Leaf operators query the state
 * tree via path strings (see `./path.ts` for the path syntax).
 *
 * Design constraints:
 *   - Check expressions serialize as plain JSON. No lambdas, no closures,
 *     no code. This is what makes autocheck a wire format and not just a
 *     library.
 *   - Every check evaluates to `{ pass, gap, why, anchor?, meta? }`. Bool
 *     is too thin; we want the gradient (gap) and the diagnostic (why) too.
 *   - Composability is first-class. A success criterion is a single check
 *     expression, possibly nested. No flat-list-of-assertions concept.
 */

/** Path string into a JSON tree. See ./path.ts for grammar. */
export type Path = string;

/**
 * Check expression AST. Discriminated union — one shape per `op`.
 *
 * The operator set is inherited from autocheck's predecessor `mark` —
 * proven bit-equivalent to Zapier's AutomationBench grader across
 * 5267 / 5290 cases.
 */
export type CheckExpr =
  | { op: "eq";       path: Path; value: unknown }
  | { op: "neq";      path: Path; value: unknown }
  | { op: "gte";      path: Path; value: number }
  | { op: "lte";      path: Path; value: number }
  | { op: "contains"; path: Path; substring: string; ci?: boolean }
  | { op: "exists";   path: Path }
  | { op: "missing";  path: Path }
  | { op: "find";     collection: Path; where: CheckExpr }
  | { op: "count";    collection: Path; where?: CheckExpr; eq?: number; gte?: number; lte?: number }
  | { op: "and";      of: CheckExpr[] }
  | { op: "or";       of: CheckExpr[] }
  | { op: "not";      of: CheckExpr };

/**
 * Anchor into a scenecast asset. Points the failure at where in the scene
 * it lives — same grammar as scenecast's anchor selectors
 * (`item[id]`, `row[3]`, `field[email]`, `room[r-104]`, …).
 */
export interface AnchorRef {
  asset_id: string;
  anchor?:  string;
}

/**
 * A source of authority for the check.
 *
 *   - string         → shorthand, "EAA Annex III §3.3"
 *   - external       → regulation, paper, SOP with optional URL
 *   - in-scene       → anchored at a scenecast asset (e.g. an embedded SOP)
 *
 * Modeled after Semgrep / OPA / SCAP's `references` field.
 */
export type Reference =
  | string
  | { source: string; url?: string }
  | { source: string; anchor: AnchorRef };

export interface CheckMeta {
  references?: Reference[];
  severity?:   "info" | "warn" | "fail";
  tags?:       string[];
  /** Pack identifier, e.g. "eu-eaa@1.0.0". Enables compliance roll-ups. */
  pack?:       string;
}

/**
 * A named, reusable check. Created via `defineCheck()`. Bundles a check
 * expression with an id and optional metadata.
 */
export interface Check {
  id:    string;
  expr:  CheckExpr;
  meta?: CheckMeta;
}

/**
 * Result of evaluating a check against a scene (or any structured state).
 *
 * `pass`:    did the check hold?
 * `gap`:     a non-negative number; 0 iff pass. Higher means "further
 *            from satisfaction." For atoms this is binary (0 or 1). For
 *            composites like `and` we sum sub-gaps so partial progress
 *            is visible — this is what makes autocheck a heuristic in
 *            the A* sense, not just a checker.
 * `why`:     short human-and-agent-readable explanation. For failures,
 *            the diagnostic ("expected X at path Y, got Z"); for
 *            successes the supporting value. Token-efficient.
 * `anchor?`: pointer into the scene where the failure lives.
 * `meta?`:   carry-through of the check's metadata (references, severity,
 *            tags, pack) so consumers can render compliance grids
 *            without round-tripping back to the check definition.
 */
export interface CheckResult {
  pass:    boolean;
  gap:     number;
  why:     string;
  anchor?: AnchorRef;
  meta?:   CheckMeta;
}

/**
 * Define a named, reusable check. Pass the resulting object to `runCheck`
 * or `attachCheck`. The returned Check carries metadata that flows into
 * CheckResult.meta automatically.
 */
export function defineCheck(spec: { id: string; expr: CheckExpr; meta?: CheckMeta }): Check {
  return { id: spec.id, expr: spec.expr, meta: spec.meta };
}

/** Type guard — was this a defined Check, or a raw CheckExpr? */
export function isCheck(c: CheckExpr | Check): c is Check {
  return typeof (c as Check).id === "string" && typeof (c as Check).expr === "object";
}
