#!/usr/bin/env bun

import { execSync, spawn } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";

// ── Constants ──────────────────────────────────────────────────────────

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, ".kilohub");
const REPO_DIR = join(ROOT, "repo");
const ISSUES_FILE = join(STATE_DIR, "issues.json");
const PROGRESS_FILE = join(STATE_DIR, "progress.json");
const PROMPT_FILE = join(STATE_DIR, "current-prompt.md");
const REPO_URL = "https://github.com/Kilo-Org/kilocode.git";
const DEFAULT_MODEL = "kilo/google/gemini-2.5-flash";
const SOLVE_TIMEOUT = 20 * 60 * 1000; // 20 minutes
const DELAY_BETWEEN_SOLVES = 5000; // 5 seconds
const MAX_BODY_LENGTH = 2000;

// ── Types ──────────────────────────────────────────────────────────────

interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
}

interface SolveAttempt {
  issueNumber: number;
  status: "pending" | "success" | "no-changes" | "error" | "timeout";
  branch: string;
  model: string;
  timestamp: string;
  error?: string;
  filesChanged?: number;
}

interface Progress {
  attempts: SolveAttempt[];
}

// ── Utilities ──────────────────────────────────────────────────────────

const log = (msg: string) => console.log(`[kilohub] ${msg}`);
const err = (msg: string) => console.error(`[kilohub] ERROR: ${msg}`);

const exec = (cmd: string, opts: { cwd?: string; timeout?: number } = {}): string => {
  try {
    return execSync(cmd, {
      cwd: opts.cwd ?? ROOT,
      timeout: opts.timeout ?? 30000,
      maxBuffer: 50 * 1024 * 1024,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e: any) {
    throw new Error(e.stderr?.trim() || e.message);
  }
};

const readJson = <T>(path: string, fallback: T): T => {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
};

const writeJson = (path: string, data: unknown) => {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
};

const loadProgress = (): Progress => readJson(PROGRESS_FILE, { attempts: [] });

const TRIAGE_FILE = join(STATE_DIR, "triage.json");
const loadTriage = (): Record<string, string> => readJson(TRIAGE_FILE, {});
const saveTriage = (t: Record<string, string>) => writeJson(TRIAGE_FILE, t);

const saveProgress = (p: Progress) => writeJson(PROGRESS_FILE, p);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Commands ───────────────────────────────────────────────────────────

const cmdInit = async () => {
  log("Initializing KiloHub...");

  // Create state dir
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
    log("Created .kilohub/ state directory");
  }

  // Clone repo
  if (existsSync(REPO_DIR)) {
    log("Repo already exists, pulling latest...");
    exec("git fetch origin && git checkout main && git pull origin main", { cwd: REPO_DIR });
  } else {
    log("Cloning kilocode repo...");
    exec(`git clone ${REPO_URL} repo`, { cwd: ROOT, timeout: 120000 });
  }

  // Install deps
  log("Installing dependencies...");
  try {
    exec("bun install", { cwd: REPO_DIR, timeout: 120000 });
    log("Dependencies installed.");
  } catch (e: any) {
    log(`Warning: bun install had issues: ${e.message}`);
  }

  // Init state files
  if (!existsSync(PROGRESS_FILE)) writeJson(PROGRESS_FILE, { attempts: [] });

  log("Init complete. Run 'kilohub fetch-issues' next.");
};

const cmdFetchIssues = async () => {
  log("Fetching all open issues from GitHub (full copy)...");

  const raw = exec(
    `gh issue list --repo Kilo-Org/kilocode --state open --limit 500 --json number,title,body,labels,url,author,createdAt,updatedAt,comments`,
    { timeout: 60000 }
  );

  const ghIssues = JSON.parse(raw) as Array<{
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    url: string;
    author: { login: string };
    createdAt: string;
    updatedAt: string;
    comments: Array<{ author: { login: string }; body: string; createdAt: string }>;
  }>;

  const issues = ghIssues.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body || "",
    labels: i.labels.map((l) => l.name),
    url: i.url,
    author: i.author?.login || "unknown",
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    comments: (i.comments || []).map((c) => ({
      author: c.author?.login || "unknown",
      body: c.body || "",
      createdAt: c.createdAt,
    })),
  }));

  writeJson(ISSUES_FILE, issues);
  log(`Cached ${issues.length} open issues (with comments) to .kilohub/issues.json`);
};

