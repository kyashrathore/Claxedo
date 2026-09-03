import path from "node:path"

import {
  CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS,
  certifiedHostedWorkerArtifact,
  type CertifiedHostedWorkerArtifactId,
  type CertifiedHostedWorkerEnvironment,
} from "../../src/deployments/hosted-workerd/certified-worker-artifacts"

export const SERVER_ROOT = path.resolve(import.meta.dirname, "../..")
export const REPO_ROOT = path.resolve(SERVER_ROOT, "../..")
export const WORKERD_BOUNDARY_DIST = path.join(SERVER_ROOT, "dist-boundary/workerd")

/**
 * The gate bundles the staging release train.
 *
 * Only the Worker name and `CLAXEDO_ENVIRONMENT_ID` differ between the two
 * environments, so staging exercises the same module graph while keeping a
 * production Worker name out of a CI artifact.
 */
export const WORKERD_BOUNDARY_ENVIRONMENT: CertifiedHostedWorkerEnvironment = "staging"

/**
 * The artifact whose closure the deployed product actually serves.
 *
 * The release train publishes the locked entry first and the candidate at
 * cutover (see scripts/deploy/release-better-auth-d1.ts); the candidate is the
 * one that composes the whole hosted core, so its graph is the recorded
 * `server-workerd` boundary manifest.
 */
export const WORKERD_BOUNDARY_MANIFEST_ARTIFACT: CertifiedHostedWorkerArtifactId =
  "user-deployed-better-auth-d1-candidate"

/**
 * The documented fail-closed answer of each certified entry, by artifact.
 *
 * Every certified entry answers an unconfigured request with 503 and a code
 * naming why it refused — the locked worker's and candidate's `catch` arms
 * (better-auth-d1-locked-worker.cf.ts, better-auth-d1-candidate-worker.cf.ts)
 * and the bootstrap gate the bridge re-exports
 * (better-auth-d1-bootstrap-gate.cf.ts). The smoke asserts the exact code so a
 * change that starts answering an unconfigured deployment some other way — or
 * that boots far enough to reach product code without bindings — fails here.
 */
const FAIL_CLOSED: Readonly<Record<CertifiedHostedWorkerArtifactId, { status: number; code: string }>> = Object.freeze({
  "user-deployed-better-auth-d1-locked": { status: 503, code: "deployment_unavailable" },
  "user-deployed-better-auth-d1-candidate": { status: 503, code: "deployment_candidate_unavailable" },
  "user-deployed-better-auth-d1-live-sync-migration-bridge": { status: 503, code: "deployment_bootstrap" },
})

export type WorkerdBoundaryTarget = Readonly<{
  artifactId: CertifiedHostedWorkerArtifactId
  entrypointFromPackageRoot: string
  outputDirectory: string
  bundleFile: string
  metafileFile: string
  /** The exact config Wrangler bundled with, kept so the smoke boots the built entry under the same compatibility contract. */
  configFile: string
  failClosed: Readonly<{ status: number; code: string }>
}>

/**
 * Every certified Worker artifact, as this gate's build/boot targets.
 *
 * certified-worker-artifacts.ts states that an entry in its closed inventory
 * has "a real Wrangler dry run" behind it. Deriving the targets from that
 * inventory is what keeps the claim true: certifying a new artifact fails this
 * gate until the artifact bundles and is proven to fail closed.
 */
export const WORKERD_BOUNDARY_TARGETS: readonly WorkerdBoundaryTarget[] = CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS.map(
  (artifactId) => {
    const artifact = certifiedHostedWorkerArtifact(artifactId, WORKERD_BOUNDARY_ENVIRONMENT)
    const outputDirectory = path.join(WORKERD_BOUNDARY_DIST, artifactId)
    // Wrangler names its emitted module after the entry file.
    const bundleName = `${path.basename(artifact.entrypointFromPackageRoot, ".ts")}.js`
    return Object.freeze({
      artifactId,
      entrypointFromPackageRoot: artifact.entrypointFromPackageRoot,
      outputDirectory,
      bundleFile: path.join(outputDirectory, bundleName),
      metafileFile: path.join(outputDirectory, "meta.json"),
      configFile: path.join(outputDirectory, "boundary-wrangler.toml"),
      failClosed: FAIL_CLOSED[artifactId],
    })
  },
)
