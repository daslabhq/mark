#!/usr/bin/env bun
/**
 * Differential test: mark vs Zapier's official AutomationBench grader.
 *
 * For every (assertion, world_state) in the AB corpus, evaluate with both
 * graders and compare. Report divergences classified by assertion type.
 *
 * Requires the AutomationBench Python repo + a venv with its deps installed.
 * Set env vars (or use the corresponding flags):
 *
 *   AB_TASKS_DIR=/path/to/automationbench/tasks
 *   AB_PYTHON=/path/to/automationbench/.venv/bin/python
 *   AB_REPO=/path/to/automationbench         (used as cwd for the bridge)
 *
 * Optional flags:
 *   --max=200          cap cases for fast iteration
 *   --types=salesforce_*
 */

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/evaluate.js";
import { translate, SUPPORTED_TYPES } from "../src/translate/automationbench.js";

const HERE      = import.meta.dir;
const TASK_DIR  = process.env.AB_TASKS_DIR;
const AB_REPO   = process.env.AB_REPO;
const AB_PYTHON = process.env.AB_PYTHON;
const BRIDGE    = join(HERE, "zapier-grade.py");

if (!TASK_DIR || !existsSync(TASK_DIR)) {
  console.error("error: AB_TASKS_DIR is not set or missing.");
  console.error("       export AB_TASKS_DIR=/path/to/automationbench/tasks");
  process.exit(1);
}
if (!AB_REPO || !existsSync(AB_REPO)) {
  console.error("error: AB_REPO is not set or missing (the AutomationBench Python repo).");
  console.error("       export AB_REPO=/path/to/automationbench");
  process.exit(1);
}
if (!AB_PYTHON || !existsSync(AB_PYTHON)) {
  console.error("error: AB_PYTHON is not set or missing (Python with AutomationBench deps).");
  console.error("       export AB_PYTHON=/path/to/automationbench/.venv/bin/python");
  process.exit(1);
}

interface Args { max?: number; typesGlob?: string; }
function parseArgs(): Args {
  const args: Args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--(\w+)=(.+)$/);
    if (!m) continue;
    if (m[1] === "max")   args.max = parseInt(m[2]!, 10);
    if (m[1] === "types") args.typesGlob = m[2];
  }
  return args;
}

interface Case {
  idx:        number;
  taskSlug:   string;
  type:       string;
  assertion:  any;
  world:      any;
  approximate?: boolean;
}

interface MarkResult {
  satisfied: boolean;
  gap:       number;
  evidence?: string;
}

