/**
 * What a self-hosted single-binary must have before it serves anything.
 *
 * The mirror of `assertHostedAppBootConfig`, and deliberately NOT that
 * function. Both guard the same routes; they guard them for different trust
 * postures, and the postures are incompatible:
 *
 *   | | cloud-hosted | self-hosted |
 *   |---|---|---|
 *   | deployment mode | `hosted` | `self-hosted` |
 *   | auth | signed Clerk issuer + JWKS | embedded auth |
 *   | authority | remote workspace authority URL | local SQLite |
 *
 * A single assertion covering both would have to accept "either a Clerk issuer
 * or embedded auth" and "either a remote authority or SQLite" — which is no
 * longer a check that a cloud deployment is configured as a cloud deployment.
 * A misconfigured hosted build would sail through it by looking self-hosted.
 * That is why the shared route core asserts nothing and each deployment brings
 * its own gate.
 *
 * Reports every failure at once. An operator bringing up a self-host fixes
 * these one environment variable at a time otherwise, restarting between each.
 *
 * NOT YET WIRED, and the reason is Unit 7's whole justification. Attempting to
 * call this from today's `deployments/local/server.ts#createApp` fails 24
 * tests: that composition also serves a `CLAXEDO_DEPLOYMENT_MODE=local` mode
 * with no embedded auth and no authority. `createApp` is not the self-hosted
 * product — it is the self-hosted product AND something else sharing one
 * function, which is precisely what the recomposition separates.
 *
 * Making it fit would mean weakening the gate until it accepted the mixed mode,
 * at which point it would stop being a check. So it waits for
 * `createSelfHostedApp`, whose only caller is the self-hosted entry.
 */

export type SelfHostedPosture = {
  deploymentMode: string
  /** Whether the embedded auth adapter is composed. */
  embeddedAuth: boolean
  /** Whether a workspace authority is composed at all. */
  authority: boolean
  /** True when the composed authority is the local SQLite one. */
  sqliteAuthority: boolean
  /** Whether the local-execution adapter is composed. */
  localExecution: boolean
  /** Set when static SPA serving is configured; its absence is not an error. */
  staticAppDir?: string
  /** Whether that directory actually exists, when one is configured. */
  staticAppDirExists?: boolean
}

export class SelfHostedCompositionError extends Error {
  readonly code = "self_hosted_composition_invalid"
}

export function assertSelfHostedPosture(posture: SelfHostedPosture) {
  const failures: string[] = []

  if (posture.deploymentMode !== "self-hosted") {
    failures.push(
      `deployment mode is "${posture.deploymentMode}", not self-hosted`
      + " (set CLAXEDO_DEPLOYMENT_MODE=self-hosted)",
    )
  }
  if (!posture.embeddedAuth) {
    failures.push("embedded auth is not composed; a self-hosted binary has no identity provider without it")
  }
  if (!posture.authority) {
    failures.push("no workspace authority is composed")
  } else if (!posture.sqliteAuthority) {
    // Specifically rejected, not merely unexpected. A self-hosted binary
    // pointed at a remote authority would be a single-tenant deployment
    // writing into someone else's control plane.
    failures.push("the composed workspace authority is not the local SQLite one")
  }
  if (!posture.localExecution) {
    // The product IS local execution. Without the adapter it boots and serves
    // an app that cannot open a project — a working health check over a shell
    // with nothing in it.
    failures.push("no local-execution adapter is composed; this deployment could not open a workspace")
  }
  if (posture.staticAppDir && posture.staticAppDirExists === false) {
    // Configured but absent means a build step did not run. Serving the API
    // with no UI looks like a broken app rather than a broken deploy.
    failures.push(`the configured static app directory does not exist: ${posture.staticAppDir}`)
  }

  if (failures.length > 0) {
    throw new SelfHostedCompositionError(
      `Self-hosted control plane refuses to start: ${failures.join("; ")}`,
    )
  }
}
