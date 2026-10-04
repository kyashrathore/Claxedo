/**
 * Closed inventory of Worker artifacts that deployment tooling may publish.
 *
 * An entry in this table is stronger than "a TypeScript file exists": it says
 * the file has a default Worker export and its resource closure is known.
 * Adding an artifact therefore requires updating the renderer, closure tests,
 * and a real Wrangler dry run in the same change.
 */

export const CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS = [
  "user-deployed-better-auth-d1",
  "user-deployed-better-auth-d1-agent-plugins",
  "user-deployed-better-auth-d1-agent-plugins-full-hosted",
] as const

export type CertifiedHostedWorkerArtifactId = (typeof CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS)[number]

/**
 * Worker names retired from this repository.
 *
 * Cloudflare keys a Worker's append-only Durable Object migration history by
 * Worker NAME, and that history outlives the config that declared it — this
 * repo no longer carries one for these. Reusing a name would inherit a
 * migration ladder nothing here can express, so a deployment must never take
 * one.
 */
export const RESERVED_LEGACY_WORKER_NAMES = Object.freeze([
  "claxedo-control-plane",
  "claxedo-control-plane-staging",
] as const)

const RESERVED_LEGACY_WORKER_NAME_SET = new Set<string>(RESERVED_LEGACY_WORKER_NAMES)

export function requireNonLegacyWorkerName(name: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(name)) {
    throw new Error("Worker names must be valid Cloudflare Worker identifiers")
  }
  if (RESERVED_LEGACY_WORKER_NAME_SET.has(name)) {
    throw new Error(`${name} is reserved by the legacy Worker and its append-only Durable Object migration history`)
  }
  return name
}

const ARTIFACTS = Object.freeze({
  "user-deployed-better-auth-d1": Object.freeze({
    artifactId: "user-deployed-better-auth-d1" as const,
    sandboxPosture: "control-plane-only" as const,
    entrypointFromPackageRoot: "src/deployments/hosted-workerd/better-auth-d1-worker.cf.ts",
    agentPlugins: false,
  }),
  // A feature-selected artifact of the same user-deployed product, not a
  // second product. It adds the immutable plugin artifact bucket, the
  // org-partitioned credential namespace, and the plugin-backend platform:
  // the Worker Loader binding and the PluginSupervisor Durable Object.
  "user-deployed-better-auth-d1-agent-plugins": Object.freeze({
    artifactId: "user-deployed-better-auth-d1-agent-plugins" as const,
    sandboxPosture: "control-plane-only" as const,
    entrypointFromPackageRoot: "src/deployments/hosted-workerd/better-auth-d1-worker.agent-plugins.cf.ts",
    agentPlugins: true,
  }),
  // The Agent Plugins composition plus cloud workspace execution, selected by
  // CLAXEDO_SANDBOX_DRIVER over the D1 lease store. It is the only artifact
  // whose closure may carry a sandbox provider SDK.
  "user-deployed-better-auth-d1-agent-plugins-full-hosted": Object.freeze({
    artifactId: "user-deployed-better-auth-d1-agent-plugins-full-hosted" as const,
    sandboxPosture: "full-hosted" as const,
    entrypointFromPackageRoot: "src/deployments/hosted-workerd/better-auth-d1-worker.agent-plugins.full-hosted.cf.ts",
    agentPlugins: true,
  }),
})

export type CertifiedHostedWorkerArtifact = (typeof ARTIFACTS)[CertifiedHostedWorkerArtifactId]

export function certifiedHostedWorkerArtifact(artifactId: unknown): CertifiedHostedWorkerArtifact {
  const certifiedId = CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS.find((candidate) => candidate === artifactId)
  if (!certifiedId) throw new Error(`Worker artifact ${JSON.stringify(artifactId)} is not certified`)
  return ARTIFACTS[certifiedId]
}

/** The artifact a deployment's feature selection publishes. */
export function selectHostedWorkerArtifact(input: { agentPlugins: boolean; fullHosted: boolean }) {
  if (input.fullHosted && !input.agentPlugins) {
    throw new Error("the full-hosted Worker is an Agent Plugins artifact; select --agent-plugins")
  }
  if (input.fullHosted) return ARTIFACTS["user-deployed-better-auth-d1-agent-plugins-full-hosted"]
  return input.agentPlugins ? ARTIFACTS["user-deployed-better-auth-d1-agent-plugins"] : ARTIFACTS["user-deployed-better-auth-d1"]
}
