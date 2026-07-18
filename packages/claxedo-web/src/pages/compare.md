---
layout: ../layouts/Prose.astro
title: "Claxedo — Agent Coding GUI Feature Comparison"
description: "How Claxedo compares to other agent coding GUIs across platform, models, terminals, review, MCP, and more. Free and open source — managed hosting is the only paid tier."
noindex: true
---

# Agent Coding GUI — Feature Comparison Index

> Last updated: 2026-07-18
>
> **Legend:** ✅ = Yes | ❌ = No | 🔶 = Partial / Limited | 🔜 = Planned | — = N/A

## Products

| Abbr | Product | Website |
|------|---------|---------|
| **CLX** | Claxedo | claxedo.com |
| **T3** | T3 Code | t3.codes |
| **CDX** | OpenAI Codex App | developers.openai.com/codex/app |
| **CUR** | Cursor | cursor.com |
| **PLY** | Polyscope | getpolyscope.com |
| **JEN** | Jean | jean.build |
| **TRA** | Trae AI | trae.ai |
| **CON** | Conductor | conductor.build |
| **SUP** | Superset | superset.sh |
| **WND** | Windsurf | windsurf.com |
| **SPC** | Supacode | supacode.sh |
| **OPC** | OpenCode | opencode.ai |
| **AIR** | Air (JetBrains) | air.dev |

---

## 1 — Platform & Distribution 

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| macOS (Apple Silicon) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| macOS (Intel) | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Windows | ✅ | ✅ | ✅ | ✅ | ❌ | 🔶 | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Linux | ✅ (.deb + .rpm) | ✅ | ❌ | ✅ | ❌ | 🔶 | 🔜 | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Browser / Web app | ✅ (preview + mobile) | ✅ (web GUI) | ❌ | ❌ | ❌ | ❌ | ✅ (Cloud IDE) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| IDE extension | ❌ | ❌ | ✅ | — (is IDE) | ❌ | ❌ | ✅ (VSCode + JetBrains) | ❌ | ❌ | ✅ (JetBrains plugin) | ❌ | ✅ | — (is IDE) |
| TUI / CLI mode | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (primary) | ❌ |
| Desktop framework | Tauri | Electron | Proprietary | Electron | Native macOS | Electron | Proprietary | Native macOS | Proprietary | Electron | Native (libghostty) | Tauri | Fleet-based |
| Open source | ✅ (MIT, every layer) | ✅ | ❌ | ❌ | ❌ | ✅ (Apache 2.0) | ❌ | ❌ | Source (ELv2) | ❌ | ✅ | ✅ | ❌ |
| Self-hostable | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ |

---

## 2 — Pricing & Licensing

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Free tier | ✅ (free + open source) | ✅ | ❌ (needs ChatGPT plan) | ✅ | ✅ | ✅ (free forever) | ✅ | ✅ | ✅ | ✅ | ✅ (beta) | ✅ | Preview (free) |
| Paid plans | Managed hosting only | ❌ | ChatGPT Plus/Pro/Ent | Per-seat plans | ❌ | ❌ | Pro tier | ❌ | TBD | Per-seat + Enterprise | ❌ | ❌ | TBD |
| BYO API keys | ✅ | ✅ | ❌ | ✅ (BYO model) | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| No API proxying | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| Enterprise plan | ❌ | ❌ | ✅ (ChatGPT Enterprise) | ✅ (SOC 2) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | TBD |
| Student/edu discount | ❌ | ❌ | ❌ | ✅ | ❌ | — | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |

---

