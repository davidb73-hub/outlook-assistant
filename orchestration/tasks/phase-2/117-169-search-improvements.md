# #117 + #169 — `search-emails` improvements (folders UX + personal-account disparity + `kqlQuery` rename)

**Phase:** 2 (group C2) · **Owner:** `feature-engineer` → `reviewer` · **Branch:** `fix/117-169-search-improvements`
**Issues:** [#117](https://github.com/littlebearapps/outlook-assistant/issues/117) ("Improve `search-emails` experience for Sent Items and non-inbox folders") and [#169](https://github.com/littlebearapps/outlook-assistant/issues/169) ("`searchAllFolders=true` zero-results disparity on personal accounts (V37-F-2) + cosmetic noResults render bug + rename `kqlQuery`") — `ROADMAP.md` §v3.8.x "Search & people". Grouped per Scope Proposal D8. `gh issue view 117` and `gh issue view 169` first; issue bodies win.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1. **This is the most regression-prone area in the repo** — v3.7.1/v3.7.3/v3.7.4 all shipped search fixes (`CHANGELOG.md`); read those entries before touching anything.

## Grounded context

- `email/search.js`: default folder is `'inbox'` (`:27`); `searchAllFolders` flag (`:51`, endpoint switch `:63-70` via `resolveFolderPath`, `email/folder-utils.js`); `kqlQuery` documented as "Raw KQL query for advanced users" (`:23`), used directly at step 0 of the search cascade (`:130`).
- #169's rename rationale (from ROADMAP): the param is actually a Graph `$search` expression, not full KQL. **Renames are breaking for callers** — the repo's established mechanism is param-name aliases at the MCP boundary (v3.7.3 shipped "param-name aliases across tools", `CHANGELOG.md`; implementation in `utils/schema-coerce.js`). PROPOSED: introduce the new name (issue body decides it; if unspecified, `searchQuery` is the PROPOSED default), keep `kqlQuery` as a deprecated alias, note deprecation in the description.
- Personal-account fallback behaviour is documented in `docs/quickrefs/tools-reference.md` ("progressive search fallback") and `docs/troubleshooting.md` — the V37-F-2 disparity is that the fallback chain behaves differently when `searchAllFolders=true`. The E2E-sweep finding details are in the issue body (V37-F-2 label from the v3.7.3 sweep) — read them; do not implement from this summary alone.
- Tests: `test/email/search.test.js`, `test/email/list.test.js`, plus `test/utils/` for schema-coerce alias tests (locate exact file with `ls test/utils/`).

## PROPOSED design (issue bodies refine)

1. **#169 noResults render bug:** fix the cosmetic rendering (details in issue).
2. **#169 disparity:** make the personal-account fallback chain fire consistently under `searchAllFolders=true`, mirroring the single-folder chain.
3. **#169 rename:** new param name + boundary alias for `kqlQuery` (no behaviour change for existing callers; both names hit the same code path; unknown-param strictness preserved).
4. **#117 folders UX:** per issue body — likely folder-name resolution/hints for Sent Items (`resolveFolderPath` already exists) and description/docs improvements for non-inbox search.

## TDD → acceptance criteria

1. Failing tests first for each of the four items (alias test asserts both `kqlQuery` and the new name reach the handler identically; disparity test pins the fallback sequence under `searchAllFolders=true` with mocked zero-result `$search`). Red → implement → green.

| Check | Command | Expected |
|-------|---------|----------|
| New tests | `npx jest test/email/search` | pass, incl. alias + fallback-parity cases |
| Alias boundary | stdio `tools/call` `search-emails` with `kqlQuery` (`USE_TEST_MODE=true`) | works, no unknown-param rejection |
| Suite / lint | `npm test` · `npm run lint` | all pass · 0 errors |
| Live checks (post-merge, golive-operator, read-only) | (a) `search-emails` `{"folder":"sentitems"}`; (b) `{"searchAllFolders":true,"query":"<word known to exist>"}`; (c) same with old `kqlQuery` param | (a) sent items listed; (b) results ≥ what single-folder returns for the same query; (c) still works |

## Files in scope / must not change

**In scope:** `email/search.js`, `email/folder-utils.js` (only if #117 requires), `email/index.js` (search-emails schema/description), `utils/schema-coerce.js` alias table, `test/email/`, `test/utils/` alias tests, `CHANGELOG.md`, `docs/quickrefs/tools-reference.md` search section, `docs/troubleshooting.md` search rows.
**Must not change:** the v3.7.4 no-fall-through guarantee ("trusts your KQL syntax and never falls through", `docs/troubleshooting.md`) — regression here reopens #169 V37-F-1; other email tools; annotations.

## PR

`fix(search): folder UX, all-folders parity on personal accounts, rename kqlQuery (alias kept)` … "Fixes #117, fixes #169", Module(s): Email + Documentation. Reviewer gate; reviewer re-runs the three live checks' mock-mode equivalents.
