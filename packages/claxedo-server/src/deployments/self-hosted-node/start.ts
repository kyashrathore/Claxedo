/**
 * The self-hosted single binary's start path.
 *
 * Unit 7 moves the self-hosted product onto its own composition. This is the
 * first half of that move, and it is the half that can land without breaking
 * anything: the entry point, its boot gate, and the ownership statement that
 * `deployments/local` is no longer a shared thing.
 *
 * The measurement that made this possible: after Unit 5 the desktop boots
 * `@claxedo/local-server`, so `startServer` in `deployments/self-hosted-node/app.ts`
 * has exactly ONE production caller left — the self-hosted entry. Its own
 * comment still claimed two. That file is now self-hosted's private
 * implementation rather than a shared composition, and this module is the
 * public way in.
 *
 * What has NOT moved yet: the 1,270-line `createSelfHostedApp` body, which still lives
 * in `deployments/self-hosted-node/app.ts` and is still reached by ~24 tests that
 * construct it with a `local` deployment mode and no authority. Those tests are
 * why the posture gate cannot simply be added there — see `posture.ts`. They
 * are the remaining migration, and until they move, `createSelfHostedApp` stays exported
 * for them and unreachable from production.
 */

import fs from "node:fs"
import path from "node:path"
import { deploymentMode } from "@claxedo/server-core/authority/deployment-mode"
import { convexAuthorityUrlFromEnv } from "../../authority/adapters/convex/workspace-authority"
import { embeddedAuthEnabled } from "./embedded-auth"
import { selfHostedCapabilities } from "./capabilities"
import { startServer } from "./app"
import { assertSelfHostedPosture } from "./posture"

export type SelfHostedStartOptions = {
  port: number
  /** An explicit URL opts out of the embedded engine. */
  opencodeUrl?: string
  env?: NodeJS.ProcessEnv
}

/**
 * The static-app half of the posture, as data.
 *
 * Absent is valid — an API-only self-host is supported. Configured but missing
 * means a build step did not run, and serving the API with no UI reads to a
 * user as a broken app rather than a broken deploy.
 */
export function staticAppPosture(staticDir: string | undefined) {
  if (!staticDir) return {}
  return {
    staticAppDir: staticDir,
    staticAppDirExists: fs.existsSync(path.join(staticDir, "index.html")),
  }
}

/**
 * Which workspace authority this environment will actually compose.
 *
 * `createDefaultLocalControlPlaneServices` chooses Convex only for hosted
 * trust; local trust deliberately stays on SQLite even when a developer's
 * environment contains a stale hosted URL. Read both inputs here too, so the
 * posture reports the authority the composition is about to build.
 */
export function selectedWorkspaceAuthority(env: NodeJS.ProcessEnv): "convex" | "sqlite" {
  return deploymentMode(env) === "hosted" && convexAuthorityUrlFromEnv(env) ? "convex" : "sqlite"
}

/**
 * The posture this process is actually in, read from its environment.
 *
 * Separate from the assertion so a test can inspect what was measured without
 * booting a server, and so the two concerns — observing and judging — do not
 * end up in one function that is hard to exercise.
 */
export function selfHostedPosture(env: NodeJS.ProcessEnv) {
  // Read ONCE and used for both authority fields, so they cannot disagree
  // about the same composition.
  const workspaceAuthority = selectedWorkspaceAuthority(env)
  return {
    deploymentMode: deploymentMode(env),
    embeddedAuth: embeddedAuthEnabled(env),
    // Both arms of that branch return an authority, so this composition always
    // has one — it chooses WHICH, never whether. The field stays so a future
    // composition that builds none cannot pass by omission.
    authority: true,
    // The data-residency claim, and therefore the one that must never be a
    // literal. A stale hosted URL cannot make this false in local trust because
    // the composition ignores that URL too. Hosted trust still reports Convex
    // and is rejected: that environment wants the hosted composition.
    sqliteAuthority: workspaceAuthority === "sqlite",
    // The product IS local execution; `createDefaultLocalControlPlaneServices`
    // composes it, and `createSelfHostedApp` refuses outright without it.
    localExecution: true,
    ...staticAppPosture(env.CLAXEDO_APP_DIST_DIR?.trim()),
  }
}

/**
 * Validate the self-hosted posture, then start.
 *
 * The gate runs BEFORE anything is composed. Every failure it reports is a way
 * to boot something that answers a health check and cannot do its job, and
 * discovering that after the listener is up means the operator finds out from a
 * user rather than from a log line.
 */
export function startSelfHostedServer(options: SelfHostedStartOptions) {
  const env = options.env ?? process.env
  // Asserted here as well as inside `createSelfHostedApp`, and deliberately so:
  // this runs before the port is bound and before any subsystem is started,
  // where a refusal costs nothing. The one inside the composition catches a
  // caller that reaches it another way.
  assertSelfHostedPosture(selfHostedPosture(env))
  return startServer(options.port, options.opencodeUrl, undefined, { capabilities: selfHostedCapabilities })
}