## 3 — LLM & Model Support

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Anthropic (Claude) | ✅ | 🔜 | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| OpenAI (GPT / Codex) | ✅ | ✅ (Codex-first) | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| Google (Gemini) | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| xAI (Grok) | ✅ (via OpenCode) | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Local models (Ollama etc.) | ✅ (via OpenCode) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| OpenRouter | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Proprietary models | ❌ | ❌ | ❌ | ✅ (Cursor models) | ❌ | ❌ | ✅ (Trae models) | ❌ | ❌ | ✅ (Windsurf models) | ❌ | ❌ | ✅ (Junie) |
| Total providers | 75+ (via Models.dev) | 1-2 | 1 | 5+ | Multiple | 3 | Proprietary | 2 | 4+ | Proprietary | 3+ | 75+ | 4 |
| GitHub Copilot login | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| ChatGPT Plus/Pro login | ✅ | ❌ | ✅ (required) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Model switching in-session | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |

---

## 4 — CLI Agent Support (Wrapper/Orchestrator)

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code CLI | ✅ | 🔜 | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | — | ✅ |
| OpenAI Codex CLI | ✅ | ✅ | — | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | — | ✅ |
| Gemini CLI | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | — | ✅ |
| Amp CLI | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| Cursor agent CLI | ✅ | ❌ | ❌ | — | ❌ | ❌ | ❌ | ❌ | ✅ | — | ❌ | — | ❌ |
| Any arbitrary CLI agent | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | — | ❌ |
| Managed agent terminals | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | — | ✅ |
| Agent status tracking (running/waiting/done) | ✅ | 🔶 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🔶 | — | ✅ |
| Agent start/stop/restart from UI | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🔶 | — | ✅ |
| Agent lifecycle hooks | ✅ | ❌ | ✅ (automations) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |

---

## 5 — Multi-Agent & Parallelism

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Run agents in parallel | ✅ | ✅ | ✅ | ✅ (cloud) | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| Max parallel agents | Unlimited | Unlimited | Multiple | Multiple (cloud) | Dozens | Multiple | 1 | Multiple | 50+ | 1 | 50+ | Multiple | Multiple |
| Git worktree isolation | 🔶 (workspace-level) | ✅ | ✅ | ❌ (shadow) | ✅ (CoW clones) | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ |
| Copy-on-write clones | ❌ | ❌ | ❌ | ❌ | ✅ (zero disk overhead) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Docker container isolation | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Multi-repo agent collaboration | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Agent dashboard (all-at-a-glance) | ✅ (rail sidebar) | ✅ | ✅ (thread list) | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ |
| Autopilot (goal → subtasks → execute) | ❌ | ❌ | ✅ (automations) | ❌ | ✅ | ❌ | ✅ (Builder) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Subagent delegation | ✅ (via OpenCode) | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |

---

## 6 — Workspace & Layout

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Split panes (side-by-side) | ✅ | ❌ | ❌ | ✅ (IDE splits) | ❌ | ❌ | ✅ (IDE splits) | ❌ | ❌ | ✅ (IDE splits) | ❌ | ❌ | ✅ (IDE splits) |
| Multi-group tab system | ✅ | ❌ | ❌ | ✅ (IDE tabs) | ❌ | ❌ | ✅ (IDE tabs) | ❌ | ❌ | ✅ (IDE tabs) | ❌ | ❌ | ✅ (IDE tabs) |
| Per-group layout state | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Drag-to-resize panels | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Toggle split (keyboard) | ✅ (Mod+\\) | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Focus switch between groups | ✅ (Mod+Alt+Arrow) | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Collapsible sidebar / rail | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Tab types (session, page, review, etc.) | ✅ (session, page, review) | 🔶 (project) | ✅ (thread) | ✅ (file-based) | 🔶 (workspace) | 🔶 (session) | ✅ (file-based) | 🔶 (agent) | 🔶 (agent) | ✅ (file-based) | 🔶 (terminal) | 🔶 (session) | ✅ (task-based) |
| Layout persistence (survives restart) | ✅ (localStorage + migration) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| File tree sidebar | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Project / workspace hierarchy | ✅ (projects > workspaces > sessions) | ✅ (projects) | ✅ (projects) | ✅ (workspaces) | ✅ (workspaces) | ✅ (projects) | ✅ (projects) | ✅ (repos) | ✅ (repos) | ✅ (workspaces) | ✅ (repos) | ✅ (sessions) | ✅ (projects) |

