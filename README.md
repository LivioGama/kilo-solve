# KiloHub

Automated issue solver + web dashboard for the [Kilo League 5](https://kilo.ai) competition. KiloHub fetches open issues from the [Kilo Code](https://github.com/Kilo-Org/kilocode) repository, triages them with AI, and orchestrates the [Kilo CLI](https://github.com/Kilo-Org/kilocode) to attempt automated fixes.

## Demo

https://github.com/user-attachments/assets/916a65a5-42ba-4796-b0ba-c1fb2ca2fcfe

## Features

- **Web Dashboard** — Browse all 500+ open issues with search, labels, and status indicators
- **AI Triage** — Automatically classify issues as fixable-by-code or not
- **Kilo CLI Solving** — Delegates code fixes to `kilo run --auto`, leveraging the full Kilo agent with file editing, tool use, and code understanding
- **Branch Per Issue** — Each fix attempt creates a `kilohub/fix-issue-{N}` branch with a clean commit
- **Live Logs** — Real-time Kilo CLI output streaming while solving
- **Diff & Commit Viewer** — Inspect generated patches and commits directly in the dashboard
- **Batch Solving** — Solve multiple issues sequentially with configurable limits

## Quick Start

```bash
# Clone
git clone https://github.com/LivioGama/kilo-solve.git
cd kilo-solve

# Prerequisites: install Kilo CLI
bun install -g @kilocode/cli
kilo auth login

# Initialize (clones kilocode repo, installs deps)
bun run src/kilohub.ts init

# Fetch open issues
bun run src/kilohub.ts fetch-issues

# Launch dashboard
bun run src/dashboard.ts
# Open http://localhost:3333
```

## CLI Commands

```bash
bun run src/kilohub.ts init                          # Clone repo & setup
bun run src/kilohub.ts fetch-issues                  # Fetch issues via gh CLI
bun run src/kilohub.ts solve <number> [-m model]     # Fix a single issue with Kilo CLI
bun run src/kilohub.ts solve-all [--limit N]         # Batch solve issues
bun run src/kilohub.ts auto-triage                   # AI-classify all issues
bun run src/kilohub.ts status                        # Show progress summary
```

## Architecture

```
kilo-solve/
  src/
    dashboard.ts    # Bun HTTP server serving single-page dashboard
    kilohub.ts      # CLI orchestrator: init, fetch, solve (via kilo run), triage
  .kilohub/
    issues.json     # Cached GitHub issues (with comments)
    progress.json   # Solve attempt results
    triage.json     # AI triage decisions (keep/skip)
  Dockerfile        # oven/bun container
  docker-compose.yml
```

## How Solving Works

1. Resets `repo/` to clean `main`
2. Creates branch `kilohub/fix-issue-{N}`
3. Builds a prompt from the issue title + body
4. Runs `kilo run --auto --dir repo/ -m <model>` with the prompt
5. Kilo CLI autonomously reads files, edits code, and applies fixes
6. Commits changes, records result in `progress.json`

## Requirements

- [Bun](https://bun.sh) runtime
- [Kilo CLI](https://github.com/Kilo-Org/kilocode) (`bun install -g @kilocode/cli`)
- [GitHub CLI](https://cli.github.com) (`gh`) for fetching issues

## License

MIT
