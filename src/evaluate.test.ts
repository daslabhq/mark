import { test, expect, describe } from "bun:test";
import { runCheck } from "./evaluate.js";
import { resolve, lookup } from "./path.js";
import type { CheckExpr } from "./check.js";

describe("path resolver", () => {
  const scene = {
    salesforce: {
      contacts: [
        { id: "003001", first_name: "Jordan", email: "jordan@old.com" },
        { id: "003002", first_name: "Maria", email: "maria@new.com" },
      ],
    },
    gmail: {
      messages: [
        { id: "m1", to: ["alice@x.com"], label_ids: ["INBOX"] },
        { id: "m2", to: ["bob@y.com"],   label_ids: ["SENT", "INBOX"] },
      ],
    },
  };

  test("simple property chain", () => {
    expect(resolve(scene, "salesforce.contacts")).toBeArray();
  });

  test("array index", () => {
    expect(resolve(scene, "salesforce.contacts[0].id")).toBe("003001");
  });

  test("find-where by id", () => {
    expect(resolve(scene, "salesforce.contacts[id=003002].email")).toBe("maria@new.com");
  });

  test("find-where with 'has' operator over array fields", () => {
    const m = resolve(scene, "gmail.messages[label_ids has SENT].id");
    expect(m).toBe("m2");
  });

  test("missing path returns undefined", () => {
    expect(resolve(scene, "salesforce.opportunities[id=foo].name")).toBeUndefined();
  });

  test("lookup distinguishes missing from present-undefined", () => {
    const s = { a: { b: undefined } };
    expect(lookup(s, "a.b").present).toBe(true);
    expect(lookup(s, "a.c").present).toBe(false);
  });
});

describe("eq", () => {
  const scene = { sf: { contacts: [{ id: "x", email: "a@b" }] } };

  test("matches", () => {
    const c: CheckExpr = { op: "eq", path: "sf.contacts[id=x].email", value: "a@b" };
    const r = runCheck(scene, c);
    expect(r.pass).toBe(true);
    expect(r.gap).toBe(0);
  });

  test("mismatches", () => {
    const c: CheckExpr = { op: "eq", path: "sf.contacts[id=x].email", value: "wrong" };
    const r = runCheck(scene, c);
    expect(r.pass).toBe(false);
    expect(r.gap).toBe(1);
    expect(r.why).toContain("expected");
  });

  test("missing path → not pass with diagnostic", () => {
    const c: CheckExpr = { op: "eq", path: "sf.contacts[id=nope].email", value: "x" };
    const r = runCheck(scene, c);
    expect(r.pass).toBe(false);
    expect(r.why).toContain("undefined");
  });
});

describe("gte / lte — continuous gap is the point", () => {
  // The whole reason gte/lte exist in autocheck (vs. plain `>=` in code) is
  // that `gap` is the distance to satisfaction, in the same units as the
  // value being checked. These tests document that property.

  test("gap is in the same units as the value, so agents can read 'over by €2000'", () => {
    const overBudget = runCheck(
      { totalCost: 27_000 },
      { op: "lte", path: "totalCost", value: 25_000 },
    );
    expect(overBudget.pass).toBe(false);
    expect(overBudget.gap).toBe(2_000);
    expect(overBudget.why).toMatch(/over by 2000/);

    const underLit = runCheck(
      { lux: 600 },
      { op: "gte", path: "lux", value: 800 },
    );
    expect(underLit.pass).toBe(false);
    expect(underLit.gap).toBe(200);
    expect(underLit.why).toMatch(/short by 200/);
  });

  test("under `and`, gaps sum — the heuristic stays a useful gradient", () => {
    // Two failing constraints with very different scales. The summed gap
    // tells an agent "the budget is the dominant problem to fix" — exactly
    // what makes autocheck a heuristic in the A* sense rather than a
    // boolean checker.
    const r = runCheck(
      { totalCost: 27_000, lux: 600 },
      { op: "and", of: [
        { op: "lte", path: "totalCost", value: 25_000 },   // gap 2000 €
        { op: "gte", path: "lux",       value: 800 },      // gap 200 lux
      ] },
    );
    expect(r.pass).toBe(false);
    expect(r.gap).toBe(2_200);
    // First-failure surfacing helps the agent pick what to act on first.
    expect(r.why).toContain("totalCost");
  });

  test("under `or`, gap is the min — distance to the closest satisfiable branch", () => {
    // Either route works: cut cost OR boost lumens. Gap = how far to the
    // *easier* fix — the cheaper alternative for a planning agent.
    const r = runCheck(
      { totalCost: 27_000, lux: 600 },
      { op: "or", of: [
        { op: "lte", path: "totalCost", value: 25_000 },   // gap 2000
        { op: "gte", path: "lux",       value: 700 },      // gap 100
      ] },
    );
    expect(r.pass).toBe(false);
    expect(r.gap).toBe(100);
  });

  test("non-numeric and missing values fail with a typed `why`, not a thrown error", () => {
    // Predicates are agent-authored. They WILL aim at malformed paths.
    // Returning a structured `why` lets the agent recover; a thrown error
    // crashes the loop. This is the agent-first design contract.
    const wrongType = runCheck({ x: "hello" }, { op: "gte", path: "x", value: 5 });
    expect(wrongType.pass).toBe(false);
    expect(wrongType.why).toMatch(/expected number/);

    const missing = runCheck({}, { op: "lte", path: "deeply.nested.x", value: 10 });
    expect(missing.pass).toBe(false);
    expect(missing.why).toMatch(/expected number/);
  });
});