const cmdSolve = async (issueNumber: number, model: string) => {
  const issues: Issue[] = readJson(ISSUES_FILE, []);
  const issue = issues.find((i) => i.number === issueNumber);

  if (!issue) {
    err(`Issue #${issueNumber} not found in cache. Run 'kilohub fetch-issues' first.`);
    process.exit(1);
  }

  const branch = `kilohub/fix-issue-${issueNumber}`;
  const progress = loadProgress();

  log(`Solving issue #${issueNumber}: ${issue.title}`);

  // 1. Reset repo to clean main
  try {
    exec("git checkout main && git reset --hard origin/main && git clean -fd", { cwd: REPO_DIR });
  } catch {
    exec("git checkout main && git reset --hard HEAD && git clean -fd", { cwd: REPO_DIR });
  }

  // 2. Create branch
  try {
    exec(`git branch -D ${branch}`, { cwd: REPO_DIR });
  } catch {
    // branch didn't exist, fine
  }
  exec(`git checkout -b ${branch}`, { cwd: REPO_DIR });
  log(`Created branch: ${branch}`);

  // 3. Write prompt
  const prompt = buildPrompt(issue);
  writeFileSync(PROMPT_FILE, prompt);
  log("Wrote prompt to .kilohub/current-prompt.md");

  // 4. Run kilo
  const attempt: SolveAttempt = {
    issueNumber,
    status: "pending",
    branch,
    model,
    timestamp: new Date().toISOString(),
  };

  try {
    log(`Solving with Kilo CLI (model: ${model})...`);
    const result = await solveWithKilo(issue, model);
    log(`Solver finished: ${result}`);
  } catch (e: any) {
    if (e.message.includes("TIMEOUT")) {
      attempt.status = "timeout";
      attempt.error = "Kilo CLI timed out";
      log("Solver timed out.");
    } else {
      attempt.status = "error";
      attempt.error = e.message.slice(0, 500);
      err(`Solver failed: ${e.message}`);
    }
  }

  // 5. Check for changes
  if (attempt.status === "pending") {
    try {
      const diffStat = exec("git diff --stat", { cwd: REPO_DIR });
      if (diffStat.length > 0) {
        // Stage and commit
        exec("git add -A", { cwd: REPO_DIR });
        const commitMsg = `fix: attempt fix for issue #${issueNumber}\n\n${issue.title}\n\nAutomated fix by KiloHub using Kilo CLI\nModel: ${model}`;
        exec(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: REPO_DIR });

        const filesChanged = diffStat.split("\n").length - 1;
        attempt.status = "success";
        attempt.filesChanged = filesChanged;
        log(`Committed changes (${filesChanged} files) on branch ${branch}`);
      } else {
        // Check staged changes too
        const stagedStat = exec("git diff --cached --stat", { cwd: REPO_DIR });
        if (stagedStat.length > 0) {
          const commitMsg = `fix: attempt fix for issue #${issueNumber}\n\n${issue.title}\n\nAutomated fix by KiloHub using Kilo CLI\nModel: ${model}`;
          exec(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: REPO_DIR });
          attempt.status = "success";
          attempt.filesChanged = stagedStat.split("\n").length - 1;
          log(`Committed staged changes on branch ${branch}`);
        } else {
          attempt.status = "no-changes";
          log("No changes detected after kilo run.");
        }
      }
    } catch (e: any) {
      attempt.status = "error";
      attempt.error = `Post-kilo error: ${e.message}`;
      err(e.message);
    }
  }

  // 6. Record progress
  progress.attempts = progress.attempts.filter((a) => a.issueNumber !== issueNumber);
  progress.attempts.push(attempt);
  saveProgress(progress);

  // 7. Return to main
  try {
    exec("git checkout main", { cwd: REPO_DIR });
  } catch {
    // best effort
  }

  return attempt;
};