---

## 7 — Terminal

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Integrated terminal emulator | ✅ (xterm.js) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (libghostty) | ✅ (is TUI) | ✅ |
| Per-agent dedicated terminal | ✅ | ✅ | ✅ (per thread) | ❌ | ✅ (per workspace) | ✅ (per worktree) | ❌ | ✅ | ✅ | ❌ | ✅ | — | ✅ (per task) |
| Multiple terminal tabs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| Terminal search | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Clickable URLs / file paths | ✅ (Cmd/Ctrl+Click) | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| 24-bit color / ANSI | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Unicode 11 support | ✅ | 🔶 | 🔶 | ✅ | 🔶 | 🔶 | ✅ | 🔶 | 🔶 | ✅ | ✅ | ✅ | ✅ |
| Font ligatures | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ |
| WebGL rendering | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Terminal serialization / export | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| PTY recovery / reconnect | ✅ (clone-on-reconnect) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (session persist) | ❌ | ❌ | ❌ | ❌ |
| Terminal history to disk | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| OSC 7 directory tracking | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Shell integration (zsh/bash) | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Ghostty backend | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (libghostty native) | ❌ | ❌ |
| Natural language terminal (Cmd+I) | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |

---

## 8 — Code Editing

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Built-in code editor | ✅ (viewer + basic edit) | ❌ | ❌ | ✅ (full IDE) | ❌ | ❌ | ✅ (full IDE) | ❌ | ❌ (opens external IDE) | ✅ (full IDE) | ❌ | ❌ | ✅ (full IDE) |
| Syntax highlighting | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| LSP integration | ✅ (via OpenCode, auto-loads) | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ (auto-loads) | ✅ |
| AI autocomplete / Tab complete | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ (Supercomplete) | ❌ | ❌ | ❌ |
| Inline AI edit (Cmd+K) | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ (Cmd+I) | ❌ | ❌ | ❌ |
| Multi-file edit | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Extensions / plugins marketplace | ❌ | ❌ | ✅ (skills) | ✅ | ❌ | ❌ | ✅ (VS Code extensions) | ❌ | ❌ | ✅ (VS Code extensions) | ❌ | ❌ | ❌ |
| Open in external IDE | ✅ | ❌ | ❌ | — | ❌ | ❌ | — | ❌ | ✅ (Cursor/VS Code/Xcode/JetBrains/Sublime) | — | ❌ | ❌ | — |
| Codelenses / code actions | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| AI-predicted cursor positioning | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (Tab to Jump) | ❌ | ❌ | ❌ |

---

## 9 — Code Review & Diffs

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Built-in diff viewer | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Unified diff mode | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Side-by-side diff mode | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Dedicated review panel/surface | ✅ | ❌ | ✅ (review pane) | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| Per-group review panels | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Stage / revert individual chunks | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Inline comments on diffs | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Approval before apply | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Multi-model code review ("Opinions") | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Automated PR review bot | ❌ | ❌ | ❌ | ✅ (BugBot) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Change statistics (additions/deletions) | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ |

---

