/**
 * Closed inventory of Worker artifacts that deployment tooling may publish.
 *
 * An entry in this table is stronger than "a TypeScript file exists": it says
 * the file has a default Worker export, its resource closure is known, and its
 * Worker name cannot collide with a retired deployment's Worker name.
 * Adding an artifact therefore requires updating the renderer, closure tests,
 * and a real Wrangler dry run in the same change.
 */

export const CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS = [
  "user-deployed-better-auth-d1-locked",
  "user-deployed-better-auth-d1-live-sync-migration-bridge",
  "user-deployed-better-auth-d1-candidate",
  "user-deployed-better-auth-d1-candidate-agent-plugins",
  "user-deployed-better-auth-d1-candidate-agent-plugins-full-hosted",
] as const

export type CertifiedHostedWorkerArtifactId = (typeof CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS)[number]
export type CertifiedHostedWorkerEnvironment = "production" | "staging"

/**
 * Worker names retired from this repository.
 *
 * Cloudflare keys a Worker's append-only Durable Object migration history by
 * Worker NAME, and that history outlives the config that declared it — this
 * repo no longer carries one for these. Reusing a name would inherit a
 * migration ladder nothing here can express, so a generated deployment must
 * never take one.
 */
export const RESERVED_LEGACY_WORKER_NAMES = Object.freeze([
  "claxedo-control-plane",
  "claxedo-control-plane-staging",
] as const)

const RESERVED_LEGACY_WORKER_NAME_SET = new Set<string>(RESERVED_LEGACY_WORKER_NAMES)

export function requireNonLegacyWorkerName(name: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(name)) {
    throw new Error("certified Worker names must be valid Cloudflare Worker identifiers")
  }
  if (RESERVED_LEGACY_WORKER_NAME_SET.has(name)) {
    throw new Error(`${name} is reserved by the legacy Worker and its append-only Durable Object migration history`)
  }
  return name
}

const LOCKED_ENTRYPOINT = "src/deployments/hosted-workerd/better-auth-d1-locked-worker.cf.ts"
const LIVE_SYNC_MIGRATION_BRIDGE_ENTRYPOINT =
  "src/deployments/hosted-workerd/better-auth-d1-live-sync-migration-bridge.cf.ts"
const CANDIDATE_ENTRYPOINT = "src/deployments/hosted-workerd/better-auth-d1-candidate-worker.cf.ts"
const CANDIDATE_AGENT_PLUGINS_ENTRYPOINT =
  "src/deployments/hosted-workerd/better-auth-d1-candidate-worker.agent-plugins.cf.ts"
const CANDIDATE_AGENT_PLUGINS_FULL_HOSTED_ENTRYPOINT =
  "src/deployments/hosted-workerd/better-auth-d1-candidate-worker.agent-plugins.full-hosted.cf.ts"

