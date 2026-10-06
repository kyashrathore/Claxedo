import { afterEach, describe, expect, test, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import {
  createSandboxManager,
  SANDBOX_MODEL_PROVIDER_HOSTS,
  type SandboxDriver,
  type SandboxDriverEnsureInput,
  type SandboxEgressControl,
} from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import type { ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../../authority/services"
import type { ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { inlineSandboxStart } from "../../test-support/inline-sandbox-start"
import { workspaceBackingDatabase } from "../../test-support/workspace-backing-database"
import { createHostedRuntimeDelivery } from "../../workspace/hosted-runtime-delivery"
import { unusedSandboxStart } from "../../test-support/inline-sandbox-start"
import { hostedSandboxInput } from "../../workspace/hosted-sandbox-input"
import { HostedWorkspaceRoutes, type HostedWorkspaceRouteOptions } from "./workspace"

/**
 * Security review 2026-07-27 §6.14 — hosted sandbox egress containment.
 *
 * The explicit start (`POST /:id/connection`) is the hosted, multi-tenant
 * provisioning path: the sandbox it boots clones someone's private repository
 * and runs agent-authored code inside it. It once reached the manager with no
 * `net`, and an omitted policy means allow-all, so every hosted sandbox ever
 * provisioned could reach any host on the internet. The egress machinery
 * existed on the capable drivers; nothing upstream engaged it.
 *
 * These tests assert on what the DRIVER receives — the real start drive over
 * a real `SandboxManager` and lease store, with only the driver faked —
 * because an assertion on an argument object would have passed just as
 * happily while the drive, the manager or the driver dropped the policy on
 * the way down.
 */

// A ready sandbox takes its settings over the runtime client under a
// supervisor token; neither is what these tests observe.
vi.mock("@claxedo/workspace-runtime/client", () => ({ createWorkspaceRuntimeClient: () => ({ applyConfig: async () => {} }) }))
vi.mock("@claxedo/server-core/platform/auth/runtime-access-token", () => ({ mintSupervisorBackplaneToken: async () => ({ supervisorBackplaneToken: "supervisor-token" }) }))

const active: ControlPlaneDatabase[] = []
afterEach(async () => { await Promise.all(active.splice(0).map((instance) => instance.dispose())) })

const authConfig = {
  enabled: true,
  issuer: "https://issuer.example.test",
  jwksUrl: "https://issuer.example.test/.well-known/jwks.json",
} as const

const verifier: ControlPlaneTokenVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: {
    subject: token,
    tokenIdentifier: `${config.issuer}|${token}`,
    issuer: config.issuer,
    orgId: `org_of_${token}`,
  },
})

const RELAY_URL = "https://relay.claxedo.test"
const CONTROL_PLANE_ORIGIN = "https://cp.claxedo.test"
const REQUEST_ORIGIN = "https://edge.claxedo.test"
const REPO_URL = "https://github.com/acme/widgets.git"

function fakeDriver(egressControl: SandboxEgressControl) {
  const seen: SandboxDriverEnsureInput[] = []
  const driver: SandboxDriver = {
    id: `driver-${egressControl}`,
    ensureHost: vi.fn(async (input) => {
      seen.push(input)
      return {
        sandboxId: `sandbox_${input.workspaceId}`,
        url: `https://runtime.test/${input.workspaceId}`,
        hostId: `host_${input.workspaceId}`,
        labels: input.labels,
      }
    }),
    metadata: {
      driverRunsIn: ["worker"],
      hostStopBehavior: "suspends-host",
      hostResumeBehavior: "same-host",
      targetAccess: "relay",
      secretBrokering: "native",
      egressControl,
      persistence: {
        resume: "same-sandbox",
        capture: "none",
        clone: false,
        captureSource: "not-applicable",
        retention: "not-applicable",
        restoreMount: "not-applicable",
      },
    },
  }
  return { driver, seen }
}

async function buildApp(egressControl: SandboxEgressControl, options: Partial<HostedWorkspaceRouteOptions> = {}) {
  const { driver, seen } = fakeDriver(egressControl)
  const leaseStore = createMemoryLeaseStore()
  // The REAL manager, so the policy has to survive the whole descent from the
  // route to `driver.ensureHost`.
  const sandboxManager = createSandboxManager({ leaseStore, driver })
  const backing = await workspaceBackingDatabase([])
  active.push(backing)
  const capture = vi.fn()
  const rows = new Map<string, Record<string, unknown>>()
  const services = {
    authority: {
      usersMe: vi.fn(async () => ({ subject: "user_1", actor_id: "user_1", actor_kind: "human", actor_public_id: "user_1", actor_name: "User One" })),
      recordRuntimeAccessToken: vi.fn(async () => ({})),
      authorizeWorkspaceCreate: vi.fn(async () => ({ orgId: "org_1" })),
      createCloudWorkspace: vi.fn(async (_auth: unknown, args: { workspaceId: string; projectId?: string; repoUrl?: string }) => {
        rows.set(args.workspaceId, { workspace_id: args.workspaceId, project_id: args.projectId, backing: "cloud-vm", repo_url: args.repoUrl })
        await backing.database.prepare(`insert into workspaces
          (workspace_id, org_id, project_id, owner_user_id, backing, display_name, created_at, updated_at, deleted_at)
          values (?, 'org', 'project', 'owner', 'cloud-vm', 'Egress', 1, 1, null)`).bind(args.workspaceId).run()
        return { workspace_id: args.workspaceId }
      }),
      openWorkspace: vi.fn(async (_auth: unknown, args: { workspaceId: string }) => ({ allowed: true, role: "owner", workspace: rows.get(args.workspaceId) })),
      resolveWorkspaceOwner: vi.fn(async () => ({ userId: "owner", orgId: "org" })),
      auditAllow: vi.fn(async () => ({})),
      auditDeny: vi.fn(async () => ({})),
    },
    sandbox: { sandboxManager, defaultDriver: driver.id },
    telemetry: { capture },
  } as unknown as ControlPlaneServices
  const egress = {
    relayUrl: RELAY_URL,
    sandboxControlPlaneOrigin: CONTROL_PLANE_ORIGIN,
    ...(options.sandboxEgressExtraHosts ? { sandboxEgressExtraHosts: options.sandboxEgressExtraHosts } : {}),
  }
  // The production drive over this test's rows: what the route's start hands
  // the manager is what `hostedSandboxInput` rebuilds from the workspace row.
  const delivery = createHostedRuntimeDelivery({
      sandboxStart: unusedSandboxStart,
    authority: services.authority as unknown as WorkspaceAuthority,
    database: backing.database,
    services,
    sandboxManager,
    workspaceSecretBrokering: async () => driver.metadata.secretBrokering,
    sandboxInput: async (workspaceId, prepared) => hostedSandboxInput(rows.get(workspaceId) ?? {}, { egress, ...prepared }),
    settings: { read: async () => ({ version: 3, connections: {} }), write: async () => {} },
    credentials: () => ({ listCredentials: async () => [], accountSelections: async () => ({}), resolveCredentialSecretById: async () => null }) as never,
    signingEnv: {},
    provisionedRunner: undefined,
  })
  const app = HostedWorkspaceRoutes(services, {
    authConfig,
    verifier,
    ...egress,
    sandboxStart: inlineSandboxStart(delivery.start),
    runtimeAccessTokenSigner: async () => ({ runtimeAccessToken: "rat", tokenExpiresAt: 1_000_000, jti: "jti_rat" }),
    countActiveOrgSandboxLeases: async () => 0,
    // No real DNS in tests: clone admission resolves through this stub.
    resolveRepoAddresses: async () => ["140.82.112.3"],
    ...options,
  })
  return { app, driver, seen, leaseStore, capture }
}

async function create(app: Awaited<ReturnType<typeof buildApp>>["app"], token = "user_1") {
  const res = await app.fetch(
    new Request(`${REQUEST_ORIGIN}/create`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ projectId: "proj_1", workspaceName: "Egress", repoUrl: REPO_URL }),
    }),
  )
  const body = (await res.json()) as { workspaceId?: string }
  const started = await app.fetch(
    new Request(`${REQUEST_ORIGIN}/${body.workspaceId}/connection`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    }),
  )
  expect(started.status).toBe(200)
  return { res, body }
}

