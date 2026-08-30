/**
 * The egress allowlist a HOSTED, multi-tenant sandbox is provisioned with.
 *
 * A hosted sandbox runs agent-authored code on the operator's infrastructure,
 * next to other tenants' sandboxes, holding a checkout of the user's private
 * repository and (via `SandboxBrokeredSecret`) the ability to spend the
 * operator's model credits. The default for that shape of workload is
 * restrictive, not allow-all: the interesting attack is not "the agent
 * downloads a package", it is "the agent POSTs the repository to a host the
 * attacker controls". An allowlist is what makes that fail.
 *
 * Every entry below has to earn its place, so the list is assembled from three
 * sources of truth rather than from taste:
 *
 *   1. DERIVED PER REQUEST — the control plane the sandbox reports back to and
 *      the git host it clones from. These differ per deployment and per
 *      workspace, so they are inputs, not constants.
 *   2. MODEL PROVIDERS — the endpoints an agent harness must reach to do any
 *      work at all. Taken from the harness→provider mapping the credential
 *      layer already maintains (`PROVIDER_TO_GROUP` /`DEFAULT_ALLOWLIST` in
 *      claxedo-server's `network/types.ts`), narrowed to the API hostnames.
 *   3. PACKAGE REGISTRIES — an agent that cannot install a dependency cannot
 *      edit a real repository. Same source, again narrowed.
 *
 * What is deliberately NOT here, despite being in that same default list:
 * general-purpose object storage and CDN wildcards (`*.workers.dev`,
 * `r2.cloudflarestorage.com`, `storage.googleapis.com`,
 * `*.blob.core.windows.net`, `*.amazonaws.com`). Every one of those is a
 * bucket an attacker can create in their own account, so allowlisting them
 * hands back exactly the exfiltration channel the policy exists to close. A
 * deployment that genuinely needs one adds it through `extraHosts` as an
 * explicit, auditable decision.
 *
 * This module is data + string handling only, so it runs unchanged inside the
 * hosted Worker (no DNS, no node builtins). That matters: name-based policy is
 * the only kind the Worker can compute, which is why `egressControl` treats
 * name filtering as the capability that qualifies a driver for hosted use.
 */

import type { SandboxNetworkPolicy, SandboxSource } from "."

/**
 * Model-provider endpoints. Derived from the harness→provider groups in
 * claxedo-server `network/types.ts` (`PROVIDER_TO_GROUP`): claude-sdk →
 * anthropic, codex-app-server/cursor-sdk → openai,
 * google → google_ai; plus the aggregator and catalog endpoints the engine
 * itself fetches at startup.
 */
export const SANDBOX_MODEL_PROVIDER_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "openrouter.ai",
  // Model catalog + engine config, fetched on runner startup.
  "models.dev",
  "opencode.ai",
] as const

/**
 * Package registries. Narrowed from the npm / pypi / rust / golang groups of
 * `DEFAULT_ALLOWLIST` to the hostnames a package install actually contacts —
 * the wildcard CDN entries in those groups are excluded on purpose (see the
 * module comment).
 */
export const SANDBOX_PACKAGE_REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "nodejs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
] as const

/** The deployment-independent floor: providers + registries. */
export const SANDBOX_BASELINE_EGRESS_HOSTS = [
  ...SANDBOX_MODEL_PROVIDER_HOSTS,
  ...SANDBOX_PACKAGE_REGISTRY_HOSTS,
] as const

/** Hostname of a URL-ish string, or undefined when it is not one. */
function hostOf(value: string | undefined): string | undefined {
  const raw = value?.trim()
  if (!raw) return
  try {
    const host = new URL(raw).hostname.trim().toLowerCase()
    return host ? host : undefined
  } catch {
    return
  }
}

/**
 * The git host this workspace clones from.
 *
 * Scoped to the ONE repository host in the request rather than to a forge
 * allowlist, matching how `authenticatedGitHubCloneSource` scopes the clone
 * credential it brokers (`hosts: ["github.com"]`) — the credential and the
 * network policy should describe the same reachable surface.
 */
export function sandboxSourceHost(source: SandboxSource | undefined): string | undefined {
  if (!source || source.kind !== "git") return
  return hostOf(source.repoUrl)
}

export type HostedSandboxNetworkPolicyInput = {
  /**
   * Control-plane and relay endpoints the runtime reports back to: the relay
   * it tunnels through and fetches `WORKSPACE_RUNTIME_RELAY_JWKS_URL` from,
   * and the control-plane origin serving `WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL`
   * plus register/heartbeat. URLs or bare hostnames; blanks are ignored.
   */
  controlPlane: Array<string | undefined>
  /** Workspace source — its git host is allowed, nothing else on that forge. */
  source?: SandboxSource
  /** Operator escape hatch for deployment-specific hosts. */
  extraHosts?: readonly string[]
}

/**
 * Build the restricted policy for a hosted sandbox.
 *
 * Always `mode: "restricted"`. There is no input that makes this return
 * allow-all — a hosted sandbox with an empty or unresolvable control-plane URL
 * is a misconfiguration, and answering it with "then allow everything" is how
 * the gap this closes came to exist in the first place.
 */
export function hostedSandboxNetworkPolicy(input: HostedSandboxNetworkPolicyInput): SandboxNetworkPolicy {
  const hosts = new Set<string>()
  for (const entry of input.controlPlane) {
    const host = hostOf(entry) ?? entry?.trim().toLowerCase()
    if (host) hosts.add(host)
  }
  const sourceHost = sandboxSourceHost(input.source)
  if (sourceHost) hosts.add(sourceHost)
  for (const host of SANDBOX_BASELINE_EGRESS_HOSTS) hosts.add(host)
  for (const host of input.extraHosts ?? []) {
    const trimmed = host.trim().toLowerCase()
    if (trimmed) hosts.add(trimmed)
  }
  return { mode: "restricted", hosts: [...hosts] }
}