const ARTIFACTS = Object.freeze({
  "user-deployed-better-auth-d1-locked": Object.freeze({
    artifactId: "user-deployed-better-auth-d1-locked" as const,
    adapterProfile: "better-auth-d1" as const,
    productPosture: "user-deployed" as const,
    sandboxPosture: "control-plane-only" as const,
    entrypointFromPackageRoot: LOCKED_ENTRYPOINT,
    entrypointFromPackageChild: `../${LOCKED_ENTRYPOINT}`,
    bootstrapEntrypointFromPackageRoot: "src/deployments/hosted-workerd/better-auth-d1-bootstrap-gate.cf.ts",
    workerNames: Object.freeze({
      production: "claxedo-user-deployed-locked",
      staging: "claxedo-user-deployed-locked-staging",
    }),
    resources: Object.freeze({
      authDatabase: true as const,
      controlPlaneDatabase: true as const,
      requestLimiter: true as const,
      liveSyncRoom: false as const,
      optionalServices: false as const,
      billing: false as const,
      sandboxDriver: false as const,
    }),
  }),
  "user-deployed-better-auth-d1-candidate": Object.freeze({
    artifactId: "user-deployed-better-auth-d1-candidate" as const,
    adapterProfile: "better-auth-d1" as const,
    productPosture: "user-deployed" as const,
    sandboxPosture: "control-plane-only" as const,
    entrypointFromPackageRoot: CANDIDATE_ENTRYPOINT,
    entrypointFromPackageChild: `../${CANDIDATE_ENTRYPOINT}`,
    workerNames: Object.freeze({
      production: "claxedo-user-deployed-locked",
      staging: "claxedo-user-deployed-locked-staging",
    }),
    resources: Object.freeze({
      authDatabase: true as const,
      controlPlaneDatabase: true as const,
      requestLimiter: true as const,
      liveSyncRoom: true as const,
      optionalServices: false as const,
      billing: false as const,
      sandboxDriver: false as const,
    }),
  }),
  // The same release train and Worker name as the plain candidate: the Agent
  // Plugins build is a feature-selected artifact of the user-deployed product,
  // not a second product. It adds the immutable plugin artifact bucket and the
  // org-partitioned credential namespace, and nothing else.
  "user-deployed-better-auth-d1-candidate-agent-plugins": Object.freeze({
    artifactId: "user-deployed-better-auth-d1-candidate-agent-plugins" as const,
    adapterProfile: "better-auth-d1" as const,
    productPosture: "user-deployed" as const,
    sandboxPosture: "control-plane-only" as const,
    entrypointFromPackageRoot: CANDIDATE_AGENT_PLUGINS_ENTRYPOINT,
    entrypointFromPackageChild: `../${CANDIDATE_AGENT_PLUGINS_ENTRYPOINT}`,
    workerNames: Object.freeze({
      production: "claxedo-user-deployed-locked",
      staging: "claxedo-user-deployed-locked-staging",
    }),
    resources: Object.freeze({
      authDatabase: true as const,
      controlPlaneDatabase: true as const,
      requestLimiter: true as const,
      liveSyncRoom: true as const,
      optionalServices: false as const,
      billing: false as const,
      sandboxDriver: false as const,
      agentPlugins: true as const,
    }),
  }),
  // The same release train again, now with cloud workspace execution: the
  // Agent Plugins composition plus a sandbox driver selected by
  // CLAXEDO_SANDBOX_DRIVER and the D1 lease store. It is the only artifact
  // whose closure may carry a sandbox provider SDK.
  "user-deployed-better-auth-d1-candidate-agent-plugins-full-hosted": Object.freeze({
    artifactId: "user-deployed-better-auth-d1-candidate-agent-plugins-full-hosted" as const,
    adapterProfile: "better-auth-d1" as const,
    productPosture: "user-deployed" as const,
    sandboxPosture: "full-hosted" as const,
    entrypointFromPackageRoot: CANDIDATE_AGENT_PLUGINS_FULL_HOSTED_ENTRYPOINT,
    entrypointFromPackageChild: `../${CANDIDATE_AGENT_PLUGINS_FULL_HOSTED_ENTRYPOINT}`,
    workerNames: Object.freeze({
      production: "claxedo-user-deployed-locked",
      staging: "claxedo-user-deployed-locked-staging",
    }),
    resources: Object.freeze({
      authDatabase: true as const,
      controlPlaneDatabase: true as const,
      requestLimiter: true as const,
      liveSyncRoom: true as const,
      optionalServices: false as const,
      billing: false as const,
      sandboxDriver: true as const,
      agentPlugins: true as const,
    }),
  }),
  "user-deployed-better-auth-d1-live-sync-migration-bridge": Object.freeze({
    artifactId: "user-deployed-better-auth-d1-live-sync-migration-bridge" as const,
    adapterProfile: "better-auth-d1" as const,
    productPosture: "user-deployed" as const,
    sandboxPosture: "control-plane-only" as const,
    entrypointFromPackageRoot: LIVE_SYNC_MIGRATION_BRIDGE_ENTRYPOINT,
    entrypointFromPackageChild: `../${LIVE_SYNC_MIGRATION_BRIDGE_ENTRYPOINT}`,
    workerNames: Object.freeze({
      production: "claxedo-user-deployed-locked",
      staging: "claxedo-user-deployed-locked-staging",
    }),
    resources: Object.freeze({
      authDatabase: true as const,
      controlPlaneDatabase: true as const,
      requestLimiter: true as const,
      liveSyncRoom: true as const,
      optionalServices: false as const,
      billing: false as const,
      sandboxDriver: false as const,
    }),
  }),
})

type CertifiedArtifact<Id extends CertifiedHostedWorkerArtifactId> = Readonly<
  (typeof ARTIFACTS)[Id] & {
    environment: CertifiedHostedWorkerEnvironment
    workerName: string
  }
>

export function certifiedHostedWorkerArtifact<const Id extends CertifiedHostedWorkerArtifactId>(
  artifactId: Id,
  environment: unknown,
): CertifiedArtifact<Id>
export function certifiedHostedWorkerArtifact(
  artifactId: unknown,
  environment: unknown,
): CertifiedArtifact<CertifiedHostedWorkerArtifactId>
export function certifiedHostedWorkerArtifact(artifactId: unknown, environment: unknown) {
  if (
    typeof artifactId !== "string" ||
    !CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS.some((candidate) => candidate === artifactId)
  ) {
    throw new Error(`Worker artifact ${JSON.stringify(artifactId)} is not certified`)
  }
  if (environment !== "production" && environment !== "staging") {
    throw new Error('certified Worker environment must be "production" or "staging"')
  }
  const artifact = ARTIFACTS[artifactId as CertifiedHostedWorkerArtifactId]
  const workerName = requireNonLegacyWorkerName(artifact.workerNames[environment])
  return Object.freeze({ ...artifact, environment, workerName }) as CertifiedArtifact<CertifiedHostedWorkerArtifactId>
}
