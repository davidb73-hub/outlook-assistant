# #127 — Contact structured email fields (primary/secondary/tertiary)

**Phase:** 2 (group C3, first) · **Owner:** `feature-engineer` → `reviewer` · **Branch:** `feat/127-contact-email-fields`
**Issue:** [#127](https://github.com/littlebearapps/outlook-assistant/issues/127) — `ROADMAP.md` §v3.8.x "Search & people". `gh issue view 127` first; issue body wins.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1.

## Grounded context

- Contacts module is a single file: `contacts/index.js` (both `manage-contact` and `search-people` tools). `emailAddresses` is already selected/rendered as a flat joined list (`contacts/index.js:16,20,29,59-60`).
- Graph `contact.emailAddresses` is an ordered array (index 0 ≈ "Email", 1 ≈ "Email 2", 2 ≈ "Email 3" in Outlook UI). The issue asks for structured access to those positions — likely: create/update accepting distinct primary/secondary/tertiary values, and reads rendering which is which. Exact semantics from the issue body.
- Note the existing caveat comment at `contacts/index.js:232`: "emailAddresses/any() lambda is unreliable on personal accounts" — filtering by email has known personal-account limits; don't regress the workaround there.
- Tests: `test/contacts/` (locate files with `ls test/contacts/`).

## PROPOSED design

On `manage-contact` create/update: accept `email` (primary, existing behaviour preserved) plus optional `email2`/`email3` (names per issue), mapped to `emailAddresses[0..2]` with Outlook-style display names. Update semantics must be explicit about partial updates (does setting `email2` alone clear `email3`? PROPOSED: no — read-modify-write the array; state the choice in the PR). On read paths, label the slots in output.

## TDD → acceptance criteria

1. `test/contacts/`: cases for create-with-3-emails payload shape, update-preserves-untouched-slots, read rendering labels. Red → implement → green.

| Check | Command | Expected |
|-------|---------|----------|
| Unit tests | `npx jest test/contacts` | pass incl. new cases |
| Schema boundary | stdio `tools/call` `manage-contact` with the new params (`USE_TEST_MODE=true`) | accepted; unknown params still rejected |
| Suite / lint | `npm test` · `npm run lint` | all pass · 0 errors |
| Live check (post-merge, golive-operator) | `manage-contact` create a contact `oa-127-test` with 3 emails → read it back → **delete it** (`manage-contact` delete is destructive — this cleanup call is authorized here) | all three slots round-trip; mailbox restored; both calls logged in STATE.md |

## Files in scope / must not change

**In scope:** `contacts/index.js` (manage-contact schema, handlers, rendering), `test/contacts/`, `CHANGELOG.md` → Added, `docs/quickrefs/tools-reference.md` contacts rows.
**Must not change:** `search-people` (that's #91), the `:232` personal-account filter workaround, annotations (`manage-contact` keeps `destructiveHint: true` from v3.8.1), `utils/safety.js`.

## PR

`feat(contacts): structured primary/secondary/tertiary email fields` … "Fixes #127", Module(s): Contacts + Documentation. Reviewer gate. FAQ triggers: none expected.
