# Claxedo Positioning & Competitive Landscape — Handoff

**Date:** 2026-07-11 · **Updated 2026-07-20** (second research pass: community-mindshare mining across X/Reddit/HN/awesome-lists/PH + 11 new site teardowns)
**Scope:** Positioning decisions, the competitive claim map, and research findings. Deliberately excludes implementation (site code, diagrams, page structure).
**Provenance:** ~40 competitor homepages/docs fetched verbatim on 2026-07-10/20; HN mined via Algolia API (16 major threads read comment-by-comment on the second pass); audience sizing measured against the public ClickHouse `github_events` dataset; npm/GitHub/Open Collective numbers pulled live. Reddit was fetch-blocked on the second pass — Reddit quotes there are aggregator-sourced (verify before printing). Quotes are verbatim unless marked as estimates. Prices and traction numbers age fast — treat everything as a July-2026 snapshot.

---

## 1. The decision (TL;DR)

**Positioning center of gravity (founder-locked):** *every layer of Claxedo is open source (MIT), and you can deploy the whole thing to your own servers with one click.*

- **Category term: "agent stack."** Chosen over "AI stack" (reads as GPUs/inference — buyers expect model hosting, training, vector DBs) and over "coding-agent stack" (needlessly traps the product in dev tooling; the founder's thesis is that coding harnesses are becoming general computer operators). "Agent stack" preserves breadth without over-promising.
- **Anchor line:** "Deploy your entire agent stack. One click. Your servers." Subhead pattern: "Any model. Any harness. Any kind of work." — with the open-source app/backend/workspaces/runtime deploying to infrastructure you control, or running on the hosted backend. **Same code either way** is a load-bearing phrase (see "not the secret real product" below).
- **One product, two deployment paths.** Not "App + Framework" as two products. The app is always Claxedo; you choose where its backend runs (hosted vs self-deployed). Packages are the proof that "open source" means the whole product.
- **Funnel:** one dominant CTA (Deploy your stack) + secondary (Try the desktop app). Post-deploy, hand the user their URL → open web app or connect desktop.
- **Claim hierarchy:** ownership/deploy is the spine; extension-sync is the magic; hybrid placement is the structural differentiator; any-harness / remote access / terminal fidelity are proof rows (commodity claims — never headlines).

---

## 2. Finding: the addressable market is small, dense, and reachable

Measured directly (ClickHouse `github_events`, through 2026-07-10):

- Unique accounts that starred **any of the top ~33 AI repos**: ~0.93M captured → **~1.3–1.8M true** after ingestion-coverage adjustment.
- Unique accounts that starred **an AI coding tool** specifically (cline, aider, continue, zed, opencode, claude-code, codex, OpenHands, void, plandex, etc.): **~500–700K**. This is the actual targeting universe.
- Only ~18–28M accounts starred *anything* since 2023. "10M developers who starred AI repos" is off by 2–7×; for coding tools, 15–20×.
- CMU (ICSE 2026) found ~6M fake stars, with AI/LLM repos the largest category — discount all star-based audience claims.

Implication: this is good news at small budgets. The audience is dense (a handful of subreddits, a few dozen YouTubers, one trending page), and positioning matters more than reach.

---

## 3. Competitive map

### 3.1 Cohorts

| Cohort | Players | What they sell | What they can't say |
|---|---|---|---|
| **Model-lab surfaces** | Claude Code (+web/iOS/Remote Control/Teleport/Agent Teams/Cowork), OpenAI Codex (+Handoff), Google Jules, **Google Antigravity 2.0**, **xAI Grok Build**, AWS Kiro, **Z.ai Z Code** | Their agent on their cloud; increasingly with native laptop↔cloud session movement | Any-harness; your backend. Single-vendor by design. Grok Build confirmed uploading the *entire repo* to xAI/GCS. |
| **Funded agent apps** | Cursor, Devin/Devin Desktop (ex-Windsurf), Factory (droids), Amp (Sourcegraph), Warp, **Zencoder** | Polished closed platforms; "self-hosted" = execution-only (Zencoder: enterprise "Private Deployments") | An open backend. VPC/on-prem only as enterprise contracts. |
| **Open agent runtimes** | Cline (Apache), opencode = upstream (MIT, ~160K★), OpenHands (MIT core), Goose | The agent itself, open | A harness-neutral workspace layer above agents (each runs *its own* agent). |
| **Mega-scale own-agent** *(new)* | **Hermes Agent (Nous Research)** — MIT, **217K★** (#25 on GitHub globally), $70M raised, six BYO-infra targets ("$5 VPS… GPU cluster… serverless"), Skills Hub | One self-improving agent on your infra | A harness-neutral workspace (it IS the agent, 300+ models plugged into *it*); no cross-machine setup sync. Every "open self-hostable agent" comparison will cite it — pre-empt with "Hermes is an agent; Claxedo is the stack agents run in (Hermes could be a tenant)." |
| **Local orchestrator cohort** | Conductor ($22M A), Orca (15.8K★), Superset (YC, 12.4K★, ELv2), Emdash (YC), Supacode (FSL), Jean (coolLabs), T3 Code (13.5K★), Paseo (AGPL, 10.2K★), **cmux (24.4K★)**, **Composio Agent Orchestrator (Apache, 8.4K★ — the reference OSS orchestrator)**, **Sculptor (Imbue)**, Claude Squad (AGPL 8.1K★), Crystal→**Nimbalyst**, **OpenAI Symphony**, **GCP Scion**, gastown (17.1K★) | Parallel agent CLIs in worktrees on your machine | A backend at all. HN's own verdict on this cohort: "the new TODO app — just build your own." |
| **Anti-backend terminal cohort** *(new)* | **Herdr** (AGPL, 18.7K★ in ~115 days, solo dev) | "One terminal. The whole herd." — verbatim: "No web view, no account, no hosted control plane" | Anything cross-machine: no sync, no placement, no phone/web reach. The rhetorical anti-Claxedo — answer with what a backend *buys*, never by out-minimal-ing it. |
| **Cloud workspace cluster (mostly YC, closed)** *(new)* | **Terminal Use (W26)**, **boxes.dev**, **Runtime (P26)**, **Twill (S25)**, **InsForge (P26)**, **flexenv**, **Coasts (OSS)**, **Ara (S26)**, **Vorflux ($15M YC-led, cloud-only)**, Cursor Cloud Agents | "Run agents in the cloud" with team/env features | Open + your servers, self-serve. HN sentiment runs against them: "I can't imagine the world standardizing on a closed source system for this infra." |
| **Cloud multiplayer** | **Superconductor / Super — SAME company** (Volition Inc., $7M, ex-Gradescope founders; superconductor.com = cloud GA, super.engineering = local Mac alpha, mid-rename — first-party confirmed) | Team workspace: cloud agents (their infra) + a no-backend local Mac app | An open backend on either surface; no sync on either. *(Corrects the 2026-07-11 version of this doc, which listed Super and Superconductor as two competitors.)* |
| **Open self-host cluster** *(new — the composite contesters)* | **Matrix OS** ("the open-source cloud computer for agents" — your VPS, any-harness, laptop/phone/terminal as shells), **codeg** (Apache, one-command deploy incl. `docker compose up -d`, 14 harnesses, hybrid session aggregation, ~2.2K★), **AgentsMesh** (~2.3K★, self-host backend + runner daemons fanning "AgentPods" across your fleet), **tlbx/MidTerm** (local-execution-only but no-inbound-ports reach via tunnels), **agent-vm** (shares SSH keys/git/GH auth/Claude skills/MCP across agent VMs), clay, Netclode | Pieces of Claxedo's exact composite, open | The **full four-pillar composite as one polished MIT product**. Each holds 2–3 pillars. This cluster is why the window is shortening. |
| **Meta/infra layer** | Omnigent (Databricks OSS, Apache), Coder (AGPL, enterprise), Northflank, e2b, Happy, Omnara, Microsoft Conductor (naming collision with Conductor.build), claude-flow (65K★ swarm framework — distorts "top tool" lists) | Governance / CDE infra / sandboxes / session mirroring / swarm frameworks | The desktop-first, individual-dev workspace experience; deploy-tied extension-sync. |
| **Authoring frameworks (vs the Claxedo framework, not the app)** *(new)* | **Flue** (Apache, 7.4K★ in ~2.5 months, Astro's Fred Schott, Cloudflare-backed flagship — "The Open Agent Framework"), **Eve (Vercel)** (Apache, ~3.9K★ — "The framework for building agents", compiles to Vercel's cloud), VibeKit | Write NEW agents from scratch; durable execution | Running *existing* coding-agent CLIs as themselves; extension-sync; session workspaces. Flue is the narrative threat ("the open, deploy-anywhere one" halo with more famous backers); differentiate as "framework for the workspace/stack layer, not another agent-authoring SDK" — which is already the /framework page's line. |

### 3.2 Claim-ownership ledger (who owns which sentence, verbatim)

Do not print these sentences as Claxedo's; each is an incumbent's live homepage copy (fetched 2026-07-10):

- **"The open-source control plane for coding agents."** — T3 Code's literal H1. (Their own docs renounce the architecture: "Avoid introducing a local control plane unless product pressure proves it is necessary"; syncing auth across machines is a stated non-goal.)
- **"Run any coding agent from your phone, desktop, or terminal. Self-hosted, multi-provider, open source."** — Paseo's subhead.
- **"All the models, All the agents… powered by ACP."** — Devin Desktop. **"Any Agent, Any Tool."** — Zed. **"From the terminal to the cloud, with any agent" + "SELF-HOST OR WARP-HOST."** — Warp. **"One portal for every agent" / "Fork, modify, self-host."** — Kilo.
- **"Any model, your infrastructure" / "No vendor lock-in."** — Cline. **"no lock-in"** also on Emdash's hero.
- **"Deploy on your infrastructure or ours."** — n8n. **"Self-hosting with superpowers."** — Coolify.
- **"A first-class agent experience on your infrastructure" / "Self-hosted AI development infrastructure… any model or agent."** — Coder (plus: "Coder Agents is not a wrapper around tools like Claude Code or Codex" — they deliberately rejected cross-harness).
- **"Agent Control Plane."** — OpenHands Enterprise (and GitHub Enterprise); Forrester runs a formal enterprise category by this name.
- **"The open source AI coding agent."** — upstream opencode. Claxedo must never position at this altitude.
- **"Continue local sessions from any device."** — Anthropic Remote Control (Claude-Code-only, subscription-gated, dies when the laptop closes). **"Claude Code Anywhere."** — Happy. **"command center"** — Omnara/Supacode.
- **"The command center for coding agents."** — Supacode. **"Manage all of your coding agents without friction."** — Super. **"Run parallel coding agents on your Mac."** — Conductor. **"The Code Editor for AI Agents."** — Superset. **"Ship 100x With The Agent IDE" (ADE)** — Orca. **"The multiplayer workspace for your team and AI coding agents."** — Superconductor. **"a meta-harness for building and running AI agents."** — Omnigent.
- *(Added 2026-07-20)* **"One terminal. The whole herd." / "No web view, no account, no hosted control plane."** — Herdr. **"The Agent That Grows With You."** — Hermes Agent. **"the open-source cloud computer" for agents** — Matrix OS. **"One config, all tools."** — vsync (and a 6+-tool config-sync micro-category). **"Deploy your own persistent agent instance."** — Agent 37 Cloud (431 PH upvotes — the tagline's neighborhood is occupied; the differentiator is the three words they can't say together: *open · yours · every layer*). **"The Open Agent Framework."** — Flue. **"The framework for building agents."** — Eve/Vercel. **"Official Harness for GLM-5.2."** — Z Code. **"The orchestration layer for parallel AI coding agents."** — Composio.

### 3.3 Per-competitor threat notes (condensed)

**HIGH threat:**
- **Paseo** — closest single overlap (any-agent + phone/desktop/terminal + "self-hosted" + open source, native mobile apps, 10.2K★, solo dev, free forever). No backend at all (daemon on your box; hosted relay is Paseo-operated Cloudflare, self-hosting it not first-class), **no extension-sync**, AGPL. Wedge: deployable backend + sync + MIT.
- **Omnigent (Databricks)** — closest *architectural* twin: Apache-2.0 self-deployable server (Docker/Railway/Render/Fly configs shipped), laptop relay via outbound WS, orchestrator, wraps Claude Code/Codex/Pi/OpenCode. Gaps: **no extension-sync** (cloud credential flow undocumented), no real desktop app (macOS web-wrapper; tmux+Python alpha), no ACP. It wraps "Pi" as a harness — naming collision with Claxedo's pi orchestrator.
- **T3 Code** — owns the phrase (above) + Theo's distribution (13.5K★ in 5 months). Architecture doesn't match the phrase; remote access shipped; sync explicitly renounced. Expect "why not T3 with opencode?"
- **Orca** — 15.8K★, daily releases, MIT, coining "ADE"; owns terminal-fidelity + parallel worktrees. No cloud execution, mobile dies when desktop closes ("there is no cloud relay"), no sync.
- **Conductor** — best-funded local incumbent; owns "parallel agents" polish; closed, account-gated, Mac-only. Twice-stated roadmap: "available everywhere from your phone to your VPC" — ship the open version of that promise before they do.
- **OpenHands** — the head-to-head at category level: "Open source, model-agnostic, and deployable in your environment" at ~75K★. But it runs *its own agent* (not a harness-neutral workspace) and self-hosting at scale is an enterprise K8s sale. A comparison page is mandatory.

**MEDIUM:**
- **Superset** (ELv2 despite "open source" label; relay is theirs, Pro-gated, desktop-to-desktop; no cloud VMs) · **Superconductor** (opposite bet — cloud-only, "running agents locally is a dead end" is a quotable foil; owns team/multiplayer lane Claxedo doesn't claim) · **Supacode/Super** (native-terminal wedge, attack Electron by name — don't fight on native speed; Supacode says "open source" but ships FSL) · **Coder** (owns enterprise self-host words; wrong buyer — don't fight for governance vocabulary) · **Amp** ("Start agents in your terminal and continue from anywhere" — owns that phrase among labs).

**LOW / context:**
- **Jean** (coolLabs halo; purest "free/local, no backend to trust" — don't fight on purity; watch: Coolify's institutional competence could bolt a control plane on fast) · **Emdash** (vocabulary hazard: their homepage says "sync MCP servers to supported agents" — single-machine fan-out; word sync claims carefully) · **Happy** (owns open-source E2E phone relay for Claude Code; sets the E2E security bar for any relay claim) · **Kiro/Jules** (single-vendor clouds) · **Crush** (terminal-culture darling, FSL, no platform).

**Dead/absorbed (usable as narrative, §4.6):** Roo Code (dead 2026-05-15), Continue (acquired by Cursor), Windsurf (renamed away by Cognition), Terragon (dead 2026-02-09), vibe-kanban (sunset — 27.4K★ at shutdown), Ona/Gitpod (**correction 2026-07-20:** OpenAI acquisition *announced* 2026-06-11 but **not closed** — Ona still sells independently, $20/mo self-serve + enterprise VPC runners; treat as "signed, pending regulatory close"), Daytona (closed-source 2026-06-11), Morph (acquired by Mercor).

**New teardown verdicts (2026-07-20), condensed:**
- **Hermes Agent (Nous)** — HIGH for the doc, new cohort (see table). Real overlap: BYO-infra self-host + MIT + Skills Hub (cross-product skill portability). Real difference: it's ONE agent, not a harness-neutral workspace; no cross-machine setup sync. The mindshare giant every open-source comparison will reach for.
- **Matrix OS** — highest-priority watch. Same thesis in nearly the same words ("agents run on a VPS… laptop, phone, browser, and terminal as shells into the same workspace"). Out-execute on one-command deploy + sync + MIT-every-layer; comparison page likely needed.
- **Herdr** — HIGH mindshare / LOW moat overlap. 18.7K★ in ~115 days, #1 Trending, HN front page; solo dev, AGPL+commercial dual license. Its no-backend rhetoric is the exact counter-position to answer (with what the backend buys: sync, placement, phone, team).
- **Zencoder** — MEDIUM. "Universal CLI Platform" runs Zen CLI/Claude Code/Codex interchangeably (any-harness at enterprise polish) + "Private Deployments" on-your-infra tier; closed, murky funding, near-zero grassroots presence.
- **Vorflux** — $15M seed (YC-led, Parker Conrad/Immad/Balaji angels) days out of stealth, ~zero usage proof; cloud-only "AI coding agent for teams," no self-host anywhere. Philosophical mirror image — foil, not threat.
- **Ara (YC S26)** — cloud-only autonomous engineer for GitHub, Ara-provisioned sandboxes, closed core; opposite side of every Claxedo axis. Cohort example, not a head-to-head.
- **Zodex** — solo closed macOS app + LAN mobile client; zero axis overlap. Footnote only.
- **Z Code (Z.ai)** — closed harness for GLM-5.2 on Z.ai's cloud (BYOK swaps the model only). Best use: the **"open weights ≠ open harness"** receipt — a lab praised for open models still locks the harness and routes through its cloud.
- **Flue / Eve** — see Authoring-frameworks cohort row. Flue = HIGH narrative risk vs the framework story (famous founder + Cloudflare productization + "zero lock-in, deploy anywhere" language); Eve = category-confusion risk only (Vercel-cloud-default authoring framework; zero overlap with running existing CLIs). Note: Flue's harness is adapted from **Pi** — the pi-name collision (Omnigent wraps "Pi", Flue derives from it, Claxedo's orchestrator is "pi") is now a real disambiguation hazard.
- **Super/Superconductor** — corrected above (one company, two domains, mid-rename; local surface has no backend, cloud surface is their infra; no sync on either).

---

## 4. Findings that shaped the positioning

### 4.1 Claims that are FALSE as stated (never print)

- **"No one open-sources the backend / no one does this."** Falsified ≥3×: OpenHands (MIT core, "deployable in your environment"), Coder (AGPL, self-hosted, "any model or agent"), Happy (MIT self-host relay, 3-min Docker), Omnigent (Apache server + deploy configs). The *compound* is unclaimed (§4.4); the fragment is not.
- **"Everyone wants you on their backend."** Falsified by the same names. The true, dated version: **"the model labs want your agents on their cloud"** (Ona→OpenAI; "Claude Code on the web runs on Anthropic-managed cloud infrastructure").
- **"The only / first / no one else."** Every superlative audited died on contact.

### 4.2 Polluted / banned vocabulary

- **"AI infra" / "your AI infrastructure"** — reads as GPUs/inference ($142.8B compute framing; NVIDIA/Deloitte define it that way). "Agent infrastructure" reads as e2b/Daytona sandboxes. Use "agent stack" / "agent backend."
- **"Self-hosted" is semantically diluted** — Cursor ("Run cloud agents in your own infrastructure" while "Cursor handles orchestration"), Warp (enterprise execution-only), even Anthropic ("self-hosted sandboxes") use it for execution-in-your-VPC with a closed control plane. If used, immediately sharpen: *the stack is yours, not just execution*. Naming this trick is itself good copy.
- **"Agent control plane"** — captured by enterprise governance (Forrester category, IBM definition, Palo Alto/Portkey). CISO vocabulary; fine internally, wrong on a dev homepage.
- **"One click"** → HN tests literalism; the artifact is one *command* (`claxedo deploy`). The founder kept "one click" for the hero with the command shown beside it — the gap closes only when a web deploy flow exists (§6).
- Also owned/avoid: "no lock-in" (Cline/Emdash), "command center" (Omnara/Supacode), "background agents" (Cursor's product name — good as a *contrast* hook: "on your infra, not Cursor's cloud"), bare "Harness" (Harness.io collision — always "agent harness", always with agent names beside it), "ACP" unexpanded (3-way acronym collision — expand as "ACP (Agent Client Protocol)").
- **Safe/green:** "agent harness" is fully mainstream (Anthropic's glossary: "Claude Code is the harness; Claude is the model inside it"; OpenAI blogs "harness engineering"; benchmarks score "model-plus-harness pairs"). **"Agent workspace"** is the best available category noun (young, accurate, unowned).

### 4.3 Commodity claims (proof rows, never headlines)

- **Any-harness / any-agent** — claimed verbatim by Devin Desktop, Zed, Warp, Kilo, plus the entire local cohort. ACP: 50+ agents, 12 clients; table stakes.
- **Remote/mobile access to local sessions** — Anthropic ships it first-party (Remote Control), Happy/Omnara/Paseo/T3 ship it open/indie. Claxedo's version is only interesting as: *any* harness, through *your* relay, no subscription gate, laptop optional.
- **Parallel worktree agents** — Conductor/Orca/Superset home turf. Concede rhetorically.
- **Terminal fidelity ("runs as itself")** — Supacode/Super/Orca/Emdash/Jean/Paseo all own it; ACP support is the only unclaimed sliver.

### 4.4 What is genuinely unclaimed (the composite Claxedo owns)

> **Revision (2026-07-20), after the community pass — the composite held, but two pillars narrowed and the window shortened:**
> 1. **Hybrid placement is no longer unclaimed at the lab level.** Codex Handoff ("hand off threads between local and remote hosts"), Claude Code `--teleport` + Remote Control, Cursor Cloud Agents, and open-sourced Devin `/handoff` all ship laptop↔cloud session movement natively. What remains unclaimed: **Split** (loop on the control plane, tools in a sandbox VM) — no product found claims it — and placement *through an open backend you own*.
> 2. **The per-machine half of extension-sync is now a commodity micro-category** (dot-agents "One config. Every AI agent.", agentsync, vsync "One config, all tools", agent-rules-sync + 3 more; agent-vm even shares SSH keys/git/GH auth/Claude skills/MCP across agent VMs). The defensible claim is strictly the **deploy-tied** half: *setup fans out through your own backend to every machine AND every cloud workspace, credentials and MCP included, the moment a workspace comes up.* Never pitch the "every harness on one machine" half as differentiation.
> 3. **The composite is being assembled in the open** — codeg, AgentsMesh, MidTerm, Matrix OS, Netclode each hold 2–3 of the 4 pillars (see cohort table). Nobody ships all four as one polished MIT product yet. Demand-side validation is explicit: on boxes.dev's HN thread, peterldowns asks for exactly extension-sync ("define the template so a new team member logs in and all the repos and tools are already there… no way to standardize environments for my team") and the founders admit it's unbuilt; HN's "open source will win this infra" sentiment (Eridrus) favors MIT-at-every-layer over the closed YC cloud cluster.

No product found combines: **(a)** an open-source (MIT) backend for coding-agent workspaces that **(b)** deploys self-serve with one command (not an enterprise K8s sale), **(c)** *extension-sync*: skills/credentials/MCP configs written once and fanned out to every workspace — local machines AND cloud VMs, every harness, and **(d)** web/phone reach into local sessions through that same self-hostable plane. Each fragment has an owner; the compound has none. **State it as the compound.**

- **Extension-sync is the single most ownable claim.** Demand receipts: anthropics/claude-code issue #57678 ("Add cloud sync for skills, settings, and memory across machines"), OpenAI forum config-sync threads, a dotfiles-hack ecosystem, and the verbatim dev pain: "Claude wants .claude/, Cursor wants .cursor/, Codex wants .codex/… update it in 3+ places. Usually I'd forget one." Confirmed absent in all ~30 products (nearest: Emdash single-machine fan-out; Superconductor cloud-only shared config; Docker MCP Gateway single-host). **Wording hazard:** must say "every machine AND every cloud workspace, credentials included" or it reads as parity. **Security pre-answer required:** "where do my keys live?" → through a backend you can run yourself ("if your keys cross a wire, it can be your wire") — else the top comment is "you sync my API keys through your server?"
- **Hybrid placement is the structural gap.** The local cohort has no cloud execution; the cloud cohort rejects local ("running agents locally is a dead end" — Superconductor); Anthropic split the world into cloud-sandbox-without-your-environment vs your-environment-but-laptop-stays-on. Verbatim demand for the missing quadrant: "Having Claude Code on the web, without access to a custom environment with the right tools, just doesn't make sense to me"; "control claude code on the go… without having my computer always running" (web version "lacks mcps, skills"). **Correction that matters (founder, 2026-07-11): "hosted" and "central" are not different modes.** The placement taxonomy is **Local / Cloud / Split**: cloud = loop *and* tools in the sandbox VM; split = loop on the central server, tools in the sandbox VM (brain central, hands next to the code). Don't present a "central, no workspace" third transport.
- **The "why not just opencode?" answer is checkable, not rhetorical:** upstream's `opencode serve` is a single-instance headless HTTP server with env-var basic auth — no multi-user state, no credential sync, no relay. Claxedo positions one level up from its own upstream or it reads as a redundant fork.

### 4.5 Demand ranking (inverts founder instinct — order sections by this)

1. Parallel/background agents + a review/steering story (never promise unattended autonomy — "none of these tools solves QA/review" is the standing skeptic reply)
2. Remote control of local sessions
3. Config/skills/MCP sync
4. Self-host / compliance ("on-prem or it will never get approved" — the team-sale wedge)
5. Any-agent/ACP (table stakes)
6. SDK/packages (zero homepage-level demand; docs-page material)

### 4.6 The 2026 consolidation narrative (dated, documented — the story gift)

Roo Code dead (May 15, pivoted to $899/mo Roomote) · Continue absorbed by Cursor · Windsurf renamed away by Cognition · Terragon dead (Feb 9 — parting gift: open-sourced so users could self-host, i.e., the thesis played out) · vibe-kanban sunset at 27.4K★ · **Ona/Gitpod: OpenAI acquisition announced (Jun 11, not yet closed)** · **Daytona went closed-source (Jun 11)** · Morph acquired by Mercor (Feb). Framing: "every neutral agent backend died, sold to a lab, or closed its source." Best single line that survived judging: **"An acquisition can't relicense code you already run — that's how MIT works, and it's the point."** It also pre-empts "what if *Claxedo* gets acquired?"

*(Added 2026-07-20 — two fresh receipts for "your servers":)* **Grok Build's confirmed full-repo upload** — xAI's own @grok account confirmed the CLI "uploads your entire repo as a git bundle (full history + all tracked files) to xAI backend/Google Cloud Storage — even files the agent never reads in that session." Hard, dated proof that cloud-hosted majors exfiltrate code; the sharpest single contrast available for MIT-backend-on-your-infra. And **closed-vendor resentment stays hot**: "Antigravity's rate limits are a slap in the face to Ultra/Advanced subscribers" (r/Bard, ~118↑, aggregator-sourced). **Messaging landmine (Jan 9, 2026):** Anthropic blocked third-party tools from using Claude *subscription* OAuth tokens (broke opencode users routing Claude Max). Never imply "bring your Claude Max subscription through our stack" — say API keys / your provider account.

### 4.7 License receipts (factual contrast, no editorializing)

Several rivals say "open source" while shipping source-available: **Supacode** (FSL-1.1), **Superset** (ELv2 — their own compare page concedes it), **Crush** (FSL). **Paseo** is AGPL (copyleft — matters to teams embedding). **Conductor, Super, Devin, Warp's backend, Superconductor**: closed. Claxedo's line: **"Actually MIT — app, backend, relay, and the packages."** Supporting: "Published, not promised — no 'open-sourcing soon,' no source-available asterisk, no conversion date."

### 4.8 Fork positioning (Claxedo is a hard fork of opencode)

- Forking itself carries no stigma (ICSE 2020, 15,306 hard forks; this niche's upstreams publicly bless forks — Cline on Roo: "contributed to our community more than any other fork"). **Concealment is what burns**: PearAI (hid Continue lineage, relicensed → 704★ despite YC money), Ollama (refused one line of llama.cpp credit → years of recurring HN hostility), and — in this exact lineage — Charm was accused of rewriting opencode's git history; the community rallied 7:1 to the other side.
- **The measured winner is Kilo's radical-disclosure playbook** (26K★): README opens with the lineage, "superset" framing, still says "fork of OpenCode" today. Disclosure is marketing, not confession.
- Claxedo's single-commit history reset is the top trust liability: **publish the pre-fork history archive + fork-point SHA before launch** (OpenTofu beat HashiCorp's C&D only because git history proved provenance; a reset fork forfeits that defense unless the prehistory is public).
- "Own project" perception requires architecture-level divergence (Kilo took ~12 months); lead with what upstream structurally lacks (backend, sync, placement), credit the engine plainly.

### 4.9 Adjacent strategic findings (context for the positioning)

- **Launch mechanics:** HN→GitHub-Trending flywheel converts at ~10–25 stars/HN-point, peak star-day 2–5 days *after* the post; ~100–300 stars in one day ≈ daily Trending. Winners in this category launched with no audience (Cline: no spike, Reddit compounding; Cursor's own HN posts flopped; OpenHands = news-jacking academics). Reddit (r/ClaudeAI, r/LocalLLaMA, r/ChatGPTCoding) is the best zero-network channel; coordinated X/PH launches are the weakest game and were deprioritized.
- **Contributors:** ~0.5% of stars become lifetime contributors; extension/plugin registries convert 50–100× better than core repos (Zed extensions: 72% contributors-per-star); first-response <24h roughly doubles long-term-contributor odds.
- **Sponsorship reality:** donations ≈ $0 in this category (no AI coding agent is donation-funded; peers took VC). Year-one money is programs: Anthropic Claude for OSS ($1,200/maintainer), OpenAI Codex OSS Fund (≤$25K credits), GitHub Accelerator ($40K when it runs), FLOSS/fund. Realized corporate-logo revenue runs ~25% of posted rate cards.

### 4.10 Community mindshare — what devs actually name in "what do you use" threads (added 2026-07-20)

Across X, Reddit (aggregator-sourced), HN (16 threads, comments read), awesome-lists and PH:

- **The harness layer is settled; the fight moved up to Claxedo's layer.** Tier 0 everywhere: **Claude Code dominant** (126 mentions across the 16 HN threads; "the best coding agent… and it's not close", ~270↑ r/ClaudeAI) with **Codex the clear #2 and rising** ("with the right skills, honestly better than Claude Code", ~468↑ r/codex) — and the modal serious dev runs **both** ("I stopped arguing about Claude Code vs Codex. Now I use both"). Cursor is the baseline being defected from ("Almost every YC founder I've talked to switched from Cursor to Claude Code", 4.6K+ engagement). **opencode is HN's beloved open alternative** (19 mentions/7 threads; "Opencode TUI experience is so much better", ~81↑) — good news for a credited fork.
- **The central HN thesis is existential and must be answered on-page:** *"everything collapses back to Claude Code."* Native Agent Teams orchestrate for free; Cowork + Claude Code Web eat the wrapper layer; devs describe abandoning tools and returning to CC-in-tmux ("Downloaded all sorts of tools… nothing else stuck"; "claude-code now spins up many agents on its own... do we still need to outwit [it]?"). Claxedo's only durable answer is the one Anthropic structurally can't copy: cross-vendor + open backend + your servers.
- **The worktree-orchestrator category is self-aware commodity:** "GitButler, Spectator, Vibe-Kanban, Conductor in the past week… we'll consolidate on 2-3"; "the new TODO [app], just build your own." Star anchors: claude-flow 65.2K, vibe-kanban 27.4K (dead), cmux 24.4K, gastown 17.1K, Superset 12.5K, Composio 8.4K. Never position here; also don't sound like **orchestration-maximalism** (gastown is the hype foil HN sours on).
- **"OSS will win this infra" is strongly held** ("I can't imagine the world standardizing on a closed source system for this infra… someone is going to solve this in open source" — Eridrus) — direct tailwind for MIT-every-layer against the closed YC cloud cluster.
- **Channel note for launch:** the real competitors live on GitHub/HN; Product Hunt's AI-coding lane is hosted vibe-coding majors and hosted agent-infra (AgentX 560↑, Skybridge 549↑, Agent 37 Cloud 431↑) — confirms PH's demotion in the launch plan.

### 4.11 HN objection playbook (verbatim objections → answers)

| Objection (real quotes) | Defusal |
|---|---|
| "I've been using Tailscale ssh to a raspberry pi… I can do all the same stuff on my own." | Concede the base case ("for one agent on one machine — honestly, maybe"). The beating demo is fan-out: deploy → fresh VM → skills/creds/MCP already present → open from phone. tmux can't do that. |
| "No way I'm sending my code to your central servers." | Show the deploy command, not a promise. The backend that syncs is MIT and yours to run. |
| "What's your moat against Anthropic just launching the same thing a week from now?" | They did (Remote Control) — Claude-Code-only, subscription-gated, dies when the laptop closes. Anthropic will never host Codex; OpenAI will never host Claude Code. Cross-vendor neutrality + open backend is the only durable answer. |
| "My problem is QAing and reviewing the code all these agents write, and none of these tools solves that." | Acknowledge steering/approval (diffs, permission prompts from the phone); never promise unattended autonomy. |
| "So it's an opencode fork?" | Yes — credited, proudly (Kilo pattern), and the delta is checkable: `opencode serve` = single-instance server w/ basic auth; Claxedo adds the multi-workspace backend, sync, relay. |

---

## 5. Language guide

| Use | Avoid |
|---|---|
| agent stack · agent backend · agent workspace | AI infra / AI infrastructure · agent infrastructure |
| "one command" (`claxedo deploy`) — "one click" only where a click exists | "one click" as a literal claim without a clickable flow |
| "agent harness" (with agent names beside it) | bare "Harness" (Harness.io) · unexpanded "ACP" |
| "MIT at every layer" / "actually MIT, including the backend" | "open source" unqualified (diluted by FSL/ELv2 claimants) |
| "the model labs want your agents on their cloud" | "everyone wants you on their backend" |
| "your setup follows you" · "written once, on every machine and every cloud workspace, credentials included" | "sync" unqualified (Emdash's single-machine usage) |
| "built on the OpenCode engine" (prominent) | any lineage hedging |
| Local / Cloud / Split (placement) | "Hosted vs Central" as separate transports |

---

## 6. Truth gates & open items (positioning-level only)

1. **"One click / one command deploy" must be real self-serve** before the promise ships: publish a real `claxedo` CLI usable outside the monorepo, auth on by default. (Fly.io-only is fine; the copy says "Fly.io today, more targets on the way.")
2. **"Published, not promised" requires republishing the npm packages from the post-fork tree** — all 8 publishes predate the 2026-07-09 fork.
3. **Publish the pre-fork history archive + fork-point SHA** (the lineage claim references it).
4. **Comparison pages are mandatory day-one:** OpenHands, Paseo, T3 Code, Omnigent — *and (added 2026-07-20)* **Hermes Agent** ("agent vs stack" framing) and **Matrix OS** (nearest whole-composite rival). Each has a factual, checkable answer — §3.3/§4.4.
5. `/compare` matrix is stale (2026-03-24) — refresh or remove; several rows (Roo, Continue, Windsurf) are dead/renamed; it also predates Hermes/Antigravity/Grok Build.
6. Watch list for fast-followers on the compound claim *(updated 2026-07-20)*: **Matrix OS** (#1 — same thesis, open), **codeg / AgentsMesh / MidTerm** (open self-host cluster, each 2–3 pillars), Omnigent (needs only sync + polish), Rivet, Conductor ("phone to your VPC" roadmap, $22M), coolLabs/Jean, **Composio** (8.4K★ orchestrator one deployable-backend release away).
7. *(Added 2026-07-20)* **Naming hazards:** "pi" now collides three ways (Claxedo's orchestrator · the Pi harness Omnigent wraps · Flue's harness lineage) — disambiguate on-page; "Conductor" collides (Conductor.build vs Microsoft Conductor). **Subscription-OAuth landmine:** never market routing Claude/ChatGPT *subscriptions* through the stack (Anthropic's Jan 9 block; §4.6).

---

*Compiled from the 2026-07-10/11 research runs (channel economics, contributor/sponsor/fork studies, 6-lane positioning research, 12-competitor teardown, copy judging) and the 2026-07-20 second pass (4-lane community-mindshare mining + 11 new teardowns: Ona, Ara, Super/Superconductor, Zodex, Vorflux, Hermes Agent, Herdr, Zencoder, Flue, Eve, Z Code). Underlying detail lives in the project memory notes; this doc is the standalone strategic summary.*
