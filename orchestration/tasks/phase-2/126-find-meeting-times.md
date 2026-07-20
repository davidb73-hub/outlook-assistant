# #126 — `findMeetingTimes` scheduling assistant

**Phase:** 2 (group C1, after #125) · **Owner:** `feature-engineer` → `reviewer` · **Branch:** `feat/126-find-meeting-times`
**Issue:** [#126](https://github.com/littlebearapps/outlook-assistant/issues/126) — `ROADMAP.md` §v3.8.x "Calendar & meetings". `gh issue view 126` first; issue body wins — especially on whether this is a **new tool** or an action on an existing one.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1.

## Grounded context

- **No `findMeetingTimes` code exists anywhere in the repo** (verified 2026-07-07).
- Graph API: `POST /me/findMeetingTimes` — **work/school accounts only** (it requires organizer/attendee free-busy, which personal Microsoft accounts don't expose). The repo already has this account-gating pattern: `advanced/` module's `access-shared-mailbox` and `find-meeting-rooms` are the org-dependent tools, with their optional scopes commented in `config.js:93-95` (`Mail.Read.Shared`, `Place.Read.All`).
- `findMeetingTimes` needs no *new* scope beyond `Calendars.Read`/`Calendars.ReadWrite` (already in `AUTH_CONFIG.scopes`, `config.js:87-88`) — verify against current Graph docs during implementation.
- Precedent for placement: the ROADMAP groups it under calendar; the account-gated siblings live in `advanced/`. PROPOSED: **new read-only tool in `advanced/`** (with `find-meeting-rooms`), named `find-meeting-times`, keeping `calendar/` personal-account-clean. The issue body may override.
- The tool count changes (22 → 23): update the count everywhere it's asserted — `CLAUDE.md` header, `package.json:5` description, `docs/quickrefs/tools-reference.md` heading, and any test pinning tool count (find with `rg -n "22" test/ | grep -i tool`).

## PROPOSED design

Read-only tool: params `attendees` (array of emails), `meetingDuration` (ISO8601 duration string, e.g. `PT30M`), optional `timeConstraint` window, `maxCandidates`. Calls `POST /me/findMeetingTimes`; renders candidate slots with confidence + attendee availability. Annotations: `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false` (post-#92 conventions). On personal accounts Graph returns an error — catch and return the friendly message pattern used by the other org-only tools (read `advanced/` for the existing wording).

## TDD → acceptance criteria

1. New `test/advanced/find-meeting-times.test.js` (mirror existing `test/advanced/` structure): payload construction, response rendering, personal-account error path, mock data in `utils/mock-data.js`. Red → implement per `CLAUDE.md` §"Adding New Tools" (handler → module export → `TOOLS` array → annotations → test) → green.

| Check | Command | Expected |
|-------|---------|----------|
| Unit tests | `npx jest test/advanced -t "meeting-times"` | pass |
| Tool registered | stdio `tools/list` (`USE_TEST_MODE=true`, EXECUTOR-GUIDE §3) | 23 tools incl. `find-meeting-times` with annotations |
| Count refs updated | `rg -n "22 tools" README.md CLAUDE.md docs/ package.json` | zero stale hits |
| Suite / lint | `npm test` · `npm run lint` | all pass · 0 errors |
| Live check (post-merge, golive-operator) | account type from STATE.md: work/school → call with owner as sole attendee, expect candidate slots; personal → call once, expect the documented friendly error, log "deferred — personal account" | per account type |

## Files in scope / must not change

**In scope:** `advanced/` (new handler + index.js), `index.js` `TOOLS` wiring is automatic via module export — verify, `utils/mock-data.js`, `test/advanced/`, `CHANGELOG.md`, `CLAUDE.md` tool count, `package.json` description count, `docs/quickrefs/tools-reference.md` (+ Advanced section), `README.md` count/tool list.
**Must not change:** `config.js` scopes (none needed — if Graph docs disagree, stop and re-plan via the issue), `utils/safety.js`, calendar module.

## PR

`feat(advanced): find-meeting-times scheduling assistant` … "Fixes #126", Module(s): Advanced + Documentation. Reviewer gate. FAQ triggers fire: **new tool** + **account-compatibility** (work/school-only) — docs-maintainer updates the "what you can do" and personal-account answers (targeted Edit, ≥7 H2s).