const cmdSolveAll = async (limit: number, model: string) => {
  const issues: Issue[] = readJson(ISSUES_FILE, []);
  if (issues.length === 0) {
    err("No issues found. Run 'kilohub fetch-issues' first.");
    process.exit(1);
  }

  const progress = loadProgress();
  const triage = loadTriage();
  const solved = new Set(progress.attempts.filter((a) => a.status === "success").map((a) => a.issueNumber));
  const skipped = new Set(Object.entries(triage).filter(([_, v]) => v === "skip").map(([k]) => parseInt(k)));
  const remaining = issues.filter((i) => !solved.has(i.number) && !skipped.has(i.number));
  const toSolve = remaining.slice(0, limit);

  log(`Solving ${toSolve.length} issues (${solved.size} solved, ${skipped.size} skipped, ${remaining.length} remaining)`);

  let interrupted = false;
  process.on("SIGINT", () => {
    log("\nSIGINT received. Saving progress and exiting...");
    interrupted = true;
  });

  for (let i = 0; i < toSolve.length; i++) {
    if (interrupted) break;

    const issue = toSolve[i];
    log(`\n[${ i + 1}/${toSolve.length}] Issue #${issue.number}: ${issue.title}`);

    try {
      await cmdSolve(issue.number, model);
    } catch (e: any) {
      err(`Failed to solve #${issue.number}: ${e.message}`);
    }

    // Delay between solves (skip after last)
    if (i < toSolve.length - 1 && !interrupted) {
      log(`Waiting ${DELAY_BETWEEN_SOLVES / 1000}s before next issue...`);
      await sleep(DELAY_BETWEEN_SOLVES);
    }
  }

  log("\nSolve-all complete.");
  printStatus();
};

const cmdStatus = () => {
  printStatus();
};

const cmdAutoTriage = async (model: string, batchSize: number) => {
  const issues: Issue[] = readJson(ISSUES_FILE, []);
  if (issues.length === 0) {
    err("No issues found. Run 'kilohub fetch-issues' first.");
    process.exit(1);
  }

  const triage = loadTriage();
  const untriaged = issues.filter((i) => !triage[i.number]);
  log(`${untriaged.length} untriaged issues (${Object.keys(triage).length} already done)`);

  if (untriaged.length === 0) {
    log("All issues already triaged.");
    return;
  }

  let interrupted = false;
  process.on("SIGINT", () => {
    log("\nSIGINT received. Saving progress...");
    interrupted = true;
  });

  // Process in batches
  for (let i = 0; i < untriaged.length; i += batchSize) {
    if (interrupted) break;

    const batch = untriaged.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(untriaged.length / batchSize);
    log(`Batch ${batchNum}/${totalBatches} (${batch.length} issues)...`);

    const prompt = buildTriagePrompt(batch);

    try {
      const result = await runKiloTriage(prompt, model);
      const decisions = parseTriageResult(result, batch);

      let kept = 0;
      let skipped = 0;
      for (const [num, decision] of Object.entries(decisions)) {
        triage[num] = decision;
        if (decision === "skip") skipped++;
        else kept++;
      }
      saveTriage(triage);
      log(`  -> ${kept} fixable, ${skipped} skipped`);
    } catch (e: any) {
      err(`Batch ${batchNum} failed: ${e.message}`);
      // Mark batch as keep by default on failure
      for (const issue of batch) {
        if (!triage[issue.number]) triage[issue.number] = "keep";
      }
      saveTriage(triage);
    }

    // Small delay between batches
    if (i + batchSize < untriaged.length && !interrupted) {
      await sleep(2000);
    }
  }

  const finalTriage = loadTriage();
  const skipCount = Object.values(finalTriage).filter((v) => v === "skip").length;
  const keepCount = Object.values(finalTriage).filter((v) => v === "keep").length;
  log(`\nTriage complete: ${keepCount} fixable, ${skipCount} skipped out of ${issues.length} total`);
};

