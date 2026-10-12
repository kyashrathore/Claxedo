export type SandboxNetworkPolicy = {
  mode: "allow-all" | "restricted"
  hosts?: string[]
  cidrs?: string[]
}

/** Brokered destinations are the minimum egress needed to use the credential. */
export function sandboxNetworkPolicyWithBrokeredHosts(
  policy: SandboxNetworkPolicy,
  secrets: readonly SandboxBrokeredSecret[] | undefined,
): SandboxNetworkPolicy {
  if (policy.mode !== "restricted" || !secrets?.length) return policy
  const hosts = [...new Set([
    ...(policy.hosts ?? []),
    ...secrets.flatMap((secret) => secret.hosts),
  ])].toSorted()
  return {
    ...policy,
    ...(hosts.length ? { hosts } : {}),
  }
}

/** @see SandboxDriverMetadata.egressControl */
export type SandboxEgressControl = "none" | "hosts" | "hosts-and-cidrs"

/**
 * What the manager does with a caller's `net` for a given driver: enforce
 * where the driver can, and say so loudly rather than refuse where it cannot.
 *
 *  - `"enforce"` — the driver gets the policy verbatim and contains the
 *    sandbox. Also the answer when the caller asked for no containment
 *    (absent / `allow-all`), which is nothing to enforce.
 *  - `"withhold"` — the driver declares `egressControl: "none"`, so there is no
 *    containment to be had. The policy is NOT handed down: half the `"none"`
 *    drivers throw on a restricted policy (docker, modal, boat) and the
 *    other half silently drop it (cloudflare, the fetch bridge). Withholding at
 *    the manager means the throwing drivers never see one — their throws stay
 *    in place as their own last line of defence — and the silently-dropping
 *    ones stop pretending. The sandbox comes up with UNRESTRICTED egress, which
 *    is a real exposure, so the manager warns (see `onEgressUnenforced`).
 *  - `"refuse"` — the driver HAS egress control but cannot express this
 *    particular policy's encoding (a hosts-only driver handed an address-only
 *    allowlist). Deliberately still fail-closed: this is a composition mistake
 *    on an otherwise-enforcing driver, and degrading it to "withhold" would
 *    weaken the enforcing path. `hostedSandboxNetworkPolicy` only ever emits
 *    hosts, so no production path reaches it.
 *
 * Pure, like `validateSandboxPersistenceCapabilities`, so the manager, the
 * composition layer, and tests can all ask the same question.
 */
export type SandboxEgressDisposition =
  | { action: "enforce" }
  | { action: "withhold"; reason: "sandbox_egress_uncontained" }
  | { action: "refuse"; reason: "sandbox_egress_policy_unenforceable" }

/** @see SandboxEgressDisposition */
export function sandboxEgressDisposition(
  control: SandboxEgressControl,
  net: SandboxNetworkPolicy | undefined,
): SandboxEgressDisposition {
  if (!net || net.mode === "allow-all") return { action: "enforce" }
  if (control === "none") return { action: "withhold", reason: "sandbox_egress_uncontained" }
  const hosts = net.hosts?.length ?? 0
  const cidrs = net.cidrs?.length ?? 0
  // Deny-all: no allowance to express, and every non-"none" driver can block.
  if (hosts === 0 && cidrs === 0) return { action: "enforce" }
  if (hosts > 0) return { action: "enforce" }
  return control === "hosts-and-cidrs"
    ? { action: "enforce" }
    : { action: "refuse", reason: "sandbox_egress_policy_unenforceable" }
}

/**
 * Emitted whenever a restricted egress policy is withheld because the composed
 * driver declares no egress control: an unrestricted sandbox that nobody was
 * told about is the exposure, so the degrade is never silent.
 *
 * Two phases, because a per-create line is easy to miss in request logs:
 *  - `"composition"` — once per `createSandboxManager` per driver, at boot.
 *  - `"ensure"` — every time a caller's policy is actually withheld, naming the
 *    workspace and the allowlist that did not take effect.
 */
export type SandboxEgressUnenforcedEvent = {
  phase: "composition" | "ensure"
  reason: "sandbox_egress_uncontained"
  /** `SandboxDriver.id` of the composed driver. */
  driver: string
  /** Always `"none"` today — carried so a sink can group without re-deriving. */
  egressControl: SandboxEgressControl
  /** Ready-to-log sentence. Sinks that only forward text can use this alone. */
  message: string
  /** Present on `"ensure"`. */
  workspaceId?: string
  /** The allowlist the caller asked for and did NOT get. Present on `"ensure"`. */
  requested?: SandboxNetworkPolicy
}

/**
 * A credential the SANDBOX must be able to USE for outbound requests but must
 * NEVER be able to READ. Unlike `env` (plaintext, readable — reserved for
 * credentials the agent is trusted with, e.g. the user's own model
 * subscription), a brokered secret's `value` never enters the sandbox: the
 * provider injects it on egress to `hosts` only. Non-model credentials
 * (connection tokens, deploy tokens) belong here.
 *
 * Guarantees enforced by the manager: brokered secrets are never written to
 * labels, never logged, and never captured in a driver snapshot. A driver
 * whose `metadata.secretBrokering` is not `"native"` cannot honor them and the
 * manager refuses to provision (fail-closed).
 */
export type SandboxBrokeredSecret = {
  /** Env var name the sandbox references. */
  name: string
  /** The secret material. Never enters the sandbox in plaintext. */
  value: string
  /** Egress allowlist: the only hosts for which the value is substituted/injected. */
  hosts: string[]
  /**
   * The HTTP header the value is injected as on egress to `hosts`. Every
   * native driver needs one and refuses a secret without it.
   */
  header?: string
  /**
   * The authentication scheme `header` carries, when it has one (`Bearer`).
   *
   * A driver that WRITES the whole header composes `"<scheme> <value>"`; one
   * that SUBSTITUTES a placeholder the sandbox already wrote after the scheme
   * ignores it, because the scheme is in the request before the value is.
   */
  scheme?: string
  /**
   * The methods and path prefixes the credential may be attached to, on top of
   * `hosts`. A vendor host serves far more than the routes a turn needs —
   * api.anthropic.com also answers the organization-admin API — and everything
   * sharing the sandbox reaches the same host.
   *
   * Optional so a producer that has not been taught to state a policy still
   * type-checks, and fails closed instead: a driver that can express them
   * attaches the credential only within them, so an absent or empty policy
   * names a host and nothing else, and nothing is spendable at a host alone. A
   * driver whose provider cannot express them documents that it drops them,
   * and the host allowlist is all the containment there is.
   */
  methods?: readonly string[]
  pathPrefixes?: readonly string[]
}

/**
 * What the sandbox presents so a header-injecting driver recognizes the request
 * as one asking for that secret.
 *
 * Carries no authority: the value is attached at the edge, keyed by the host
 * and this string, and the string itself is never accepted by a vendor. The
 * Cloudflare sandbox Worker is deployed on its own and cannot depend on this
 * package, so it matches on its own copy of the prefix; a driver minting
 * anything else sends every brokered request upstream bare, which is what
 * `brokered-placeholder.test.ts` exists to catch.
 */
export function brokeredSecretPlaceholder(name: string) {
  return `claxedo-broker:${name}`
}

/** The environment a header-injecting driver must add so the sandbox can present each secret. */
export function brokeredPlaceholderEnv(
  secrets: readonly SandboxBrokeredSecret[] | undefined,
): Record<string, string> {
  return Object.fromEntries((secrets ?? []).map((secret) => [secret.name, brokeredSecretPlaceholder(secret.name)]))
}
