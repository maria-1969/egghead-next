#!/usr/bin/env node
/**
 * context-rot-check — finds stale claims in AI instruction files (CLAUDE.md, *.md runbooks).
 *
 *   node context-rot-check.mjs audit                 # measure rot at HEAD  -> your number
 *   node context-rot-check.mjs pr --base origin/dev  # gate a PR in CI
 *   node context-rot-check.mjs audit --json out.json # machine-readable, for tallying
 *
 * Requires: node 18+, ANTHROPIC_API_KEY.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const MODEL = process.env.ROT_MODEL || "claude-sonnet-4-6";
const API_KEY = process.env.ANTHROPIC_API_KEY;

// ---- 1. WHICH FILES COUNT AS INSTRUCTION FILES ----------------------------
// Edit this. It is the single most important knob in the script.
const INSTRUCTION_GLOBS = [
  "CLAUDE.md", "claude.md", "AGENTS.md", ".cursorrules",
  "*.md", ".claude/**/*.md", "docs/ai/**/*.md",
];

// ---- 2. WHEN THE PR GATE FIRES --------------------------------------------
// Only structural changes can invalidate an instruction file. Everything else
// is noise, and noise is how a check like this gets switched off in week two.
const STRUCTURAL = [
  /schema\.prisma$/,
  /package\.json$/,
  /^src\/datasources\//,
  /(^|\/)(tsconfig|docker-compose|Dockerfile)/,
];