## 10 — Git Integration

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Git status / log / blame | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (terminal) | ✅ | ✅ |
| Commit from UI | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ (AI commits) | ✅ | ❌ | ✅ | ✅ | ✅ (terminal) | ✅ | ✅ |
| Branch management | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| PR creation from UI | ❌ | ❌ | ❌ | ✅ | ✅ (GitHub) | ✅ (auto PR) | ❌ | ❌ | ✅ | ❌ | ✅ (terminal) | ❌ | ❌ |
| PR review from UI | ❌ | ❌ | ❌ | ✅ (BugBot) | ❌ | ✅ | ❌ | ❌ | ✅ (PR comments) | ❌ | ✅ (terminal) | ❌ | ❌ |
| AI merge conflict resolution | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ (terminal) | ❌ | ❌ |
| GitHub Issues integration | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ (load as context) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Worktree auto-create/archive | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ |
| Auto-merge worktrees back | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 11 — Process Management

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Long-lived process management | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Process status at a glance | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Port management / collision avoidance | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (port forwarding) | ❌ | ❌ | ❌ | ❌ |
| Auto-run processes across workspaces | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Process diagnostics | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Dev server management | ✅ | ❌ | ✅ (per-thread) | ❌ | ❌ | ❌ | ✅ (Cloud IDE) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Process output capture | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 12 — Document & Spec Authoring

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| In-workspace page/doc editor | ✅ (Page Arena) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Spec / prompt / notes authoring | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Document workflow statuses | ✅ (Draft, In Review, etc.) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Workgraph / dependency visualization | ✅ (Mermaid) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Doc lifecycle (dump→explore→design→implement) | 🔜 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 13 — Cloud & Sandbox

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Cloud sandbox workspaces | ✅ (Daytona etc.) | ❌ | ✅ (cloud environments) | ✅ (cloud agents) | ❌ | ❌ | ✅ (Cloud IDE) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Multiple sandbox providers | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cloud session sync | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Message replay / persistence | ✅ (SQLite + cloud) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Repository cloning into sandbox | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| One-click deployment | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Serverless functions | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 14 — MCP & Extensibility

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| MCP (Model Context Protocol) support | ✅ (workspace-aware) | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Workspace-scoped MCP | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Custom MCP server management | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Skills / custom tools system | ❌ | ❌ | ✅ (skills) | ❌ | ❌ | ❌ | ❌ | ✅ (Codex skills) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Extension / plugin system | ✅ (registerExtensions) | ❌ | ✅ | ✅ (marketplace) | ❌ | ❌ | ✅ (VS Code extensions) | ❌ | ❌ | ✅ (VS Code extensions) | ❌ | ❌ | ❌ |
| Slash commands | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Automations / workflows | ❌ | ❌ | ✅ (automations + inbox) | ❌ | ✅ (Autopilot) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 15 — Chat & Conversation

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Chat/conversation interface | ✅ | ✅ | ✅ | ✅ (Cascade) | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ (Cascade) | ❌ | ✅ | ✅ |
| Markdown rendering in chat | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Session history / list | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Session sharing (link) | 🔶 | ❌ | ✅ (cloud threads) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Context from files / @ mentions | ✅ | ❌ | ✅ (file input) | ✅ (@ mentions) | ❌ | ✅ (GitHub issues/PRs) | ✅ (multimodal) | ❌ | ❌ | ✅ (@ mentions) | ❌ | ✅ | ✅ (code symbols) |
| Image / multimodal input | ✅ (via OpenCode) | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Sync across app/CLI/IDE | ✅ (cloud sync) | ❌ | ✅ (Auto Context) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Agent type switching (build/plan) | ✅ (Tab key) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 16 — Visual & Preview

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Built-in web preview | ❌ | ❌ | ❌ | ❌ | ✅ (preview browser) | ❌ | ✅ (Cloud IDE) | ❌ | ❌ | ✅ (Windsurf Previews) | ❌ | ❌ | ✅ (built-in preview) |
| Click-to-edit in preview | ❌ | ❌ | ❌ | ❌ | ✅ (visual workflows) | ❌ | ❌ | ❌ | ❌ | ✅ (click-to-reshape) | ❌ | ❌ | ❌ |
| Live preview hot reload | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |

---

## 17 — Remote & Mobile Access

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Mobile / tablet access | ✅ (web workspace) | ❌ | ❌ | ✅ (mobile agent) | ✅ (browser via relay) | ✅ (localhost/CF tunnel/Tailscale) | ✅ (browser) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Remote / headless mode | ❌ | 🔜 | ❌ | ✅ (cloud agents) | ✅ (E2E encrypted relay) | ✅ | ✅ (Cloud IDE) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Tunnel support | ✅ | ❌ | ❌ | ❌ | ✅ (encrypted relay) | ✅ (CF Tunnel / Tailscale) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 18 — Authentication & Security

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Enterprise auth (SSO) | ✅ (Clerk) | ❌ | ✅ (ChatGPT Ent) | ✅ (SOC 2) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | TBD |
| Local-only mode (no cloud) | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | 🔶 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Data stays on device | ✅ | ✅ | ❌ | ✅ (BYO model) | ✅ | ✅ | ✅ (local-first) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| No telemetry / tracking | ❌ (PostHog) | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ |
| On-premise deployment | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | TBD |
| Admin / managed config | ❌ | ❌ | ✅ (Enterprise) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | TBD |