const buildTriagePrompt = (batch: Issue[]): string => {
  const issueList = batch
    .map((i) => {
      const labels = i.labels.length > 0 ? ` [${i.labels.join(", ")}]` : "";
      const bodyPreview = (i.body || "").slice(0, 150).replace(/\n/g, " ");
      return `#${i.number}: ${i.title}${labels}\n${bodyPreview}`;
    })
    .join("\n---\n");

  return `/no_think
You are classifying GitHub issues for a VS Code extension called "Kilo Code" (TypeScript/Node.js codebase).

For each issue, decide: can it be fixed by modifying SOURCE CODE or CONFIG FILES in the repository?

SKIP (not fixable by code):
- JetBrains/IntelliJ plugin requests (this is a VS Code extension only)
- Marketplace listing changes, store descriptions, branding
- Community management, moderation, social media
- Hardware/OS-specific issues that need user-side fixes
- Feature requests for completely different products
- Issues that are just questions, not bugs or feature requests
- Issues about documentation website (not in-repo docs)

KEEP (fixable by code):
- Bug fixes, error handling, crashes
- Feature additions or enhancements
- UI/UX improvements in the extension
- Configuration, settings, preferences
- API integrations, model provider support
- Build system, CI/CD, tooling improvements
- In-repo documentation updates (README, comments)
- Performance improvements
- Refactoring requests

Respond with ONLY a JSON object mapping issue numbers to "keep" or "skip". No explanation.
Example: {"123":"keep","456":"skip","789":"keep"}

Issues:
---
${issueList}
---

JSON:`;
};

const runKiloTriage = async (prompt: string, model: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const child = spawn("kilo", ["run", "--auto", "-m", model, prompt], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, KILO_DISABLE_AUTOUPDATE: "1" },
    });

    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("TIMEOUT"));
    }, 60000);

    child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(output);
      else reject(new Error(`Kilo CLI exited with code ${code}: ${output.slice(0, 200)}`));
    });

    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn kilo: ${e.message}`));
    });
  });
};

const parseTriageResult = (raw: string, batch: Issue[]): Record<string, string> => {
  // Extract JSON from the output (might be wrapped in markdown or other text)
  const jsonMatch = raw.match(/\{[^{}]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const result: Record<string, string> = {};
      for (const issue of batch) {
        const val = parsed[String(issue.number)] || parsed[issue.number];
        result[issue.number] = val === "skip" ? "skip" : "keep";
      }
      return result;
    } catch {}
  }

  // Fallback: try line-by-line parsing
  const result: Record<string, string> = {};
  for (const issue of batch) {
    const pattern = new RegExp(`#?${issue.number}[^a-z]*(skip|keep)`, "i");
    const match = raw.match(pattern);
    result[issue.number] = match?.[1]?.toLowerCase() === "skip" ? "skip" : "keep";
  }
  return result;
};

// ── Helpers ────────────────────────────────────────────────────────────

const buildPrompt = (issue: Issue): string => {
  const body = (issue.body || "No description provided.").slice(0, MAX_BODY_LENGTH);
  return `Fix issue #${issue.number}: ${issue.title}

${body}

Rules: minimal changes only, no test files, no unrelated files. Just fix the bug/feature described above.`;
};

// ── Kilo CLI solver ───────────────────────────────────────────────────