describe("the first start hands the driver a restricted egress policy", () => {
  test("the driver is provisioned with a restricted policy, not allow-all", async () => {
    const { app, seen } = await buildApp("hosts-and-cidrs")
    const { res } = await create(app)

    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    // The assertion that fails without the fix: this was `undefined`, and
    // `undefined` means allow-all.
    expect(seen[0].net).toBeDefined()
    expect(seen[0].net!.mode).toBe("restricted")
  })

  test("the allowlist carries the hosts a hosted sandbox genuinely needs", async () => {
    const { app, seen } = await buildApp("hosts-and-cidrs")
    await create(app)
    const hosts = seen[0].net!.hosts ?? []

    // Its own control plane and relay: the runtime tunnels through the relay,
    // fetches the relay JWKS, and reports register/heartbeat back to the
    // control plane. Without these the sandbox cannot be reached at all.
    // The control plane is the origin the sandbox is given, not whichever
    // origin the create request arrived on, so a refresh that has no request
    // allows the same one.
    expect(hosts).toContain("relay.claxedo.test")
    expect(hosts).toContain("cp.claxedo.test")
    expect(hosts).not.toContain("edge.claxedo.test")
    // The git host it clones from — this workspace's repo, not a forge list.
    expect(hosts).toContain("github.com")
    // The model providers the agent harness calls.
    for (const provider of SANDBOX_MODEL_PROVIDER_HOSTS) expect(hosts).toContain(provider)
  })

  test("the allowlist is not a rubber stamp — object storage stays out", async () => {
    const { app, seen } = await buildApp("hosts-and-cidrs")
    await create(app)
    const hosts = seen[0].net!.hosts ?? []

    // An allowlist that includes anywhere a file can be uploaded is not an
    // allowlist. These are the plausible exfiltration destinations.
    for (const denied of ["storage.googleapis.com", "r2.cloudflarestorage.com", "*.workers.dev"]) {
      expect(hosts, `${denied} must not be reachable by default`).not.toContain(denied)
    }
    expect(hosts.filter((host) => host.includes("*"))).toEqual([])
  })

  test("a deployment can widen the allowlist, but only by naming hosts", async () => {
    const { app, seen } = await buildApp("hosts-and-cidrs", {
      sandboxEgressExtraHosts: ["models.internal.acme.test"],
    })
    await create(app)
    expect(seen[0].net!.hosts).toContain("models.internal.acme.test")
  })
})

