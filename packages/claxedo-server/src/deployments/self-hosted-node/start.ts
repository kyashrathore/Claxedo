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
import { embeddedAuthEnabled } from "./embedded-auth"
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
 * The posture this process is actually in, read from its environment.
 *
 * Separate from the assertion so a test can inspect what was measured without
 * booting a server, and so the two concerns — observing and judging — do not
 * end up in one function that is hard to exercise.
 */
export function selfHostedPosture(env: NodeJS.ProcessEnv) {
  return {
    deploymentMode: deploymentMode(env),
    embeddedAuth: embeddedAuthEnabled(env),
    // Self-host always composes a workspace authority (the local SQLite one);
    // hosted trust is rejected before anything is built. The field stays so a
    // future composition that builds none cannot pass by omission.
    authority: true,
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
export async function startSelfHostedServer(options: SelfHostedStartOptions) {
  const env = options.env ?? process.env
  // Asserted here as well as inside `createSelfHostedApp`, and deliberately so:
  // this runs before the port is bound and before any subsystem is started,
  // where a refusal costs nothing. The one inside the composition catches a
  // caller that reaches it another way.
  assertSelfHostedPosture(selfHostedPosture(env))
  // The local Agent Plugins module (catalog, activation, machine discovery),
  // composed the way the desktop's server entry composes it. Behind the same
  // flag so a box that did not ask for the marketplace mounts none of it.
  const agentPlugins = env.CLAXEDO_AGENT_PLUGINS?.trim() === "1"
    ? await import("@claxedo/local-server/agent-plugins/local-composition")
        .then(({ createLocalAgentPluginsComposition }) => createLocalAgentPluginsComposition(env))
    : undefined
  await agentPlugins?.ready
  return startServer(options.port, options.opencodeUrl, undefined, {
    ...(agentPlugins ? { routeContributions: agentPlugins.routeContributions } : {}),
  })
}
