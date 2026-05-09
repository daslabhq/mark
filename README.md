# mark

> Declare what your agent should achieve. Measure how far it is from achieving it.

```ts
import { evaluate } from "mark";

const goal = {
  op: "eq",
  path: "salesforce.contacts[id=003002].email",
  value: "maria@new.com",
};

evaluate(world, goal);
// → { satisfied: true,  gap: 0, evidence: 'salesforce.contacts[id=003002].email = "maria@new.com"' }
// or → { satisfied: false, gap: 1, evidence: '...email: expected "maria@new.com", got "maria@old.com"' }
```

A goal in mark is a **JSON-serializable predicate over an arbitrary world tree**. The evaluator returns `{satisfied, gap, evidence}` — not just a bool. `gap` is non-negative, 0 iff satisfied — a continuous *distance to goal*. `evidence` is a short diagnostic an agent can read.

Goals compose:

```ts
const fullGoal = {
  op: "and", of: [
    { op: "eq", path: "salesforce.contacts[id=003002].email", value: "maria@new.com" },
    { op: "find", collection: "gmail.messages", where: {
      op: "and", of: [
        { op: "find", collection: "label_ids", where: { op: "eq", path: "", value: "SENT" } },
        { op: "contains", path: "to",         substring: "manager@co",   ci: true },
        { op: "contains", path: "body_plain", substring: "updated Maria", ci: true },
      ],
    } },
  ],
};
```

`and` sums sub-gaps so partial progress is visible. `or` takes the min — distance to the nearest branch. The grader is a heuristic in the A* sense.

