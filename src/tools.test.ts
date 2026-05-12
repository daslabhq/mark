import { test, expect, describe } from "bun:test";
import { check_scene, gap, diagnose, attachCheck, TOOL_DESCRIPTORS } from "./tools.js";
import { defineCheck } from "./check.js";
import type { CheckExpr } from "./check.js";

describe("agent-first tool surface", () => {
  const check: CheckExpr = { op: "eq", path: "x", value: 1 };

  test("check_scene returns full CheckResult", () => {
    const r = check_scene({ check, scene: { x: 1 } });
    expect(r.pass).toBe(true);
    expect(r.gap).toBe(0);
  });

  test("gap returns just the number — token-efficient", () => {
    const r = gap({ check, scene: { x: 2 } });
    expect(r).toEqual({ gap: 1 });
    expect(Object.keys(r)).toEqual(["gap"]);
  });

  test("diagnose returns short diagnostic only when failed", () => {
    expect(diagnose({ check, scene: { x: 1 } })).toEqual({ pass: true });
    const r = diagnose({ check, scene: { x: 2 } });
    expect(r.pass).toBe(false);
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

describe("defineCheck — named checks carry meta through", () => {
  test("meta flows into CheckResult", () => {
    const cap = defineCheck({
      id:   "warehouse-cost-cap",
      expr: { op: "eq", path: "ok", value: false },
      meta: {
        references: ["Warehouse budget agreement, 2026-03"],
        severity:   "fail",
        tags:       ["budget"],
      },
    });
    const r = check_scene({ check: cap, scene: { ok: false } });
    expect(r.pass).toBe(true);
    expect(r.meta?.references).toEqual(["Warehouse budget agreement, 2026-03"]);
    expect(r.meta?.severity).toBe("fail");
  });

  test("bare CheckExpr has no meta", () => {
    const r = check_scene({ check: { op: "eq", path: "x", value: 1 }, scene: { x: 1 } });
    expect(r.meta).toBeUndefined();
  });
});

describe("attachCheck — agent-first event hook (the auto in autocheck)", () => {
  const check: CheckExpr = { op: "eq", path: "ready", value: true };

  test("fires only on transitions, not every tick", () => {
    const events: boolean[] = [];
    const sub = attachCheck(check, (r) => events.push(r.pass));

    sub.tick({ ready: false }); // no fire (initial → not pass)
    sub.tick({ ready: false }); // no fire (no transition)
    sub.tick({ ready: true  }); // FIRE
    sub.tick({ ready: true  }); // no fire
    sub.tick({ ready: false }); // FIRE

    expect(events).toEqual([true, false]);
    sub.unsubscribe();
  });

  test("fireOnFirst option fires immediately", () => {
    const events: boolean[] = [];
    const sub = attachCheck(check, (r) => events.push(r.pass), { fireOnFirst: true });
    sub.tick({ ready: false });
    expect(events).toEqual([false]);
  });

  test("unsubscribe stops events", () => {
    const events: boolean[] = [];
    const sub = attachCheck(check, (r) => events.push(r.pass));
    sub.tick({ ready: false });
    sub.unsubscribe();
    sub.tick({ ready: true });
    expect(events).toEqual([]);
  });
});
