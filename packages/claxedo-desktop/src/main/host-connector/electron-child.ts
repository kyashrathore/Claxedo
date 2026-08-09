import type { SafeStorageApi } from "../account/credential-store"
import { hostConnectorChildResourceDir, verifyHostConnectorChildArtifact } from "./child-artifact"
import {
  setupHostConnectorChild,
  type AccountOperationRunner,
  type HostConnectorChildProcess,
} from "./child-supervisor"
import {
  loadHostConnectorIdentity,
  machineIdentityFile,
  storeHostConnectorIdentity,
} from "./identity-store"

export type HostConnectorUtilityFork = (
  modulePath: string,
  args: string[],
  options: { stdio: "inherit"; serviceName: string },
) => HostConnectorChildProcess

export function machineDisplayName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macOS"
  if (platform === "win32") return "Windows"
  if (platform === "linux") return "Linux"
  return "This machine"
}

/** Production adapter from Electron primitives to the dependency-light supervisor. */
export function setupElectronHostConnector(input: {
  runAccountOperation: AccountOperationRunner
  safeStorage: SafeStorageApi
  userDataDir: string
  fork: HostConnectorUtilityFork
  packaged: boolean
  mainDir: string
  resourcesPath: string
  platform?: NodeJS.Platform
  displayName?: string
  heartbeatIntervalMs?: number
  onError?: (stage: string, error: unknown) => void
  onStatusChange?: Parameters<typeof setupHostConnectorChild>[0]["onStatusChange"]
}) {
  const file = machineIdentityFile(input.userDataDir)
  const platform = input.platform ?? process.platform
  const resourceDir = hostConnectorChildResourceDir({
    packaged: input.packaged,
    mainDir: input.mainDir,
    resourcesPath: input.resourcesPath,
  })

  return setupHostConnectorChild({
    runAccountOperation: input.runAccountOperation,
    spawn: () => {
      const entry = verifyHostConnectorChildArtifact(resourceDir)
      return input.fork(entry, [], { stdio: "inherit", serviceName: "Claxedo Host Connector" })
    },
    loadIdentity: async () =>
      loadHostConnectorIdentity({
        safeStorage: input.safeStorage,
        file,
        platform,
        ...(input.onError ? { onRejected: (reason) => input.onError?.("machine-identity", reason) } : {}),
      }),
    storeIdentity: async (identity) => {
      const result = storeHostConnectorIdentity({
        safeStorage: input.safeStorage,
        file,
        platform,
        identity,
      })
      return result.ok ? result : { ok: false as const, detail: result.detail }
    },
    clearIdentity: () => file.clear(),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.heartbeatIntervalMs ? { heartbeatIntervalMs: input.heartbeatIntervalMs } : {}),
    ...(input.onError ? { onError: input.onError } : {}),
    ...(input.onStatusChange ? { onStatusChange: input.onStatusChange } : {}),
  })
}
