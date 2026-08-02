import { describe, expect, test, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import {
  createSandboxManager,
  hostedSandboxNetworkPolicy,
  sandboxEgressDisposition,
  sandboxSourceHost,
  SANDBOX_MODEL_PROVIDER_HOSTS,
  type SandboxDriver,
  type SandboxDriverEnsureInput,
  type SandboxEgressControl,
  type SandboxEgressUnenforcedEvent,
} from "."
import { createMemoryLeaseStore } from "./stores/memory"
import { sandboxDriverCatalog, sandboxDriverIds } from "./driver-catalog"
import { createDaytonaSandboxDriver, type DaytonaClientLike } from "./drivers/daytona"
import { createFetchBridgeSandboxDriver } from "./drivers/fetch-bridge"

/**
 * Security review 2026-07-27 §6.14 — sandbox egress containment.
 * Owner directive 2026-07-28 — "for egress in sandbox enforce where we can and
 * document where we cant."
 *
 * Round 1 reported that the `exe` driver cannot enforce host-based policy.
 * Round 2 found the larger hole: NOTHING upstream ever handed any driver a
 * restricted policy, so the hosted path provisioned every sandbox with the open
 * internet available to it. The first fix made the manager REFUSE a policy it
 * could not enforce — which fails closed, but takes the most likely production
 * driver (cloudflare, first in the hosted auto-selection order) offline
 * entirely.
 *
 * The contract these tests now pin:
 *   - a driver DECLARES whether it can contain egress (`egressControl`);
 *   - a capable driver receives the policy verbatim and enforces it;
 *   - an INCAPABLE driver provisions successfully but is handed NO policy —
 *     the drivers that throw on one therefore cannot throw, and the drivers
 *     that would silently drop one are no longer pretending;
 *   - the gap is LOUD. A silent degrade to unrestricted egress is the exact
 *     finding this whole workstream exists to close, so the warning is
 *     asserted, not assumed;
 *   - the operator-facing doc cannot drift away from the metadata.
 */

function fakeDriver(
  egressControl: SandboxEgressControl,
  options: { id?: string; seen?: (input: SandboxDriverEnsureInput) => void } = {},
): SandboxDriver {
  return {
    id: options.id ?? `driver-${egressControl}`,
    ensureHost: vi.fn(async (input) => {
      options.seen?.(input)
      return {
        sandboxId: `sandbox_${input.workspaceId}`,
        url: `https://runtime.test/${input.workspaceId}`,
        hostId: `host_${input.workspaceId}`,
        labels: input.labels,
      }
    }),
    metadata: {
      driverRunsIn: ["node"],
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
}

/**
 * A driver that behaves like the real exe/docker/modal/box drivers: it raises
 * when handed a restricted policy. Used to prove the manager withholds rather
 * than passes — an assertion on `seen.net` alone would still pass if the
 * withholding happened one layer too late.
 */
function throwingDriver(): SandboxDriver {
  const driver = fakeDriver("none", { id: "driver-throws" })
  return {
    ...driver,
    ensureHost: vi.fn(async (input: SandboxDriverEnsureInput) => {
      if (input.net && input.net.mode !== "allow-all") {
        throw new Error("driver cannot enforce host-based network policy")
      }
      return {
        sandboxId: `sandbox_${input.workspaceId}`,
        url: `https://runtime.test/${input.workspaceId}`,
        hostId: `host_${input.workspaceId}`,
        labels: input.labels,
      }
    }),
  }
}

/** Collect the manager's egress warnings instead of writing them to stderr. */
function warnings() {
  const events: SandboxEgressUnenforcedEvent[] = []
  return { events, sink: (event: SandboxEgressUnenforcedEvent) => void events.push(event) }
}

describe("sandboxEgressDisposition", () => {
  test("asking for no containment is always fine", () => {
    for (const control of ["none", "hosts", "hosts-and-cidrs"] as const) {
      expect(sandboxEgressDisposition(control, undefined)).toEqual({ action: "enforce" })
      expect(sandboxEgressDisposition(control, { mode: "allow-all" })).toEqual({ action: "enforce" })
    }
  })

  test("a driver with no egress control has ANY restricted policy withheld, not refused", () => {
    // Inverted 2026-07-28. This used to assert a `"sandbox_egress_uncontained"`
    // refusal. The reason code survives — it is still the right name for the
    // condition — but it now describes a documented gap rather than a create
    // that never happens.
    const withheld = { action: "withhold", reason: "sandbox_egress_uncontained" }
    expect(sandboxEgressDisposition("none", { mode: "restricted", hosts: ["github.com"] })).toEqual(withheld)
    expect(sandboxEgressDisposition("none", { mode: "restricted", cidrs: ["10.0.0.0/8"] })).toEqual(withheld)
    // Even deny-all: "none" means the driver has no egress control to apply.
    expect(sandboxEgressDisposition("none", { mode: "restricted" })).toEqual(withheld)
  })

  test("hosts and cidrs are alternative encodings, not additive requirements", () => {
    const both = { mode: "restricted" as const, hosts: ["github.com"], cidrs: ["140.82.0.0/16"] }
    // A hosts-only driver handed both enforces the names and contains the
    // sandbox — the cidrs are the same allowance re-encoded.
    expect(sandboxEgressDisposition("hosts", both)).toEqual({ action: "enforce" })
    expect(sandboxEgressDisposition("hosts-and-cidrs", both)).toEqual({ action: "enforce" })
  })

  test("a hosts-only driver handed an address-only policy is still REFUSED", () => {
    // Deliberately NOT relaxed alongside the "none" case. This driver enforces
    // egress; it just cannot express this encoding. Withholding here would turn
    // a working control off, which is the opposite of "enforce where we can".
    const cidrsOnly = { mode: "restricted" as const, cidrs: ["140.82.0.0/16"] }
    expect(sandboxEgressDisposition("hosts", cidrsOnly)).toEqual({
      action: "refuse",
      reason: "sandbox_egress_policy_unenforceable",
    })
    expect(sandboxEgressDisposition("hosts-and-cidrs", cidrsOnly)).toEqual({ action: "enforce" })
  })

  test("deny-all is enforceable by anything that has egress control at all", () => {
    expect(sandboxEgressDisposition("hosts", { mode: "restricted" })).toEqual({ action: "enforce" })
    expect(
      sandboxEgressDisposition("hosts-and-cidrs", { mode: "restricted", hosts: [], cidrs: [] }),
    ).toEqual({ action: "enforce" })
  })
})

describe("manager: enforce where we can", () => {
  test("a capable driver receives the restricted policy verbatim", async () => {
    let seen: SandboxDriverEnsureInput | undefined
    const driver = fakeDriver("hosts-and-cidrs", { seen: (input) => void (seen = input) })
    const { events, sink } = warnings()
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver,
      onEgressUnenforced: sink,
    })
    const net = { mode: "restricted" as const, hosts: ["github.com", "api.anthropic.com"] }

    await expect(manager.ensure("ws_1", { homeRegion: "us-east", net })).resolves.toMatchObject({ status: "ready" })
    expect(seen?.net).toEqual(net)
    // Nothing to warn about: the containment the caller asked for happened.
    expect(events).toEqual([])
  })

  test("an enforcing driver handed an encoding it cannot express is still refused", async () => {
    const store = createMemoryLeaseStore()
    const driver = fakeDriver("hosts")
    const manager = createSandboxManager({ leaseStore: store, driver })

    const result = await manager.ensure("ws_1", {
      homeRegion: "us-east",
      net: { mode: "restricted", cidrs: ["140.82.0.0/16"] },
    })

    expect(result).toMatchObject({ status: "unavailable", error: "sandbox_egress_policy_unenforceable" })
    expect(driver.ensureHost).not.toHaveBeenCalled()
    // A composition mistake must not burn a lease epoch or enter retry backoff.
    expect(await store.get("ws_1")).toBeUndefined()
  })
})

describe("manager: document where we can't", () => {
  test("an incapable driver PROVISIONS, and is handed no policy at all", async () => {
    // Inverted 2026-07-28. This used to assert `status: "unavailable"`,
    // `ensureHost` never called, and no lease. Under the owner directive the
    // create must proceed; what must not happen is the driver seeing a policy
    // it cannot honour.
    const store = createMemoryLeaseStore()
    let seen: SandboxDriverEnsureInput | undefined
    const driver = fakeDriver("none", { seen: (input) => void (seen = input) })
    const { sink } = warnings()
    const manager = createSandboxManager({ leaseStore: store, driver, onEgressUnenforced: sink })

    const result = await manager.ensure("ws_1", {
      homeRegion: "us-east",
      net: { mode: "restricted", hosts: ["github.com"] },
    })

    expect(result).toMatchObject({ status: "ready" })
    expect(driver.ensureHost).toHaveBeenCalledTimes(1)
    // The load-bearing assertion: withheld, not downgraded, not passed through.
    expect(seen).toBeDefined()
    expect(seen!.net).toBeUndefined()
    expect(await store.get("ws_1")).toMatchObject({ status: "ready" })
  })

  test("a driver that THROWS on a restricted policy never gets the chance", async () => {
    // exe, docker, modal and box all raise "cannot enforce host-based network
    // policy". Their throws stay in place as their own last line of defence;
    // this proves the manager never trips them, so removing the caller-side
    // refusal did not turn a refusal into a provisioning failure.
    const driver = throwingDriver()
    const { sink } = warnings()
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver,
      onEgressUnenforced: sink,
    })

    await expect(
      manager.ensure("ws_1", { homeRegion: "us-east", net: { mode: "restricted", hosts: ["github.com"] } }),
    ).resolves.toMatchObject({ status: "ready" })
  })

  test("withholding the policy emits a warning naming the driver and the workspace", async () => {
    const { events, sink } = warnings()
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver: fakeDriver("none", { id: "cloudflare" }),
      onEgressUnenforced: sink,
    })

    await manager.ensure("ws_abc", {
      homeRegion: "us-east",
      net: { mode: "restricted", hosts: ["github.com", "api.anthropic.com"] },
    })

    const ensure = events.filter((event) => event.phase === "ensure")
    expect(ensure).toHaveLength(1)
    expect(ensure[0]).toMatchObject({
      phase: "ensure",
      reason: "sandbox_egress_uncontained",
      driver: "cloudflare",
      egressControl: "none",
      workspaceId: "ws_abc",
      requested: { mode: "restricted", hosts: ["github.com", "api.anthropic.com"] },
    })
    // The message has to be usable on its own — a sink that only forwards text
    // must still convey what is wrong and what to do about it.
    expect(ensure[0]!.message).toContain("UNRESTRICTED")
    expect(ensure[0]!.message).toContain("cloudflare")
    expect(ensure[0]!.message).toContain("ws_abc")
    expect(ensure[0]!.message).toContain("public-docs/sandbox-egress.md")
  })

  test("composition warns at boot, before any workspace exists", async () => {
    // A per-create line lands in request logs and gets missed. This one lands
    // wherever the process starts. Unique driver id per test: the composition
    // warning is deduped per driver so a per-request Worker composition does
    // not warn on every request.
    const { events, sink } = warnings()
    createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver: fakeDriver("none", { id: "boot-warn-driver" }),
      onEgressUnenforced: sink,
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      phase: "composition",
      reason: "sandbox_egress_uncontained",
      driver: "boot-warn-driver",
    })
    expect(events[0]!.workspaceId).toBeUndefined()
  })

  test("composing a capable driver warns about nothing", () => {
    const { events, sink } = warnings()
    createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver: fakeDriver("hosts-and-cidrs", { id: "boot-quiet-driver" }),
      onEgressUnenforced: sink,
    })
    expect(events).toEqual([])
  })

  test("with no sink configured the warning still reaches the console", async () => {
    // The default must be loud. An operator who never wires telemetry is
    // exactly the operator who most needs to be told.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const manager = createSandboxManager({
        leaseStore: createMemoryLeaseStore(),
        driver: fakeDriver("none", { id: "console-default-driver" }),
      })
      await manager.ensure("ws_console", {
        homeRegion: "us-east",
        net: { mode: "restricted", hosts: ["github.com"] },
      })
      const said = warn.mock.calls.map((call) => String(call[0])).join("\n")
      expect(said).toContain("SANDBOX EGRESS IS UNRESTRICTED")
      expect(said).toContain("ws_console")
    } finally {
      warn.mockRestore()
    }
  })
})