---

## 19 — Data Persistence & Storage

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Local database (SQLite etc.) | ✅ (SQLite + localStorage) | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Cloud sync of sessions | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Message replay from disk | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Server-scoped storage isolation | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Legacy data migration | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Database repair utilities | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 20 — UI / UX Polish

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Theme support (light/dark) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Custom themes / colors | ✅ (CSS variables) | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Keyboard shortcuts system | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Toast / notification system | ✅ (success/error/loading) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Native OS notifications | ✅ (Tauri) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Smooth panel animations | ✅ | 🔶 | ✅ | ✅ | ✅ | 🔶 | ✅ | 🔶 | 🔶 | ✅ | ❌ | ❌ | ✅ |
| Deep linking (URL schemes) | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Auto-update system | ✅ (Tauri updater) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| i18n / localization | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 21 — Collaboration & Social

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Slack integration | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| GitHub integration | 🔶 | ❌ | ❌ | ✅ (BugBot) | ✅ (sign in + PRs) | ✅ (issues + PRs) | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| Code comments / annotations | ✅ | ❌ | ✅ (inline) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Real-time collaboration | ❌ | ❌ | ❌ | ✅ (presence) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Community (Discord etc.) | ✅ (Discord) | ✅ (Discord) | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |

---

## 22 — Performance & Architecture

| Feature | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SolidJS (reactive, no vDOM) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| CSS hidden panel toggling (no unmount) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| WebGL terminal rendering | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Native (no Electron) | ✅ (Tauri) | ❌ (Electron) | ❌ | ❌ (Electron) | ✅ (native macOS) | ❌ (Electron) | ❌ | ✅ (native macOS) | ❌ | ❌ (Electron) | ✅ (libghostty) | ✅ (Tauri) | ✅ (Fleet) |
| Instant project/thread switching | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WebSocket real-time updates | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| SSE (Server-Sent Events) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Connection auto-recovery | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |

---

## Feature Count Summary

