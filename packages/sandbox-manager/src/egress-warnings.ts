import type { SandboxEgressControl, SandboxEgressUnenforcedEvent, SandboxNetworkPolicy } from "./egress-policy"

function egressUnenforcedMessage(input: {
  phase: "composition" | "ensure"
  driver: string
  workspaceId?: string
  requested?: SandboxNetworkPolicy
}) {
  const scope = input.workspaceId ? `workspace ${input.workspaceId}` : "every sandbox it provisions"
  const withheld = input.requested
    ? ` The requested allowlist (${(input.requested.hosts ?? []).length} host(s), ` +
      `${(input.requested.cidrs ?? []).length} cidr(s)) was withheld, not applied.`
    : ""
  return (
    `[sandbox-manager] SANDBOX EGRESS IS UNRESTRICTED: driver "${input.driver}" declares ` +
    `egressControl: "none", so ${scope} can reach ANY host on the internet, including ` +
    `attacker-controlled buckets — agent-authored code inside the sandbox has an unmonitored ` +
    `exfiltration path.${withheld} Select a driver that can enforce egress (vercel) ` +
    `to close it. See public-docs/sandbox-egress.md.`
  )
}

/**
 * Drivers already warned about at composition time, so a control plane that
 * composes its services per request (the hosted Worker does) logs the boot
 * warning once per isolate instead of once per request. Keyed by driver id +
 * declared capability, never by workspace.
 */
const compositionEgressWarnings = new Set<string>()

/**
 * Drivers whose withheld policy was already reported from a start in this
 * isolate. Every connection to a sleeping or starting cloud workspace runs
 * the manager's admission, so without this the hosted Worker logged the same
 * paragraph on each of them; the first start names the driver, one workspace
 * and the allowlist it withheld, which is what an operator needs to act.
 */
const ensureEgressWarnings = new Set<string>()

function defaultEgressUnenforcedSink(event: SandboxEgressUnenforcedEvent) {
  console.warn(event.message)
}

/**
 * The two halves of the warning that a driver runs sandboxes with unrestricted
 * egress. The composition half is raised here, once per driver per isolate: a
 * per-create line lands in request logs and is easy to miss, this one lands
 * wherever the process starts, so an operator learns of it BEFORE the first
 * workspace exists. `withheld` is the start half, raised once per driver per
 * isolate from the first start whose policy the driver could not enforce.
 */
export function createEgressWarnings(input: {
  driver: { id: string; egressControl: SandboxEgressControl }
  sink?: (event: SandboxEgressUnenforcedEvent) => void
}) {
  const { id, egressControl } = input.driver
  const sink = input.sink ?? defaultEgressUnenforcedSink
  const key = `${id}|${egressControl}`
  if (egressControl === "none" && !compositionEgressWarnings.has(key)) {
    compositionEgressWarnings.add(key)
    sink({
      phase: "composition",
      reason: "sandbox_egress_uncontained",
      driver: id,
      egressControl,
      message: egressUnenforcedMessage({ phase: "composition", driver: id }),
    })
  }
  return {
    withheld(start: { workspaceId: string; labels?: Record<string, string>; requested: SandboxNetworkPolicy }) {
      if (ensureEgressWarnings.has(key)) return
      ensureEgressWarnings.add(key)
      sink({
        phase: "ensure",
        reason: "sandbox_egress_uncontained",
        driver: id,
        egressControl,
        message: egressUnenforcedMessage({ phase: "ensure", driver: id, workspaceId: start.workspaceId, requested: start.requested }),
        workspaceId: start.workspaceId,
        ...(start.labels ? { labels: start.labels } : {}),
        requested: start.requested,
      })
    },
  }
}