describe("manager: self-host and allow-all paths are untouched", () => {
  test("an incapable driver serving a workspace with no policy warns about nothing", async () => {
    // Local/self-host passes no policy at all when the operator configured
    // none. Containment is a hosted, multi-tenant requirement; warning here
    // would train operators to ignore the warning that matters.
    const driver = fakeDriver("none", { id: "self-host-driver" })
    const { events, sink } = warnings()
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver,
      onEgressUnenforced: sink,
    })

    await expect(manager.ensure("ws_1", { homeRegion: "us-east" })).resolves.toMatchObject({ status: "ready" })
    expect(driver.ensureHost).toHaveBeenCalledTimes(1)
    expect(events.filter((event) => event.phase === "ensure")).toEqual([])
  })

  test("an explicit allow-all is a request for no containment, not a failure", async () => {
    let seen: SandboxDriverEnsureInput | undefined
    const { events, sink } = warnings()
    const manager = createSandboxManager({
      leaseStore: createMemoryLeaseStore(),
      driver: fakeDriver("none", { id: "allow-all-driver", seen: (input) => void (seen = input) }),
      onEgressUnenforced: sink,
    })

    await expect(
      manager.ensure("ws_1", { homeRegion: "us-east", net: { mode: "allow-all" } }),
    ).resolves.toMatchObject({ status: "ready" })
    expect(seen?.net).toEqual({ mode: "allow-all" })
    expect(events.filter((event) => event.phase === "ensure")).toEqual([])
  })
})

