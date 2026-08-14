# 13 — Harness roster parity (+ DeepSeek Harness evaluation)

## Scope
The multi-harness capability is a core product feature and must port intact:
harness selection, per-harness config/health, session transport per harness.
This sub-plan owns roster parity in the port AND evaluates the newest
candidate, DeepSeek Harness.

## Current roster & integration classes (canonical files)
- **Embedded**: opencode engine, in-process in the server child
  (`packages/opencode` artifact; `/provider` catalog path — HANDOFF §2).
- **ACP adapters**: `claude-agent-acp`, `codex-acp` — built by desktop
  prebuild (`packages/claxedo-desktop/scripts/prebuild.ts`, now minified),
  shipped under `Resources/acp/`.
- **Vendor CLIs on PATH**: `claude`, `codex`, `cursor-agent` (HANDOFF
  §12.6 credentials table).
- Selection/health: `features/session/harness/harness-config-runtime.ts`,
  the 20 s health peek (visibility-gated this session), readiness gates in
  the composer.

The port keeps ALL of this server-side (the server child owns harness
processes); the GPUI app only renders roster state — so roster parity is
mostly sub-plan 08 transport + 04 selectors. New harness integrations land
server-side and benefit both frontends under W2.

## DeepSeek Harness (dsh) — evaluated 2026-08-14 against the real artifact
Probed `@deepseek-ai/dsh@0.1.0-rc.6` (MIT, Node, `npx @deepseek-ai/dsh web`,
web UI on 127.0.0.1:3080; plugin architecture on the Cordis kernel — the
`--dump-default-config` web profile composes **129 plugins**).

Findings that decide the integration path:
- **No ACP**: zero ACP references anywhere in the composed profile — the
  existing ACP adapter path does not apply today.
- **HTTP surface exists**: `dsh-api-gateway`, `dsh-host-apiproxy`,
  `dsh-api-remotes` plugins — the web UI drives sessions over a local HTTP
  API; this is the drivable seam.
- **Session model is compatible in shape**: append-only JSONL session log
  (`dsh-session-persistence-jsonl`) + sqlite query projection
  (`dsh-session-query-sqlite`) with resume/fork (`providerName: spawn/fork`)
  — maps naturally onto Claxedo's session/transcript concepts.
- **Model config**: default `deepseek-official`/`deepseek-v4-flash`,
  `DEEPSEEK_API_KEY` env — the credentials story fits the existing
  per-harness credential class (HANDOFF §12.6 "agent harnesses" row).
- **Cautions**: 0.1.0-rc (developer preview — API stability risk); profile
  plugins install via pnpm under `$DSH_HOME` (heavyweight, network at first
  boot — do NOT embed; treat as external-CLI class); OTel telemetry
  exporter to `harness-telemetry.deepseeksvc.com` is composed into the
  default profile — the integration must surface/inherit Claxedo's
  telemetry consent posture.

## Integration options, ranked
1. **dsh ACP plugin** (preferred): "everything is a plugin" cuts both ways —
   write an ACP server plugin for dsh (the same contract claude-agent-acp
   implements), vendored beside the other adapters. Claxedo then gets dsh
   through the EXISTING ACP path with zero new client code, and the plugin
   is upstreamable.
2. **Native adapter over dsh-api-gateway**: drive its local HTTP API from a
   new connection driver in `packages/claxedo-connections`. More surface to
   own against an rc-unstable API.
3. **Wait for stabilization**: revisit at 0.2/1.0 if the rc API churns.

## Acceptance
dsh appears in the harness selector with health/readiness semantics
identical to other ACP harnesses; the multi-turn session metric (HANDOFF
§12.6, still unbuilt) runs against it; telemetry consent policy documented.
