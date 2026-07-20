# #93 — Tool-description audit (verify-and-close)

**Phase:** 1 · **Owner:** `feature-engineer` → `reviewer` · **Branch:** `docs/93-tool-descriptions` (only if gaps found)
**Issue:** [#93](https://github.com/littlebearapps/outlook-assistant/issues/93) ("docs: audit and improve all tool descriptions" — `ROADMAP.md` §v3.7.5). `gh issue view 93` first.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1. **Sequencing: after #92 merges** (same files).

## Objective — read this carefully, the work may already be done

**v3.8.1 already rewrote all 22 tool descriptions** to a `purpose → when-to-use → returns → side-effects/pagination/errors` template, driven by the glama.ai audit (`CHANGELOG.md` §3.8.1 Changed: "Tool descriptions — all 22 tools"). ROADMAP still lists #93 as open. This task is therefore an **audit against the issue's own checklist**, expected to end in one of:

- **(a) Close-as-shipped:** the issue's asks are covered by the 3.8.1 rewrite → comment on #93 with the evidence mapping (issue ask → 3.8.1 description text) and close it. No code branch needed.
- **(b) Gap-fix:** the issue body contains specific asks the 3.8.1 template missed (or #92's new annotations made a description stale) → fix exactly those gaps on the branch, then close.

Do not re-rewrite descriptions that already meet the bar — v3.8.1's text is the accepted baseline, and churning it regresses the glama scoring work.

## Grounded context

- Descriptions live on the tool definitions in module `index.js` files / `auth/tools.js` (same locations as #92's annotations; see that brief's file list).
- The single-source-of-truth prose is `docs/quickrefs/tools-reference.md` — 3.8.1 lifted description text from it. Any description change must keep the two consistent.
- Example of current quality bar: the `send-email` description (`email/index.js:240`) covers purpose, safety controls, env vars, and the draft-workflow alternative.

## Steps

1. Pull the issue checklist (`gh issue view 93`). Build a 22-row audit table: tool → issue ask(s) → covered-by-3.8.1? (quote the description fragment) → gap?
2. If all covered → outcome (a): post the table as an issue comment, close #93, log in STATE.md. **Done — skip to acceptance row 4.**
3. Else → outcome (b): TDD is not applicable to prose, but the description/reference consistency is testable — for each gap, update the description **and** the matching `docs/quickrefs/tools-reference.md` row in the same commit. Metadata only: no schema, handler, or annotation changes.

## Acceptance criteria (runnable)

| # | Check | Command | Expected |
|---|-------|---------|----------|
| 1 | Audit table exists | `gh issue view 93 --comments` | 22-row table posted |
| 2 | (b only) Only descriptions changed | `git diff main -G"openWorldHint|readOnlyHint|destructiveHint|idempotentHint|inputSchema" --name-only -- '*.js'` | empty |
| 3 | (b only) Suite / lint | `npm test` · `npm run lint` | all pass (descriptions are asserted nowhere behaviourally, but the tools/list surface must still serve 22 tools — run the EXECUTOR-GUIDE §3 recipe) · 0 errors |
| 4 | Issue closed | `gh issue view 93 --json state -q .state` | `CLOSED` |

## Files in scope / must not change

- **In scope (b only):** module `index.js` description strings, `auth/tools.js`, `docs/quickrefs/tools-reference.md`, `CHANGELOG.md` `[Unreleased]` → Changed.
- **Must not change:** annotations (just merged in #92), inputSchemas, handlers, `utils/safety.js`, FAQ (no trigger fires for description prose).

## PR

Only for outcome (b): `docs(tools): close remaining description gaps from #93 audit` … "Fixes #93". Reviewer gate; reviewer additionally spot-checks 3 changed descriptions against `docs/quickrefs/tools-reference.md` for consistency.