const solveWithKilo = async (issue: Issue, model: string): Promise<string> => {
  const logFile = join(STATE_DIR, "kilo-run.log");
  writeFileSync(logFile, `[${new Date().toISOString()}] Solving #${issue.number} with Kilo CLI (${model})\n`);

  const prompt = buildPrompt(issue);
  log("Running Kilo CLI...");

  return new Promise((resolve, reject) => {
    const args = [
      "run",
      "--auto",
      "--dir", REPO_DIR,
      "-m", model,
      prompt,
    ];

    const child = spawn("kilo", args, {
      cwd: REPO_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, KILO_DISABLE_AUTOUPDATE: "1" },
    });

    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("TIMEOUT: Kilo CLI timed out"));
    }, SOLVE_TIMEOUT);

    const onData = (d: Buffer) => {
      const text = d.toString();
      output += text;
      const lines = text.split("\n").filter(Boolean);
      for (const l of lines) {
        log(`  ${l}`);
        appendFileSync(logFile, l + "\n");
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("close", (code) => {
      clearTimeout(timeout);
      appendFileSync(logFile, `\n[exit code ${code}]\n`);
      if (code === 0) {
        resolve(output.length > 0 ? "kilo-completed" : "no-output");
      } else {
        reject(new Error(`Kilo CLI exited with code ${code}`));
      }
    });

    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn kilo: ${e.message}`));
    });
  });
};

const printStatus = () => {
  const progress = loadProgress();
  const issues: Issue[] = readJson(ISSUES_FILE, []);

  console.log("\n=== KiloHub Status ===\n");
  console.log(`Total cached issues: ${issues.length}`);
  console.log(`Total attempts: ${progress.attempts.length}\n`);

  if (progress.attempts.length === 0) {
    console.log("No solve attempts yet.\n");
    return;
  }

  const counts = { success: 0, "no-changes": 0, error: 0, timeout: 0, pending: 0 };
  for (const a of progress.attempts) {
    counts[a.status] = (counts[a.status] || 0) + 1;
  }

  console.log(`  Success:    ${counts.success}`);
  console.log(`  No changes: ${counts["no-changes"]}`);
  console.log(`  Errors:     ${counts.error}`);
  console.log(`  Timeouts:   ${counts.timeout}`);
  console.log(`  Pending:    ${counts.pending}`);
  console.log("");

  // Table of recent attempts
  console.log("Recent attempts:");
  console.log("─".repeat(80));
  console.log(
    `${"#".padEnd(8)}${"Status".padEnd(14)}${"Branch".padEnd(30)}${"Files".padEnd(8)}${"Model".padEnd(20)}`
  );
  console.log("─".repeat(80));

  for (const a of progress.attempts.slice(-20)) {
    const files = a.filesChanged !== undefined ? String(a.filesChanged) : "-";
    const shortModel = a.model.split("/").pop() || a.model;
    console.log(
      `${String(a.issueNumber).padEnd(8)}${a.status.padEnd(14)}${a.branch.padEnd(30)}${files.padEnd(8)}${shortModel.padEnd(20)}`
    );
  }
  console.log("─".repeat(80));
  console.log("");
};

// ── CLI Entry ──────────────────────────────────────────────────────────

const main = async () => {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(`
KiloHub - Automated Issue Solver for Kilo Code

Usage:
  kilohub init                          Clone repo, install deps, create state
  kilohub fetch-issues                  Fetch open issues via gh CLI
  kilohub solve <number>                Attempt to fix a single issue
  kilohub solve-all [--limit N] [-m M]  Loop through all issues
  kilohub auto-triage [-m M]            AI-classify issues as fixable or not
  kilohub status                        Show progress dashboard

Options:
  --limit N    Max issues to solve (default: all)
  -m, --model  Model to use (default: ${DEFAULT_MODEL})
`);
    process.exit(0);
  }

  switch (command) {
    case "init":
      await cmdInit();
      break;

    case "fetch-issues":
      await cmdFetchIssues();
      break;

    case "solve": {
      const num = parseInt(args[1]);
      if (isNaN(num)) {
        err("Usage: kilohub solve <issue-number>");
        process.exit(1);
      }
      const { values } = parseArgs({
        args: args.slice(2),
        options: {
          model: { type: "string", short: "m", default: DEFAULT_MODEL },
        },
        allowPositionals: true,
      });
      await cmdSolve(num, values.model!);
      break;
    }

    case "solve-all": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          limit: { type: "string", default: "999" },
          model: { type: "string", short: "m", default: DEFAULT_MODEL },
        },
        allowPositionals: true,
      });
      await cmdSolveAll(parseInt(values.limit!), values.model!);
      break;
    }

    case "auto-triage": {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          model: { type: "string", short: "m", default: DEFAULT_MODEL },
          batch: { type: "string", default: "10" },
        },
        allowPositionals: true,
      });
      await cmdAutoTriage(values.model!, parseInt(values.batch!));
      break;
    }

    case "status":
      cmdStatus();
      break;

    default:
      err(`Unknown command: ${command}`);
      process.exit(1);
  }
};

main().catch((e) => {
  err(e.message);
  process.exit(1);
});