describe("driver egress capability declarations", () => {
  test("every driver in the catalog declares whether it can contain egress", () => {
    for (const id of sandboxDriverIds) {
      expect(
        sandboxDriverCatalog[id].metadata.egressControl,
        `${id} must declare egressControl`,
      ).toMatch(/^(none|hosts|hosts-and-cidrs)$/)
    }
  })

  test("the drivers that throw on a restricted policy are declared uncontained", () => {
    // exe.ts, docker.ts, modal.ts and box.ts all raise "cannot enforce
    // host-based network policy". Declaring them "none" is what makes the
    // manager withhold the policy, so those throws are never reached — and it
    // keeps them intact as the driver's own last line of defence.
    for (const id of ["exe", "docker", "modal", "box"] as const) {
      expect(sandboxDriverCatalog[id].metadata.egressControl, id).toBe("none")
    }
  })

  test("cloudflare is uncontained even though it has a secret broker", () => {
    // Its egress broker is an OPT-IN proxy for brokered credentials, not a
    // network boundary: the driver drops `net` on the floor. `secretBrokering`
    // and `egressControl` are independent capabilities and must not be
    // confused for one another.
    expect(sandboxDriverCatalog.cloudflare.metadata.secretBrokering).toBe("proxy")
    expect(sandboxDriverCatalog.cloudflare.metadata.egressControl).toBe("none")
  })

  test("daytona and vercel are the ONLY drivers that can contain a hosted workload", () => {
    expect(sandboxDriverCatalog.daytona.metadata.egressControl).toBe("hosts-and-cidrs")
    expect(sandboxDriverCatalog.vercel.metadata.egressControl).toBe("hosts")
    // Exhaustive, not just spot-checked: `public-docs/sandbox-egress.md` and
    // the package README both tell operators these two are the enforcing
    // drivers. A third one gaining the capability has to update that prose.
    expect(
      sandboxDriverIds.filter((id) => sandboxDriverCatalog[id].metadata.egressControl !== "none").sort(),
    ).toEqual(["daytona", "vercel"])
  })
})

