/** Build-selected hosted Worker with the complete Agent Plugins module. */
import handler, { configureHostedWorkerFeatures } from "./worker"
import { createHostedAgentPluginsComposition } from "../../agent-plugins/hosted-composition"

configureHostedWorkerFeatures((env, plane) => createHostedAgentPluginsComposition({ env, plane }))

export { WorkGraphSettler, LiveSyncRoom, ClaxedoWakeLane } from "./worker"
export default handler