const sh = (cmd) => execSync(cmd, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();

function instructionFiles() {
  // explicit list wins: --files a.md b.md ...  (so Phase 0 runs both tools over the same set)
  const fi = process.argv.indexOf("--files");
  if (fi !== -1) {
    return process.argv.slice(fi + 1).filter((a) => !a.startsWith("--") && existsSync(a));
  }
  const tracked = sh("git ls-files").split("\n");
  const rx = INSTRUCTION_GLOBS.map(
    (g) => new RegExp("^" + g.replace(/\./g, "\\.").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$")
  );
  return tracked.filter((f) => rx.some((r) => r.test(f)));
}

/** Ground truth the model checks claims against. Cheap, deterministic, small. */
function repoFacts() {
  const tracked = sh("git ls-files").split("\n");
  const scripts = existsSync("package.json")
    ? Object.keys(JSON.parse(readFileSync("package.json", "utf8")).scripts || {})
    : [];
  const schemas = tracked.filter((f) => f.endsWith("schema.prisma"));
  // Keep the tree small or you pay for it every run: dirs + config-ish files only.
  const dirs = [...new Set(tracked.map((f) => f.split("/").slice(0, 3).join("/")))];
  return { npm_scripts: scripts, prisma_schemas: schemas, tracked_paths_sample: dirs, tracked_count: tracked.length };
}

// ---- 3. THE PROMPT --------------------------------------------------------
// Narrow question, mandatory verbatim quote, explicit permission to return
// nothing. All three are load-bearing against false positives.
const SYSTEM = `You audit AI-assistant instruction files (CLAUDE.md and similar) for STALE CLAIMS.

A stale claim is a statement in the file that is FALSE about the codebase as it exists now. Categories:
- referential: names a file, path, script, function, or command that no longer exists
- count: a number that no longer matches ("three datasources", "two clients")
- architectural: describes a component, datasource, or integration that was removed or restructured
- behavioral: a convention or workflow instruction the codebase no longer follows
- contradiction: two statements in the file that cannot both be true

RULES:
1. Every finding MUST include "quote": text copied CHARACTER-FOR-CHARACTER from the instruction file. If you cannot quote it exactly, do not report it.
2. Only report what the evidence supports. You are shown limited repo facts — if you cannot tell whether a claim is false, DO NOT report it. Silence is the correct output for a healthy file.
3. Do not report style, tone, missing docs, or things that could be improved. Only claims that are FALSE.
4. confidence: "high" only when the evidence directly contradicts the claim. "medium" when strongly implied. Never report below medium.

Return ONLY a JSON object, no prose, no markdown fences:
{"findings":[{"quote":"...","kind":"referential|count|architectural|behavioral|contradiction","why":"one sentence","confidence":"high|medium"}]}
Return {"findings":[]} if the file is clean.`;

function userPrompt({ path, content, facts, diff }) {
  return [
    diff
      ? `A pull request made the changes below. Report ONLY claims in the instruction file that THIS DIFF invalidates.\n\n<diff>\n${diff}\n</diff>`
      : `Report claims in the instruction file that are false about the repository as it exists now.`,
    `<repo_facts>\n${JSON.stringify(facts, null, 1)}\n</repo_facts>`,
    `<instruction_file path="${path}">\n${content}\n</instruction_file>`,
  ].join("\n\n");
}

async function ask(body) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 8000, system: SYSTEM, messages: [{ role: "user", content: body }] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const stop = data.stop_reason;
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  // Be tolerant: strip fences, then take the outermost {...} in case the model
  // added a sentence of prose around the JSON.
  let json = text.replace(/```json|```/g, "").trim();
  const open = json.indexOf("{"), close = json.lastIndexOf("}");
  if (open >= 0 && close > open) json = json.slice(open, close + 1);
  try {
    return JSON.parse(json).findings || [];
  } catch {
    const hint = stop === "max_tokens" ? " (response hit max_tokens — raise it)" : "";
    console.error(`  ! unparseable model output, skipping file${hint}. First 400 chars:\n${text.slice(0, 400)}`);
    return [];
  }
}

// ---- 4. VERIFICATION ------------------------------------------------------
// The model proposes; the repo disposes. Drop any finding whose quote isn't
// literally in the file — that is a hallucination, and it costs nothing to catch.
function verify(findings, content) {
  const lines = content.split("\n");
  return findings.flatMap((f) => {
    const idx = lines.findIndex((l) => l.includes(f.quote.split("\n")[0].trim()));
    if (idx === -1) return [];              // quote not real -> discard
    return [{ ...f, line: idx + 1 }];
  });
}

// ---- 5. MODES -------------------------------------------------------------
async function run() {
  if (!API_KEY) { console.error("set ANTHROPIC_API_KEY"); process.exit(2); }
  const mode = process.argv[2] || "audit";
  const base = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "origin/dev";
  const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

  let diff = null;
  if (mode === "pr") {
    const changed = sh(`git diff --name-only ${base}...HEAD`).split("\n").filter(Boolean);
    const structural = changed.filter((f) => STRUCTURAL.some((r) => r.test(f)));
    const deleted = sh(`git diff --diff-filter=DR --name-only ${base}...HEAD`).split("\n").filter(Boolean);
    if (!structural.length && !deleted.length) {
      console.log("no structural changes — skipping context-rot check");
      return;
    }
    console.log(`structural changes: ${[...new Set([...structural, ...deleted])].join(", ")}`);
    diff = sh(`git diff ${base}...HEAD -- ${[...new Set([...structural, ...deleted])].map((f) => `'${f}'`).join(" ")}`).slice(0, 60000);
  }

  const facts = repoFacts();
  const files = instructionFiles();
  const report = [];

  for (const path of files) {
    const content = readFileSync(path, "utf8");
    process.stdout.write(`checking ${path} ... `);
    const raw = await ask(userPrompt({ path, content, facts, diff }));
    const findings = verify(raw, content);
    console.log(`${findings.length} finding(s)${raw.length !== findings.length ? ` (${raw.length - findings.length} discarded: bad quote)` : ""}`);
    if (findings.length) report.push({ path, findings });
  }

  // ---- output ----
  const total = report.reduce((n, r) => n + r.findings.length, 0);
  const byKind = {};
  report.forEach((r) => r.findings.forEach((f) => (byKind[f.kind] = (byKind[f.kind] || 0) + 1)));

  console.log("\n" + "=".repeat(60));
  console.log(`${total} stale claim(s) across ${report.length}/${files.length} instruction files`);
  console.log("by kind:", JSON.stringify(byKind));
  const referential = byKind.referential || 0;
  console.log(`referential (a grep/DOCER-style tool could catch): ${referential}`);
  console.log(`semantic    (it could not): ${total - referential}`);
  console.log("=".repeat(60) + "\n");

  for (const { path, findings } of report) {
    console.log(`\n### ${path}`);
    for (const f of findings) console.log(`  L${f.line} [${f.kind}/${f.confidence}] "${f.quote.slice(0, 70)}"\n      -> ${f.why}`);
  }

  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ mode, model: MODEL, files: files.length, total, byKind, report }, null, 2));
  if (mode === "pr" && total > 0) process.exit(1);   // flip to exit(0) for warn-only rollout
}

run().catch((e) => { console.error(e); process.exit(2); });