// ——— Documentation ratchet ———
//
// "Document where we can't" is only worth anything if the document stays true.
// This reads the operator-facing matrix and compares it to what the drivers
// actually declare, so a capability change that is not written down fails here
// instead of quietly making the doc a lie.

const EGRESS_DOC = path.join(import.meta.dirname, "..", "..", "..", "public-docs", "sandbox-egress.md")

/** `| \`driver\` | \`egressControl\` | …` rows of the capability matrix. */
function documentedEgressControls(markdown: string) {
  const rows = new Map<string, string>()
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*`([a-z-]+)`\s*\|\s*`(none|hosts|hosts-and-cidrs)`\s*\|/.exec(line.trim())
    if (match) rows.set(match[1]!, match[2]!)
  }
  return rows
}

describe("the egress capability doc cannot drift from the metadata", () => {
  const markdown = fs.readFileSync(EGRESS_DOC, "utf8")
  const documented = documentedEgressControls(markdown)
  // The fetch bridge is a driver factory, not a catalog entry, so it has to be
  // instantiated to read its declaration.
  const declared = new Map<string, string>([
    ...sandboxDriverIds.map((id) => [id, sandboxDriverCatalog[id].metadata.egressControl] as const),
    [
      "fetch",
      createFetchBridgeSandboxDriver({
        id: "fetch",
        baseUrl: "https://bridge.test",
        autoStopMs: 60_000,
        autoDeleteMs: 3_600_000,
      }).metadata.egressControl,
    ],
  ])

  test("the scanner actually finds the matrix (guard against an empty ratchet)", () => {
    expect(documentedEgressControls("nothing to see here").size).toBe(0)
    expect(documented.size).toBeGreaterThan(0)
  })

  test("every driver is documented, and nothing is documented that does not exist", () => {
    expect([...documented.keys()].sort()).toEqual([...declared.keys()].sort())
  })

  test("each documented capability matches what the driver declares", () => {
    for (const [id, control] of declared) {
      expect(documented.get(id), `public-docs/sandbox-egress.md is stale for "${id}"`).toBe(control)
    }
  })

  test("the doc names the unrestricted drivers as unrestricted, in words", () => {
    // A table an operator has to decode against a type union is not
    // documentation. Every `none` driver's row must say so outright.
    for (const [id, control] of declared) {
      if (control !== "none") continue
      const row = markdown.split("\n").find((line) => line.trim().startsWith(`| \`${id}\` |`))
      expect(row, `no matrix row for ${id}`).toBeDefined()
      expect(row!, `${id} row must say it is unrestricted`).toContain("UNRESTRICTED")
    }
  })

  test("the doc states the consequence and the remedy, not just the capability", () => {
    expect(markdown).toContain("exfiltration")
    expect(markdown).toContain("CLAXEDO_SANDBOX_DRIVER=daytona")
  })
})

