---
date: 2026-07-21
updated: 2026-07-23
topic: claxedo-homepage-copy
status: implemented
strategy: docs/plans/2026-07-20-001-feat-claxedo-website-strategy-plan.md
implementation: packages/claxedo-web/src/pages/index.astro
---

# Claxedo Homepage Copy

This is the canonical homepage copy deck for `claxedo.com`. Claxedo is the open cloud workspace for coding agents. Visitors can use the hosted Claxedo product immediately or deploy the open control plane to their own Cloudflare account. Both paths use the same MIT-licensed platform packages.

The homepage has exactly two conversion actions: **Open Claxedo** and **Deploy to Cloudflare**. Framework and download links remain supporting navigation.

## Search metadata

**Title**

> Claxedo — The open cloud workspace for coding agents

**Description**

> Run coding agents from one open cloud workspace. Use Claxedo Cloud or deploy the MIT-licensed control plane to your Cloudflare account while execution stays on infrastructure you choose.

## 1. Hero

**Eyebrow**

> Open cloud workspace

**Heading**

> # The open cloud workspace for coding agents.

**Supporting copy**

> Run coding agents across chat, terminal, desktop, browser, and mobile. Start with Claxedo Cloud—or deploy the open control plane to your Cloudflare account with a prompt.

**Actions**

> **Open Claxedo**
>
> **Deploy to Cloudflare**
>
> Explore the open architecture ↓

**Deploy to Cloudflare** is a copy button. It copies one self-contained agent brief containing the prerequisites, architecture boundary, secret-handling rules, billable-resource approval, deployment procedure, verification, upgrade, rollback, and teardown requirements. The homepage does not show those details separately.

The architecture link is a tertiary in-page navigation action. It is not a third conversion path.

**Provider line**

> MIT licensed · Bring your own AI and sandbox providers

**Proof**

Use `marketing-workspace.png`: the seeded `Northstar` workspace with a completed release-verification conversation and changed files in Review.

## 2. Architecture explorer

**Eyebrow**

> Architecture

**Heading**

> ## The whole product is open.

**Copy**

> Claxedo Cloud and a deployment in your Cloudflare account use the same MIT-licensed platform packages. Choose where the control plane runs, then connect the machines and sandboxes where agents do their work.

The section contains three keyboard-accessible views in one stable location:

1. **Platform** — shows every Claxedo product layer inside a visible MIT-licensed boundary: clients, control plane, relay, protocol, workspace runtime, WorkGraph, extensions, and agent runtimes. AI and sandbox providers sit outside the boundary as user-selected infrastructure.
2. **Deployment** — compares the hosted Claxedo control plane with the same open control plane in the user's Cloudflare account. Both connect through the relay to the user's machine, server, or sandbox.
3. **Inside a workspace** — shows the interaction between the agent runtime, terminal, files, processes, review surfaces, extensions, and an optional remote sandbox.

Desktop uses polished SVG diagrams. Mobile uses a dedicated vertical flow, not a scaled-down desktop diagram. Each view has its own deep-link hash.

## 3. Continuity

**Heading**

> ## Move between desktop, browser, and mobile web.

**Copy**

> Start work on your machine and reopen the same workspace from the desktop app or browser. The machine doing the work stays under your control while you follow the same workspace from the client in front of you.

**Sequence**

> Desktop — Start beside your local files, tools, and agent CLIs.
>
> Browser — Open the same running workspace from another computer.
>
> Mobile web — Check progress and respond away from your desk.

The page uses “your machine,” not “workspace host,” and never uses the contextless phrase “Start here.” Product images open at full resolution on mobile.

## 4. Harness neutrality

**Heading**

> ## Keep the harnesses you already use.

**Copy**

> Choose the harness that fits each session. Claxedo keeps its models, tools, permissions, and behavior intact instead of turning every harness into the same generic assistant.

**Visual labels**

