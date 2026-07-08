# WorkGraph Flat Inbox

Status: retained code-grounded reference
Last updated: 2026-07-09

This document is retained because
`packages/workgraph/test/orchestrator-ratchet.test.ts` cites it as the reason
the old orchestrator/DAG import count must stay at zero.

## Current Implementation

- Package: `packages/workgraph`
- Public client: `packages/workgraph/src/client.ts`
- Connectors: `packages/workgraph/src/connectors/*`
- Event substrate: `packages/workgraph/src/substrate/*`
- Model/reducer/policy layer: `packages/workgraph/src/model/*`
- HTTP routes: `packages/workgraph/src/routes/*`
- MCP surface: `packages/workgraph/src/mcp/*`
- Trigger scheduler/store: `packages/workgraph/src/triggers/*`
- Ratchet test: `packages/workgraph/test/orchestrator-ratchet.test.ts`

## Current Architecture

WorkGraph is retained as a flat, event-sourced work inbox for AI-agent work:

- mirror work from external trackers through connectors,
- stage work deliberately,
- record event-log state changes,
- create attempts/runs instead of mutating work in place,
- answer interrupt/decision queues,
- sync back through connector policy.

The old `src/orchestrator/**` DAG-execution tree is not part of the current
package. The ratchet test enforces that imports from that tree remain at zero.

## Tests To Check

- `packages/workgraph/test/orchestrator-ratchet.test.ts`
- `packages/workgraph/test/client.test.ts`
- `packages/workgraph/test/events.test.ts`
- `packages/workgraph/test/connectors/*`
- `packages/workgraph/test/unit/*`

## Maintenance Rule

Keep this file as the short rationale for the orchestrator deletion ratchet.
Move implementation details into package README/API docs when they become
public contract.
