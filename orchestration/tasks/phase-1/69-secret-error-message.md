# #69 — Improve error message when client secret is wrong

**Phase:** 1 · **Owner:** `feature-engineer` → `reviewer` · **Branch:** `fix/69-secret-error-message`
**Issue:** [#69](https://github.com/littlebearapps/outlook-assistant/issues/69) ("Improve error message when client secret is wrong", good first issue — `ROADMAP.md` §v3.7.5). `gh issue view 69` first; issue body wins.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1.

## Objective

When Microsoft rejects a token exchange because the operator pasted the Secret **ID** instead of the secret **Value** (error `AADSTS7000215`), the surfaced error tells them exactly that and how to fix it — instead of a raw Graph error blob.

## Grounded context

- The documented failure: `AADSTS7000215` → "Used Secret ID instead of secret Value" (`HANDOVER.md` §"Common Auth Failures"; `docs/troubleshooting.md` table row 1; `.env.example:7` already warns "(not the secret ID)").
- **No auth source file currently matches `AADSTS`** (verified: only `config.js` — a different code in a comment — and `llms.txt`). So there is no special-casing today; the raw Microsoft error text passes through from the token endpoints.
- Token-exchange call sites to inspect (all POST to `AUTH_CONFIG.tokenEndpoint`, `config.js:101`): `auth/token-storage.js` (refresh), `auth/device-code.js` (device-code polling), `auth/oauth-server.js` (browser callback exchange). Locate exact error paths with `rg -n "error_description|statusCode" auth/`.
- Existing test conventions for these paths: `test/auth/token-refresh.test.js` (mocks `https` and asserts on error handling), `test/auth/oauth-server.test.js`, `test/auth/device-code.test.js`.

## PROPOSED design

A small shared helper (e.g. in `auth/` — follow the issue if it names a location) that inspects a Microsoft token-endpoint error body: if `error_description` contains `AADSTS7000215`, wrap/augment the thrown error message with: invalid client secret — you likely pasted the Secret **ID**; use the secret **Value** from Azure Portal → Certificates & secrets (mirror the `docs/troubleshooting.md` wording). Apply at each of the three call sites. Preserve the original AADSTS text in the message (needed for the troubleshooting table lookup).

## TDD steps

1. Add tests (extend the three existing `test/auth/*.test.js` files or a new `test/auth/secret-error.test.js`) mocking a 400/401 token response whose body carries `error_description: "AADSTS7000215: ..."`; assert the surfaced message contains both `AADSTS7000215` and the words `secret` + `Value` (the friendly hint). One test per call site. Confirm red.
2. Implement; green.

## Acceptance criteria (runnable)

| Check | Command | Expected |
|-------|---------|----------|
| Hint surfaced | `npx jest test/auth -t "7000215"` (name tests accordingly) | New tests pass, asserting the friendly message at all three call sites |
| No regression | `npm test` | All suites pass (751 baseline + new) |
| Lint | `npm run lint` | 0 errors |
| Original code preserved | The new tests assert `AADSTS7000215` still present in the message | pass |

## Files in scope / must not change

- **In scope:** `auth/token-storage.js`, `auth/device-code.js`, `auth/oauth-server.js`, optional new `auth/` helper, matching `test/auth/` files, `CHANGELOG.md` `[Unreleased]` → Fixed, `docs/troubleshooting.md` row update (note the server now explains this error itself).
- **Must not change:** `config.js` scopes/endpoints, token file formats, `utils/safety.js`, any tool schema or annotation.

## Docs

CHANGELOG + troubleshooting row. FAQ trigger: "auth flow change" is **not** fired by a message-text improvement — no FAQ edit.

## PR

`fix(auth): explain AADSTS7000215 (secret ID vs Value) in error message` … "Fixes #69", Module(s): Auth. Reviewer gate.
