# Changelog

All notable changes to Kavi are documented here.

## [1.5.1] - 2026-04-10

Massive release — missions, brain, patterns, acceptance testing, TUI redesign, and autonomy policies all land here.

### Added
- Mission orchestration and acceptance workflows
- Mission policy controls — configure autonomy level per mission (`--guided`, `--autonomous`, `--overnight`, `--inspect`)
- Autopilot, auto-verify, and auto-land policy toggles
- Mission-first recovery flows with retry budgets and pause-on-repair-failure
- Shadow missions — run parallel variants and compare results (`kavi mission shadow`, `kavi mission compare --family`)
- Mission packets with explainable pattern memory
- Live mission progress tracking and mission-first operator surface
- Brain (knowledge base) — captures facts, decisions, procedures, risks, and artifacts
- Brain graph navigation, curation in TUI, and entry explain command
- Brain portfolio exploration
- Patterns system — reusable workflow patterns from successful missions
- Pattern constellation and graph visualization
- Pattern templates with `template-apply` command
- Pattern-driven acceptance criteria
- Acceptance testing framework with command, manual, file, scenario, contract, docs, HTTP, and browser check types
- Enriched generated acceptance harnesses for API and browser evals
- Acceptance explainability and portfolio comparison
- Scheduler repair loops and task recovery
- Provider semantic checkpoints for degradation detection
- Codex semantic runtime streaming
- Transcript progress and brain graph views
- TUI redesign with truecolor theme, module decomposition, and interaction polish
- Stale-daemon detection and follow-up orchestration safeguards

### Fixed
- Preserve running task artifact timestamps
- Harden vnext release audit blockers
- Harden mission execution audit gaps
- Correct the GitHub URL on the website

## [1.1.2] - 2026-03-31

### Added
- Upgraded TUI compose editing (multi-line, paste flow)

### Changed
- Node.js requirement updated to v25

### Fixed
- Normalize legacy task data in operator views

## [1.1.0] - 2026-03-29

### Added
- Dependency-aware orchestration planning — DAG-based task decomposition
- Improved compose paste flow and task routing
- Polished operator workflow and landing experience

## [1.0.1] - 2026-03-29

### Added
- Approve-all execution mode (`kavi open --approve-all`)

### Fixed
- Remove unsupported codex app-server flag

## [1.0.0] - 2026-03-26

First stable release.

### Added
- CLI with `init`, `open`, `start`, `resume`, `stop`, `status`, `tasks`, `events` commands
- Daemon architecture — background process managing agent lifecycles
- Git worktree isolation per agent (kavi-codex, kavi-claude)
- Claude Code adapter — child process with structured JSON output
- Codex adapter — app-server RPC client with multi-turn support
- Intelligent task routing — layered system with path-claim, keyword, and AI classification
- Path ownership rules in `.kavi/kavi.toml` (`codex_paths`, `claude_paths`)
- Route preview command (`kavi route "prompt"`)
- Approval system with per-session rule memory (`--remember` flag)
- Decision ledger tracking all routing, approval, task, and integration decisions
- Path claims with conflict detection
- Landing system — `kavi land` merges worktrees with overlap detection and validation
- Interactive TUI with tab-based navigation (Activity, Results, Tasks, Approvals)
- Composer panel with multi-line input and route preview
- Real-time snapshot subscription via Unix socket JSON-RPC
- Peer messaging between agents (question, handoff, review_request, blocked, context_share)
- Session persistence (`.kavi/state/session.json`) and append-only event log
- TOML configuration (`.kavi/kavi.toml` and `~/.kavi/config.toml`)
- Custom agent prompts via `.kavi/prompts/`
- `kavi doctor` health checks (node version, CLI auth, worktree setup)
- `kavi update` for self-updates via npm
- Recommendation workflows and lifecycle controls
- Activity-first workflow summaries
- Diff visualization with add/remove coloring

### Fixed
- Use valid UUIDs for initial Claude sessions

## [0.1.0] - 2026-03-23

### Added
- Initial project setup
- Basic CLI command structure
- Package scaffolding
