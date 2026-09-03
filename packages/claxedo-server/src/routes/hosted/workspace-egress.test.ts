import { describe, expect, test, vi } from "vitest"
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
import type { ControlPlaneServices } from "../../authority/services"
import { HostedWorkspaceRoutes, type HostedWorkspaceRouteOptions } from "./workspace"

/**
 * Security review 2026-07-27 §6.14 — hosted sandbox egress containment.
 *
 * `POST /create` is the hosted, multi-tenant provisioning path: the sandbox it
 * creates clones someone's private repository and runs agent-authored code
 * inside it. It called `sandboxManager.ensure` with no `net`, and an omitted
 * policy means allow-all, so every hosted sandbox ever provisioned could reach
 * any host on the internet. The egress machinery existed on the capable
 * drivers; nothing upstream engaged it.
 *
 * These tests assert on what the DRIVER receives — a real `SandboxManager`
 * over a real lease store, with only the driver faked — because an assertion
 * on the route's argument object would have passed just as happily while the
 * manager or the driver dropped the policy on the way down.
 */

const authConfig = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
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

function buildApp(egressControl: SandboxEgressControl, options: Partial<HostedWorkspaceRouteOptions> = {}) {
  const { driver, seen } = fakeDriver(egressControl)
  const leaseStore = createMemoryLeaseStore()
  // The REAL manager, so the policy has to survive the whole descent from the
  // route to `driver.ensureHost`.
  const sandboxManager = createSandboxManager({ leaseStore, driver })
  const capture = vi.fn()
  const services = {
    authority: {
      usersMe: vi.fn(async () => ({ subject: "user_1" })),
      createCloudWorkspace: vi.fn(async () => ({ workspace_id: "ignored" })),
      auditAllow: vi.fn(async () => ({})),
      auditDeny: vi.fn(async () => ({})),
    },
    sandbox: { sandboxManager, defaultDriver: driver.id },
    telemetry: { capture },
  } as unknown as ControlPlaneServices
  const app = HostedWorkspaceRoutes(services, {
    authConfig,
    verifier,
    relayUrl: RELAY_URL,
    countActiveOrgSandboxLeases: async () => 0,
    ...options,
  })
  return { app, driver, seen, leaseStore, capture }
}

async function create(app: ReturnType<typeof buildApp>["app"], token = "user_1") {
  const res = await app.fetch(
    new Request(`${CONTROL_PLANE_ORIGIN}/create`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ projectId: "proj_1", repoUrl: REPO_URL }),
    }),
  )
  const body = (await res.json()) as { workspaceId?: string }
  // `ensure` is fire-and-forget so the create response does not wait on a cold
  // start; let the kicked-off promise settle before asserting on the driver.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { res, body }
}

describe("POST /create hands the driver a restricted egress policy", () => {
  test("the driver is provisioned with a restricted policy, not allow-all", async () => {
    const { app, seen } = buildApp("hosts-and-cidrs")
    const { res } = await create(app)

    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    // The assertion that fails without the fix: this was `undefined`, and
    // `undefined` means allow-all.
    expect(seen[0]!.net).toBeDefined()
    expect(seen[0]!.net!.mode).toBe("restricted")
  })

  test("the allowlist carries the hosts a hosted sandbox genuinely needs", async () => {
    const { app, seen } = buildApp("hosts-and-cidrs")
    await create(app)
    const hosts = seen[0]!.net!.hosts ?? []

    // Its own control plane and relay: the runtime tunnels through the relay,
    // fetches the relay JWKS, and reports register/heartbeat back to the
    // control plane. Without these the sandbox cannot be reached at all.
    expect(hosts).toContain("relay.claxedo.test")
    expect(hosts).toContain("cp.claxedo.test")
    // The git host it clones from — this workspace's repo, not a forge list.
    expect(hosts).toContain("github.com")
    // The model providers the agent harness calls.
    for (const provider of SANDBOX_MODEL_PROVIDER_HOSTS) expect(hosts).toContain(provider)
  })

  test("the allowlist is not a rubber stamp — object storage stays out", async () => {
    const { app, seen } = buildApp("hosts-and-cidrs")
    await create(app)
    const hosts = seen[0]!.net!.hosts ?? []

    // An allowlist that includes anywhere a file can be uploaded is not an
    // allowlist. These are the plausible exfiltration destinations.
    for (const denied of ["storage.googleapis.com", "r2.cloudflarestorage.com", "*.workers.dev"]) {
      expect(hosts, `${denied} must not be reachable by default`).not.toContain(denied)
    }
    expect(hosts.filter((host) => host.includes("*"))).toEqual([])
  })

  test("a deployment can widen the allowlist, but only by naming hosts", async () => {
    const { app, seen } = buildApp("hosts-and-cidrs", {
      sandboxEgressExtraHosts: ["models.internal.acme.test"],
    })
    await create(app)
    expect(seen[0]!.net!.hosts).toContain("models.internal.acme.test")
  })
})

