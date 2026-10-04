import path from "node:path"

import {
  CERTIFIED_HOSTED_WORKER_ARTIFACT_IDS,
  certifiedHostedWorkerArtifact,
  type CertifiedHostedWorkerArtifactId,
} from "../../src/deployments/hosted-workerd/certified-worker-artifacts"

export const SERVER_ROOT = path.resolve(import.meta.dirname, "../..")
export const REPO_ROOT = path.resolve(SERVER_ROOT, "../..")
export const WORKERD_BOUNDARY_DIST = path.join(SERVER_ROOT, "dist-boundary/workerd")

/**
 * The artifact whose closure the deployed product serves by default: the
 * plain Worker composes the whole hosted core, so its graph is the recorded
 * `server-workerd` boundary manifest.
 */
export const WORKERD_BOUNDARY_MANIFEST_ARTIFACT: CertifiedHostedWorkerArtifactId = "user-deployed-better-auth-d1"

/**
 * Every certified entry answers an unconfigured request with 503 and the code
 * of its `catch` arm (`createBetterAuthD1Worker` in better-auth-d1-worker.cf.ts,
 * which both Agent Plugins entries wrap). The smoke asserts the exact code so
 * a change that starts answering an unconfigured deployment some other way —
 * or that boots far enough to reach product code without bindings — fails here.
 */
const FAIL_CLOSED = Object.freeze({ status: 503, code: "deployment_candidate_unavailable" })

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
    const artifact = certifiedHostedWorkerArtifact(artifactId)
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
      failClosed: FAIL_CLOSED,
    })
  },
)