describe("contains", () => {
  test("substring match (case-sensitive)", () => {
    const c: CheckExpr = { op: "contains", path: "msg.body", substring: "Hello" };
    expect(runCheck({ msg: { body: "Hello world" } }, c).pass).toBe(true);
    expect(runCheck({ msg: { body: "hello world" } }, c).pass).toBe(false);
  });

  test("substring match (case-insensitive)", () => {
    const c: CheckExpr = { op: "contains", path: "msg.body", substring: "Hello", ci: true };
    expect(runCheck({ msg: { body: "hello world" } }, c).pass).toBe(true);
  });

  test("non-string value → fails with diagnostic", () => {
    const c: CheckExpr = { op: "contains", path: "n", substring: "x" };
    const r = runCheck({ n: 42 }, c);
    expect(r.pass).toBe(false);
    expect(r.why).toContain("expected string");
  });
});

describe("exists / missing", () => {
  test("exists on present field", () => {
    expect(runCheck({ a: 1 }, { op: "exists", path: "a" }).pass).toBe(true);
  });

  test("exists on absent field", () => {
    expect(runCheck({ a: 1 }, { op: "exists", path: "b" }).pass).toBe(false);
  });

  test("missing on absent field", () => {
    expect(runCheck({ a: 1 }, { op: "missing", path: "b" }).pass).toBe(true);
  });
});

describe("find / count", () => {
  const scene = {
    msgs: [
      { from: "alice", read: false },
      { from: "bob",   read: true  },
      { from: "carol", read: false },
    ],
  };

  test("find — at least one match", () => {
    const c: CheckExpr = {
      op: "find", collection: "msgs",
      where: { op: "eq", path: "from", value: "bob" },
    };
    expect(runCheck(scene, c).pass).toBe(true);
  });

  test("find — none match → not pass", () => {
    const c: CheckExpr = {
      op: "find", collection: "msgs",
      where: { op: "eq", path: "from", value: "ZED" },
    };
    const r = runCheck(scene, c);
    expect(r.pass).toBe(false);
    expect(r.why).toContain("no element matched");
  });

  test("count — eq", () => {
    expect(runCheck(scene, { op: "count", collection: "msgs", eq: 3 }).pass).toBe(true);
    expect(runCheck(scene, { op: "count", collection: "msgs", eq: 4 }).pass).toBe(false);
  });

  test("count with where + gte", () => {
    const c: CheckExpr = {
      op: "count", collection: "msgs",
      where: { op: "eq", path: "read", value: false },
      gte: 2,
    };
    expect(runCheck(scene, c).pass).toBe(true);
  });

  test("count gap is signed distance from threshold", () => {
    const r = runCheck(scene, { op: "count", collection: "msgs", eq: 5 });
    expect(r.gap).toBe(2); // |3 - 5| = 2
  });
});

describe("and / or / not", () => {
  const scene = { contact: { id: "x", email: "a@b" } };

  test("and — all must hold", () => {
    const c: CheckExpr = {
      op: "and", of: [
        { op: "eq", path: "contact.id",    value: "x" },
        { op: "eq", path: "contact.email", value: "a@b" },
      ],
    };
    expect(runCheck(scene, c).pass).toBe(true);
  });

  test("and — gap sums sub-gaps (gradient stays continuous)", () => {
    const c: CheckExpr = {
      op: "and", of: [
        { op: "eq", path: "contact.id",    value: "WRONG" },  // gap 1
        { op: "eq", path: "contact.email", value: "WRONG" },  // gap 1
      ],
    };
    expect(runCheck(scene, c).gap).toBe(2);
  });

  test("or — any branch wins", () => {
    const c: CheckExpr = {
      op: "or", of: [
        { op: "eq", path: "contact.id", value: "WRONG" },
        { op: "eq", path: "contact.id", value: "x" },
      ],
    };
    expect(runCheck(scene, c).pass).toBe(true);
  });

  test("or — gap is min over branches when none pass", () => {
    const c: CheckExpr = {
      op: "or", of: [
        { op: "and", of: [
          { op: "eq", path: "contact.id", value: "WRONG" },
          { op: "eq", path: "contact.email", value: "WRONG" },
        ] },
        { op: "eq", path: "contact.id", value: "WRONG" },
      ],
    };
    // First branch gap 2, second branch gap 1 → min = 1
    expect(runCheck(scene, c).gap).toBe(1);
  });

  test("not — flips truth", () => {
    expect(runCheck(scene, { op: "not", of: { op: "eq", path: "contact.id", value: "WRONG" } }).pass).toBe(true);
    expect(runCheck(scene, { op: "not", of: { op: "eq", path: "contact.id", value: "x"     } }).pass).toBe(false);
  });
});

describe("regression: AB-style salesforce_contact_field_equals", () => {
  // The exact case our broken adapter silently passed.
  const scene = {
    salesforce: {
      contacts: [
        { id: "003002", first_name: "Maria", email: "maria.santos@brightwave.example.com" },
      ],
    },
  };

  test("initial state must NOT be marked passing", () => {
    // Goal: contact 003002 has the NEW email
    const c: CheckExpr = {
      op: "eq",
      path: "salesforce.contacts[id=003002].email",
      value: "maria.santos@brightwave-global.example.com",
    };
    const r = runCheck(scene, c);
    expect(r.pass).toBe(false);
    expect(r.gap).toBe(1);
    // Diagnostic should explain the mismatch (this is the agent-first signal)
    expect(r.why).toContain("expected");
    expect(r.why).toContain("brightwave-global");
  });

  test("after 'agent action' that updates the email, passes", () => {
    const updated = structuredClone(scene);
    updated.salesforce.contacts[0]!.email = "maria.santos@brightwave-global.example.com";
    const c: CheckExpr = {
      op: "eq",
      path: "salesforce.contacts[id=003002].email",
      value: "maria.santos@brightwave-global.example.com",
    };
    expect(runCheck(updated, c).pass).toBe(true);
  });
});