describe("POST /create with a driver that cannot contain egress", () => {
  /**
   * Inverted 2026-07-28 by owner directive: "for egress in sandbox enforce
   * where we can and document where we cant."
   *
   * These three tests previously asserted the manager REFUSED the create
   * (`ensureHost` never called, no lease, a `workspace.create.
   * sandbox_egress_refused` telemetry event). That posture failed closed but
   * took the most likely production driver offline: explicit cloudflare selection
   * prefers cloudflare, and cloudflare declares `egressControl: "none"`.
   *
   * The create now proceeds. What must NOT happen is the driver receiving a
   * policy it cannot honour — half the `"none"` drivers throw on one — and what
   * must not happen silently is the degrade itself. The manager owns the
   * warning; see `packages/sandbox-manager/src/egress-policy.test.ts` for the
   * assertions on it and `public-docs/sandbox-egress.md` for the operator page.
   */
  test("an uncontained driver still provisions, and is handed no policy", async () => {
    const { app, driver, seen, leaseStore } = buildApp("none")
    const { res, body } = await create(app)

    expect(res.status).toBe(200)
    expect(driver.ensureHost).toHaveBeenCalledTimes(1)
    // The load-bearing assertion: withheld, not passed through and not
    // downgraded. A driver that throws on a restricted policy cannot throw.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.net).toBeUndefined()
    expect(await leaseStore.get(body.workspaceId!)).toMatchObject({ status: "ready" })
  })

  test("the route's refusal telemetry no longer has anything to report", async () => {
    // `workspace.ts` still emits `workspace.create.sandbox_egress_refused`
    // when `ensure` returns an `sandbox_egress_*` error. With the refusal gone
    // for `"none"` drivers that branch simply never fires. It is left in place
    // deliberately: it still covers `sandbox_egress_policy_unenforceable`,
    // which an enforcing-but-wrong-encoding driver can still produce.
    const { app, capture } = buildApp("none")
    await create(app)
    expect(
      capture.mock.calls.filter((call) => call[1] === "workspace.create.sandbox_egress_refused"),
    ).toEqual([])
  })

  test("a contained driver is unaffected and emits no refusal", async () => {
    const { app, capture } = buildApp("hosts-and-cidrs")
    await create(app)
    expect(
      capture.mock.calls.filter((call) => call[1] === "workspace.create.sandbox_egress_refused"),
    ).toEqual([])
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
// Same philosophy as the rate-limit ratchet in
// `hosted-workspace-create-guards.test.ts`: the behavioural tests above prove
// the policy is passed TODAY; this proves nobody can quietly stop passing it.

const routeSource = fs.readFileSync(path.join(import.meta.dirname, "workspace.ts"), "utf8")

/** Strip whole-line comments so prose about `net:` cannot satisfy the check. */
function code(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
}

/** The `sandboxManager.ensure(...)` argument object, comments removed. */
function ensureCallSites(source = routeSource) {
  const stripped = code(source)
  const sites: string[] = []
  const marker = ".ensure(workspaceId, {"
  let at = stripped.indexOf(marker)
  while (at !== -1) {
    // Walk braces from the argument object's `{` to its match.
    let depth = 0
    let end = at + marker.length - 1
    for (let i = end; i < stripped.length; i++) {
      const char = stripped[i]
      if (char === "{") depth++
      else if (char === "}") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    sites.push(stripped.slice(at, end + 1))
    at = stripped.indexOf(marker, end)
  }
  return sites
}

describe("the hosted ensure call site cannot omit the egress policy", () => {
  test("the scanner actually finds the call site (guard against an empty ratchet)", () => {
    expect(ensureCallSites()).toHaveLength(1)
    expect(ensureCallSites()[0]).toContain("homeRegion")
  })

  test("the ratchet fires on a call site with no policy", () => {
    // Proves the check below can fail. This is exactly the shape the call site
    // had before the 2026-07-27 review.
    const regressed = [
      "        void sandboxManager",
      "          .ensure(workspaceId, {",
      "            homeRegion,",
      "            workspaceRoot: directory,",
      '            source: { kind: "git", repoUrl },',
      "          })",
    ].join("\n")
    expect(ensureCallSites(regressed).every((site) => site.includes("net:"))).toBe(false)
  })

  test("every hosted ensure call site passes net", () => {
    // A new hosted provisioning path with no `net` lands here. Do not add an
    // exemption — pass the policy. `hostedSandboxNetworkPolicy` exists so that
    // costs one line.
    const missing = ensureCallSites().filter((site) => !site.includes("net:"))
    expect(missing).toEqual([])
  })

  test("the policy comes from the shared builder, not an inline literal", () => {
    // An inline `{ mode: "restricted", hosts: [...] }` here would drift away
    // from the reviewed allowlist the moment anything changed.
    expect(ensureCallSites()[0]).toContain("hostedSandboxNetworkPolicy({")
    expect(code(routeSource)).toContain('from "@claxedo/sandbox-manager"')
  })
})
