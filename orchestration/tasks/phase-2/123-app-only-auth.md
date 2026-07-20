# #123 — Client-credentials (app-only) authentication

**Phase:** 2 (final code slot — highest blast radius) · **Owner:** `feature-engineer` → `reviewer`; 👤 owner **Azure admin** required · **Branch:** `feat/123-app-only-auth`
**Issue:** [#123](https://github.com/littlebearapps/outlook-assistant/issues/123) ("Client credentials (app-only) authentication — eliminates the 90-day re-auth cliff for headless deployments" — `ROADMAP.md` §v3.8.x Highlights). `gh issue view 123` **before any design work** — this brief's design is PROPOSED at a higher level of uncertainty than any other; the issue body governs.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1. **The delegated flows must remain the default and must not regress.**

## Grounded context

- Current auth is delegated-only: device-code (default) + browser (`config.js:103` `defaultAuthMethod`; endpoints `:100-102`). Token lifecycle in `auth/token-storage.js` (auto-refresh; `auth_method` field persisted — `CLAUDE.md` §Key Files). The 90-day cliff: refresh-token expiry (`CLAUDE.md` §"Token refresh").
- Client-credentials flow: `POST /{tenant}/oauth2/v2.0/token` with `grant_type=client_credentials`, `scope=https://graph.microsoft.com/.default`. Requires **application permissions** (not delegated) + **tenant-admin consent**; **work/school single-tenant practical reality — personal accounts cannot use app-only**. `OUTLOOK_AUTH_AUDIENCE` must be a tenant GUID here (`common`/`consumers` reject client-credentials for Graph app perms).
- **Architectural constraint — the `/me` problem:** app-only tokens have no `/me`. Handler endpoints throughout the modules address `me/...` (e.g. `calendar` via `/me/events`, search via folder paths). App-only requires `/users/{id-or-upn}/...`. The design MUST resolve how a target mailbox is selected (PROPOSED: a single env var naming the mailbox UPN, validated at startup when app-only is active; name it per the issue — do not invent silently; document it in `.env.example` + README). Survey the endpoint surface first: `rg -n "'me/|\"me/|/me/" --glob '*.js' --glob '!test/**' | wc -l` and read `utils/graph-api.js` to see whether a central endpoint-prefix seam exists or must be introduced there (all Graph calls go through it — `CLAUDE.md` §Key Files).
- Safety: app-only bypasses per-user consent — the send/rules guards (`OUTLOOK_ALLOWED_RECIPIENTS`, `OUTLOOK_MAX_EMAILS_PER_SESSION`) become **mandatory-in-docs** for app-only deployments; the brief's docs updates must say so explicitly.
- Secrets: client secret or certificate. Secret stays env-only (EXECUTOR-GUIDE §1.6); never logged.

## PROPOSED design (issue body refines)

1. `auth/` gains a client-credentials token provider (new file, e.g. `auth/app-only.js`) integrated into `token-storage.js`'s get/refresh path keyed off `auth_method: 'client-credentials'`; opt-in via `OUTLOOK_AUTH_METHOD=client-credentials` (extends the existing env contract, `.env.example:27-30`).
2. Central mailbox-target resolution in `utils/graph-api.js` (single seam, minimal handler churn): `me` prefix when delegated; `users/<target>` when app-only.
3. `auth` tool `status`/`about` report the app-only identity and target mailbox.
4. Startup validation: app-only without tenant-GUID audience or without target mailbox → clear config error at boot.

## TDD → acceptance criteria

1. Tests first: `test/auth/app-only.test.js` (token acquisition, no-refresh-token semantics — app tokens are re-fetched not refreshed, error paths incl. AADSTS consent errors) + `test/utils/` endpoint-seam tests (delegated → `me/...` unchanged; app-only → `users/x/...`) + config-validation tests. **Every existing auth test must pass unmodified** — that is the no-regression bar. Red → implement → green.

| Check | Command | Expected |
|-------|---------|----------|
| New tests | `npx jest test/auth -t "app-only"` + seam tests | pass |
| Delegated untouched | `npx jest test/auth` | all pre-existing tests pass **unmodified** (`git diff main -- test/auth` shows only additions) |
| Suite / lint | `npm test` · `npm run lint` | all pass · 0 errors |
| Boot validation | `OUTLOOK_AUTH_METHOD=client-credentials node index.js` without target/audience (test-mode) | clear config error, non-zero exit or explicit warning per design |
| Live check (post-merge) | Only if 👤 owner has a work/school tenant + admin consent: app-only `auth status` → read-only smoke steps 3–6 (EXECUTOR-GUIDE §4) against the target mailbox. Otherwise log "deferred — no admin tenant available" in STATE.md | per availability |

## Files in scope / must not change

**In scope:** `auth/` (new provider + `token-storage.js` + `tools.js` status/about), `config.js` (auth method plumbing only), `utils/graph-api.js` (endpoint seam), `.env.example`, `test/auth/`, `test/utils/`, `CHANGELOG.md` → Added, `README.md` (new auth section incl. mandatory-guards note), `docs/troubleshooting.md` (admin-consent errors), FAQ (see below).
**Must not change:** delegated flow behaviour (device-code remains `defaultAuthMethod`, `config.js:103`), existing scopes list semantics, `utils/safety.js`, any tool schema.

## PR

`feat(auth): client-credentials app-only authentication` … "Fixes #123", Module(s): Auth + Utils/Config + Documentation. Reviewer gate at maximum scrutiny (review step 3 + the no-regression bar above). FAQ triggers fire hard: **auth flow change** → update permissions/tokens/device-vs-browser answers (`.claude/rules/faq-maintenance.md` questions 3, 4, 7) + **account-compatibility** (app-only = work/school). Release after merge (minor bump) per Phase 2 workflow step 10.
