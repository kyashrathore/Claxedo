import { createFullHostedWorker } from "../../deployments/hosted-workerd/better-auth-d1-worker.agent-plugins.full-hosted.cf"
import { registryKeysWithTestKey } from "../registry-test-key"

export { LiveSyncRoom, PluginOutbound, PluginPlatform, PluginSupervisor } from "../../deployments/hosted-workerd/better-auth-d1-worker.agent-plugins.full-hosted.cf"

/**
 * The certified full-hosted Worker with the registry test key added, for the
 * signed e2e stack's app-plugin flows: their test registry is signed with a
 * key generated for the run. Every other binding and route is the production
 * composition's.
 */
const worker = createFullHostedWorker(registryKeysWithTestKey)

export class SandboxProvisioner extends worker.SandboxProvisioner {}

export default worker.handler