async function main() {
  const args = parseArgs();

  // 1. Build the case corpus from AB tasks.
  const cases: Case[] = [];
  const skipped: Record<string, number> = {};
  const taskFiles = readdirSync(TASK_DIR).filter(f => f.endsWith(".json") && f !== "tasks-manifest.json");
  let idx = 0;
  for (const f of taskFiles) {
    const slug = f.replace(/\.json$/, "");
    const task = JSON.parse(readFileSync(join(TASK_DIR, f), "utf-8"));
    for (const a of task.info.assertions ?? []) {
      if (args.typesGlob) {
        const re = new RegExp("^" + args.typesGlob.replace(/\*/g, ".*") + "$");
        if (!re.test(a.type)) continue;
      }
      if (!SUPPORTED_TYPES.has(a.type)) {
        skipped[a.type] = (skipped[a.type] ?? 0) + 1;
        continue;
      }
      cases.push({ idx: idx++, taskSlug: slug, type: a.type, assertion: a, world: task.info.initial_state });
      if (args.max && cases.length >= args.max) break;
    }
    if (args.max && cases.length >= args.max) break;
  }

  console.log(`prepared ${cases.length} cases across ${SUPPORTED_TYPES.size} translatable types`);
  console.log(`skipped ${Object.values(skipped).reduce((a, b) => a + b, 0)} cases for unsupported types (${Object.keys(skipped).length} distinct)`);

  // 2. Evaluate all cases in mark — fast, in-process.
  const markResults: Map<number, MarkResult & { translated: boolean; approximate?: boolean }> = new Map();
  for (const c of cases) {
    const t = translate(c.assertion);
    if (!t) {
      markResults.set(c.idx, { satisfied: false, gap: 1, translated: false });
      continue;
    }
    try {
      const r = evaluate(c.world, t.predicate);
      markResults.set(c.idx, { ...r, translated: true, approximate: t.approximate });
    } catch (e) {
      markResults.set(c.idx, { satisfied: false, gap: 1, translated: false, evidence: `mark error: ${e}` });
    }
  }
  const markMs = Date.now();

  // 3. Evaluate all cases in Zapier's Python grader — single subprocess.
  const zapierResults = await runZapierBatch(cases);
  const zapierMs = Date.now();

  // 4. Compare and report.
  let agree = 0, disagree = 0, errored = 0;
  const disagreeByType: Record<string, { count: number; samples: any[]; approximate: number }> = {};
  for (const c of cases) {
    const m = markResults.get(c.idx)!;
    const z = zapierResults.get(c.idx);
    if (!z || z.error) {
      errored++;
      continue;
    }
    if (m.satisfied === z.satisfied) {
      agree++;
    } else {
      disagree++;
      const e = (disagreeByType[c.type] ??= { count: 0, samples: [], approximate: 0 });
      e.count++;
      if (m.approximate) e.approximate++;
      if (e.samples.length < 3) e.samples.push({ slug: c.taskSlug, mark: m.satisfied, zapier: z.satisfied, evidence: m.evidence });
    }
  }

  console.log("");
  console.log("=== differential test report ===");
  console.log(`total cases:    ${cases.length}`);
  console.log(`agree:          ${agree}`);
  console.log(`disagree:       ${disagree}`);
  console.log(`errored:        ${errored}`);
  if (cases.length > 0) {
    console.log(`equivalence:    ${(100 * agree / (cases.length - errored)).toFixed(2)}%`);
  }
  console.log("");
  if (disagree > 0) {
    console.log("=== disagreements by type ===");
    const sorted = Object.entries(disagreeByType).sort(([, a], [, b]) => b.count - a.count);
    for (const [type, e] of sorted) {
      console.log(`${e.count.toString().padStart(5)}  ${type}  (${e.approximate} approximate)`);
      for (const s of e.samples) {
        console.log(`         · ${s.slug}: mark=${s.mark} zapier=${s.zapier}  ${s.evidence ? "[" + s.evidence.slice(0, 80) + "]" : ""}`);
      }
    }
  }
  console.log("");
  console.log(`timing: mark ${markMs - 0}ms ... zapier ${zapierMs - markMs}ms (subprocess)`);
}

interface ZResult { satisfied: boolean | null; error?: string; }

function runZapierBatch(cases: Case[]): Promise<Map<number, ZResult>> {
  return new Promise((resolve, reject) => {
    const proc = spawn(AB_PYTHON, [BRIDGE], { cwd: AB_REPO });
    const results: Map<number, ZResult> = new Map();
    let outBuf = "";
    let errBuf = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      outBuf += chunk.toString();
      const lines = outBuf.split("\n");
      outBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        results.set(r.idx, { satisfied: r.satisfied, error: r.error });
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => { errBuf += chunk.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error("zapier-grade.py stderr:\n" + errBuf);
        reject(new Error(`bridge exited ${code}`));
        return;
      }
      // flush remaining buffer
      if (outBuf.trim()) {
        for (const line of outBuf.split("\n")) {
          if (!line.trim()) continue;
          const r = JSON.parse(line);
          results.set(r.idx, { satisfied: r.satisfied, error: r.error });
        }
      }
      resolve(results);
    });

    // Pipe all cases as JSONL to stdin.
    for (const c of cases) {
      proc.stdin.write(JSON.stringify({ idx: c.idx, assertion: c.assertion, world: c.world }) + "\n");
    }
    proc.stdin.end();
  });
}

await main();