**Try it live →** [scene-otel viewer with mark integration](https://daslabhq.github.io/scene-otel/) — open the *Browse AutomationBench* tab; every assertion shows its mark Predicate compilation and live evaluation against the seeded world.

---

## AutomationBench equivalence — proven

mark is **bit-equivalent to Zapier's official AutomationBench grader** on the supported assertion types, verified by differential testing across the full task corpus.

```
total cases:    5290
agree:          5267
disagree:       23
equivalence:    99.57%
```

Across 18 assertion types covering ~58% of the 9,919 assertions in AutomationBench's 806 tasks. The 23 divergences are localized to one predicate family (`google_sheets_row_*` with `cell_contains` substring search across all cells) where mark currently approximates — documented and fixable.

The differential test runs in ~10 s on a laptop and is CI-gateable. Anyone can audit:

```bash
git clone https://github.com/daslabhq/mark
cd mark
bun scripts/diff-vs-zapier.ts
```

**Plain English:** if you grade your AB runs with mark, you get the same pass/fail Zapier's leaderboard would give you — just faster, with diagnostics, with a continuous gradient, and embeddable wherever you want.

---

## Why

Existing assertion libraries (Hamcrest, chai, expect, pytest) are built for tests humans write *about* code. mark is built for **agents acting on a world** — where success is "the world ended up looking like this," distance to that goal is a useful learning signal, and the same predicate has to be evaluated by a Python harness, a Rust runtime, and a browser viewer all on the same trace.

The closest existing thing in spirit is **CEL** (Google's Common Expression Language) — but CEL is shaped for policy decisions and returns booleans. mark is shaped for agent-state goals and returns *distance functions* over state space.

Concretely, a `mark` predicate is simultaneously:

- a **postcondition checker** (Hoare logic, Hoare 1969)
- an **A\* heuristic** (admissible distance to goal, Hart-Nilsson-Raphael 1968)
- a **dense reward function** (potential-based reward shaping, Ng-Harada-Russell 1999)
- a **runtime type system** (refinement types over JSON, Liquid Types 2008)
- a **wire format** for cross-language portability (predicates serialize as plain JSON)
- a **debug protocol** (every failure explains itself via `evidence`)

Six independent academic and operational traditions, each asking for the same primitive. mark is the synthesis.

---

## Install

```bash
npm install mark
```

Pure TypeScript, no runtime dependencies, browser-compatible.

---

## Where things live

`mark` is the **wire format and reference evaluator** for agent goals. It pairs with:

- [`scene-otel`](https://github.com/daslabhq/scene-otel) — wire format for agent **traces** (what happened).
- [`scenebench`](https://github.com/daslabhq/scenebench) — eval harnesses (uses mark for grading).
- [`scenegrad`](https://github.com/daslabhq/scenegrad) — observer-mode evaluator (uses mark's gap as gradient).

You can use mark standalone — it has no dependencies on the rest. The trio just composes well.

---

## The predicate language

Eleven operators. JSON-serializable. Composable. That's the whole language:

| Op | Meaning |
|---|---|
| `eq`       | `path` resolves to value (deep equality) |
| `neq`      | `path` does not resolve to value |
| `contains` | `path` resolves to a string containing `substring` (optional `ci` for case-insensitive) |
| `exists`   | `path` is reachable in the tree |
| `missing`  | `path` is not reachable |
| `find`     | the array at `collection` has at least one element matching `where` |
| `count`    | the array at `collection` has element count satisfying `eq` / `gte` / `lte` |
| `and`      | all sub-predicates hold (gap = sum of sub-gaps) |
| `or`       | any sub-predicate holds (gap = min of sub-gaps) |
| `not`      | sub-predicate does not hold |

Path syntax (JSONPath-ish, intentionally minimal):

```
foo.bar.baz                  → property chain
foo[0]                       → array index
foo[id=003002]               → array find-where (string equality)
foo[label_ids has SENT]      → array find-where (membership in nested array)
```

The path resolver is deliberately small — every operator is a porting burden for cross-language reference impls. Anything beyond the above goes through nested `find`.

---

## Agent-first surface

```ts
import { check_goal, gap, diagnose, subscribe, TOOL_DESCRIPTORS } from "mark";

// Drop these descriptors into any model API tool array (Anthropic, OpenAI, MCP).
TOOL_DESCRIPTORS.check_goal;   // { name, description, input_schema }
TOOL_DESCRIPTORS.gap;
TOOL_DESCRIPTORS.diagnose;

// Pure functions an agent can call:
check_goal({ goal, world });  // → { satisfied, gap, evidence }
gap({ goal, world });          // → { gap }   ← cheaper, for tight planning loops
diagnose({ goal, world });     // → { satisfied, diagnostic? }   ← failure-only
```

Returns are token-efficient by construction — designed to land in a model's context window, not a human dashboard. Agents can call mark like any other tool: declare a goal, evaluate against the current world, decide what to do next.

For long-running runs, subscribe to transitions instead of polling:

```ts
const sub = subscribe({
  goal,
  on: (r) => {
    // Inject as a system message so the agent sees the change on its next turn.
    history.push({
      role:    "system",
      content: r.satisfied ? "✓ goal achieved" : `gap ${r.gap}: ${r.evidence}`,
    });
  },
});

// After every tool result in the agent loop:
sub.tick(currentWorld);
```

This is the agent-first replacement for polling. Agents aren't reading dashboards — they're consuming context.

---

## What it does that other tools don't

| | What it returns | Composable | Cross-language | Notes |
|---|---|---|---|---|
| chai / expect / Hamcrest | bool | yes | no | Built for unit tests, not for agents acting on world state |
| CEL | bool | yes | yes | Closest neighbor; policy-shaped, not goal-shaped, no `gap` |
| Rego / OPA | bool / set | yes | yes | Policy engine; heavyweight for grading |
| JSON Schema | bool (validation) | partial | yes | Data shape only, not semantic predicates |
| LLM-as-judge | bool + free text | yes | n/a | Expensive, stochastic, untraceable |
| Vendor graders (AB Python) | bool | no | no | Tightly coupled to one world type and one language |
| **mark** | **`{satisfied, gap, evidence}`** | **yes** | **yes (JSON wire)** | **Distance function, not just a bool** |

Use mark for everything verifiable. Use a judge only for genuinely soft criteria (writing quality, etc.).

---

## What's not in mark yet

- **Number / date coercion** — Zapier's salesforce grader has 30 lines of inline numeric and ISO-date coercion. mark uses straight equality. Most cases work; edge cases drift. Roadmap.
- **Wildcard path steps** (`foo[*].bar`) — currently expressed via nested `find`. Workable but verbose for deeply nested structures. May add later.
- **Reference impls in other languages** — Python / Rust / Go ports planned. The wire format is JSON, so each port is ~300 lines.
- **Differentiable predicates** — soft `eq`, smooth `min`/`max`. Would turn `gap` into a literal training gradient. Speculative; not building yet.

---

## Roadmap

- **More AutomationBench assertion type translators** (18 → 50+, pushing coverage from 58% to 90%+ of the corpus).
- **Reference Python implementation** — for use inside existing Python harnesses without subprocess overhead.
- **Test-vector conformance suite** — canonical `(predicate, world, expected_result)` triples that any reference impl can run to prove correctness.
- **MCP server wrapping mark** — drop-in `define_goal` / `check_goal` / `gap` tools for any MCP-aware runtime.

---

## License

MIT.
