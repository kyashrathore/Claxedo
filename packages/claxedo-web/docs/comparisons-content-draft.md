# Comparison content — draft (2026-07-22)

Source-of-truth for the rebuilt `/compare/*` pages. Tone: **punchy + matrix**, still sourced (every fact carries a first-party URL). Every page: one-line verdict → shared capability matrix → their genuine edge → where Claxedo differs → "choose X if / choose Claxedo if" → sources + review date.

**Drop the fabricated entries** currently in `competitors.ts`: Matrix OS, Omnigent, Hermes Agent (no real products by those names). Keep the real set below.

## Positioning (drop "connected workspace" — it's jargon)

"Connected workspace" buried the real category difference. **The lead is: personal tool vs team platform.**

> **Claxedo is a team platform you self-host — one open-source deployment your whole team signs into.** Everyone else here is a *single-operator personal tool* each developer runs alone (or gates the team part behind a closed, paid cloud). Bring your own harness, provider, and sandbox.

**Why this is THE wedge:** Paseo has **no auth and no accounts at all** — it's a personal daemon that reaches *your own* machine; a team means everyone runs their own copy. Synara, Conductor, and T3 Code are personal desktop apps (per-developer). Superset only gets multi-user through its **paid, hosted, ELv2** remote tier. Claxedo is designed as an **accounts-backed, org-scoped platform a small startup hosts once for the whole team** — and it's open source, so you host it yourself.

### Honest status of the team/auth claim (word the pages to THIS — verified 2026-07-22)
Near-term self-host ships as **two profiles** (owner scope, 2026-07-22): **single-node** (SQLite, zero-config) or **Clerk + Convex on your own Cloudflare** (the same stack Claxedo runs hosted, self-hosted by the team).
- **Teams work today on the Clerk + Convex profile** — accounts, orgs, roles (Clerk→Convex org mirror). This runs hosted *and* self-hosted on your Cloudflare.
- **Single-node SQLite self-host works but is single-user today** — verified: both embedded Better Auth *and* Clerk-on-SQLite mint only *personal* orgs; shared teams need the Convex path (or the not-yet-built embedded org layer).
- **Publishable claim:** *"Self-host Claxedo for your team — a single node, or the same Clerk + Convex stack on your own Cloudflare. One deployment, real accounts, your infra."* Do **not** imply turnkey *team* self-host on plain SQLite yet. The safe, true wedge vs the field is **"a multi-user platform you self-host,"** which is real via the Convex profile — every competitor here is single-operator or gates teams behind a closed/paid cloud.