- Claude Code — Chat UI + terminal
- Codex — Chat UI + terminal
- Gemini CLI — Terminal
- OpenCode — Chat UI + terminal
- Any agent CLI — First-class terminal
- More through ACP — Bring a compatible agent

The marks are recognizable and proportionally consistent. The strip communicates accurate mode support without implying identical integration depth.

## 5. Chat UI and terminal

**Eyebrow**

> Chat + terminal

**Heading**

> ## Use the chat UI. Or use the terminal.

**Copy**

> Use supported coding agents through Claxedo's chat UI, or run any installed agent CLI in a terminal. Chat sessions and terminals are equally first-class parts of the workspace.

**Supporting line**

> One workspace. Two first-class ways to work.

**Proof**

Use `marketing-session-terminal.png`: a normal Codex chat session beside a functioning Codex terminal in the same Claxedo workbench. The Session Environment card stays collapsed.

## 6. WorkGraph

**Heading**

> ## Work that outlives the session.

**Copy**

> WorkGraph organizes durable Streams, Tasks, Attempts, decisions, and evidence. See what is ready, waiting, running, done, or waiting for your decision without reconstructing the story from chat history.

**Proof**

Use `marketing-workgraph.png`: a close contextual capture of one populated `Ship Claxedo Cloud` Stream card. The crop shows Tasks and varied states without displaying the complete board.

## 7. Agent Extensions

**Heading**

> ## Sync your tools automatically.

**Copy**

> Set up skills, MCP servers, plugins, and instructions once. Claxedo syncs them into each workspace or sandbox, ready for the harness you choose.

The adjacent illustration shows one Agent Extension materializing into a workspace or sandbox as harness-ready configuration.

## 8. Why Claxedo exists

> We do not train models.
>
> We do not replace agents.
>
> We do not resell tokens or sandbox minutes.
>
> **We build the open system that connects them.**
>
> Models, agents, and infrastructure will keep changing. The interface around them should remain open, portable, and under your control.

## 9. Closing conversion

**Heading**

> ## Your agents. Your infrastructure. One open cloud workspace.

**Copy**

> Use Claxedo Cloud or deploy the open control plane to your Cloudflare account.

**Actions**

> **Open Claxedo**
>
> **Deploy to Cloudflare**

## Capture contract

`packages/claxedo-app/e2e/playwright/marketing-screenshots.spec.ts` regenerates the homepage images from deterministic fixtures at 1440 × 900. The fixture contains no personal project, repository, or account data and uses the neutral `Northstar` project.

## Content boundaries

- “Cloud” names the connected product and deployment model in the headline; product and cloud are not separate products.
- The site claims MIT licensing only for packages verified by the public license and package manifests.
- The site explains hosted and self-deployed compositions without claiming production environment parity that has not been demonstrated.
- Cloudflare is the control plane deployment target. Execution remains on a connected user-controlled machine, server, or sandbox.
- Deployment prerequisites and operational details live inside the copied prompt rather than a separate homepage section.
- Framework and download are supporting destinations, not competing hero conversions.
- The page does not use “More than another chat window,” “Discover at the frontier,” “Use an integrated harness,” “Start here,” or “workspace host.”
- The site does not fabricate testimonials, customer logos, performance metrics, or identical structured-chat support for every CLI.

## Product sources

- `packages/claxedo-app/src/app/workbench/` — chat, terminal, review, and workspace surfaces.
- `packages/claxedo-app/src/features/workgraph/` and `packages/workgraph/README.md` — WorkGraph behavior and contracts.
- `packages/agent-extensions/` — portable extension materialization.
- `packages/agent-sdk-runtime/` and `packages/agent-event-runtime/src/harnesses/acp/` — ACP client and normalized event behavior.
- `packages/claxedo-server/`, `packages/claxedo-relay/`, and `packages/workspace-runtime/` — control-plane, connection, and execution boundaries.
- `docs/plans/2026-07-20-001-feat-claxedo-website-strategy-plan.md` — implementation goal, positioning, discovery, and truth gates.
