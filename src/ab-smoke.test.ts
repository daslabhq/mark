/**
 * Smoke test: autocheck on real AutomationBench tasks.
 *
 * Verifies autocheck correctly grades simple_email_sf_contact_* tasks: at
 * the task's seeded initial state, autocheck must report `pass: false` with
 * a useful `why` (the "agent hasn't done the work yet" baseline).
 *
 * Requires AutomationBench tasks on disk. Set:
 *   AB_TASKS_DIR=/path/to/automationbench/tasks   (sibling AB checkout)
 * If unset, this file's tests skip cleanly — the rest of the suite still runs.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runCheck } from "./evaluate.js";
import type { CheckExpr } from "./check.js";

const TASK_DIR = process.env.AB_TASKS_DIR ?? "";
const HAS_AB = TASK_DIR !== "" && existsSync(TASK_DIR);
if (!HAS_AB) {
  console.warn("[ab-smoke] AB_TASKS_DIR not set or missing — skipping AutomationBench smoke tests.");
}

interface AbAssertion {
  type: string;
  contact_id?: string;
  record_id?: string;
  field?: string;
  value?: unknown;
  collection?: string;
  [k: string]: unknown;
}

interface AbTask {
  task: string;
  prompt: { role: string; content: string }[];
  info: {
    initial_state: unknown;
    assertions: AbAssertion[];
    zapier_tools: string[];
  };
}

/**
 * Translate one Zapier-format assertion to an autocheck CheckExpr.
 *
 * This is a minimal subset for the smoke test — full coverage is the
 * Day-2 differential testing task. Right now we just need the variants
 * that show up in the four tasks we already ran.
 */
function translate(a: AbAssertion): CheckExpr {
  switch (a.type) {
    case "salesforce_field_equals":
    case "salesforce_contact_field_equals":
      // Zapier's two near-duplicate ops both reduce to the same check.
      // (This is the elegance argument: 80+ Zapier types collapse into a
      // few autocheck shapes.)
      return {
        op: "eq",
        path: `salesforce.contacts[id=${a.contact_id ?? a.record_id}].${a.field}`,
        value: a.value,
      };
    case "salesforce_lead_field_equals":
      return {
        op: "eq",
        path: `salesforce.leads[id=${a.contact_id ?? a.record_id}].${a.field}`,
        value: a.value,
      };
    default:
      throw new Error(`unhandled assertion type in smoke test: ${a.type}`);
  }
}

function loadTask(slug: string): AbTask {
  return JSON.parse(readFileSync(join(TASK_DIR, `${slug}.json`), "utf-8"));
}

describe.skipIf(!HAS_AB)("autocheck on AutomationBench seeded states", () => {
  const TASKS = [
    "simple_email_sf_contact_email_update",
    "simple_email_sf_contact_title_update",
    "simple_email_sf_contact_assistant_update",
  ];

  for (const slug of TASKS) {
    test(`${slug}: initial state must NOT pass`, () => {
      const task = loadTask(slug);
      // AND-compose all assertions into one check.
      const check: CheckExpr =
        task.info.assertions.length === 1
          ? translate(task.info.assertions[0]!)
          : { op: "and", of: task.info.assertions.map(translate) };

      const result = runCheck(task.info.initial_state, check);

      // The broken adapter reported these as already-satisfied.
      // autocheck must report them as NOT passing (this is the bug fix proof).
      expect(result.pass).toBe(false);
      expect(result.gap).toBeGreaterThan(0);
      // And give a useful diagnostic so an agent can read why.
      expect(result.why).toBeString();
      expect(result.why!.length).toBeGreaterThan(0);
    });
  }

  // Also verify autocheck agrees with reality for the task that DID work end-to-end:
  test("simple_email_sf_contact_phone_update: initial state correctly not-pass", () => {
    const task = loadTask("simple_email_sf_contact_phone_update");
    const check = translate(task.info.assertions[0]!);
    const r = runCheck(task.info.initial_state, check);
    expect(r.pass).toBe(false);
    expect(r.gap).toBe(1);
  });

  // And: simulate the agent's correct action and verify autocheck flips to pass.
  test("simple_email_sf_contact_email_update: applying the correct update flips to pass", () => {
    const task = loadTask("simple_email_sf_contact_email_update");
    const a = task.info.assertions[0]!;
    const scene = structuredClone(task.info.initial_state) as any;
    const target = scene.salesforce.contacts.find((c: any) => c.id === a.contact_id);
    target[a.field as string] = a.value;

    const check = translate(a);
    const r = runCheck(scene, check);
    expect(r.pass).toBe(true);
    expect(r.gap).toBe(0);
  });
});
