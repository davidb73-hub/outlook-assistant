# Draft-Reply Push — Design

**Date:** 2026-07-22
**Status:** Approved by David (this session). DESIGN.md decision #4 ratified — see Safety.
**Repos touched:** `command-centre` (primary), `outlook-assistant` (review target + token reuse)

## Summary

Extend `command-centre/draft_replies.py` so that every real inbound email from a genuine
correspondent gets a suggested reply waiting in the **Outlook Drafts folder** before David
opens the mail. Drafts are written by the **local model only**, informed by Hannibal's
read path (archive + CRM + vault), Reggie's ledger view, and a style profile learned from
David's own sent mail (VitaSci Outlook + both Gmail accounts). **Nothing is ever sent
automatically** — the system's only mailbox capability is draft creation on the original
thread; sending remains a human act in Outlook.

## Decisions made (with owner)

1. **Build on `draft_replies.py`**, not a new module in outlook-assistant. Reuses
   tiering, taint, local-LLM routing, and the candidate filter already built.
2. **Scope**: client domains + genuine two-way correspondents (the existing `--broad`
   semantics), never bulk/marketing/auto-replies/first-contact strangers.
3. **Landing**: straight into Outlook Drafts for VitaSci-Outlook mail (threaded reply
   drafts). Gmail-account mail keeps the vault review copy only (Gmail drafts = phase 2).
   The vault review copy is always written, as audit trail.
4. **Style**: stored style profile + per-sender few-shot examples.
5. **DESIGN.md decision #4 ratified 2026-07-22**: David accepts that the scheduled
   background push uses the existing Mail.ReadWrite delegated token
   (`~/.outlook-assistant-tokens.json`) even though no Graph scope exists that grants
   draft-creation without mailbox-wide write. Mitigations below.

## Components

### 1. `style_profile.py` (new, command-centre)
- Reads `direction='outbound'` messages from the archive (all three accounts:
  `vitasci-outlook`, `gmail-ablative`, `gmail-personal`), read-only connection.
- Local model distils an editable profile → `Assistant-Vault/00-Command-Centre/style-profile.md`:
  greetings/sign-offs, formality per audience (client vs personal, per account),
  sentence length, how David declines/chases/commits.
- Re-runnable; the vault file is the source of truth and David may hand-edit it.

### 2. Context enrichment (edit `draft_replies.py`)
Per candidate, the prompt gains:
- the style profile (vault file, verbatim);
- 2–3 actual past outbound replies to this sender/domain (few-shot);
- **sender-scoped** retrieval from the existing FTS5 indexes (`retrieval_index.py` /
  archive FTS) — scoped to the sender's domain/matter, never a global vault sweep,
  honouring `cloud_policy` and quarantine exclusion;
- open Reggie commitments for the correspondent via `reggie_view.py` (read-only).
The inbound body is wrapped in the existing `<external-content>` envelope
(`reggie_memory.py` idiom) extended with `tier` and `provenance` attributes.
Routing stays `prefer_frontier=False`; confidential tiers never leave the Mac.

### 3. `email_draft_push.py` (new, command-centre — name already reserved in the docstring)
- Graph calls **only**: `POST /me/messages/{id}/createReply` then `PATCH` the draft body.
  The module contains no send, no delete, no move, no folder ops. Recipients come from
  the original message, so an injected email cannot redirect a draft elsewhere.
- Uses the outlook-assistant delegated token file, with its existing auto-refresh.
- Every push recorded in the ledger (`ledger.py`); ledger is also the idempotency store
  (never draft the same message twice; skip threads answered since).
- Applies only to messages that arrived on the `vitasci-outlook` account.

### 4. Scheduling
- One launchd job (`com.vitasci.draft-replies`), every 30 min, using the existing
  `run.sh` locking/notification idiom, covered by `job_health.py`.
- Default mode pushes to Drafts; `--review-only` flag preserves the old
  vault-folder-only behaviour.

## Data flow

archive sync (existing) → candidate filter (existing) → context assembly
(style profile + few-shot + scoped retrieval + Reggie view) → local LLM draft →
vault review copy (always) → Outlook Drafts push (VitaSci mail only) → ledger entry.

## Safety / injection posture

- Inbound email is attacker-controlled. The only actuator reachable from its content is
  *draft creation on its own thread* — worst case is a bad draft David reads and bins.
- Sender-scoped retrieval bounds what an injected instruction could exfiltrate into a
  draft body; and that body goes only back to the original sender, only if David sends.
- Local-model-only drafting keeps sensitive mail on the Mac.
- Decision #4 residual risk (accepted): the background process holds a token that could
  modify/delete mailbox content, including litigation evidence. Code-level capability
  scoping is not credential scoping. Compensations: same token already on this Mac (no
  new credential), push module is ~small and reviewable, every mutation ledgered,
  job_health watches the job, and the adversarial review covers the module before it is
  wired to launchd.

## Error handling

- Push failures (401/expired token, 429, 5xx): log, ledger a `push-failed` entry, leave
  the review copy in place, retry next scheduled run via idempotency check. Never crash
  the whole batch on one message.
- Archive/tiering snapshot missing: fail closed (no drafts), notify via the existing
  notifier path.

## Testing

- Unit: candidate filter regressions (exists), style-profile builder on fixture archive,
  push module against a mock Graph server (asserts *only* createReply/PATCH are called,
  asserts ledger entries, asserts idempotency on re-run).
- Manual acceptance: one scheduled cycle in `--review-only`, then one live push cycle on
  a small `--limit`, verify drafts thread correctly in Outlook and nothing sends.

## Out of scope (explicit)

- Gmail draft creation (phase 2).
- Any auto-send, send-reminder, or "send if I don't object" behaviour — never.
- New retrieval daemons, envelopes, sensitivity systems (DESIGN.md Build-NEVER list).
