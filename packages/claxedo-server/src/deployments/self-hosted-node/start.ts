/**
 * The self-hosted single binary's start path: the posture gate, then
 * `startServer`.
 *
 * `startServer` in `./app.ts` has this module as its only production caller
 * (the desktop boots `@claxedo/local-server`), so it stays internal and this
 * is the public way in. `createSelfHostedApp` stays exported for library
 * consumers and the route contract tests; it gates itself when handed a
 * `posture` option and refuses without a local-execution adapter.
 */

import fs from "node:fs"
import path from "node:path"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import { deploymentMode } from "@claxedo/server-core/authority/deployment-mode"
import { embeddedAuthEnabled } from "./embedded-auth"
import { createDefaultLocalControlPlaneServices, startControlPlaneStack } from "./app"
import type { ControlPlaneServices } from "../../authority/services"
import { assertSelfHostedPosture } from "./posture"
import { createLocalTasksComposition } from "@claxedo/local-server/tasks/local-composition"
import { localBuiltinToolGroupsReader } from "@claxedo/local-server/agent-plugins/builtin-groups"
import { BUILTIN_TASKS_TOOL_GROUP } from "@claxedo/server-core/agent-plugins/builtin/plugin"
import { createTasksSessionGrants, type TasksSessionGrants } from "@claxedo/server-core/tasks-host/session-grants"
import { createSelfHostedTasksComposition } from "../../tasks/self-hosted-composition"

export type SelfHostedStartOptions = {
  port: number
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
  const services = createDefaultLocalControlPlaneServices()
  const agentPlugins = await import("@claxedo/local-server/agent-plugins/local-composition")
    .then(({ createLocalAgentPluginsComposition }) => createLocalAgentPluginsComposition(env))
  const tasks = selfHostedTasks(services)
  await agentPlugins.ready
  return startControlPlaneStack({
    services,
    port: options.port,
    routeContributions: [...agentPlugins.routeContributions, ...tasks.routeContributions],
    ...(tasks.grants ? { tasksGrants: tasks.grants } : {}),
  })
}

/**
 * Tasks for this posture, and the grants its own sessions present.
 *
 * The two are returned together because they are two ends of one thing: the
 * signed composition verifies exactly the grants this registry issues, and a
 * box that built one without the other would either serve routes no session
 * can reach or hand out handles nothing honours.
 */
export function selfHostedTasks(services: ControlPlaneServices): {
  routeContributions: readonly ControlPlaneRouteContribution[]
  grants?: TasksSessionGrants
} {
  const toolGroups = localBuiltinToolGroupsReader()
  const tasksOn = () => toolGroups().includes(BUILTIN_TASKS_TOOL_GROUP)
  if (!services.auth.config.enabled) {
    const local = createLocalTasksComposition({ enabled: tasksOn })
    return { routeContributions: local.routeContributions, grants: local.grants }
  }
  const workspaceOwner = services.authority?.resolveWorkspaceOwner?.bind(services.authority)
  // Without an owner to resolve, a grant could only be believed on what it
  // says about itself, so this box issues none and its sessions get no Tasks
  // tools rather than tools that act as nobody in particular.
  const grants = workspaceOwner ? createTasksSessionGrants({ workspaceOwner, enabled: tasksOn }) : undefined
  return {
    routeContributions: createSelfHostedTasksComposition({
      services,
      ...(grants ? { grants } : {}),
    }).routeContributions,
    ...(grants ? { grants } : {}),
  }
}

/**
 * Tasks for the posture this box composed.
 *
 * The posture is read from the COMPOSED services, not from the environment: a
 * box whose embedded issuer did not configure has `auth.config.enabled` false
 * whatever `CLAXEDO_EMBEDDED_AUTH` asked for, and the signed composition
 * mounted there refuses every caller. The two are not interchangeable the other
 * way either — the loopback composition admits a request because it arrived on
 * loopback and mints one local owner for every caller, so serving it to a
 * signed multi-user self-host hands every member the same preset catalog.
 */
export function selfHostedTasksRouteContributions(
  services: ControlPlaneServices,
): readonly ControlPlaneRouteContribution[] {
  return selfHostedTasks(services).routeContributions
}
