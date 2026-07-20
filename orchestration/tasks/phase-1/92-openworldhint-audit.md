# #92 — `openWorldHint` security-annotation audit

**Phase:** 1 · **Owner:** `feature-engineer` → `reviewer` · **Branch:** `fix/92-openworldhint`
**Issue:** [#92](https://github.com/littlebearapps/outlook-assistant/issues/92) ("fix: set `openWorldHint` on tools reading external content (security annotation gap)" — `ROADMAP.md` §v3.7.5). `gh issue view 92` first; **the issue's tool list is authoritative** for which tools flip.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1. **Sequencing: must merge before #93** (`orchestration/workflows/phase-1-polish.md` group B).

## Objective

Every one of the 22 tools carries a deliberate, correct `openWorldHint` — in particular, tools whose *output* contains untrusted external content (emails, attachments authored by arbitrary senders) are marked `openWorldHint: true` so MCP clients can treat their results as prompt-injection surface.

## Grounded context (current state, verified 2026-07-07)

- All 22 tools already have an explicit `openWorldHint` key. Exactly **two** are `true`: `send-email` (`email/index.js:246`) and `draft` (`email/index.js:305`) — the *outbound* tools. All read-side tools are `false`, including the ones the issue targets.
- Candidate gap (per the issue title "tools reading external content"): `search-emails` (`email/index.js:40`), `read-email` (`email/index.js:186`), plus the other email/index.js entries at lines 384, 463, 524, 641 (`update-email`/`attachments`/`export`/`get-mail-tips` — confirm mapping by reading the file), and possibly calendar/contacts list/search tools (external organizers/senders). The **issue body decides the final list** — do not guess beyond it; if the body is thin, propose the list in the PR description with one-line rationale per tool.
- Annotation objects live on the tool definitions in each module's `index.js` (and `auth/tools.js:396` for `auth`). v3.8.1 already fixed two `destructiveHint` issues from the same audit wave (`CHANGELOG.md` §3.8.1 Fixed) — this issue is the remaining `openWorldHint` slice.
- MCP annotations are metadata only — no behaviour change, no schema change (same framing as the 3.8.1 description work).

## TDD steps

1. Extend the existing annotation coverage in tests: find the current annotation assertions with `rg -ln "openWorldHint|annotations" test/` and follow that pattern. Add/adjust a test that pins the **complete expected annotation set for all 22 tools** (a table-driven test asserting each tool's four hints), so future drift fails loudly. Red first (it should fail against today's values for the tools being flipped).
2. Flip the agreed tools' `openWorldHint` to `true`. Never touch `readOnlyHint`/`destructiveHint`/`idempotentHint` values in this task (EXECUTOR-GUIDE §1.3 — and any change there belongs to a different issue).

## Acceptance criteria (runnable)

| Check | Command | Expected |
|-------|---------|----------|
| Pinning test | `npx jest -t "annotation"` (or the file you extended) | Table-driven assertions over all 22 tools pass |
| Only openWorldHint changed | `git diff main -G"readOnlyHint|destructiveHint|idempotentHint" --name-only -- '*.js'` | empty (no other hint edited) |
| Tool count stable | EXECUTOR-GUIDE §3 stdio `tools/list` with `USE_TEST_MODE=true` | 22 tools, each with an `annotations` object |
| Suite / lint | `npm test` · `npm run lint` | all pass · 0 errors |

## Files in scope / must not change

- **In scope:** `email/index.js`, `calendar/index.js`, `contacts/index.js`, `categories/index.js`, `rules/index.js`, `folder/index.js`, `settings/index.js`, `advanced/index.js`, `auth/tools.js` (annotation objects only), matching `test/` file, `CHANGELOG.md` `[Unreleased]` → Fixed, `docs/quickrefs/tools-reference.md` (safety column notes if it mentions annotations).
- **Must not change:** tool descriptions (that's #93), inputSchemas, handlers, `utils/safety.js`.

## Docs

CHANGELOG + tools-reference safety column. FAQ trigger fires: "**new safety controls** (… MCP annotations) → update the read-only-mode answer" (`.claude/rules/faq-maintenance.md`) — docs-maintainer applies a targeted Edit to that answer noting the injection-surface annotation.

## PR

`fix(annotations): set openWorldHint on tools returning external content` … "Fixes #92", Module(s): all affected + Documentation. Reviewer gate (pay attention to review step 3 — this PR is *supposed* to change annotations; verify no downgrades).
