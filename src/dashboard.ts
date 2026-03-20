#!/usr/bin/env bun

import { execSync, spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, ".kilohub");
const REPO_DIR = join(ROOT, "repo");
const ISSUES_FILE = join(STATE_DIR, "issues.json");
const PROGRESS_FILE = join(STATE_DIR, "progress.json");
const TRIAGE_FILE = join(STATE_DIR, "triage.json");
const PORT = parseInt(process.env.PORT || "3333");
const DEFAULT_MODEL = "kilo/google/gemini-2.5-flash";

// ── State ──────────────────────────────────────────────────────────────

let currentProcess: ChildProcess | null = null;
let solveLog: string[] = [];
let solveState: "idle" | "solving" | "done" | "error" = "idle";
let solveIssueNum: number | null = null;

const readJson = <T>(path: string, fallback: T): T => {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
};

const git = (cmd: string): string => {
  try {
    return execSync(cmd, { cwd: REPO_DIR, encoding: "utf-8", timeout: 10000 }).trim();
  } catch { return ""; }
};

// ── Solve ──────────────────────────────────────────────────────────────

const runSolve = (issueNumber: number, model: string) => {
  if (currentProcess) return false;
  solveLog = [];
  solveState = "solving";
  solveIssueNum = issueNumber;

  const child = spawn("bun", ["run", "src/kilohub.ts", "solve", String(issueNumber), "-m", model], {
    cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
  });
  currentProcess = child;

  const onData = (d: Buffer) => {
    const lines = d.toString().split("\n").filter(Boolean);
    for (const l of lines) { solveLog.push(l); if (solveLog.length > 300) solveLog.shift(); }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  child.on("close", (code) => {
    currentProcess = null;
    solveState = code === 0 ? "done" : "error";
    solveLog.push(`[exit code ${code}]`);
  });
  return true;
};

const runSolveAll = (limit: number, model: string) => {
  if (currentProcess) return false;
  solveLog = [];
  solveState = "solving";
  solveIssueNum = 0;

  const child = spawn("bun", ["run", "src/kilohub.ts", "solve-all", "--limit", String(limit), "-m", model], {
    cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
  });
  currentProcess = child;

  const onData = (d: Buffer) => {
    const lines = d.toString().split("\n").filter(Boolean);
    for (const l of lines) {
      solveLog.push(l);
      if (solveLog.length > 300) solveLog.shift();
      const m = l.match(/Issue #(\d+)/);
      if (m) solveIssueNum = parseInt(m[1]);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  child.on("close", (code) => {
    currentProcess = null;
    solveState = code === 0 ? "done" : "error";
    solveLog.push(`[exit code ${code}]`);
  });
  return true;
};

// ── Build HTML with embedded data ──────────────────────────────────────

const buildHtml = () => {
  const issues = readJson(ISSUES_FILE, []);
  const progress = readJson(PROGRESS_FILE, { attempts: [] });
  const triage: Record<string, string> = readJson(TRIAGE_FILE, {});
  const dataJson = JSON.stringify({ issues, progress, triage }).replace(/<\//g, "<\\/");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KiloHub</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:#0a0e17;--s:#111827;--s2:#1a2332;--b:#1e293b;--t:#e2e8f0;--m:#64748b;
    --a:#6366f1;--a2:#8b5cf6;--g:#10b981;--r:#ef4444;--y:#f59e0b;--c:#06b6d4;
  }
  body{background:var(--bg);color:var(--t);font-family:'Inter',sans-serif;min-height:100vh}
  body::before{content:'';position:fixed;inset:0;background:linear-gradient(rgba(99,102,241,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,.03) 1px,transparent 1px);background-size:50px 50px;animation:grid 20s linear infinite;z-index:0}
  @keyframes grid{to{transform:translate(50px,50px)}}

  .app{position:relative;z-index:1;display:grid;grid-template-columns:1fr minmax(330px,380px);grid-template-rows:auto 1fr;gap:20px;padding:20px;min-height:100vh;width:100%}
  .head{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;padding:12px 0}
  .logo{display:flex;align-items:center;gap:14px}
  .logo h1{font-size:26px;font-weight:700;background:linear-gradient(135deg,var(--a),var(--a2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .badge{font-size:10px;font-weight:600;padding:3px 9px;border-radius:16px;background:rgba(99,102,241,.15);color:var(--a);text-transform:uppercase;letter-spacing:1px}
  .stats{display:flex;gap:20px}
  .st{text-align:center}
  .sv{font-size:22px;font-weight:700;font-family:'JetBrains Mono',monospace}
  .sl{font-size:10px;color:var(--m);text-transform:uppercase;letter-spacing:1px}
  .sv.g{color:var(--g)}.sv.r{color:var(--r)}.sv.y{color:var(--y)}

  /* Left panel */
  .left{display:flex;flex-direction:column;gap:14px;min-width:0;overflow:hidden}
  .bar{background:var(--s);border:1px solid var(--b);border-radius:14px;padding:12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .bar input,.bar select{background:var(--s2);border:1px solid var(--b);border-radius:8px;padding:7px 10px;color:var(--t);font-family:'JetBrains Mono',monospace;font-size:12px;outline:none}
  .bar input:focus{border-color:var(--a)}
  .bar input{flex:1;min-width:60px}
  button{padding:7px 14px;border:none;border-radius:8px;font-family:'Inter',sans-serif;font-size:11px;font-weight:600;cursor:pointer;transition:all .2s;text-transform:uppercase;letter-spacing:.5px}
  .bp{background:linear-gradient(135deg,var(--a),var(--a2));color:#fff}
  .bp:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(99,102,241,.4)}
  .bp:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
  .bg{background:rgba(16,185,129,.1);color:var(--g);border:1px solid rgba(16,185,129,.3)}
  .br{background:rgba(239,68,68,.1);color:var(--r);border:1px solid rgba(239,68,68,.3)}
  .bk{background:none;border:none;color:var(--m);font-size:18px;padding:4px 8px;cursor:pointer;border-radius:6px}
  .bk:hover{background:var(--s2);color:var(--t)}

  /* Issue list */
  .list{background:var(--s);border:1px solid var(--b);border-radius:14px;flex:1;overflow-y:auto;max-height:calc(100vh - 240px);scrollbar-width:thin;scrollbar-color:var(--b) transparent}
  .li{padding:10px 14px;border-bottom:1px solid var(--b);display:flex;align-items:center;gap:10px;cursor:pointer;transition:background .15s}
  .li:hover{background:var(--s2)}.li:last-child{border-bottom:none}
  .li.act{background:rgba(6,182,212,.05);border-left:3px solid var(--c)}
  .ln{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--m);min-width:44px}
  .lt{flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ll{display:flex;gap:3px;flex-shrink:0}
  .lb{font-size:9px;padding:2px 7px;border-radius:10px;background:rgba(99,102,241,.1);color:var(--a);white-space:nowrap}
  .si{width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0}
  .si.ok{background:rgba(16,185,129,.15);color:var(--g)}
  .si.er{background:rgba(239,68,68,.15);color:var(--r)}
  .si.nc{background:rgba(245,158,11,.15);color:var(--y)}

  /* Detail view */
  .detail{background:var(--s);border:1px solid var(--b);border-radius:14px;flex:1;display:none;flex-direction:column;overflow:hidden;max-height:calc(100vh - 240px)}
  .detail.open{display:flex}.list.hide{display:none}

  .dh{padding:14px 16px;border-bottom:1px solid var(--b)}
  .dh-top{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .dh-num{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--m)}
  .dh-title{font-size:16px;font-weight:600;line-height:1.4;flex:1}
  .dh-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .pill{font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:.5px}
  .pill.ok{background:rgba(16,185,129,.15);color:var(--g)}
  .pill.er{background:rgba(239,68,68,.15);color:var(--r)}
  .pill.nc{background:rgba(245,158,11,.15);color:var(--y)}
  .dh-author{font-size:11px;color:var(--m);font-family:'JetBrains Mono',monospace}
  .dh-link{font-size:11px;color:var(--a);text-decoration:none;font-family:'JetBrains Mono',monospace;margin-left:auto}
  .dh-link:hover{text-decoration:underline}

  .tabs{display:flex;border-bottom:1px solid var(--b);padding:0 16px}
  .tab{padding:9px 14px;background:none;border:none;color:var(--m);font-size:12px;font-weight:500;cursor:pointer;position:relative;transition:color .15s;display:flex;align-items:center;gap:5px;text-transform:none;letter-spacing:0}
  .tab:hover{color:var(--t)}
  .tab.on{color:var(--a)}
  .tab.on::after{content:'';position:absolute;bottom:-1px;left:0;right:0;height:2px;background:var(--a);border-radius:2px 2px 0 0}
  .tc{font-size:9px;font-family:'JetBrains Mono',monospace;background:var(--s2);padding:1px 5px;border-radius:6px}

  .dbody{flex:1;overflow-y:auto;padding:16px;scrollbar-width:thin;scrollbar-color:var(--b) transparent;font-size:13px;line-height:1.7}
  .dbody pre{background:var(--s2);padding:10px;border-radius:8px;overflow-x:auto;margin:8px 0;font-size:12px}
  .dbody code{background:var(--s2);padding:1px 5px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:11px}

  .dact{padding:10px 16px;border-top:1px solid var(--b);display:flex;gap:8px;align-items:center}

  .empty{text-align:center;padding:30px;color:var(--m)}
  .empty h4{font-size:13px;margin-bottom:4px;color:var(--t)}

  /* Comments */
  .comment{border:1px solid var(--b);border-radius:10px;margin-bottom:10px;overflow:hidden}
  .comment-head{padding:8px 12px;background:var(--s2);font-size:11px;color:var(--m);display:flex;gap:8px;align-items:center;font-family:'JetBrains Mono',monospace}
  .comment-head strong{color:var(--t)}
  .comment-body{padding:10px 12px;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}

  /* Diff */
  .diff-file{border:1px solid var(--b);border-radius:8px;margin-bottom:10px;overflow:hidden;font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.5}
  .diff-fh{padding:7px 10px;background:var(--s2);border-bottom:1px solid var(--b);font-weight:600;font-size:11px;color:var(--a);display:flex;gap:8px;align-items:center}
  .diff-st{font-weight:400;font-size:10px;color:var(--m)}
  .diff-st .da{color:#34d399}.diff-st .dd{color:#f87171}
  .dl{padding:0 10px;min-height:18px;white-space:pre-wrap;word-break:break-all}
  .dl.a{background:rgba(16,185,129,.08);color:#34d399}
  .dl.d{background:rgba(239,68,68,.08);color:#f87171}
  .dl.h{color:#a78bfa;padding:3px 10px;background:rgba(167,139,250,.05)}
  .dl.x{color:var(--m)}

  /* Commits */
  .ci{padding:10px 0;border-bottom:1px solid var(--b);display:flex;gap:10px;align-items:flex-start}
  .ci:last-child{border-bottom:none}
  .cd{width:8px;height:8px;border-radius:50%;background:var(--a);margin-top:5px;flex-shrink:0;box-shadow:0 0 0 2px var(--s),0 0 0 4px var(--a)}
  .cm{font-size:12px;font-weight:500;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cx{font-size:10px;color:var(--m);font-family:'JetBrains Mono',monospace;display:flex;gap:10px}
  .cs{color:var(--a)}

  /* Right panel */
  .right{display:flex;flex-direction:column;gap:16px;min-width:0;overflow:hidden}
  .bot{background:var(--s);border:1px solid var(--b);border-radius:16px;padding:20px;display:flex;flex-direction:column;align-items:center;gap:16px;position:relative;overflow:hidden}
  .bot::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:radial-gradient(circle,rgba(99,102,241,.05) 0%,transparent 50%);animation:pulse 4s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.1)}}

  .robot{position:relative;z-index:1;width:100px;height:120px}
  .rh{width:70px;height:50px;margin:0 auto;background:var(--s2);border:2px solid var(--a);border-radius:10px;position:relative;transition:all .3s}
  .rh.solving{border-color:var(--c);box-shadow:0 0 20px rgba(6,182,212,.3)}
  .rh.done{border-color:var(--g);box-shadow:0 0 20px rgba(16,185,129,.3)}
  .rh.error{border-color:var(--r);box-shadow:0 0 20px rgba(239,68,68,.3)}
  .eye{width:12px;height:12px;background:var(--a);border-radius:50%;position:absolute;top:15px;transition:all .3s}
  .eye.l{left:14px}.eye.r{right:14px}
  .eye.solving{background:var(--c);animation:blink 2s ease-in-out infinite}
  .eye.done{background:var(--g)}.eye.error{background:var(--r)}
  @keyframes blink{0%,90%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}
  .mo{width:20px;height:3px;background:var(--a);border-radius:2px;position:absolute;bottom:12px;left:50%;transform:translateX(-50%);transition:all .3s}
  .mo.solving{background:var(--c);animation:talk .5s ease-in-out infinite}
  .mo.done{background:var(--g);height:7px;border-radius:0 0 10px 10px}
  .mo.error{background:var(--r);transform:translateX(-50%) rotate(180deg);border-radius:0 0 10px 10px;height:5px}
  @keyframes talk{0%,100%{width:20px}50%{width:14px}}
  .ant{width:3px;height:16px;background:var(--a);margin:0 auto;position:relative;border-radius:2px}
  .ant::after{content:'';width:8px;height:8px;background:var(--a);border-radius:50%;position:absolute;top:-5px;left:-2.5px;transition:all .3s}
  .ant.solving::after{background:var(--c);animation:ap 1s ease-in-out infinite}
  @keyframes ap{0%,100%{box-shadow:0 0 5px rgba(6,182,212,.5)}50%{box-shadow:0 0 15px rgba(6,182,212,.8),0 0 30px rgba(6,182,212,.3)}}
  .rb{width:50px;height:34px;margin:3px auto 0;background:var(--s2);border:2px solid var(--b);border-radius:7px;position:relative;display:flex;align-items:center;justify-content:center;gap:3px}
  .bl{width:5px;height:5px;border-radius:50%;background:var(--m);transition:all .3s}
  .bl.solving{animation:bls 1.5s ease-in-out infinite}
  .bl:nth-child(2).solving{animation-delay:.3s}.bl:nth-child(3).solving{animation-delay:.6s}
  @keyframes bls{0%,100%{background:var(--m)}50%{background:var(--c);box-shadow:0 0 8px rgba(6,182,212,.6)}}

  .rain{position:absolute;inset:0;overflow:hidden;opacity:0;transition:opacity .5s;z-index:0}
  .rain.on{opacity:1}
  .drop{position:absolute;font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(99,102,241,.2);animation:fall linear infinite;white-space:nowrap}
  @keyframes fall{0%{transform:translateY(-100%);opacity:0}10%{opacity:1}90%{opacity:1}100%{transform:translateY(350px);opacity:0}}

  .bs{position:relative;z-index:1;text-align:center;max-width:100%;overflow:hidden}
  .bs h3{font-size:14px;font-weight:600;margin-bottom:3px}
  .bs p{font-size:12px;color:var(--m);font-family:'JetBrains Mono',monospace}
  .bs .it{display:inline-block;margin-top:6px;padding:3px 10px;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.3);border-radius:7px;font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--a);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .log{background:var(--s);border:1px solid var(--b);border-radius:14px;flex:1;display:flex;flex-direction:column;min-height:180px;max-height:45vh}
  .log-h{padding:10px 14px;border-bottom:1px solid var(--b);display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--m)}
  .ldot{width:7px;height:7px;border-radius:50%;background:var(--m);transition:all .3s}
  .ldot.on{background:var(--g);animation:lp 2s ease-in-out infinite}
  @keyframes lp{0%,100%{opacity:1}50%{opacity:.4}}
  .log-b{flex:1;overflow-y:auto;padding:10px 14px;font-family:'JetBrains Mono',monospace;font-size:10px;line-height:1.6;scrollbar-width:thin;scrollbar-color:var(--b) transparent}
  .ll2{padding:1px 0;word-break:break-all}
  .ll2.i{color:var(--m)}.ll2.ac{color:var(--c)}.ll2.su{color:var(--g)}.ll2.e{color:var(--r)}

  .spin{display:inline-block;width:12px;height:12px;border:2px solid var(--b);border-top-color:var(--a);border-radius:50%;animation:spin .6s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  /* Triage */
  .triage-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;display:none;align-items:center;justify-content:center}
  .triage-overlay.open{display:flex}
  .triage-box{background:var(--s);border:1px solid var(--b);border-radius:16px;width:min(700px,90vw);max-height:80vh;display:flex;flex-direction:column;overflow:hidden}
  .triage-head{padding:14px 18px;border-bottom:1px solid var(--b);display:flex;align-items:center;justify-content:space-between}
  .triage-head h2{font-size:16px;font-weight:600}
  .triage-progress{font-size:11px;color:var(--m);font-family:'JetBrains Mono',monospace}
  .triage-body{flex:1;overflow-y:auto;padding:18px;scrollbar-width:thin;scrollbar-color:var(--b) transparent}
  .triage-issue-num{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--m);margin-bottom:4px}
  .triage-issue-title{font-size:17px;font-weight:600;margin-bottom:10px;line-height:1.4}
  .triage-issue-labels{display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap}
  .triage-issue-body{font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;padding:12px;background:var(--s2);border-radius:8px}
  .triage-actions{padding:14px 18px;border-top:1px solid var(--b);display:flex;gap:8px;align-items:center;justify-content:space-between}
  .triage-left{display:flex;gap:8px}
  .triage-right{display:flex;gap:8px;align-items:center}
  .btn-skip{background:rgba(239,68,68,.1);color:var(--r);border:1px solid rgba(239,68,68,.3);padding:9px 20px;font-size:12px}
  .btn-skip:hover{background:rgba(239,68,68,.2)}
  .btn-keep{background:rgba(16,185,129,.1);color:var(--g);border:1px solid rgba(16,185,129,.3);padding:9px 20px;font-size:12px}
  .btn-keep:hover{background:rgba(16,185,129,.2)}
  .btn-close{background:none;border:none;color:var(--m);font-size:20px;cursor:pointer;padding:4px 8px}
  .btn-close:hover{color:var(--t)}

  /* Filter toggle */
  .filter-toggle{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font-size:11px;color:var(--m);padding:4px 0}
  .filter-toggle input{accent-color:var(--a);width:14px;height:14px;cursor:pointer}
  .filter-count{font-family:'JetBrains Mono',monospace;font-size:10px;background:var(--s2);padding:1px 6px;border-radius:6px;color:var(--m)}

  .li.skipped{opacity:.35}

  .skip-badge{font-size:9px;padding:2px 6px;border-radius:8px;background:rgba(239,68,68,.1);color:var(--r);white-space:nowrap;flex-shrink:0}
  @media(max-width:900px){.app{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="app">
  <header class="head">
    <div class="logo"><h1>KiloHub</h1><span class="badge" id="badge">Idle</span><button class="bp" onclick="openTriage()" style="margin-left:8px;font-size:10px;padding:5px 12px">Triage</button><button class="bg" onclick="autoTriage()" id="bAutoTriage" style="font-size:10px;padding:5px 12px">Auto-Triage</button></div>
    <div class="stats">
      <div class="st"><div class="sv" id="sT">0</div><div class="sl">Issues</div></div>
      <div class="st"><div class="sv g" id="sS">0</div><div class="sl">Fixed</div></div>
      <div class="st"><div class="sv r" id="sF">0</div><div class="sl">Failed</div></div>
      <div class="st"><div class="sv y" id="sP">0</div><div class="sl">Left</div></div>
    </div>
  </header>

  <div class="left">
    <div class="bar">
      <input type="number" id="iNum" placeholder="Issue #" min="1"/>
      <button class="bp" id="bSolve" onclick="solve1()">Solve</button>
      <input type="number" id="iLim" placeholder="N" value="5" min="1" max="500" style="width:60px"/>
      <button class="bg" id="bAll" onclick="solveAll()">Solve All</button>
      <button class="br" id="bStop" onclick="stop()" style="display:none">Stop</button>
      <label class="filter-toggle"><input type="checkbox" id="fHide" checked onchange="renderList()"/>Hide skipped <span class="filter-count" id="fCount">0</span></label>
    </div>
    <div class="list" id="list"></div>
    <div class="detail" id="detail">
      <div class="dh">
        <div class="dh-top">
          <button class="bk" onclick="closeD()">&larr;</button>
          <span class="dh-num" id="dNum"></span>
          <span class="dh-title" id="dTitle"></span>
        </div>
        <div class="dh-meta" id="dMeta"></div>
      </div>
      <div class="tabs">
        <button class="tab on" data-t="desc" onclick="tab('desc')">Description</button>
        <button class="tab" data-t="comments" onclick="tab('comments')">Comments <span class="tc" id="tcCom">0</span></button>
        <button class="tab" data-t="diff" onclick="tab('diff')">Diff <span class="tc" id="tcDiff">0</span></button>
        <button class="tab" data-t="commits" onclick="tab('commits')">Commits <span class="tc" id="tcCom2">0</span></button>
      </div>
      <div class="dbody" id="dBody"></div>
      <div class="dact">
        <button class="bp" id="dSolve" onclick="solveD()">Solve This Issue</button>
        <a class="dh-link" id="dLink" href="#" target="_blank">GitHub &nearr;</a>
      </div>
    </div>
  </div>

  <div class="right">
    <div class="bot">
      <div class="rain" id="rain"></div>
      <div class="robot">
        <div class="ant" id="pAnt"></div>
        <div class="rh" id="pHead"><div class="eye l" id="pEL"></div><div class="eye r" id="pER"></div><div class="mo" id="pMo"></div></div>
        <div class="rb"><div class="bl" id="pB1"></div><div class="bl" id="pB2"></div><div class="bl" id="pB3"></div></div>
      </div>
      <div class="bs" id="bStatus"><h3>Waiting for orders</h3><p>Click an issue to inspect</p></div>
    </div>
    <div class="log">
      <div class="log-h"><div class="ldot" id="ldot"></div>Live Output</div>
      <div class="log-b" id="logB"><div class="ll2 i">Ready.</div></div>
    </div>
  </div>
</div>

<div class="triage-overlay" id="triageOverlay">
  <div class="triage-box">
    <div class="triage-head">
      <h2>Triage Issues</h2>
      <div style="display:flex;align-items:center;gap:12px">
        <span class="triage-progress" id="triageProg">0 / 0</span>
        <button class="btn-close" onclick="closeTriage()">&times;</button>
      </div>
    </div>
    <div class="triage-body" id="triageBody"></div>
    <div class="triage-actions">
      <div class="triage-left">
        <button class="btn-skip" onclick="triageDecision('skip')">Skip (not fixable)</button>
        <button class="btn-keep" onclick="triageDecision('keep')">Can Fix</button>
      </div>
      <div class="triage-right">
        <button class="bk" onclick="triagePrev()" title="Previous">&larr;</button>
        <button class="bk" onclick="triageNext()" title="Next (no decision)">&rarr;</button>
      </div>
    </div>
  </div>
</div>

<script>
const D = ${dataJson};
const issues = D.issues;
const attempts = D.progress.attempts || [];
const attemptMap = {};
for (const a of attempts) attemptMap[a.issueNumber] = a;

// triage: { "123": "skip" | "keep" }
const triage = D.triage || {};

let curIssue = null;
let curTab = 'desc';
let polling = null;
let triageIdx = 0;
let triageQueue = [];

// ── Render list ────────────────────
function renderList() {
  const el = document.getElementById('list');
  const hideSkipped = document.getElementById('fHide').checked;
  const skippedCount = Object.values(triage).filter(v=>v==='skip').length;
  document.getElementById('fCount').textContent = skippedCount;

  el.innerHTML = issues.map(i => {
    const isSkipped = triage[i.number] === 'skip';
    if (hideSkipped && isSkipped) return '';

    const a = attemptMap[i.number];
    let si = '';
    if (a) {
      const ic = {success:'\\u2713',error:'\\u2717','no-changes':'\\u2014',timeout:'\\u23F1'};
      const cl = a.status==='success'?'ok':a.status==='no-changes'?'nc':'er';
      si = '<div class="si '+cl+'">'+(ic[a.status]||'?')+'</div>';
    }
    const skipBadge = isSkipped ? '<span class="skip-badge">skipped</span>' : '';
    const lb = (i.labels||[]).slice(0,2).map(l=>'<span class="lb">'+esc(l)+'</span>').join('');
    return '<div class="li'+(isSkipped?' skipped':'')+'" data-n="'+i.number+'" onclick="openD('+i.number+')"><span class="ln">#'+i.number+'</span><span class="lt">'+esc(i.title)+'</span><div class="ll">'+lb+'</div>'+skipBadge+si+'</div>';
  }).join('');
  updateStats();
}

function updateStats() {
  const skipped = Object.values(triage).filter(v=>v==='skip').length;
  const actionable = issues.length - skipped;
  const s = Object.values(attemptMap).filter(a=>a.status==='success').length;
  const f = Object.values(attemptMap).filter(a=>['error','timeout','no-changes'].includes(a.status)).length;
  document.getElementById('sT').textContent = actionable;
  document.getElementById('sS').textContent = s;
  document.getElementById('sF').textContent = f;
  document.getElementById('sP').textContent = Math.max(0, actionable - s - f);
}

// ── Detail view ────────────────────
function openD(num) {
  curIssue = issues.find(i=>i.number===num);
  if (!curIssue) return;
  document.getElementById('iNum').value = num;
  document.getElementById('list').classList.add('hide');
  document.getElementById('detail').classList.add('open');

  document.getElementById('dNum').textContent = '#'+curIssue.number;
  document.getElementById('dTitle').textContent = curIssue.title;
  document.getElementById('dLink').href = curIssue.url;

  const a = attemptMap[curIssue.number];
  let meta = (curIssue.labels||[]).map(l=>'<span class="lb">'+esc(l)+'</span>').join('');
  if (curIssue.author) meta += '<span class="dh-author">@'+esc(curIssue.author)+'</span>';
  if (curIssue.createdAt) meta += '<span class="dh-author">'+curIssue.createdAt.slice(0,10)+'</span>';
  if (a) {
    const cl = a.status==='success'?'ok':a.status==='no-changes'?'nc':'er';
    meta += '<span class="pill '+cl+'">'+a.status+'</span>';
  }
  document.getElementById('dMeta').innerHTML = meta;

  document.getElementById('tcCom').textContent = (curIssue.comments||[]).length;
  tab('desc');
  loadBranch(num);
}

function closeD() {
  curIssue = null;
  document.getElementById('detail').classList.remove('open');
  document.getElementById('list').classList.remove('hide');
}

function tab(t) {
  curTab = t;
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on', b.dataset.t===t));
  const el = document.getElementById('dBody');
  if (!curIssue) return;

  if (t==='desc') {
    el.innerHTML = '<div style="white-space:pre-wrap;word-break:break-word">'+fmt(curIssue.body||'No description.')+'</div>';
  } else if (t==='comments') {
    const coms = curIssue.comments||[];
    if (!coms.length) { el.innerHTML = '<div class="empty"><h4>No comments</h4></div>'; return; }
    el.innerHTML = coms.map(c =>
      '<div class="comment"><div class="comment-head"><strong>@'+esc(c.author)+'</strong><span>'+((c.createdAt||'').slice(0,10))+'</span></div><div class="comment-body">'+fmt(c.body)+'</div></div>'
    ).join('');
  } else if (t==='diff') {
    renderDiff(el, curIssue.number);
  } else if (t==='commits') {
    renderCommits(el, curIssue.number);
  }
}

async function renderDiff(el, num) {
  el.innerHTML = '<div class="empty"><div class="spin"></div></div>';
  try {
    const r = await fetch('/api/branch/'+num+'/diff');
    const d = await r.json();
    if (!d.diff) { el.innerHTML = '<div class="empty"><h4>No diff</h4><p>Branch not created yet</p></div>'; return; }
    el.innerHTML = parseDiff(d.diff);
  } catch { el.innerHTML = '<div class="empty"><h4>Error loading diff</h4></div>'; }
}

async function renderCommits(el, num) {
  el.innerHTML = '<div class="empty"><div class="spin"></div></div>';
  try {
    const r = await fetch('/api/branch/'+num+'/commits');
    const d = await r.json();
    if (!d.commits.length) { el.innerHTML = '<div class="empty"><h4>No commits</h4><p>Branch not created yet</p></div>'; return; }
    el.innerHTML = d.commits.map(c =>
      '<div class="ci"><div class="cd"></div><div style="flex:1;min-width:0"><div class="cm">'+esc(c.message)+'</div><div class="cx"><span class="cs">'+c.sha.slice(0,7)+'</span><span>'+esc(c.author)+'</span><span>'+c.date+'</span></div></div></div>'
    ).join('');
  } catch { el.innerHTML = '<div class="empty"><h4>Error loading commits</h4></div>'; }
}

async function loadBranch(num) {
  try {
    const [dr,cr] = await Promise.all([
      fetch('/api/branch/'+num+'/diff').then(r=>r.json()),
      fetch('/api/branch/'+num+'/commits').then(r=>r.json()),
    ]);
    const fc = (dr.diff||'').split('diff --git').length - 1;
    document.getElementById('tcDiff').textContent = fc;
    document.getElementById('tcCom2').textContent = (cr.commits||[]).length;
  } catch {
    document.getElementById('tcDiff').textContent = '0';
    document.getElementById('tcCom2').textContent = '0';
  }
}

function parseDiff(raw) {
  return raw.split(/^diff --git /m).filter(Boolean).map(file => {
    const lines = file.split('\\n');
    const m = (lines[0]||'').match(/a\\/(.+?) b\\//);
    const name = m ? m[1] : lines[0];
    let adds=0, dels=0;
    const dl = [];
    for (let i=1;i<lines.length;i++) {
      const l = lines[i];
      if (l.startsWith('+++')||l.startsWith('---')||l.startsWith('index ')||l.startsWith('new file')||l.startsWith('deleted file')) continue;
      if (l.startsWith('@@')) { dl.push('<div class="dl h">'+esc(l)+'</div>'); }
      else if (l.startsWith('+')) { adds++; dl.push('<div class="dl a">'+esc(l)+'</div>'); }
      else if (l.startsWith('-')) { dels++; dl.push('<div class="dl d">'+esc(l)+'</div>'); }
      else { dl.push('<div class="dl x">'+esc(l)+'</div>'); }
    }
    return '<div class="diff-file"><div class="diff-fh">'+esc(name)+' <span class="diff-st"><span class="da">+'+adds+'</span> <span class="dd">-'+dels+'</span></span></div>'+dl.join('')+'</div>';
  }).join('');
}

// ── Solve actions ──────────────────
async function solve1() {
  const n = document.getElementById('iNum').value;
  if (!n) return;
  setSolving(true);
  await fetch('/api/solve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({num:parseInt(n)})});
  startPoll();
}

async function solveAll() {
  const lim = document.getElementById('iLim').value||5;
  setSolving(true);
  await fetch('/api/solve-all',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:parseInt(lim)})});
  startPoll();
}

function solveD() {
  if (!curIssue) return;
  document.getElementById('iNum').value = curIssue.number;
  solve1();
}

async function stop() {
  await fetch('/api/stop',{method:'POST'});
}

function setSolving(v) {
  document.getElementById('bSolve').disabled = v;
  document.getElementById('bAll').disabled = v;
  document.getElementById('dSolve').disabled = v;
  document.getElementById('bStop').style.display = v ? 'inline-block' : 'none';
}

// ── Poll for logs ──────────────────
let lastLogLen = 0;

function startPoll() {
  lastLogLen = 0;
  if (polling) clearInterval(polling);
  polling = setInterval(pollStatus, 800);
}

async function pollStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();

    // Update bot visuals
    setBotState(d.state, d.issueNum);

    // Append new log lines
    const newLines = d.log.slice(lastLogLen);
    lastLogLen = d.log.length;
    for (const l of newLines) addLog(l);

    // Update progress
    if (d.progress) {
      for (const a of (d.progress.attempts||[])) attemptMap[a.issueNumber] = a;
      renderList();
    }

    if (d.state !== 'solving') {
      clearInterval(polling);
      polling = null;
      setSolving(false);
      // Refresh branch info if in detail view
      if (curIssue) loadBranch(curIssue.number);
    }
  } catch {}
}

function setBotState(state, issueNum) {
  const parts = ['pHead','pEL','pER','pMo','pAnt','pB1','pB2','pB3'];
  for (const id of parts) {
    const el = document.getElementById(id);
    el.classList.remove('idle','solving','done','error');
    el.classList.add(state);
  }
  document.getElementById('rain').classList.toggle('on', state==='solving');
  document.getElementById('ldot').classList.toggle('on', state==='solving');

  const badge = document.getElementById('badge');
  badge.textContent = state[0].toUpperCase()+state.slice(1);
  badge.style.background = state==='solving'?'rgba(6,182,212,.15)':state==='done'?'rgba(16,185,129,.15)':state==='error'?'rgba(239,68,68,.15)':'rgba(99,102,241,.15)';
  badge.style.color = state==='solving'?'var(--c)':state==='done'?'var(--g)':state==='error'?'var(--r)':'var(--a)';

  const bs = document.getElementById('bStatus');
  if (state==='solving') {
    const iss = issueNum ? issues.find(i=>i.number===issueNum) : null;
    bs.innerHTML = '<h3>Working...</h3><p>Analyzing & patching</p>'+(iss?'<div class="it">#'+iss.number+' '+esc(iss.title).slice(0,35)+'</div>':'');
  } else if (state==='done') {
    bs.innerHTML = '<h3>Done!</h3><p>Branch created</p>';
  } else if (state==='error') {
    bs.innerHTML = '<h3>Error</h3><p>Check logs</p>';
  } else {
    bs.innerHTML = '<h3>Waiting for orders</h3><p>Click an issue to inspect</p>';
  }
}

// ── Log ────────────────────────────
function addLog(line) {
  const b = document.getElementById('logB');
  const d = document.createElement('div');
  const cl = line.includes('ERROR')||line.includes('error')||line.includes('failed')?'e':line.includes('Committed')||line.includes('complete')?'su':line.includes('Running')||line.includes('Created')||line.includes('Starting')?'ac':'i';
  d.className = 'll2 '+cl;
  d.textContent = line;
  b.appendChild(d);
  while (b.children.length > 200) b.removeChild(b.firstChild);
  b.scrollTop = b.scrollHeight;
}

// ── Helpers ────────────────────────
function esc(s) { const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }

function fmt(text) {
  let h = esc(text);
  h = h.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
  h = h.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  h = h.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  h = h.replace(/^### (.+)$/gm, '<h4 style="margin:10px 0 3px;font-size:13px">$1</h4>');
  h = h.replace(/^## (.+)$/gm, '<h3 style="margin:14px 0 5px;font-size:15px">$1</h3>');
  h = h.replace(/^# (.+)$/gm, '<h2 style="margin:14px 0 6px;font-size:17px">$1</h2>');
  return h;
}

// ── Triage ─────────────────────────
function openTriage() {
  // Build queue of untriaged issues
  triageQueue = issues.filter(i => !triage[i.number]);
  triageIdx = 0;
  if (!triageQueue.length) { alert('All issues have been triaged!'); return; }
  document.getElementById('triageOverlay').classList.add('open');
  renderTriageCard();
}

function closeTriage() {
  document.getElementById('triageOverlay').classList.remove('open');
  renderList();
}

function renderTriageCard() {
  if (triageIdx < 0) triageIdx = 0;
  if (triageIdx >= triageQueue.length) { closeTriage(); return; }
  const i = triageQueue[triageIdx];
  document.getElementById('triageProg').textContent = (triageIdx+1)+' / '+triageQueue.length+' ('+Object.keys(triage).length+' triaged)';
  const lb = (i.labels||[]).map(l=>'<span class="lb">'+esc(l)+'</span>').join('');
  document.getElementById('triageBody').innerHTML =
    '<div class="triage-issue-num">#'+i.number+'</div>' +
    '<div class="triage-issue-title">'+esc(i.title)+'</div>' +
    '<div class="triage-issue-labels">'+lb+'</div>' +
    (i.author ? '<div style="font-size:11px;color:var(--m);margin-bottom:10px;font-family:JetBrains Mono,monospace">@'+esc(i.author)+' &middot; '+((i.createdAt||'').slice(0,10))+'</div>' : '') +
    '<div class="triage-issue-body">'+fmt(i.body||'No description.')+'</div>';
}

async function triageDecision(decision) {
  if (triageIdx >= triageQueue.length) return;
  const i = triageQueue[triageIdx];
  triage[i.number] = decision;
  await fetch('/api/triage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({number:i.number,decision})});
  triageIdx++;
  renderTriageCard();
}

function triageNext() {
  triageIdx++;
  if (triageIdx >= triageQueue.length) { closeTriage(); return; }
  renderTriageCard();
}

function triagePrev() {
  if (triageIdx > 0) { triageIdx--; renderTriageCard(); }
}

// ── Auto-triage ────────────────────
async function autoTriage() {
  if (!confirm('Run AI auto-triage on '+issues.filter(i=>!triage[i.number]).length+' untriaged issues? This uses free models via kilo.')) return;
  setSolving(true);
  document.getElementById('bAutoTriage').disabled = true;
  addLog('[auto-triage] Starting AI classification...');
  await fetch('/api/auto-triage',{method:'POST'});
  startPoll();
  // Poll also reloads triage data when done
  const origPoll = pollStatus;
  const triagePollId = setInterval(async ()=>{
    try {
      const r = await fetch('/api/status');
      const d = await r.json();
      if (d.state !== 'solving') {
        clearInterval(triagePollId);
        document.getElementById('bAutoTriage').disabled = false;
        // Reload page to get fresh triage data embedded
        setTimeout(()=>location.reload(), 1500);
      }
    } catch {}
  }, 2000);
}

// ── Init ───────────────────────────
(function(){
  // Code rain
  const rc = document.getElementById('rain');
  const snip = ['const','let','async','await','return','if','for','import','export','=>','{','}','fix','patch','git'];
  for (let i=0;i<20;i++) {
    const d = document.createElement('div');
    d.className='drop';d.textContent=snip[Math.floor(Math.random()*snip.length)];
    d.style.left=(Math.random()*100)+'%';d.style.animationDuration=(3+Math.random()*5)+'s';d.style.animationDelay=(Math.random()*5)+'s';
    rc.appendChild(d);
  }
  renderList();
})();
</script>
</body>
</html>`;
};

// ── Server ─────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(buildHtml(), { headers: { "Content-Type": "text/html" } });
    }

    // Poll endpoint — returns current state + new log lines
    if (url.pathname === "/api/status") {
      return Response.json({
        state: solveState,
        issueNum: solveIssueNum,
        log: solveLog,
        progress: readJson(PROGRESS_FILE, { attempts: [] }),
      });
    }

    // Branch diff
    const dm = url.pathname.match(/^\/api\/branch\/(\d+)\/diff$/);
    if (dm) {
      const branch = `kilohub/fix-issue-${dm[1]}`;
      if (!git("git branch --list").includes(branch)) return Response.json({ diff: "" });
      return Response.json({ diff: git(`git diff main...${branch}`) });
    }

    // Branch commits
    const cm = url.pathname.match(/^\/api\/branch\/(\d+)\/commits$/);
    if (cm) {
      const branch = `kilohub/fix-issue-${cm[1]}`;
      if (!git("git branch --list").includes(branch)) return Response.json({ commits: [] });
      const log = git(`git log main..${branch} --format="%H|||%an|||%ai|||%s"`);
      if (!log) return Response.json({ commits: [] });
      const commits = log.split("\n").filter(Boolean).map(l => {
        const [sha, author, date, ...msg] = l.split("|||");
        return { sha, author, date: date?.split(" ")[0] || "", message: msg.join("|||") };
      });
      return Response.json({ commits });
    }

    // Auto-triage (trigger the CLI command)
    if (url.pathname === "/api/auto-triage" && req.method === "POST") {
      if (currentProcess) return Response.json({ ok: false, reason: "busy" });
      solveLog = [];
      solveState = "solving";
      solveIssueNum = null;

      const child = spawn("bun", ["run", "src/kilohub.ts", "auto-triage"], {
        cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
      });
      currentProcess = child;

      const onData = (d: Buffer) => {
        const lines = d.toString().split("\n").filter(Boolean);
        for (const l of lines) { solveLog.push(l); if (solveLog.length > 300) solveLog.shift(); }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      child.on("close", (code) => {
        currentProcess = null;
        solveState = code === 0 ? "done" : "error";
        solveLog.push(`[auto-triage exit code ${code}]`);
      });

      return Response.json({ ok: true });
    }

    // Manual triage
    if (url.pathname === "/api/triage" && req.method === "POST") {
      return req.json().then((b: any) => {
        const t: Record<string, string> = readJson(TRIAGE_FILE, {});
        t[b.number] = b.decision;
        Bun.write(TRIAGE_FILE, JSON.stringify(t, null, 2) + "\n");
        return Response.json({ ok: true });
      });
    }

    // Solve one
    if (url.pathname === "/api/solve" && req.method === "POST") {
      return req.json().then((b: any) => {
        return Response.json({ ok: runSolve(b.num, b.model || DEFAULT_MODEL) });
      });
    }

    // Solve all
    if (url.pathname === "/api/solve-all" && req.method === "POST") {
      return req.json().then((b: any) => {
        return Response.json({ ok: runSolveAll(b.limit || 5, b.model || DEFAULT_MODEL) });
      });
    }

    // Stop
    if (url.pathname === "/api/stop" && req.method === "POST") {
      if (currentProcess) { currentProcess.kill("SIGINT"); return Response.json({ ok: true }); }
      return Response.json({ ok: false });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n  KiloHub Dashboard running at http://localhost:${PORT}\n`);
