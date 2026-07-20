# Orchestration Package — Executor Entry Point

This directory is a complete, self-consistent execution package for taking Outlook Assistant from code-complete (v3.8.1) to **production-live and roadmap-complete through the v3.8.x milestone**. It was authored for two interchangeable executors — **Codex CLI** or **Claude Code (Opus 4.8)** — running agentically in this repo. Every design decision has already been made; if you find one that hasn't, that's a defect: log it in `STATE.md` and pick the conservative option.

## Start here (cold start, zero context)

1. Read `EXECUTOR-GUIDE.md` — global safety rules (§1), what to trust in this repo (§2), your executor's adapter (§3), the live smoke-test recipe (§4), and how state/checkpoints work (§5). **Nothing else in the package overrides §1.**
2. Read `00-SCOPE-PROPOSAL.md` — the committed 3-phase plan and the reasoning behind it (Decisions & Assumptions).
3. Open `STATE.md` (if it doesn't exist yet, you are at step zero — create it per the Phase 0 workflow, step 0). The last gated entry tells you exactly where the previous session stopped.
4. Execute the current phase's workflow file, step by step, in order. Do not skip gates.

**The literal first command of the whole package** (Phase 0, step 0 precondition):

```bash
npm install && npm test
```

Expected: `Test Suites: 29 passed` / `Tests: 751 passed`. Then follow `workflows/phase-0-golive.md`.

## Phase order & hand-off

| Phase | Workflow | Exit hands off to |
|-------|----------|-------------------|
| 0 — Go-live & hardening (no code changes) | `workflows/phase-0-golive.md` | Phase 1, via STATE.md sign-off entry |
| 1 — v3.7.5 polish slate (#68 #69 #72 #92 #93 + patch release) | `workflows/phase-1-polish.md` | Phase 2, via STATE.md entry recording the new baseline test count |
| 2 — v3.8.x feature slate (#118 #125 #126 #117+#169 #127 #91 #90 #89 #123 + minor releases) | `workflows/phase-2-features.md` | Done — ROADMAP v3.8.x section empty |

Each phase is independently valuable; the owner may stop after any phase. Checkpoints: merged PRs (code phases) / evidenced STATE.md entries (Phase 0). Resume: read STATE.md, continue from the first ungated step.

## Artifact map

```
orchestration/
├── README.md                  ← you are here (entry point)
├── 00-SCOPE-PROPOSAL.md       committed scope, phase rationale, Decisions & Assumptions
├── EXECUTOR-GUIDE.md          global rules §1 · trust map §2 · Codex/Claude adapters §3 ·
│                              smoke recipes §4 · state/checkpoints §5
├── STATE.md                   append-only progress ledger (created at Phase 0 step 0)
├── agents/                    role definitions (frontmatter schema matches .claude/agents/**)
│   ├── golive-operator.md     Phase 0 config/live-verification specialist
│   ├── feature-engineer.md    TDD implementer (Phases 1–2)
│   ├── docs-maintainer.md     docs/CHANGELOG/FAQ sync (FAQ policy enforcer)
│   └── reviewer.md            pre-merge gate: re-runs acceptance criteria
├── workflows/                 one per phase: steps, owners, gates, rollback
│   ├── phase-0-golive.md
│   ├── phase-1-polish.md
│   └── phase-2-features.md
└── tasks/                     self-contained execution briefs
    ├── phase-0/  T0.1-azure-app-config · T0.2-auth-and-readonly-smoke ·
    │             T0.3-send-safety-verification · T0.4-golive-signoff
    ├── phase-1/  68-version-flag · 69-secret-error-message ·
    │             72-token-refresh-integration-test · 92-openworldhint-audit ·
    │             93-tool-descriptions-audit
    └── phase-2/  118-list-events-timezone · 125-recurring-events ·
                  126-find-meeting-times · 117-169-search-improvements ·
                  127-contact-email-fields · 91-search-people-org-hierarchy ·
                  90-mcp-prompts · 89-manage-tasks · 123-app-only-auth
```

## Conventions this package relies on (with anchors)

- **Baseline gate:** 751 tests / 29 suites, lint 0 errors (`HANDOVER.md` §"Verification Evidence"; re-verified 2026-07-07). Phase 1 exit updates the number in STATE.md; later tasks gate on the updated figure.
- **Every brief is self-contained**: objective, grounded context with file:line citations, PROPOSED design (GitHub issue body wins — EXECUTOR-GUIDE §1.9), TDD steps, runnable acceptance criteria, files-in-scope, docs checklist, PR expectations.
- **Location note:** the superprompt that commissioned this package suggested `.claude-flow/workflows/` for workflow files; they live here instead because `.claude-flow/` is gitignored (`.gitignore:35`) — see Scope Proposal D4. Same for agent files vs `.claude/agents/` (that tree is claude-flow scaffolding; these four agents are package-scoped and reviewed with it).
- **Safety is non-negotiable** and embedded per-brief; the canonical statement is EXECUTOR-GUIDE §1. If any instruction anywhere seems to conflict with it, §1 wins and the conflict is a reportable defect.

## For the owner (review shortcuts)

- The whole plan in one read: `00-SCOPE-PROPOSAL.md` (5 minutes).
- Everything the executor is allowed to do live against your mailbox: EXECUTOR-GUIDE §1 + `tasks/phase-0/T0.3` (exactly one real email, to you).
- Your required touchpoints: T0.1 (Azure setup), T0.2 (one browser sign-in), T0.4 (sign-off), release approvals, #89 re-auth, #123 admin consent (optional feature).
