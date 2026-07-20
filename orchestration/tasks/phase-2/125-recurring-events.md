# #125 — Recurring calendar events (`create-event` recurrence rules)

**Phase:** 2 (group C1, after #118) · **Owner:** `feature-engineer` → `reviewer` · **Branch:** `feat/125-recurring-events`
**Issue:** [#125](https://github.com/littlebearapps/outlook-assistant/issues/125) — `ROADMAP.md` §v3.8.x Highlights. `gh issue view 125` first; issue body wins.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1.

## Grounded context

- `calendar/create.js` builds the Graph event from `{ subject, start, end, attendees, body }` (`calendar/create.js:14`) — **no recurrence support today** (zero matches for `recurrence` in `calendar/`, verified 2026-07-07).
- Graph API: `POST /me/events` accepts a `recurrence` property = `{ pattern: {type, interval, daysOfWeek?, dayOfMonth?, month?, firstDayOfWeek?, index?}, range: {type, startDate, endDate?, numberOfOccurrences?, recurrenceTimeZone?} }` (patternedRecurrence resource). Verify the exact shape against current Graph docs before coding — do not trust this brief's memory of the schema over Microsoft's docs.
- Tool definition + inputSchema: `create-event` in `calendar/index.js` (annotation block near line 43). Schema changes go through `utils/schema-coerce.js` validation (`additionalProperties: false` is enforced at the MCP boundary — new params must be added to the schema or they'll be rejected).
- `manage-event update` (v3.8.0, `calendar/update.js`) — decide from the issue whether updating recurrence is in scope; default PROPOSED scope is **create only** (matching the ROADMAP line "create-event recurrence rules").
- Tests: `test/calendar/create.test.js` exists.

## PROPOSED design

Add an optional `recurrence` object param to `create-event`'s inputSchema mirroring Graph's shape (typed enums for `pattern.type` / `range.type`), passed through to the event body when present. `recurrenceTimeZone` defaults to the same `DEFAULT_TIMEZONE` logic as start/end (`calendar/create.js:39,43`). Response text notes the recurrence in the confirmation. Reject nonsensical combos only where Graph's error is cryptic; otherwise let Graph validate (thin-proxy principle).

## TDD → acceptance criteria

1. `test/calendar/create.test.js`: new describe — weekly-with-end-date and daily-N-occurrences cases assert the outgoing Graph payload contains the exact `recurrence` object; a no-recurrence case asserts the property is absent. Red → implement → green.

| Check | Command | Expected |
|-------|---------|----------|
| Payload tests | `npx jest test/calendar/create -t "recurrence"` | pass |
| Schema boundary | stdio `tools/call` `create-event` with an unknown recurrence sub-param (`USE_TEST_MODE=true`) | rejected by schema-coerce, not silently dropped |
| Suite / lint | `npm test` · `npm run lint` | all pass · 0 errors |
| Live check (post-merge, golive-operator) | create a weekly test event on the owner's calendar (2 occurrences, subject `oa-125-test`), verify via `list-events`, then delete it via `manage-event` `{"action":"delete", ...}` | event appears with recurrence; calendar restored (delete is the one permitted destructive call; record both calls in STATE.md) |

## Files in scope / must not change

**In scope:** `calendar/create.js`, `calendar/index.js` (create-event schema + description), `test/calendar/create.test.js`, `CHANGELOG.md` `[Unreleased]` → Added, `docs/quickrefs/tools-reference.md` calendar table, `docs/how-to/calendar/**` if a how-to covers event creation.
**Must not change:** `manage-event` actions, annotations beyond the create-event description, `utils/safety.js`.

## PR

`feat(calendar): recurrence rules on create-event` … "Fixes #125", Module(s): Calendar + Documentation. Reviewer gate. FAQ triggers: none (no new tool, no auth/safety change) — confirm against `.claude/rules/faq-maintenance.md`.