describe("daytona egress translation", () => {
  function daytonaClient() {
    const created: Array<Record<string, unknown>> = []
    const sandbox = {
      id: "sbx_1",
      state: "started",
      process: { executeCommand: async () => ({}) },
      getPreviewLink: async () => ({ url: "https://preview.test" }),
      getSignedPreviewUrl: async () => ({ url: "https://preview.test" }),
      refreshActivity: async () => {},
      start: async () => {},
      stop: async () => {},
      delete: async () => {},
    }
    const client: DaytonaClientLike = {
      create: async (params) => {
        created.push(params as Record<string, unknown>)
        return sandbox
      },
      get: async () => sandbox,
    }
    return { client, created }
  }

  async function ensure(net: SandboxDriverEnsureInput["net"]) {
    const { client, created } = daytonaClient()
    const driver = createDaytonaSandboxDriver({ apiKey: "k", baseSnapshot: "snap", client })
    await driver.ensureHost({
      workspaceId: "ws_1",
      homeRegion: "us-east",
      epoch: 1,
      labels: {},
      ...(net ? { net } : {}),
    })
    return created[0]!
  }

  test("a host allowlist reaches daytona's domainAllowList", async () => {
    const params = await ensure({ mode: "restricted", hosts: ["github.com", "api.anthropic.com"] })
    expect(params.domainAllowList).toBe("github.com,api.anthropic.com")
    expect(params.networkBlockAll).toBeUndefined()
  })

  test("names win over addresses when the policy carries both", async () => {
    // The cidrs are DNS resolutions of the same hosts, so nothing is lost —
    // and a pinned /32 goes stale when a CDN-fronted host rotates IPs.
    const params = await ensure({
      mode: "restricted",
      hosts: ["github.com"],
      cidrs: ["140.82.0.0/16"],
    })
    expect(params.domainAllowList).toBe("github.com")
    expect(params.networkAllowList).toBeUndefined()
  })

  test("an address-only policy still reaches the CIDR allowlist", async () => {
    const params = await ensure({ mode: "restricted", cidrs: ["140.82.0.0/16"] })
    expect(params.networkAllowList).toBe("140.82.0.0/16")
    expect(params.networkBlockAll).toBeUndefined()
  })

  test("a restricted policy allowing nothing blocks everything", async () => {
    const params = await ensure({ mode: "restricted" })
    expect(params.networkBlockAll).toBe(true)
  })

  test("allow-all leaves daytona's egress controls untouched", async () => {
    const params = await ensure({ mode: "allow-all" })
    expect(params.networkBlockAll).toBeUndefined()
    expect(params.domainAllowList).toBeUndefined()
    expect(params.networkAllowList).toBeUndefined()
  })

  test("the domain list is never truncated", async () => {
    // The CIDR formatter caps at 10 for Daytona's documented limit. Applying
    // that cap to names would silently drop allowlist entries, leaving a
    // sandbox unable to reach hosts the caller believed it granted.
    const hosts = Array.from({ length: 14 }, (_, i) => `h${i}.test`)
    const params = await ensure({ mode: "restricted", hosts })
    expect(String(params.domainAllowList).split(",")).toHaveLength(14)
  })
})

