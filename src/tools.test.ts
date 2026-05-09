import { test, expect, describe } from "bun:test";
import { check_goal, gap, diagnose, subscribe, TOOL_DESCRIPTORS } from "./tools.js";
import type { Predicate } from "./predicate.js";

describe("agent-first tool surface", () => {
  const goal: Predicate = { op: "eq", path: "x", value: 1 };

  test("check_goal returns full EvalResult", () => {
    const r = check_goal({ goal, world: { x: 1 } });
    expect(r.satisfied).toBe(true);
    expect(r.gap).toBe(0);
  });

  test("gap returns just the number — token-efficient", () => {
    const r = gap({ goal, world: { x: 2 } });
    expect(r).toEqual({ gap: 1 });
    expect(Object.keys(r)).toEqual(["gap"]);
  });

  test("diagnose returns short diagnostic only when failed", () => {
    expect(diagnose({ goal, world: { x: 1 } })).toEqual({ satisfied: true });
    const r = diagnose({ goal, world: { x: 2 } });
    expect(r.satisfied).toBe(false);
    expect(typeof r.diagnostic).toBe("string");
    expect(r.diagnostic!.length).toBeLessThan(200);
  });

  test("tool descriptors have the shape model APIs expect", () => {
    for (const t of Object.values(TOOL_DESCRIPTORS)) {
      expect(t.name).toBeString();
      expect(t.description).toBeString();
      expect(t.input_schema.type).toBe("object");
      expect(t.input_schema.required).toBeArray();
    }
  });
});

describe("subscribe — agent-first event hook", () => {
  const goal: Predicate = { op: "eq", path: "ready", value: true };

  test("fires only on transitions, not every tick", () => {
    const events: boolean[] = [];
    const sub = subscribe({ goal, on: (r) => events.push(r.satisfied) });

    sub.tick({ ready: false }); // no fire (initial → unsatisfied)
    sub.tick({ ready: false }); // no fire (no transition)
    sub.tick({ ready: true  }); // FIRE
    sub.tick({ ready: true  }); // no fire
    sub.tick({ ready: false }); // FIRE

    expect(events).toEqual([true, false]);
    sub.unsubscribe();
  });

  test("fireOnFirst option fires immediately", () => {
    const events: boolean[] = [];
    const sub = subscribe({ goal, on: (r) => events.push(r.satisfied), fireOnFirst: true });
    sub.tick({ ready: false });
    expect(events).toEqual([false]);
  });

  test("unsubscribe stops events", () => {
    const events: boolean[] = [];
    const sub = subscribe({ goal, on: (r) => events.push(r.satisfied) });
    sub.tick({ ready: false });
    sub.unsubscribe();
    sub.tick({ ready: true });
    expect(events).toEqual([]);
  });
});
