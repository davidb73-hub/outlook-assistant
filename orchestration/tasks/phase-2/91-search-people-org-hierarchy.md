# #91 — Extend `search-people` with org-hierarchy lookup

**Phase:** 2 (group C3, after #127) · **Owner:** `feature-engineer` → `reviewer` · **Branch:** `feat/91-org-hierarchy`
**Issue:** [#91](https://github.com/littlebearapps/outlook-assistant/issues/91) — `ROADMAP.md` §v3.8.x "Search & people". `gh issue view 91` first; issue body wins — especially on API choice.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1.

## Grounded context

- `search-people` lives in `contacts/index.js` (annotations near `:808`), backed by Graph `/me/people`. No manager/reports code exists in the repo (verified: zero matches for `manager` in `contacts/`).
- Graph org hierarchy: `GET /users/{id-or-upn}/manager` and `/users/{id-or-upn}/directReports`. **Work/school only** (directory data; personal accounts have no org). Scope question: `/manager` & `/directReports` typically require `User.Read.All` — **not in `AUTH_CONFIG.scopes`** (`config.js:81-96`). Verify against current Graph docs; if a new scope is required, this task inherits the re-auth mechanics: add to `config.js` scopes, owner re-consents, delete token file, re-auth (`docs/troubleshooting.md` "New scopes not picked up").
- Account-gating pattern + friendly error precedent: `advanced/` org-only tools (see #126 brief's notes).
- Tests: `test/contacts/`.

## PROPOSED design

Add an `orgHierarchy` mode to `search-people` (e.g. params `person` + `direction: manager|reports|chain`) rather than a new tool — keeps tool count stable; issue body may instead want a separate tool (then follow #126's new-tool checklist including count updates). Personal account → friendly "work/school only" error. If `User.Read.All` is confirmed required and the owner declines admin consent, implement behind the existing scopes' capability (manager lookup sometimes works with `People.Read` for self) **only** if Graph docs support it — otherwise stop and record the scope decision in STATE.md for the owner.

## TDD → acceptance criteria

1. `test/contacts/`: payload/endpoint tests for manager + directReports, rendering, personal-account error path, mock data. Red → implement → green.

| Check | Command | Expected |
|-------|---------|----------|
| Unit tests | `npx jest test/contacts -t "hierarchy"` | pass |
| Suite / lint | `npm test` · `npm run lint` | all pass · 0 errors |
| Scope audit | `git diff main -- config.js` | empty **or** exactly the new documented scope + matching README/FAQ updates |
| Live check (post-merge, golive-operator) | work/school account: look up own manager; personal: expect friendly error, log "deferred — personal account" | per account type in STATE.md |

## Files in scope / must not change

**In scope:** `contacts/index.js` (search-people schema/handler/description), `test/contacts/`, `CHANGELOG.md` → Added, `docs/quickrefs/tools-reference.md`, and **only if scope changes:** `config.js` scopes + `README.md` permission list + FAQ permissions answer (trigger: "auth flow change — scopes").
**Must not change:** `manage-contact` (just shipped #127), annotations downgrades, `utils/safety.js`.

## PR

`feat(contacts): org-hierarchy lookup in search-people` … "Fixes #91", Module(s): Contacts + Documentation (+ Auth if scopes changed). Reviewer gate; if scopes changed, reviewer confirms the re-auth path was documented and STATE.md records the owner's re-consent.