### Secondary spine (supporting the team-platform lead)
- **Swappable auth + datastore adapters (verified in code).** Auth is one port with two adapters — **Clerk** (hosted) and **embedded Better Auth** (self-host, SQLite, no Clerk/Convex) — both producing the same signed `ControlPlaneAuthContext`; DB is the same (Convex hosted ↔ SQLite self-host) behind the WorkspaceAuthority port. **You're not locked to any vendor's identity or database — run the managed stack, the fully-local stack, or bring your own.** None of the six competitors offer this (they're either a local app with no backend, or a fixed SaaS). Strong, honest, and unique.
- **Open source + self-host** the whole platform (client, control plane, relay, runtime, `@claxedo/*`). NOTE: don't frame "we use Cloudflare" as unique — **Paseo's relay is also a CF Worker + Durable Object**. The wedge vs Paseo is **team/accounts + permissive license + WorkGraph**, not Cloudflare.
- **Permissive OSS** vs Conductor (closed), Superset (ELv2), Paseo (AGPL copyleft).
- **WorkGraph** durable coordination — nobody else has it.
- **Harness-neutral + BYO** provider/sandbox; doesn't resell tokens/compute.

CF precision (still true, keep for the self-host story): on Cloudflare you deploy the **control plane** (pure-coordination Worker — `packages/claxedo-server/src/deployments/hosted-workerd/worker.ts`); **execution** runs where you place it (your machine / Fly / sandboxes). Always-on all-in-one = `claxedo deploy` → Fly today.

## Claxedo's constant column (the spine)

- **Openness:** the **entire platform** is open source — client, control plane, relay, runtime, `@claxedo/*` framework. Not just a client app.
- **Self-host:** deploy the control plane to **your own Cloudflare** account (agent-guided, minutes) or an always-on server via `claxedo deploy` (Fly today). Your account, your data.
- **Harnesses:** Claude Code, Codex, Gemini CLI, OpenCode, + any CLI via ACP.
- **Economics:** BYO provider + BYO sandbox — Claxedo does **not** resell model tokens or sandbox minutes. Free during beta.
- **Where work runs:** local ↔ your own machine ↔ your sandbox provider — you choose placement.
- **Remote access:** relay (daemon dials out, no open inbound port) → reach the same session from any device.
- **Durable coordination:** **WorkGraph** — durable Streams/Tasks/Attempts with approval gates and evidence. No competitor below has an equivalent.
- **Interfaces:** full chat UI **and** first-class terminal; parallel agents via sessions + worktrees; extension sync (skills/MCP/plugins).
- **Platforms:** desktop (Mac/Win/Linux) + web + mobile **web** (no native mobile app yet — concede to Paseo).

**The wedge, in one line per rival:** you can *own and self-host the entire open-source platform on your own Cloudflare* — something none of the closed (Conductor), source-available (Superset ELv2), or local-app-only (Synara, T3 Code) competitors offer. Paseo is the one honest peer on self-host (AGPL daemon) — differentiate there on permissive license + CF control plane + WorkGraph.

## Master matrix (rows = competitor)

| Product | What it is | **Team / multi-user** | License | Self-host platform | Harnesses | Durable ledger |
|---|---|---|---|---|---|---|
| **Claxedo** | Team platform you self-host | **Accounts + org scoping** (hosted today; self-host auth landing) | **Open source** | **Yes — your Cloudflare / server** | Claude Code, Codex, Gemini, OpenCode, +ACP | **WorkGraph** |
| **Paseo** | Personal remote-access daemon | **None — no auth, no accounts** | AGPL-3.0 | Yes — daemon on your box | 39 via CLI + ACP | No |
| **Synara** | Personal local GUI | **None — per-developer app** | MIT | No — local app only | Claude Code, Codex, OpenCode, Cursor +5 | No |
| **Conductor** | Personal Mac app | None — per-developer app | **Closed** | **No — proprietary app** | Claude Code, Codex, Cursor | No |
| **Superset** | Mac "100+ agents" editor | **Only via paid hosted remote** | ELv2 (source-avail) | Partial — remote hosted-only, paid | 11+ agents | No |
| **T3 Code** | Personal local GUI | None — per-developer app | MIT | No — local app | Codex, Claude, Cursor, OpenCode | No |
| **OpenCode** | The open terminal engine | None — local; `/share` = read-only link | MIT | Partial — server, local-only | *is* the agent (75+ providers) | No |

**The pattern (this is the whole pitch):** you can **own and self-host the entire open-source platform** — Conductor is closed, Superset is ELv2 with hosted-only remote, and Synara/T3 Code are local apps with no deployable backend at all. **Paseo is the one honest peer on self-host** (AGPL daemon). Add durable coordination (WorkGraph, which *nobody* has) and permissive licensing, and the wedge is clean.

## Backing & pricing (the "who are you betting on" column)

| Product | Backing | Pricing |
|---|---|---|
| **Claxedo** | Independent · open-source *(confirm owner funding line)* | Free during beta; BYO provider + sandbox (no token/compute resale); optional paid cloud later. **Self-host ⇒ no vendor lock-in.** |
| **Paseo** | Indie, **no VC** (solo "Mo"/`boudra`, GitHub Sponsors) | Free, OSS |
| **Synara** | Solo indie, **no VC** (Emanuele Di Pietro) | Free, MIT |
| **Conductor** | **$22M Series A** (Spark + Matrix), **YC S24** (Melty Labs) | Free Mac tier + paid Cloud (exact tiers unconfirmed) |
| **Superset** | **YC (Spring 2026)**, Superset Inc. | Free (1 user) / Pro **$15–20/user-mo** / Enterprise |
| **T3 Code** | Ping Labs (**YC W22**); *tool itself not monetized* | Free, MIT (sibling t3.chat is the paid product) |
| **OpenCode** | Anomaly (ex-SST), **~$1.1–1.6M seed** (YC/Greylock/SV Angel) | Free tool (MIT) + optional paid **Zen** model gateway |

**The buyer takeaway (the honest angle, not a cheap shot):** the well-funded tools carry a business-model you're betting on — **Conductor** ($22M, **closed source**) and **Superset** (YC, **ELv2 + paid hosted remote**) monetize by owning the layer you can't self-host; **OpenCode** monetizes via the optional Zen gateway. The indies (**Paseo, Synara**) are free but solo — a real sustainability/bus-factor question. Claxedo's answer to **both** risks is the same one sentence: *the whole platform is open source and you self-host it, so your workflow survives any vendor's runway, pivot, or price change.* Ownership, not funding purity, is the pitch.

**⚠ Confirm before publishing:** Claxedo's own funding/pricing line (memory: "launch free; eventual optional $9/mo·$89/yr per seat cloud; free→paid = config flip"). State Claxedo's backing honestly — the ownership argument holds regardless, so don't imply "indie purity" if that's not accurate.

---

## Per-competitor pages

### Claxedo vs Paseo — the closest rival (and the honest self-host peer)
- **Verdict:** Paseo is the most polished way to drive your *own machine's* agents from anywhere, with real native mobile apps — and it's genuinely, fully self-hostable. Claxedo differentiates on a permissive license, durable coordination, and a framework to build on, not on "open vs closed."
- **Paseo's self-host reality (be accurate — do NOT overclaim against it):** a single local **daemon** (`npm i -g @getpaseo/cli && paseo daemon start`, or one Docker command on port 6767); **no Paseo account or login exists**; code/chats/history stay under `~/.paseo`; agents use your own API creds. The only Paseo-operated component in the *default remote* path is a **zero-knowledge, E2E-encrypted relay** that is **optional** (use direct connection or your own Tailscale/CF tunnel) and **self-hostable**. **That relay is itself a Cloudflare Worker + Durable Object** — the same architecture as Claxedo's control plane. **⇒ "We deploy on Cloudflare, they don't" is FALSE against Paseo. Don't use it.**
- **Their genuine edge (concede clearly):** shipping native iOS + Android apps; 39-agent published catalog + ACP; serious documented E2E crypto; on-device voice; in-app browser + per-worktree preview URLs; genuinely no-vendor-lock-in self-host.
- **Where Claxedo actually differs vs Paseo:**
  1. **License** — Paseo is **AGPL-3.0** (network/viral copyleft: modify + serve over a network ⇒ must publish your modified source; companies avoid embedding it in products). Claxedo's permissive OSS is the real, defensible license wedge here.
  2. **WorkGraph** durable ledger (Streams/Tasks/Attempts, approval gates, evidence) — Paseo's only persistence is heartbeats + cron schedules; no durable task ledger.
  3. **Framework/SDK to build on** — Paseo is a product; Claxedo ships `@claxedo/*` + a self-hostable control plane you compose.
- **Choose Paseo if:** you want the best native mobile + broadest agent catalog to remote-drive your own machine, and AGPL is fine for you. **Choose Claxedo if:** you need a permissively-licensed platform, durable auditable coordination (WorkGraph), and a framework to embed.
- Sources: paseo.sh, github.com/getpaseo/paseo (README, SECURITY.md, packages/relay, issue #224), paseo.sh/docs/{security,configuration,cli}, keepmind9/paseo-relay, App Store listing.

### Claxedo vs Synara — the closest positioning twin
- **Verdict:** Synara nails the "one window for the AI subscriptions you already pay for," local-first and MIT. Claxedo takes the same wrap-your-harnesses idea and adds remote access, durable coordination, and a self-hostable framework.
- **Their genuine edge:** cleanest "use what you already pay for" pitch; **cross-provider thread hand-off with shared context** (a second model resumes the same thread); MIT; genuinely local-first (no cloud holds repos/history); mac/Win/Linux desktop already.
- **Where Claxedo differs:** remote/connected access + placements (Synara is desktop-only, no cloud plane); WorkGraph; framework + control plane. Maturity: Synara is early/solo ("expect bugs", ~1.3k stars) — state neutrally, don't punch down.
- **Choose Synara if:** you want a simple, free, local one-window GUI with cross-provider handoff. **Choose Claxedo if:** you also need remote access, durable coordination, and something to build on.
- Sources: trysynara.com, github.com/Emanuele-web04/synara, trysynara.com/install.

### Claxedo vs Conductor — the polished Mac incumbent
- **Verdict:** Conductor is the most polished fan-out-and-review experience on a Mac. Claxedo trades some of that native polish for harness-neutrality, cross-platform + remote reach, durable coordination, and open source.
- **Their genuine edge:** best-in-class parallel-agent UX (dispatcher, at-a-glance status, isolated worktrees) and review (diffs, inline comments synced to GitHub, merge); well-funded ($22M, YC S24); fast shipping; free on top of your subs.
- **Where Claxedo differs:** harness-neutral (adds Gemini CLI, OpenCode, any CLI via ACP — Conductor is Claude Code/Codex/Cursor only); cross-platform vs **Mac-only**; relay/connected access; WorkGraph; **open source + framework** vs closed proprietary app.
- **Choose Conductor if:** you're Mac-only and want the slickest fan-out+review for Claude Code/Codex/Cursor. **Choose Claxedo if:** you want harness-neutral, cross-platform, remote-capable, open, durable.
- Note: name-collision — conductor.build (Melty), NOT the SEO platform or the Gemini CLI extension.
- Sources: conductor.build, conductor.build/changelog, HN 44594584, YC S24.

### Claxedo vs Superset — the many-agents orchestrator
- **Verdict:** Superset is built to run *many* agents at once on a Mac, with the broadest agent list and an SDK. Claxedo is fully open, cross-platform, and remote-first with durable coordination — where Superset gates remote behind a paid beta and ships under a restrictive license.
- **Their genuine edge:** broadest harness list (11+ agents, agent-agnostic); 10–100+ parallel agents with clean worktree isolation; SDK + MCP server; editor handoff (VS Code/Cursor/JetBrains/Xcode); usable free local tier.
- **Where Claxedo differs:** **fully open source** vs **Elastic License 2.0** (source-available, not OSI-open); relay as a core free primitive vs Superset's "remote workspaces (Beta)" paid Pro bolt-on; WorkGraph; cross-platform vs effectively Mac-only (Win/Linux "untested").
- **Choose Superset if:** you're Mac-based and want to run an army of agents with a polished editor. **Choose Claxedo if:** you want fully-open, cross-platform, remote-first with durable coordination.
- Sources: superset.sh, superset.sh/pricing, superset.sh/compare/*, github.com/superset-sh/superset.

### Claxedo vs T3 Code — the minimal local GUI
- **Verdict:** T3 Code is a clean, minimal, MIT GUI over your agent CLIs with great one-click PR ergonomics — and very early. Claxedo is the broader, connected, durable workspace with remote access shipping today.
- **Their genuine edge:** clean responsive Electron/web UI; one-click commit/push/PR; native worktrees + per-turn diffs; MIT + BYOK (no added cost); Theo/T3 distribution.
- **Where Claxedo differs:** remote access shipped (T3 Code's headless/remote is *planned*); WorkGraph; framework + self-host control plane; Gemini CLI shipped (T3 Code Codex-first, Gemini planned). T3 Code is "very very early" and not accepting contributions yet — state neutrally.
- **Choose T3 Code if:** you want a minimal, free, local GUI over your CLIs. **Choose Claxedo if:** you want remote access, durable coordination, and a framework.
- Sources: github.com/pingdotgg/t3code, pingdotgg-t3code.mintlify.app, t3.codes.

### Claxedo vs OpenCode — engine vs workspace (framed as a vs, per owner)
- **Owner call:** treat as a standard vs — OpenCode is one of the harnesses Claxedo supports, and Claxedo's client app is fully forked. Keep it respectful (Claxedo builds on the OpenCode engine) but the decision framing is legitimate.
- **Verdict:** OpenCode is a superb open, provider-agnostic *terminal engine*. Claxedo is the connected *workspace* around that class of engine — and you can run OpenCode inside Claxedo as a harness.
- **Their genuine edge:** truly provider-agnostic (75+ providers, BYO key); clean client/server + OpenAPI + SDK; MIT and self-hostable; terminal-native with LSP/MCP; large community.
- **Where Claxedo differs (verified against OpenCode's own docs):** OpenCode server binds to `127.0.0.1:4096`, "primarily local machine access", no relay → Claxedo adds reach-from-any-device; OpenCode `/share` is a public read-only link with "no dedicated team-collaboration or review workflows" → Claxedo adds review surfaces; no durable cross-session ledger → WorkGraph; plus cross-device clients and extension sync.
- **Choose OpenCode if:** you want a pure open terminal agent. **Choose Claxedo if:** you want a connected workspace around it (and other harnesses) with remote access + durable coordination — OpenCode still runs inside it.
- Sources: opencode.ai, opencode.ai/docs/server, /docs/share, /docs/sdk, github.com/anomalyco/opencode (MIT).

---

## Shared capability-matrix rows (for the per-page 2-col table: Competitor vs Claxedo)
Category · Harnesses supported · Interfaces · Platforms · Remote access · Where work runs · Parallel agents · **Durable task ledger** · Extension sync · Review/PR · License · Self-host / framework · Economics.

## Open questions for owner
1. Keep **OpenHands** (real, was in old set) as a lighter "tracked" mention, or drop entirely? Not in the six.
2. Lead the index with the **master matrix** (all six at a glance) above the per-page cards? Recommended — it's the punchiest asset.
3. Licensing as an explicit column is a real Claxedo edge (Conductor closed, Superset ELv2, Paseo AGPL). Include a "License" row prominently? Recommended.
