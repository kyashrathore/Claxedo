# Docs Map

This repo has a mix of product PRDs, architecture notes, and implementation plans. This file is the single "start here" entrypoint.

## Start Here

- Product: Claxedo WorkGraph: `packages/workgraph/PRD.md`
- Architecture (repo-level, public): `ARCHITECTURE.md`

## Orchestration + Canvas (Plans)

- Orchestrate tool rendered as an inline canvas DAG: `docs/acp-renderer-canvas-ui-plan.md`
- Multi-team orchestrator control plane build plan: `docs/agent-teams-build-plan.md`

## Integration Notes

- AG-UI protocol integration plan: `docs/agui-protocol-integration.md`
- Claxedo gateway routing (cloud vs local): `docs/cloud-vs-local-gateway-flow.md`

## Specs (API / Contracts)

- Project + session API sketch: `specs/project.md`
- Session composer refactor plan: `specs/session-composer-refactor-plan.md`

## Doc Conventions (Going Forward)

- Prefer fewer docs with stronger cross-links. When you create a new doc, add it to this index.
- Use one of these prefixes in the title:
  - `PRD:` product requirements and UX intent
  - `Architecture:` stable system design and invariants
  - `Plan:` implementation sequencing and milestones
  - `Spec:` APIs, schemas, and wire contracts
- Every non-trivial doc should answer:
  - What problem does this solve?
  - What is the minimal model?
  - What are the key decisions and why?
  - How does it map into WorkGraph nodes/edges (if applicable)?