describe("the first start with a driver that cannot contain egress", () => {
  /**
   * Owner directive: "for egress in sandbox enforce where we can and document
   * where we cant." Refusing an uncontained driver would take the most likely
   * production driver offline (cloudflare declares `egressControl: "none"`).
   * What must NOT happen is the driver receiving a policy it cannot honour —
   * half the `"none"` drivers throw on one — and what must not happen silently
   * is the degrade itself. The manager owns the warning; see
   * `packages/sandbox-manager/src/egress-policy.test.ts` and
   * `public-docs/sandbox-egress.md`.
   */
  test("an uncontained driver still provisions, and is handed no policy", async () => {
    const { app, driver, seen, leaseStore } = await buildApp("none")
    const { res, body } = await create(app)

    expect(res.status).toBe(200)
    expect(driver.ensureHost).toHaveBeenCalledTimes(1)
    // The load-bearing assertion: withheld, not passed through and not
    // downgraded. A driver that throws on a restricted policy cannot throw.
    expect(seen).toHaveLength(1)
    expect(seen[0].net).toBeUndefined()
    expect(await leaseStore.get(body.workspaceId!)).toMatchObject({ status: "ready" })
  })

  test("an enforcing driver handed an encoding it cannot express is still refused", async () => {
    // The other half of the directive: enforce where we can. A hosts-only
    // driver DOES contain egress, so an address-only policy stays fail-closed
    // with a stable code rather than degrading a working control to open.
    const { driver } = fakeDriver("hosts")
    const manager = createSandboxManager({ leaseStore: createMemoryLeaseStore(), driver })
    await expect(
      manager.ensure("ws_cidr_only", {
        homeRegion: "us-east",
        net: { mode: "restricted", cidrs: ["140.82.0.0/16"] },
      }),
    ).resolves.toMatchObject({ status: "unavailable", error: "sandbox_egress_policy_unenforceable" })
  })
})

// ——— Structural ratchet ———
//
// The behavioural tests above prove the policy is passed TODAY; this proves
// nobody can quietly stop passing it.

const driveSource = fs.readFileSync(path.join(import.meta.dirname, "../../workspace/hosted-runtime-delivery.ts"), "utf8")
const routeSource = fs.readFileSync(path.join(import.meta.dirname, "../../connections/hosted-connection-info.ts"), "utf8")

/** Strip whole-line comments so prose about `net:` cannot satisfy the check. */
function code(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
}

const MANAGER_STEP = /\.(?:ensure|acquire|provision)\(\s*workspaceId,\s*(?:epoch,\s*)?([^\n]*)/g

/** What each manager step in the drive is handed, comments removed. */
function stepArguments(source = driveSource) {
  return [...code(source).matchAll(MANAGER_STEP)].map((match) => match[1].trim())
}

describe("the hosted manager steps cannot omit the egress policy", () => {
  test("the scanner actually finds the call sites (guard against an empty ratchet)", () => {
    expect(stepArguments()).toHaveLength(2)
  })

  test("the ratchet fires on a call site that assembles its own input", () => {
    // Proves the check below can fail. This is the shape the call site had
    // before the 2026-07-27 review.
    const regressed = [
      "        void sandboxManager",
      "          .ensure(workspaceId, {",
      "            homeRegion,",
      "          })",
    ].join("\n")
    expect(stepArguments(regressed).every((argument) => /^(?:await input\.)?sandboxInput\b|^\{ \.\.\.sandboxInput\b/.test(argument))).toBe(false)
  })

  test("every manager step in the drive is handed the one full-input builder's answer", () => {
    // `input.sandboxInput` is `hostedSandboxInput` over the live workspace
    // row, which always supplies `net`, so a new step gets the policy by
    // using it. Do not add an exemption.
    expect(stepArguments().filter((argument) => !/^(?:await input\.)?sandboxInput\b|^\{ \.\.\.sandboxInput\b/.test(argument))).toEqual([])
  })

  test("the connect route runs no manager step of its own: a start reaches the driver only through the drive", () => {
    expect([...code(routeSource).matchAll(MANAGER_STEP)]).toEqual([])
    expect(code(routeSource)).toContain("options.sandboxStart(workspaceId)")
  })
})
