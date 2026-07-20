# #72 — Integration test for the token-refresh flow

**Phase:** 1 · **Owner:** `feature-engineer` → `reviewer` · **Branch:** `test/72-token-refresh-integration`
**Issue:** [#72](https://github.com/littlebearapps/outlook-assistant/issues/72) ("Add integration test for token refresh flow", good first issue — `ROADMAP.md` §v3.7.5). `gh issue view 72` first; issue body wins.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1. **Test-only task: zero production-code changes.**

## Objective

An integration-level test proving the full refresh path works end-to-end: a Graph API call that gets `401` → `callGraphAPI`'s retry logic refreshes the token via `TokenStorage.refreshAccessToken()` → the call is retried once with the new token and succeeds — plus persistence of the refreshed token.

## Grounded context

- The retry path exists and is documented in code: `utils/graph-api.js:337-382` — "Calls Graph API with automatic auth and 401 retry. Gets token via ensureAuthenticated(), and if a 401 occurs, refreshes the token and retries once" (line 369 logs `[GRAPH-API] 401 received, attempting token refresh...`; line 371 calls `tokenStorage.refreshAccessToken()`).
- What already exists (don't duplicate): `test/auth/token-refresh.test.js` covers **unit** behaviour of `TokenStorage.refreshAccessToken` `client_secret` handling only (single describe block, `https` mocked). `test/auth/token-storage.test.js` covers storage.
- Isolation helpers available: `OUTLOOK_DEVICE_CODE_STATE_PATH` override exists for device-code state (`HANDOVER.md` commit `aab0ec6`); check `auth/token-storage.js` for how the token path is derived (`config.js:97` `tokenStorePath`) and mock/point it at a temp dir so the test never touches `~/.outlook-assistant-tokens.json` (the existing token tests show the established pattern — follow it).

## PROPOSED design

New `test/auth/token-refresh-integration.test.js`, mocking **only** the `https` boundary (the convention in `test/auth/token-refresh.test.js:1-31`): script a sequence where (1) the Graph request responds 401, (2) the token-endpoint request responds 200 with a new `access_token`/`refresh_token`, (3) the retried Graph request responds 200. Drive it through `callGraphAPI` (`utils/graph-api.js`) with a seeded near-expiry/expired token file in a temp location. Assert: exactly one refresh POST to the token endpoint; retried request carries the **new** bearer token; final result is the 200 body; persisted token file contains the new tokens. Add a negative case: refresh itself fails → the original `UNAUTHORIZED` error path surfaces (`utils/graph-api.js:382` catch).

## Acceptance criteria (runnable)

| Check | Command | Expected |
|-------|---------|----------|
| New tests pass | `npx jest test/auth/token-refresh-integration.test.js` | ≥2 tests (happy path + refresh-failure), all pass |
| Truly integration | The test file requires `utils/graph-api.js` (not just `TokenStorage`) and mocks only `https`/fs-path seams | reviewer verifies by reading the file |
| No prod changes | `git diff main --name-only -- . ':!test' ':!CHANGELOG.md' ':!orchestration'` | empty |
| Home dir untouched | Test uses a temp token path; `~/.outlook-assistant-tokens.json` mtime unchanged after `npm test` | verified |
| Suite / lint | `npm test` · `npm run lint` | all pass (751 + new) · 0 errors |

## Files in scope / must not change

- **In scope:** `test/auth/token-refresh-integration.test.js` (new), `CHANGELOG.md` `[Unreleased]` (test note, if the repo logs test-only changes — 3.8.1 precedent: it does not; skip if no precedent), this brief's STATE.md line.
- **Must not change:** any file outside `test/` — if the test reveals a real defect in the refresh path, **stop**, file it as a new GitHub issue with the failing test attached, and report (EXECUTOR-GUIDE §1.10); do not fix in this branch.

## PR

`test(auth): integration test for 401→refresh→retry flow` … "Fixes #72", Module(s): Auth. Reviewer gate.
