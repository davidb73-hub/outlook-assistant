# #118 — `list-events` returns times with no timezone information

**Phase:** 2 (group C1, first) · **Owner:** `feature-engineer` → `reviewer` · **Branch:** `fix/118-list-events-timezone`
**Issue:** [#118](https://github.com/littlebearapps/outlook-assistant/issues/118) — `ROADMAP.md` §v3.8.x "Calendar & meetings". `gh issue view 118` first; issue body wins over PROPOSED design.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1. Baseline gate = the test count recorded in `orchestration/STATE.md` at Phase 1 exit.

## Grounded context

- `calendar/list.js:55-70`: rendered output shows `Start:`/`End:` via `toLocaleString('en-AU', { timeZone: tz, ... })` — the *values* are converted to `tz`, but **no line names the timezone**, and the `endsWith('Z') ? ... : \`${...}Z\`` heuristic assumes non-suffixed Graph times are UTC.
- Graph is asked for `start`/`end` via `CALENDAR_SELECT_FIELDS` (`config.js:110-111`); Graph returns `{dateTime, timeZone}` objects. `DEFAULT_TIMEZONE` from `config.js:146-147` (env-overridable, `OUTLOOK_DEFAULT_TIMEZONE`).
- Contrast: `create-event`'s response already prints `(${response.start.timeZone})` (`calendar/create.js:66,71`) — `list-events` should match.
- Tests: `test/calendar/calendar.test.js` covers list formatting.

## PROPOSED design

Append the display timezone to the rendered times (e.g. `Start: 15 Mar 2026, 10:00 am (Australia/Melbourne)`), sourced from the same `tz` used for conversion. Verify (and cover with a test) that the `Z`-appending heuristic matches what Graph actually returns given the request's `Prefer: outlook.timezone` behaviour — if the handler doesn't send that header, Graph returns UTC and the heuristic is correct; state it in a code comment only if the issue asks for deeper changes.

## TDD → acceptance criteria

1. Extend `test/calendar/calendar.test.js` (mock data path): assert each rendered event line includes the timezone name. Red → implement → green.

| Check | Command | Expected |
|-------|---------|----------|
| New assertions | `npx jest test/calendar -t "timezone"` | pass |
| Suite / lint | `npm test` · `npm run lint` | all pass · 0 errors |
| Live check (post-merge, golive-operator) | `list-events` `{}` against live mailbox | Every event shows a named timezone on Start/End |

## Files in scope / must not change

**In scope:** `calendar/list.js`, `test/calendar/calendar.test.js`, `CHANGELOG.md` `[Unreleased]` → Fixed, `docs/quickrefs/tools-reference.md` calendar row if it describes output shape.
**Must not change:** `calendar/create.js`/`update.js` (separate issues), annotations, `config.js`.

## PR

`fix(calendar): include timezone in list-events output` … "Fixes #118", Module(s): Calendar. Reviewer gate.
