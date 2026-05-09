import { test, expect, describe } from "bun:test";
import { evaluate } from "./evaluate.js";
import { resolve, lookup } from "./path.js";
import type { Predicate } from "./predicate.js";

describe("path resolver", () => {
  const world = {
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
    expect(resolve(world, "salesforce.contacts")).toBeArray();
  });

  test("array index", () => {
    expect(resolve(world, "salesforce.contacts[0].id")).toBe("003001");
  });

  test("find-where by id", () => {
    expect(resolve(world, "salesforce.contacts[id=003002].email")).toBe("maria@new.com");
  });

  test("find-where with 'has' operator over array fields", () => {
    const m = resolve(world, "gmail.messages[label_ids has SENT].id");
    expect(m).toBe("m2");
  });

  test("missing path returns undefined", () => {
    expect(resolve(world, "salesforce.opportunities[id=foo].name")).toBeUndefined();
  });

  test("lookup distinguishes missing from present-undefined", () => {
    const w = { a: { b: undefined } };
    expect(lookup(w, "a.b").present).toBe(true);
    expect(lookup(w, "a.c").present).toBe(false);
  });
});

describe("eq", () => {
  const world = { sf: { contacts: [{ id: "x", email: "a@b" }] } };

  test("matches", () => {
    const p: Predicate = { op: "eq", path: "sf.contacts[id=x].email", value: "a@b" };
    const r = evaluate(world, p);
    expect(r.satisfied).toBe(true);
    expect(r.gap).toBe(0);
  });

  test("mismatches", () => {
    const p: Predicate = { op: "eq", path: "sf.contacts[id=x].email", value: "wrong" };
    const r = evaluate(world, p);
    expect(r.satisfied).toBe(false);
    expect(r.gap).toBe(1);
    expect(r.evidence).toContain("expected");
  });

  test("missing path → unsatisfied with diagnostic", () => {
    const p: Predicate = { op: "eq", path: "sf.contacts[id=nope].email", value: "x" };
    const r = evaluate(world, p);
    expect(r.satisfied).toBe(false);
    expect(r.evidence).toContain("undefined");
  });
});

describe("contains", () => {
  test("substring match (case-sensitive)", () => {
    const p: Predicate = { op: "contains", path: "msg.body", substring: "Hello" };
    expect(evaluate({ msg: { body: "Hello world" } }, p).satisfied).toBe(true);
    expect(evaluate({ msg: { body: "hello world" } }, p).satisfied).toBe(false);
  });

  test("substring match (case-insensitive)", () => {
    const p: Predicate = { op: "contains", path: "msg.body", substring: "Hello", ci: true };
    expect(evaluate({ msg: { body: "hello world" } }, p).satisfied).toBe(true);
  });

  test("non-string value → fails with diagnostic", () => {
    const p: Predicate = { op: "contains", path: "n", substring: "x" };
    const r = evaluate({ n: 42 }, p);
    expect(r.satisfied).toBe(false);
    expect(r.evidence).toContain("expected string");
  });
});

describe("exists / missing", () => {
  test("exists on present field", () => {
    expect(evaluate({ a: 1 }, { op: "exists", path: "a" }).satisfied).toBe(true);
  });

  test("exists on absent field", () => {
    expect(evaluate({ a: 1 }, { op: "exists", path: "b" }).satisfied).toBe(false);
  });

  test("missing on absent field", () => {
    expect(evaluate({ a: 1 }, { op: "missing", path: "b" }).satisfied).toBe(true);
  });
});

