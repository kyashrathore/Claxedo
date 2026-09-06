/**
 * What a self-hosted single-binary must have before it serves anything.
 *
 * The mirror of `assertHostedAppBootConfig`, and deliberately NOT that
 * function. Both guard the same routes; they guard them for different trust
 * postures, and the postures are incompatible:
 *
 *   | | cloud-hosted | self-hosted |
 *   |---|---|---|
 *   | trust posture | `hosted` | `local` |
 *   | auth | signed issuer + JWKS | unsigned-local, or embedded auth |
 *   | authority | remote workspace authority URL | local SQLite |
 *
 * A single assertion covering both would have to accept "either a provider issuer
 * or embedded auth" and "either a remote authority or SQLite" — which is no
 * longer a check that a cloud deployment is configured as a cloud deployment.
 * A misconfigured hosted build would sail through it by looking self-hosted.
 * That is why the shared route core asserts nothing and each deployment brings
 * its own gate.
 *
 * Reports every failure at once. An operator bringing up a self-host fixes
 * these one environment variable at a time otherwise, restarting between each.
 *
 * Asserted twice: by `startSelfHostedServer` before anything is composed, and
 * by `createSelfHostedApp` when handed a `posture` option. The posture is
 * passed in rather than read from `process.env` inside the composition so a
 * test can exercise the gate without setting six variables.
 */

export type SelfHostedPosture = {
  deploymentMode: string
  /**
   * Whether the embedded auth adapter is composed.
   *
   * Recorded, not required — see the note in `assertSelfHostedPosture`. This is
   * the multi-user opt-in, and single-user self-hosts legitimately run without
   * it.
   */
  embeddedAuth: boolean
  /** Whether a workspace authority is composed at all. */
  authority: boolean
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

  // `local`, not `self-hosted`: the mode enum is a trust posture, not a
  // product name (a self-hosted box on a public domain with signed auth is
  // `trust=hosted`), so the single binary's posture is `local`.
  if (posture.deploymentMode !== "local") {
    failures.push(
      `deployment mode is "${posture.deploymentMode}", but the self-hosted binary runs at trust posture "local"`
      + " (unset CLAXEDO_DEPLOYMENT_MODE, or set it to local)",
    )
  }
  // Embedded auth is deliberately NOT required.
  //
  // `CLAXEDO_EMBEDDED_AUTH` is an opt-in for MULTI-USER self-hosting. A
  // personal self-host on a private box runs without it, behind the
  // unsigned-local gate, and that is a supported deployment — requiring it
  // here would refuse to start a configuration that works today. Observed
  // rather than asserted, so the field is available to a caller that has a
  // reason to care.
  if (!posture.authority) {
    failures.push("no workspace authority is composed")
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