describe("hostedSandboxNetworkPolicy", () => {
  const policy = hostedSandboxNetworkPolicy({
    controlPlane: ["https://relay.claxedo.test", "https://cp.claxedo.test"],
    source: { kind: "git", repoUrl: "https://github.com/acme/widgets.git" },
  })

  test("is always restricted — there is no input that yields allow-all", () => {
    expect(policy.mode).toBe("restricted")
    expect(hostedSandboxNetworkPolicy({ controlPlane: [] }).mode).toBe("restricted")
    expect(hostedSandboxNetworkPolicy({ controlPlane: [undefined, ""] }).mode).toBe("restricted")
  })

  test("allows the control plane and relay the runtime reports back to", () => {
    expect(policy.hosts).toContain("relay.claxedo.test")
    expect(policy.hosts).toContain("cp.claxedo.test")
  })

  test("allows the one git host this workspace clones from", () => {
    expect(policy.hosts).toContain("github.com")
    expect(sandboxSourceHost({ kind: "git", repoUrl: "https://gitlab.com/a/b.git" })).toBe("gitlab.com")
    expect(sandboxSourceHost({ kind: "empty" })).toBeUndefined()
    expect(sandboxSourceHost({ kind: "git", repoUrl: "git@github.com:a/b.git" })).toBeUndefined()
  })

  test("allows the model providers an agent harness has to reach", () => {
    for (const host of SANDBOX_MODEL_PROVIDER_HOSTS) expect(policy.hosts).toContain(host)
  })

  test("does not hand back general-purpose object storage or CDN wildcards", () => {
    // These are the exfiltration channel the allowlist exists to close: an
    // attacker can create a bucket or a worker under any of them.
    for (const denied of [
      "*.workers.dev",
      "r2.cloudflarestorage.com",
      "storage.googleapis.com",
      "*.blob.core.windows.net",
      "*.us-east-1.amazonaws.com",
      "transfer.sh",
    ]) {
      expect(policy.hosts, `${denied} must not be allowlisted by default`).not.toContain(denied)
    }
    // And no wildcard is ever emitted by the baseline.
    expect(policy.hosts?.filter((host) => host.includes("*"))).toEqual([])
  })

  test("operator extras widen the list only when explicitly configured", () => {
    const extended = hostedSandboxNetworkPolicy({
      controlPlane: ["https://cp.test"],
      extraHosts: ["registry.internal.acme.test"],
    })
    expect(extended.hosts).toContain("registry.internal.acme.test")
    expect(policy.hosts).not.toContain("registry.internal.acme.test")
  })

  test("emits each host once", () => {
    const duplicated = hostedSandboxNetworkPolicy({
      controlPlane: ["https://github.com", "https://github.com/"],
      source: { kind: "git", repoUrl: "https://github.com/a/b.git" },
      extraHosts: ["GitHub.com"],
    })
    expect(duplicated.hosts?.filter((host) => host === "github.com")).toHaveLength(1)
  })
})
