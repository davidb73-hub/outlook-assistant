# #90 — MCP prompts for common email workflows

**Phase:** 2 (group C4, independent) · **Owner:** `feature-engineer` → `reviewer` · **Branch:** `feat/90-mcp-prompts`
**Issue:** [#90](https://github.com/littlebearapps/outlook-assistant/issues/90) — `ROADMAP.md` §v3.8.x "Workflow". `gh issue view 90` first; issue body wins (especially the prompt list).
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1.

## Grounded context

- `index.js:114` already stubs the surface: `if (method === 'prompts/list') return { prompts: [] };` — inside `server.fallbackRequestHandler`. There is no `prompts/get` handler and the `initialize` capabilities object declares only `tools` (`index.js:63-68, 83-88`).
- MCP prompts spec: server declares `capabilities.prompts`, serves `prompts/list` (name, description, arguments) and `prompts/get` (returns messages). Verify against the pinned SDK version (`@modelcontextprotocol/sdk` `^1.29.0`, `package.json:77`) — this server hand-rolls the protocol via `fallbackRequestHandler` rather than SDK helpers, so follow the existing hand-rolled style (`index.js:73-120`).
- Workflow source material for prompt content: `docs/how-to/**` (email, calendar, organise, ai-agents subdirs) — e.g. the delta-sync inbox-monitoring workflow referenced in `docs/quickrefs/tools-reference.md`.
- Tests: `test/dispatcher/` for protocol-level tests.

## PROPOSED design

A new `prompts/` module (or `utils/prompts.js` — issue decides; default: top-level `prompts.js` kept simple) exporting a PROMPTS array; `index.js` wires `prompts/list`, `prompts/get`, and adds `prompts: {}` to both capabilities objects. Initial prompt set (adjust to issue): `triage-inbox`, `draft-reply` (arg: messageId), `schedule-follow-up` (arg: messageId), `weekly-calendar-review`. Each prompt's messages reference only tools/params that exist (cite `docs/quickrefs/tools-reference.md` names exactly) and must embed the safety posture: any prompt that leads to sending instructs `dryRun` first (EXECUTOR-GUIDE §1.2 baked into content).

## TDD → acceptance criteria

1. `test/dispatcher/prompts.test.js` (new): `prompts/list` returns the set with names/descriptions/arguments; `prompts/get` with args interpolates; unknown prompt name → proper JSON-RPC error; `initialize` response includes `prompts` capability. Red → implement → green.

| Check | Command | Expected |
|-------|---------|----------|
| Protocol tests | `npx jest test/dispatcher -t "prompts"` | pass |
| Live protocol | EXECUTOR-GUIDE §3 stdio recipe with a `prompts/list` request appended (`USE_TEST_MODE=true`) | non-empty prompts array |
| Tools untouched | same recipe, `tools/list` | tool count unchanged |
| Suite / lint | `npm test` · `npm run lint` | all pass · 0 errors |
| No-send guarantee | `rg -n "send" <prompts source file>` | every send-adjacent prompt text contains `dryRun` |

## Files in scope / must not change

**In scope:** `index.js` (capabilities + two method branches), new prompts source file, `test/dispatcher/prompts.test.js`, `CHANGELOG.md` → Added, `docs/quickrefs/tools-reference.md` (new Prompts section), `README.md` feature list.
**Must not change:** `TOOLS` array, any tool schema/annotation, `utils/safety.js`.

## PR

`feat(mcp): prompts for common email workflows` … "Fixes #90", Module(s): Utils/Config + Documentation. Reviewer gate. FAQ trigger: "What you can do" answer — new capability worth one targeted Edit (docs-maintainer decides against `.claude/rules/faq-maintenance.md`).
