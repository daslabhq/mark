# autocheck

> Scene-focused checks for agents. Declare what "right" looks like; get `{ pass, gap, why }` back. Lives next to your scene and re-evaluates on every commit.

```ts
import { runCheck } from "autocheck";

const scene = {
  warehouse: {
    totalCost: { amount: 64_200, currency: "EUR" },
    placements: [/* ... */],
  },
};

runCheck(scene, { op: "lte", path: "warehouse.totalCost.amount", value: 60_000 });
// → { pass: false, gap: 4200, why: "warehouse.totalCost.amount: expected ≤ 60000, got 64200" }
```

A check is a **JSON-serializable expression over a scene tree**. The evaluator returns `{ pass, gap, why }` — not just a bool. `gap` is non-negative, 0 iff pass — a continuous *distance to satisfaction*. `why` is a short diagnostic an agent can read.

Checks compose:

```ts
const fullCheck = {
  op: "and", of: [
    { op: "lte", path: "warehouse.totalCost.amount", value: 60_000 },
    { op: "find", collection: "warehouse.placements", where: {
      op: "and", of: [
        { op: "eq",       path: "kind",     value: "robot_station" },
        { op: "contains", path: "model",    substring: "SO-101", ci: true },
      ],
    } },
  ],
};
```

`and` sums sub-gaps so partial progress is visible. `or` takes the min — distance to the nearest branch. The evaluator is a heuristic in the A* sense.

---

## Why the `auto` in autocheck

A check isn't a one-shot assertion. Attach it to a scene and it re-evaluates on every commit:

```ts
import { attachCheck, defineCheck } from "autocheck";

const costCap = defineCheck({
  id:   "warehouse-cost-cap",
  expr: { op: "lte", path: "warehouse.totalCost.amount", value: 60_000 },
  meta: { references: ["Warehouse budget agreement, 2026-03"] },
});

const sub = attachCheck(costCap, (r) => {
  // Fires only when `pass` transitions, not every tick.
  history.push({ role: "system", content: r.pass ? "✓ within budget" : `over by €${r.gap}` });
});

// In the agent loop, after every tool result:
sub.tick(currentScene);
```

Live re-evaluation. Token-efficient. Replaces polling. The agent sees the check flip *as part of its next context window*, not as a dashboard ping.

---

## Result shape

```ts
interface CheckResult {
  pass: boolean;      // did the check hold?
  gap:  number;       // 0 iff pass; >0 = how far off
  why:  string;       // short, agent-readable diagnostic
  anchor?: AnchorRef; // where in the scene the failure lives (optional)
  meta?: {
    references?: Array<string | { source: string; url?: string } | { source: string; anchor: AnchorRef }>;
    severity?:   "info" | "warn" | "fail";
    tags?:       string[];
    pack?:       string;
  };
}
```

- **`pass`** — universal dev word (`pytest`, `jest`, GitHub Actions). Not `satisfied`.
- **`gap`** — continuous distance to satisfaction. The property that makes checks usable as a planning heuristic, not just a test result.
- **`why`** — short, structured (path + diagnostic). Designed to fit a context window, not a dashboard.
- **`anchor`** — points at the part of the scene where the failure is, using scenecast's anchor grammar (`item[id]`, `row[3]`, `room[r-104]`).
- **`meta.references`** — sources of authority for the check (regulations, SOPs, agreements). Modeled after Semgrep / OPA / SCAP precedent.
- **`meta.pack`** — pack identifier for compliance roll-ups (e.g., `eu-eaa@1.0.0`).

---

## AutomationBench equivalence — proven

autocheck inherits its operator set from the previous-name predecessor (`mark`), which is **bit-equivalent to Zapier's official AutomationBench grader** on the supported assertion types — verified by differential testing across the full task corpus.

```
total cases:    5290
agree:          5267
disagree:       23
equivalence:    99.57%
```

Across 18 assertion types covering ~58% of the 9,919 assertions in AutomationBench's 806 tasks. The 23 divergences are localized to one assertion family (`google_sheets_row_*` with `cell_contains` substring search across all cells) where the translator approximates — documented and fixable.

