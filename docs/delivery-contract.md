# Cross-repository email delivery contract

Email Assistant is the canonical source. A destination receives a package containing:

- `original.eml`: the original email bytes;
- `attachments/`: attachment bytes copied without conversion;
- `manifest.json`: schema `email-assistant.delivery.v1`.

The manifest includes archive/provider identifiers, SHA-256 hashes, security status,
triage categories, confidence, proposed destinations, and a manifest digest.

Destinations must validate the manifest and hashes before ingestion. They must reject
unsafe, unscanned, wrongly addressed, duplicate, or incomplete packages. Rejection
does not delete the archive record. Every accept/reject/retry decision must retain the
archive message ID and manifest digest.

The archive worker's routing orchestrator performs the safe sequence:

1. deterministic classification;
2. review hold for low-confidence or unmatched messages;
3. manifest creation;
4. byte/hash-verified package creation;
5. one durable delivery job per destination.

The delivery worker then hands those packages to destination adapters. It never
calls an adapter for a package whose manifest or attachment security state fails
validation.
