# Claxedo Docs

Status: retained docs index
Last updated: 2026-08-30

This directory is intentionally small. A doc belongs here only when it is still
used by current code, public docs, package READMEs, or an active architecture
workstream. Historical reviews, superseded plans, generated diagrams, and
one-off research notes should live outside this tracked docs tree or be
recovered from git history.

## Keep Criteria

- **Referenced by source, tests, public docs, or package README.**
- **Canonical for active architecture.**
- **Required by an automated check.**

If a document does not meet one of those criteria, delete it instead of adding
it to an index.

## Retained Areas

- [Making Claxedo lighter](./perf/README.md)
  Postpartum notes on what actually made the app cheaper to download, start, and switch, plus [agent learnings](./perf/AGENTS.md) for attempts that already failed.
- [Plans](./plans/README.md)
  Dated plans that are still referenced by live packages or source comments.
- [Tech Docs](./tech-docs/)
  Current architecture, public-doc support material, and docs used by tests.

Operational runbooks for the deployed control plane, relay, and Convex
deployment live in [`public-docs/`](../public-docs/README.md), not here.