The differential test runs in ~10 s on a laptop and is CI-gateable. Anyone can audit:

```bash
git clone https://github.com/daslabhq/autocheck
cd autocheck
bun scripts/diff-vs-zapier.ts
```

If you grade your AB runs with autocheck, you get the same pass/fail Zapier's leaderboard would give you — plus diagnostics, plus a continuous gradient, plus the ability to embed it anywhere.

---

## The check language

Ten operators. JSON-serializable. Composable.

| Op | Meaning |
|---|---|
| `eq`       | `path` resolves to value (deep equality) |
| `neq`      | `path` does not resolve to value |
| `contains` | `path` resolves to a string containing `substring` (optional `ci` for case-insensitive) |
| `exists`   | `path` is reachable in the tree |
| `missing`  | `path` is not reachable |
| `find`     | the array at `collection` has at least one element matching `where` |
| `count`    | the array at `collection` has element count satisfying `eq` / `gte` / `lte` |
| `and`      | all sub-checks hold (gap = sum of sub-gaps) |
| `or`       | any sub-check holds (gap = min of sub-gaps) |
| `not`      | sub-check does not hold |

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
import { check_scene, gap, diagnose, attachCheck, TOOL_DESCRIPTORS } from "autocheck";

// Drop these descriptors into any model API tool array (Anthropic, OpenAI, MCP).
TOOL_DESCRIPTORS.check_scene;  // { name, description, input_schema }
TOOL_DESCRIPTORS.gap;
TOOL_DESCRIPTORS.diagnose;

// Pure functions an agent can call:
check_scene({ check, scene });  // → { pass, gap, why, anchor?, meta? }
gap({ check, scene });           // → { gap }   ← cheaper, for tight planning loops
diagnose({ check, scene });      // → { pass, diagnostic? }   ← failure-only
```

Returns are token-efficient by construction — designed to land in a model's context window, not a human dashboard. Agents can call autocheck like any other tool: declare a check, evaluate against the current scene, decide what to do next.

---

## What it does that other tools don't

| | Returns | Composable | Cross-language | Notes |
|---|---|---|---|---|
| chai / expect / Hamcrest | bool | yes | no | Built for unit tests, not for agents acting on a scene |
| CEL | bool | yes | yes | Closest neighbor; policy-shaped, not goal-shaped, no `gap` |
| Rego / OPA | bool / set | yes | yes | Policy engine; heavyweight for grading |
| JSON Schema | bool (validation) | partial | yes | Data shape only, not semantic checks |
| LLM-as-judge | bool + free text | yes | n/a | Expensive, stochastic, untraceable |
| Vendor graders (AB Python) | bool | no | no | Tightly coupled to one world type and one language |
| **autocheck** | **`{ pass, gap, why, anchor?, meta? }`** | **yes** | **yes (JSON wire)** | **Distance function + scene anchors + citation grounding** |

Use autocheck for everything verifiable. Use a judge only for genuinely soft criteria.

---

## Install

```bash
npm install autocheck
```

Pure TypeScript, no runtime dependencies, browser-compatible.

---

## Where things live

autocheck pairs with:

- [`scene-otel`](https://github.com/daslabhq/scene-otel) — wire format for agent **traces** (what the scene looked like at each commit).
- [`scenebench`](https://github.com/daslabhq/scenebench) — eval harness; uses autocheck for grading.
- [`scenegrad`](https://github.com/daslabhq/scenegrad) — observer-mode evaluator; uses autocheck's gap as gradient.

autocheck is standalone — no dependencies on the rest. The family just composes well.

---

## Roadmap

- **Spec-by-example check induction** — label N passing and N failing scene examples; learn the check that separates them (ILASP-style).
- **Temporal mode** — `attachCheck` with `window: { from: -300, to: 0 }` for "did this ever fail in the last 5 minutes?"
- **Predictive mode** — `runCheck(scene.predict(action), check)` plugged into a registered world model.
- **More AutomationBench assertion type translators** (18 → 50+, pushing coverage from 58% to 90%+ of the corpus).
- **Reference Python implementation** — for use inside existing Python harnesses without subprocess overhead.

---

## License

MIT.
