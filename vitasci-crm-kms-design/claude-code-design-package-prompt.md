# Claude Code Prompt: VitaSci CRM/KMS Design Package

Use this prompt with Claude Code Opus 4.8 to create the full design and execution documentation package for the VitaSci CRM/KMS.

```text
You are Claude Code Opus 4.8 acting as a senior product architect, systems architect, data architect, and agentic workflow designer.

Your task is to create the complete design and execution documentation package for a VitaSci CRM/KMS platform.

Context:
- The existing repo contains an `outlook-assistant` project.
- That project is an Outlook/Microsoft Graph MCP server.
- It can read/search/export/sync Outlook email, calendar, contacts, tasks, folders, categories, and related Microsoft Graph data.
- It is NOT currently a CRM, KMS, vector database, ingestion system, or durable business memory layer.
- The desired system is a proper VitaSci CRM/KMS that ingests, stores, links, embeds, retrieves, and reasons over all relevant business information.
- Outlook/email is only one source. The platform must eventually ingest emails, calendar events, contacts, local files, PDFs, Word docs, spreadsheets, meeting notes, transcripts, web research, manual CRM entries, and future APIs.
- The user has no coding background, so all documentation must be explicit, practical, and written so a non-engineer can understand the purpose, sequence, risk, and approval gates.

Primary objective:
Create a complete design documentation and execution package for building the VitaSci CRM/KMS, including:
- architecture documents
- data model documents
- ingestion protocols
- embedding/vector-search design
- entity-linking design
- CRM/KMS workflow design
- agent definitions
- workflow definitions
- implementation phases
- quality gates
- security/privacy protocols
- testing protocols
- operator instructions
- prompt templates
- decision logs
- risk register
- acceptance criteria
- future roadmap

Important:
Do not implement code yet unless explicitly instructed later.
This task is documentation and planning only.
You may inspect the repo to understand the current Outlook Assistant architecture.
You must not delete or overwrite existing repo documentation.
Create a new top-level documentation package in the repo, preferably:

`vitasci-crm-kms-design/`

If a better location is clearly justified, use it, but explain why.

Required output structure:
Create the following files, with high-quality content in each.

1. `vitasci-crm-kms-design/README.md`
Purpose:
- Explain what this design package is.
- Explain the difference between Outlook Assistant and the proposed CRM/KMS.
- Explain the intended system in plain language.
- Provide a reading order for non-technical and technical readers.

2. `vitasci-crm-kms-design/00-executive-summary.md`
Include:
- What we are building.
- Why it matters.
- What business problem it solves.
- What the current system can and cannot do.
- Recommended architecture.
- Recommended implementation sequence.
- Key risks and mitigations.

3. `vitasci-crm-kms-design/01-current-state-assessment.md`
Include:
- What exists in `outlook-assistant`.
- What it can do.
- What it cannot do.
- Which parts can be reused.
- Which parts should remain separate.
- Why the CRM/KMS should not be hidden inside the Outlook Assistant itself.
- Clear distinction between connector, ingestion layer, CRM database, KMS/vector index, and assistant tools.

4. `vitasci-crm-kms-design/02-target-architecture.md`
Design the full architecture:
- Source systems
- Connectors
- Ingestion pipeline
- Extraction layer
- Normalisation layer
- Entity resolution/linking layer
- CRM relational database
- KMS document store
- Vector search/embedding index
- Retrieval API/MCP tools
- Agent workflows
- Human review gates
- Audit log
- Security boundaries

Include diagrams using Mermaid where useful.

5. `vitasci-crm-kms-design/03-data-model.md`
Define the initial schema conceptually.
Include tables/entities such as:
- contacts
- organisations
- projects
- opportunities
- interactions
- documents
- document_chunks
- embeddings
- tasks
- decisions
- source_sync_state
- entity_links
- tags
- audit_events

For each entity include:
- purpose
- key fields
- relationships
- example records
- notes on deduplication and source traceability

Recommend whether to use:
- Postgres + pgvector
- Supabase
- SQLite prototype
- separate vector DB

Give a reasoned recommendation for VitaSci.

6. `vitasci-crm-kms-design/04-ingestion-protocols.md`
Design protocols for ingesting:
- Outlook email
- Outlook calendar events
- Outlook contacts
- attachments
- PDFs
- Word documents
- spreadsheets
- meeting notes
- transcripts
- web pages / research notes
- manual CRM entries
- future APIs

For each source define:
- trigger mechanism
- extraction method
- metadata captured
- dedupe strategy
- chunking strategy
- embedding strategy
- entity-linking approach
- failure handling
- human review requirement
- privacy/security concerns

7. `vitasci-crm-kms-design/05-embedding-and-retrieval-design.md`
Include:
- What gets embedded.
- What does not get embedded.
- Chunking rules.
- Metadata filters.
- Hybrid search design: keyword + vector + structured filters.
- Retrieval ranking.
- Source citation requirements.
- Handling stale data.
- Handling contradictory data.
- Handling sensitive/legal/confidential material.
- Evaluation metrics for retrieval quality.

8. `vitasci-crm-kms-design/06-entity-linking-and-crm-rules.md`
Define how the system links information to:
- people
- companies
- projects
- deals/opportunities
- topics
- tasks
- decisions

Include:
- deterministic rules
- AI-assisted rules
- confidence scores
- manual confirmation gates
- merge/split rules for duplicate people/orgs
- examples using likely VitaSci contexts such as University of Sydney, Aether Diagnostics, ChemoTrak, pre-seed work, NDAs, and advisory work.

9. `vitasci-crm-kms-design/07-agent-architecture.md`
Define all agents needed.
At minimum include:
- Ingestion Agent
- Extraction Agent
- Entity Resolution Agent
- CRM Curator Agent
- Knowledge Curator Agent
- Retrieval Agent
- Briefing Agent
- Task/Commitment Agent
- Security/Privacy Reviewer Agent
- Workflow Orchestrator Agent
- Human Approval Gatekeeper Agent

For each agent include:
- purpose
- inputs
- outputs
- tools it may use
- tools it must not use
- decision authority
- escalation rules
- failure modes
- logging requirements
- example prompt

10. `vitasci-crm-kms-design/08-workflows.md`
Define workflows:
- Initial historical ingestion
- Daily incremental email sync
- New document ingestion
- Meeting prep brief
- Client/project brief generation
- Opportunity review
- Open actions extraction
- Weekly VitaSci digest
- Manual correction workflow
- Duplicate contact merge workflow
- Confidential document handling
- Human-approved CRM update workflow

Each workflow must include:
- trigger
- steps
- agent responsibilities
- data written
- gates
- success criteria
- failure handling

11. `vitasci-crm-kms-design/09-gates-and-approval-protocols.md`
Define gates:
- No-write dry run gate
- First ingestion sample review gate
- Entity merge approval gate
- Sensitive data gate
- External-send gate
- CRM write approval gate
- Bulk import approval gate
- Delete/archive approval gate
- Production go-live gate

For each gate include:
- purpose
- who/what approves
- required evidence
- pass/fail criteria
- rollback plan

12. `vitasci-crm-kms-design/10-security-privacy-and-governance.md`
Include:
- Sensitive data classification
- Confidentiality handling
- Legal/professional privilege concerns
- Health/medical information concerns
- Client confidentiality
- Email attachment handling
- Access control
- Audit logging
- Secrets management
- Data retention
- Deletion policy
- Local vs cloud storage tradeoffs
- Backup and restore
- Incident response

13. `vitasci-crm-kms-design/11-testing-and-evaluation.md`
Define:
- unit tests
- integration tests
- ingestion tests
- retrieval tests
- entity-linking tests
- embedding quality tests
- regression tests
- privacy/security tests
- human evaluation protocol
- golden datasets
- acceptance tests

Include examples.

14. `vitasci-crm-kms-design/12-implementation-roadmap.md`
Break implementation into phases:
- Phase 0: design signoff
- Phase 1: local prototype database
- Phase 2: Outlook ingestion
- Phase 3: document ingestion
- Phase 4: embeddings/vector search
- Phase 5: CRM entity linking
- Phase 6: assistant query tools
- Phase 7: review workflows and dashboards
- Phase 8: production hardening
- Phase 9: future integrations

For each phase include:
- objective
- scope
- out of scope
- deliverables
- risks
- tests
- exit criteria

15. `vitasci-crm-kms-design/13-prompts.md`
Create reusable prompts for:
- ingesting a new source
- summarising a thread
- extracting CRM facts
- extracting tasks
- linking entities
- generating a project brief
- generating a client brief
- reviewing uncertain links
- preparing a weekly digest
- evaluating retrieval quality
- asking the human for approval

Prompts must be operational, specific, and safe.

16. `vitasci-crm-kms-design/14-operator-runbook.md`
Write for a non-technical operator.
Include:
- how to run a dry-run ingestion
- how to review proposed CRM updates
- how to approve/reject entity links
- how to search the KMS
- how to generate a client/project brief
- how to troubleshoot failed ingestion
- when to stop and ask for technical help

17. `vitasci-crm-kms-design/15-decision-log.md`
Create an ADR-style decision log.
Include initial decisions such as:
- CRM/KMS is separate from Outlook Assistant.
- Outlook Assistant is a connector/source.
- Use Postgres + pgvector or Supabase as recommended target.
- Start with read-only/dry-run ingestion.
- Require source traceability for all generated knowledge.
- Require human approval before CRM writes.

18. `vitasci-crm-kms-design/16-risk-register.md`
Include risks:
- accidental ingestion of sensitive information
- incorrect entity linking
- hallucinated summaries
- stale knowledge
- duplicate CRM records
- over-automation
- data loss
- insecure secrets
- unclear source authority
- vector search returning misleading context
- user trusting summaries without source verification

For each risk include:
- severity
- likelihood
- mitigation
- detection method
- owner
- current status

19. `vitasci-crm-kms-design/17-glossary.md`
Explain terms clearly for a non-engineer:
- CRM
- KMS
- vector database
- embedding
- chunking
- ingestion
- source of truth
- entity resolution
- delta sync
- MCP
- connector
- retrieval
- audit log
- human-in-the-loop

20. `vitasci-crm-kms-design/18-build-brief-for-next-agent.md`
Write a practical handoff brief for the next coding agent that will implement Phase 1.
Include:
- what to build first
- files likely to create
- recommended tech stack
- constraints
- tests to write first
- what not to build yet
- exact acceptance criteria

Additional requirements:
- Use Markdown.
- Use clear headings.
- Avoid vague claims.
- Prefer concrete examples.
- Write for both a non-technical founder/operator and a future engineer.
- Use Mermaid diagrams where they clarify architecture or workflow.
- Do not include secrets.
- Do not modify existing Outlook Assistant behavior.
- Do not run destructive commands.
- Do not install new dependencies unless strictly needed for documentation generation.
- If you discover existing relevant documents, reference them rather than duplicating blindly.
- If the repo contains misleading agent/memory scaffolding that is not part of the product, explicitly call that out.

After creating the documentation package:
1. Summarise what files were created.
2. Identify the most important architecture decisions.
3. Identify open questions that must be answered before implementation.
4. Recommend the first implementation phase.
5. Do not claim the CRM/KMS exists yet. Make clear this is a design package for building it.
```