describe("find / count", () => {
  const world = {
    msgs: [
      { from: "alice", read: false },
      { from: "bob",   read: true  },
      { from: "carol", read: false },
    ],
  };

  test("find — at least one match", () => {
    const p: Predicate = {
      op: "find", collection: "msgs",
      where: { op: "eq", path: "from", value: "bob" },
    };
    expect(evaluate(world, p).satisfied).toBe(true);
  });

  test("find — none match → unsatisfied", () => {
    const p: Predicate = {
      op: "find", collection: "msgs",
      where: { op: "eq", path: "from", value: "ZED" },
    };
    const r = evaluate(world, p);
    expect(r.satisfied).toBe(false);
    expect(r.evidence).toContain("no element matched");
  });

  test("count — eq", () => {
    expect(evaluate(world, { op: "count", collection: "msgs", eq: 3 }).satisfied).toBe(true);
    expect(evaluate(world, { op: "count", collection: "msgs", eq: 4 }).satisfied).toBe(false);
  });

  test("count with where + gte", () => {
    const p: Predicate = {
      op: "count", collection: "msgs",
      where: { op: "eq", path: "read", value: false },
      gte: 2,
    };
    expect(evaluate(world, p).satisfied).toBe(true);
  });

  test("count gap is signed distance from threshold", () => {
    const r = evaluate(world, { op: "count", collection: "msgs", eq: 5 });
    expect(r.gap).toBe(2); // |3 - 5| = 2
  });
});

describe("and / or / not", () => {
  const world = { contact: { id: "x", email: "a@b" } };

  test("and — all must hold", () => {
    const p: Predicate = {
      op: "and", of: [
        { op: "eq", path: "contact.id",    value: "x" },
        { op: "eq", path: "contact.email", value: "a@b" },
      ],
    };
    expect(evaluate(world, p).satisfied).toBe(true);
  });

  test("and — gap sums sub-gaps (gradient stays continuous)", () => {
    const p: Predicate = {
      op: "and", of: [
        { op: "eq", path: "contact.id",    value: "WRONG" },  // gap 1
        { op: "eq", path: "contact.email", value: "WRONG" },  // gap 1
      ],
    };
    expect(evaluate(world, p).gap).toBe(2);
  });

  test("or — any branch wins", () => {
    const p: Predicate = {
      op: "or", of: [
        { op: "eq", path: "contact.id", value: "WRONG" },
        { op: "eq", path: "contact.id", value: "x" },
      ],
    };
    expect(evaluate(world, p).satisfied).toBe(true);
  });

  test("or — gap is min over branches when none satisfy", () => {
    const p: Predicate = {
      op: "or", of: [
        { op: "and", of: [
          { op: "eq", path: "contact.id", value: "WRONG" },
          { op: "eq", path: "contact.email", value: "WRONG" },
        ] },
        { op: "eq", path: "contact.id", value: "WRONG" },
      ],
    };
    // First branch gap 2, second branch gap 1 → min = 1
    expect(evaluate(world, p).gap).toBe(1);
  });

  test("not — flips truth", () => {
    expect(evaluate(world, { op: "not", of: { op: "eq", path: "contact.id", value: "WRONG" } }).satisfied).toBe(true);
    expect(evaluate(world, { op: "not", of: { op: "eq", path: "contact.id", value: "x"     } }).satisfied).toBe(false);
  });
});

describe("regression: AB-style salesforce_contact_field_equals", () => {
  // The exact case our broken adapter silently passed.
  const world = {
    salesforce: {
      contacts: [
        { id: "003002", first_name: "Maria", email: "maria.santos@brightwave.example.com" },
      ],
    },
  };

  test("initial state must NOT be marked satisfied", () => {
    // Goal: contact 003002 has the NEW email
    const goal: Predicate = {
      op: "eq",
      path: "salesforce.contacts[id=003002].email",
      value: "maria.santos@brightwave-global.example.com",
    };
    const r = evaluate(world, goal);
    expect(r.satisfied).toBe(false);
    expect(r.gap).toBe(1);
    // Diagnostic should explain the mismatch (this is the agent-first signal)
    expect(r.evidence).toContain("expected");
    expect(r.evidence).toContain("brightwave-global");
  });

  test("after 'agent action' that updates the email, satisfied", () => {
    const updated = structuredClone(world);
    updated.salesforce.contacts[0]!.email = "maria.santos@brightwave-global.example.com";
    const goal: Predicate = {
      op: "eq",
      path: "salesforce.contacts[id=003002].email",
      value: "maria.santos@brightwave-global.example.com",
    };
    expect(evaluate(updated, goal).satisfied).toBe(true);
  });
});
