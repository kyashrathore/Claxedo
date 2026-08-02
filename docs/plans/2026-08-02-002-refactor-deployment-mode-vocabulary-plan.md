# Deployment-mode vocabulary: two axes, not one enum

Date: 2026-08-02. Companion to `2026-08-02-001-refactor-claxedo-server-organization-plan.md`
(that plan's `deployments/local/` naming follows from this one). Every claim
marked **[verified]** was checked against the tree; re-cite `file:line` before
implementing.

## Goal

`"self-host"` is used as a code value to mean **unsigned loopback-only auth**.
That is not what self-hosting means. Self-hosting describes *who operates the
deployment*, not how its requests are authenticated — a user can self-host on a
public domain with signed auth, and the current vocabulary has no word for that.

The proof is in our own docs: `public-docs/self-host-fly.md` is a guide for
deploying to **Fly.io — a remote cloud machine** — and it states *"absent mode
means self-host by design; never set it to `hosted` on a self-host machine"*
**[verified, `:141`]**. The doc has to warn operators away from the word
"hosted" while describing a hosted remote deployment. The vocabulary cannot
express what it is documenting.

Likewise "hosted" says nothing useful about runtime: ours is **workerd-hosted**,
the Node container is **node-hosted**. Both are "hosted."

## The defect: two independent axes collapsed into one enum

| Axis | Real values | Governs |
|---|---|---|
| **Trust / tenancy** | unsigned-local ↔ signed multi-tenant | auth posture, fail-closed boot |
| **Runtime** | Node ↔ workerd | bundle constraints, Worker-safety |
| *(Operator — docs only)* | *Claxedo-operated ↔ self-hostable* | commercial/support, **not code** |

`DeploymentMode = "self-host" | "hosted"` **[verified,
`control-plane/deployment-mode.ts:36`]** smears trust and operator together and
omits runtime entirely.

### Target model

```ts
type Trust   = "local" | "hosted"     // unsigned-loopback ↔ signed multi-tenant
type Runtime = "node"  | "workerd"
```

| Deployment | Trust | Runtime | Expressible today? |
|---|---|---|---|
| Laptop / desktop | `local` | `node` | yes (as `self-host`) |
| Self-hosted on Fly, signed auth | `hosted` | `node` | **no — this is the gap** |
| Claxedo cloud | `hosted` | `workerd` | partially (`hosted`) |

**Runtime is not a new env var.** It is derivable at the composition root —
`worker.ts` → `workerd`, `main.ts`/`hosted-node.ts` → `node` — so this adds zero
operator surface. Only `Trust` stays on the wire.

**"self-hostable" is docs/marketing vocabulary only.** It must never again be a
code enum value.

## Scope boundary — what this plan does NOT touch

`"self-host"` appears in **4 packages as three unrelated concepts** **[verified]**:

| Location | Axis it encodes | Values |
|---|---|---|
| `claxedo-server/control-plane/deployment-mode.ts` | auth posture | `self-host \| hosted` |
| `claxedo-app/platform/telemetry/analytics.ts:11` | telemetry tag | `cloud \| self-host \| desktop-local` |
| `claxedo-app/features/onboarding/state.ts:5` | UI surface | `desktop \| web \| self-host` |

`claxedo-app/app/integrations/feature-ports.ts:78` computes
`deployment: sandboxEnabled ? "hosted" : "self-host"` — there "self-host" means
*"no sandbox"*, a fourth meaning again.

**This plan covers only the auth-posture axis** (claxedo-server + workspace-relay
+ the wire contract). The claxedo-app telemetry and onboarding renames are the
same word on different axes; folding them in produces one unreviewable commit.
Track them separately.

## Decision: hard rename (owner decision — do not re-litigate)

**No backward compatibility.** `"self-host"` becomes invalid immediately — no
deprecated alias, no migration window, no dual-accept period.
`deploymentMode()` already throws on unknown values **[verified, `:69`]**, so a
stale env var is a loud boot failure, not a silent fallback to the open posture.

Do not add an alias later "to be safe": an accepted-but-deprecated value is
exactly the silent-drift surface this plan exists to remove.

### The one real hazard this creates

The "hard rename fails loudly" premise holds for `deploymentMode()` — but **two
readers deliberately do not validate** and would silently keep emitting
`"self-host"` telemetry:

- `observability/config.ts:72` — its own comment: *"an unrecognized value is
  passed through verbatim rather than rejected (observability reports posture,
  it does not enforce it)"* **[verified]**
- `workspace-relay/src/main.ts:111` — same fallback pattern **[verified]**

Left out of the rename, these corrupt PostHog deployment-mode data instead of
failing — the silent-drift class this repo has been burned by before. **Both
must land in the same commit as the enum change**, plus a test asserting the
telemetry tag values are exactly the `Trust` union.

## Change inventory

**Wire contract**
- `CLAXEDO_DEPLOYMENT_MODE`: `"self-host"` → `"local"`; `"hosted"` unchanged.
  Absent still defaults to `local` (zero-config OSS boot preserved bit-for-bit).
- `wrangler.toml:105,189` — already `"hosted"`, no value change; update the
  adjacent comments **[verified]**.

**claxedo-server**
- `control-plane/deployment-mode.ts` — `DeploymentMode` → `Trust`; the
  `"self-host"` literals at `:36,:66,:70`; boot-error text at `:70`; the module
  doc-comment at `:9-12`. `assertHostedBootRequirements` /
  `hostedBootRequirementFailures` / `unsignedLocalRequestGuard` key off `Trust`
  only — no runtime coupling.
- New: `Runtime` derived at each composition root, not read from env.
- `observability/config.ts:41,66,72` — default tag → `"local"`.
- `central-session-runtime.ts:364` — `productDeploymentMode ?? "self-host"`.
- Comments referencing the old value: `hosted-app.ts:210,753`, `worker.ts:137`,
  `server.ts:922`.
- Tests: `deployment-mode.test.ts` (11 sites), `control-plane/auth.test.ts`
  (4 sites), `hosted-app.test.ts:1475,1480`, `observability.test.ts:168,264`,
  `routes/opencode-compat-git.test.ts:251`.

**workspace-relay**
- `src/main.ts:81,111` + doc-comment `:68`; `observability.test.ts:41,91`.

**claxedo-web**
- `test/deployment-prompt-drift.test.ts:338` asserts on the **literal source
  line** `'if (!raw || raw === "self-host") return "self-host"'` **[verified]** —
  a cross-package string-coupled test that breaks the moment the enum changes.
  Update in lockstep.
- `src/content/deployment.ts:25` — the deploy-prompt copy that the above test
  asserts against.

**public-docs (7 files [verified])**
`self-host-fly.md` (rename → `self-hosting-on-fly.md`; the guide describes a
*hosted-trust, node-runtime* deployment — reword accordingly),
`deploy-runbook.md`, `production-environment-runbook.md`,
`hosted-control-plane-worker.md`, `sandbox-egress.md`,
`see-it-all-in-action.md`, `README.md`.

Docs must draw the distinction explicitly: **"self-hosting" = you operate it**
(may be `local` or `hosted` trust); **`local`/`hosted` = auth posture**.

## Execution

**Step 1 — enum + non-validating readers, one commit.** `Trust` rename across
claxedo-server *and* the two pass-through telemetry readers *and* the
claxedo-web drift test. Splitting these is what produces silent telemetry drift.

**Step 2 — derive `Runtime` at composition roots.** `worker.ts` → `workerd`;
`main.ts`, `hosted-node.ts` → `node`. Thread into telemetry so
`node-hosted` and `workerd-hosted` become distinguishable in PostHog — the
capability that motivated the two-axis split.

**Step 3 — docs.** All 7 files + the `self-host-fly.md` rename.

**DoD**
- `CLAXEDO_DEPLOYMENT_MODE=self-host` throws at boot naming `local` as the
  replacement — verified by injecting it, not assumed.
- Telemetry tag values are exactly the `Trust` union; a test fails if
  `observability/config.ts` or `workspace-relay/main.ts` can emit a value outside
  it. **This is the assertion whose absence caused the hazard above.**
- `trust=hosted, runtime=node` is representable end-to-end and appears correctly
  in a captured telemetry event.
- Zero-config boot (env absent) is unchanged bit-for-bit → `local`.
- Full suite green; `deployment-prompt-drift.test.ts` green.

## Rollout

Breaking for any deployment whose env says `self-host` — known set: self-hosted
Fly instances following the Fly guide. `wrangler.toml` already says `hosted`, so
**Claxedo cloud is unaffected** **[verified]**.

The boot error names `local` as the replacement, so an operator hits an
actionable message rather than a silently-open deployment. That property — not
an alias — is what makes the hard rename safe.
