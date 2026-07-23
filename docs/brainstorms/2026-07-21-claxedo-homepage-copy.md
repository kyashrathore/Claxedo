---
date: 2026-07-21
topic: claxedo-homepage-copy
status: implemented
strategy: docs/plans/2026-07-20-001-feat-claxedo-website-strategy-plan.md
implementation: packages/claxedo-web/src/pages/index.astro
---

# Claxedo Homepage Copy

This is the canonical copy deck for the `claxedo.com` homepage. The product is one open-source workspace with two first-class interaction modes: a structured chat UI and the terminal. The commercial page has exactly two marketing actions: **Download app** and **Explore the open-source framework**.

## Search metadata

**Title**

> Claxedo — The open-source workspace for coding agents

**Description**

> Run Claude Code, Codex, Gemini CLI, OpenCode, and any coding-agent CLI across first-class sessions and terminals. Organize parallel agent work with WorkGraph, locally or on infrastructure you choose.

## 1. Hero

**Eyebrow**

> Open workspace for coding agents

**Heading**

> # The open-source workspace for coding agents.

**Supporting copy**

> Run coding agents in a full chat UI or directly in the terminal. Keep the conversation, files, processes, changes, and review together.

**Actions**

> **Download app**
>
> **Explore the open-source framework**

**Provider line**

> Bring your own AI provider. · Bring your own sandbox provider.

**Proof**

Use `marketing-workspace.png`: the seeded `Northstar` workspace with a completed release-verification conversation and three changed files in Review.

## 2. Continuity

**Heading**

> ## Move between desktop, browser, and mobile web.

**Copy**

> Start work on your machine and reopen the same workspace from the desktop app or browser. The machine doing the work stays under your control while you follow the same workspace from the client in front of you.

**Sequence**

> Desktop — Start beside your local files, tools, and agent CLIs.
>
> Browser — Open the same running workspace from another computer.
>
> Mobile web — Check progress and respond when you are away from your desk.

The page uses “your machine,” not “workspace host,” and never uses the contextless phrase “Start here.”

## 3. Harness neutrality

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

Each label has a recognizable visual mark. The strip communicates accurate mode support and does not imply identical integration depth.

## 4. Chat UI and terminal

**Eyebrow**

> Chat + terminal

**Heading**

> ## Use the chat UI. Or use the terminal.

**Copy**

> Use supported coding agents through Claxedo's chat UI, or run any installed agent CLI in a terminal. Chat sessions and terminals are equally first-class parts of the workspace.

**Supporting line**

> One workspace. Two first-class ways to work.

**Proof**

Use `marketing-session-terminal.png`: a real split Claxedo workbench with a normal Codex chat session in one pane and a Codex terminal in the other. The Session Environment card stays collapsed so the composition gives both modes equal weight without adding a marketing-made terminal surface.

The page does not call the structured chat surface an “integrated harness.” The user-visible distinction is the **chat UI** versus the **terminal**.

## 5. WorkGraph

**Heading**

> ## Work that outlives the session.

**Copy**

> WorkGraph organizes durable Streams, Tasks, Attempts, decisions, and evidence. See what is ready, waiting, running, done, or waiting for your decision without reconstructing the story from chat history.

**Supporting points**

- **Organize around outcomes** — Break a goal into dependent tasks with explicit completion criteria.
- **See what needs you** — Review proposed work, decisions, failed attempts, and follow-ups in one place.
- **Keep the evidence** — Preserve attempts, decisions, artifacts, and proof beyond a single session.

**Proof**

Use `marketing-workgraph.png`: a close contextual capture of the populated `Ship Claxedo Cloud` Stream card. Its Tasks and varied states explain the durable-work primitive without showing the complete WorkGraph board.

## 6. Placement

**Heading**

> ## Run the work where it belongs.

**Copy**

> Use your laptop for immediate work, a machine you control for long-running sessions, or your preferred sandbox provider for isolation. Claxedo connects the workspace; it does not resell model tokens, compute, or sandbox minutes.

**Choices**

- Local — Your laptop — Immediate files and tools
- Remote — Your machine — Persistent, long-running work
- Sandbox — Your provider — Isolated compute when needed

## 7. Agent Extensions

**Heading**

> ## Sync your tools automatically.

**Copy**

> Set up skills, MCP servers, plugins, and instructions once. Claxedo syncs them into each workspace or sandbox, ready for the harness you choose.

**Documentation link**

> How Agent Extensions work →

The adjacent illustration shows one Agent Extension flowing into a workspace or sandbox and becoming harness-ready configuration. It uses the same recognizable harness marks as the neutrality section.

## 8. Self-hosting

**Eyebrow**

> Self-hosting

**Heading**

> ## Self-host Claxedo with Cloudflare.

**Copy**

> Claxedo's clients, server, relay, protocol, WorkGraph, and framework are developed in the public repository. Open the agent-guided deployment brief and let your coding agent configure the Cloudflare control plane, connect the runtime and relay, deploy, and verify the complete path with you.

The right side is one linked deployment card. It opens `/framework/deploy/hosted-control-plane#agent-deploy`, where a copyable agent brief hand-holds preflight, secrets, deployment, health checks, and rollback. The page describes Cloudflare as the control plane and keeps runtime/relay placement explicit.

## 9. Why Claxedo exists

> We do not train models.
>
> We do not replace agents.
>
> We do not resell tokens or sandbox minutes.
>
> **We build the open system that connects them.**
>
> Models, agents, and infrastructure will keep changing. The interface around them should remain open, portable, and under your control.

## 10. Closing conversion

**Heading**

> ## Give your agents a workspace that stays yours.

**Copy**

> Bring your own AI provider and sandbox provider. Claxedo gives them one open workspace.

**Actions**

> **Download app**
>
> **Explore the open-source framework**

## Capture contract

`packages/claxedo-app/e2e/playwright/marketing-screenshots.spec.ts` regenerates the three homepage images from deterministic fixtures at 1440 × 900. The fixture contains no personal project, repository, or account data. The capture removes transient reconnect notices and uses the neutral `Northstar` project.

## Content intentionally excluded

- “More than another chat window.”
- “Discover at the frontier. Keep what works.”
- “Use an integrated harness.”
- “Start here.” and “workspace host.”
- Repeated source cards that share one destination.
- Placeholder testimonials, customer logos, or fabricated product evidence.
- Additional marketing CTAs such as Start free, Try Cloud, Copy prompt, Sign up, or Contact sales.
- Claims that all agent CLIs receive the same structured-chat integration merely because they can run in a terminal.

## Product sources

- `packages/claxedo-app/src/app/workbench/` — first-class chat, terminal, review, and workspace surfaces.
- `packages/claxedo-app/src/features/workgraph/` and `packages/workgraph/README.md` — WorkGraph product behavior and contracts.
- `packages/agent-extensions/` — portable extension materialization.
- `packages/agent-sdk-runtime/` and `packages/agent-event-runtime/src/harnesses/acp/` — ACP client and normalized event behavior.
- `docs/plans/2026-07-20-001-feat-claxedo-website-strategy-plan.md` — implementation goal, positioning, CTA hierarchy, discovery, and truth gates.