| Category | CLX | T3 | CDX | CUR | PLY | JEN | TRA | CON | SUP | WND | SPC | OPC | AIR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Platform (10) | 8 | 7 | 4 | 7 | 3 | 5 | 8 | 3 | 6 | 7 | 4 | 8 | 7 |
| LLM/Model (11) | 10 | 2 | 3 | 6 | 3 | 4 | 1 | 3 | 4 | 1 | 3 | 10 | 5 |
| CLI Agent (10) | 10 | 4 | 3 | 2 | 7 | 5 | 1 | 5 | 8 | 1 | 5 | 0 | 5 |
| Multi-Agent (8) | 5 | 4 | 5 | 3 | 6 | 3 | 2 | 4 | 4 | 0 | 3 | 2 | 5 |
| Workspace (12) | 11 | 3 | 4 | 9 | 4 | 3 | 9 | 3 | 4 | 9 | 2 | 3 | 9 |
| Terminal (17) | 15 | 4 | 4 | 10 | 3 | 3 | 8 | 3 | 4 | 10 | 5 | 3 | 8 |
| Code Editing (10) | 4 | 0 | 2 | 9 | 0 | 0 | 9 | 0 | 1 | 10 | 0 | 2 | 6 |
| Review/Diff (11) | 7 | 3 | 7 | 6 | 3 | 2 | 4 | 3 | 6 | 5 | 0 | 4 | 6 |
| Git (9) | 4 | 4 | 3 | 6 | 4 | 8 | 3 | 3 | 5 | 3 | 5 | 3 | 3 |
| Process Mgmt (7) | 7 | 0 | 1 | 0 | 0 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 |
| Doc Authoring (5) | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Cloud/Sandbox (7) | 5 | 0 | 2 | 1 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| MCP/Extensibility (7) | 5 | 0 | 5 | 3 | 0 | 0 | 3 | 1 | 2 | 3 | 0 | 3 | 0 |
| Chat (8) | 7 | 3 | 6 | 4 | 1 | 4 | 4 | 0 | 0 | 4 | 0 | 5 | 3 |
| Visual/Preview (3) | 0 | 0 | 0 | 0 | 2 | 0 | 2 | 0 | 0 | 3 | 0 | 0 | 2 |
| Mobile/Remote (3) | 2 | 0 | 0 | 1 | 3 | 3 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| Auth/Security (6) | 3 | 3 | 2 | 4 | 3 | 3 | 2 | 3 | 3 | 4 | 3 | 3 | 2 |
| Persistence (6) | 6 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 1 |
| UI/UX (9) | 8 | 4 | 5 | 7 | 5 | 4 | 6 | 4 | 4 | 7 | 4 | 4 | 7 |
| Collaboration (5) | 2 | 1 | 2 | 5 | 1 | 2 | 1 | 0 | 2 | 1 | 2 | 1 | 1 |
| Performance (8) | 7 | 3 | 3 | 4 | 2 | 1 | 2 | 3 | 1 | 4 | 3 | 5 | 4 |
| **TOTAL (162)** | **130** | **45** | **62** | **93** | **50** | **50** | **71** | **38** | **55** | **74** | **39** | **56** | **74** |

---

## Product Positioning Summary

| Product | Category | Strength | Weakness |
|---|---|---|---|
| **Claxedo** | Desktop workspace + orchestrator | Broadest feature set: splits, process mgmt, doc authoring, cloud sandbox, 75+ models, workspace-aware MCP | No built-in code editor IDE, no visual preview |
| **T3 Code** | Lightweight agent GUI | Fast, minimal, open source, multi-repo | Limited agent support (Codex-first), few features beyond basics |
| **Codex App** | OpenAI agent desktop | Skills, automations, inbox, deep OpenAI integration | Locked to OpenAI ecosystem, no BYO keys, macOS + Windows only |
| **Cursor** | Full AI IDE | Complete IDE, BugBot, Slack, cloud agents, enterprise | Not an orchestrator — single-agent focus, expensive at scale |
| **Polyscope** | Agent orchestrator | CoW clones, Opinions (multi-model review), visual workflows, Autopilot | macOS only, no code editor, no MCP |
| **Jean** | Git-centric agent env | AI merge conflicts, auto PR, free forever, open source | macOS-focused, no code editor, limited to 3 agents |
| **Trae AI** | Cloud + IDE hybrid | Browser IDE, one-click deploy, 100+ languages, free tier | Proprietary models only, no CLI agent wrapping, single agent |
| **Conductor** | Simple Mac orchestrator | Clean UX, focused on Claude+Codex, fast setup | macOS only, 2 agents only, minimal features |
| **Superset** | IDE-agnostic orchestrator | Opens in any IDE, agent-agnostic, no API proxying | No built-in editor or review, relies on external IDEs |
| **Windsurf** | Full AI IDE | Supercomplete, Tab to Jump, live preview, click-to-reshape | Not an orchestrator, proprietary models, single agent |
| **Supacode** | Native macOS runner | 50+ agents, libghostty native, ultra-fast | macOS Tahoe+ only, terminal-only (no GUI review), beta |
| **OpenCode** | Open source foundation | 75+ providers, TUI+desktop+extension, largest community | No orchestration UI, no process mgmt, no split panes |
| **Air (JetBrains)** | Agentic IDE | 4 agents, code-symbol context, Docker isolation, JetBrains quality | Preview/early, pricing unknown, not open source |
