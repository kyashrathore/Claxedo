import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
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

/**
 * Shares this machine should re-establish after a restart.
 *
 * Plain JSON on purpose: the file holds workspace ids and labels only — the
 * proof of the share is re-signed by the connector child at every
 * registration and heartbeat, so there is nothing here worth encrypting and
 * nothing an editor of this file could forge.
 */
function sharedWorkspacesFile(userDataDir: string) {
  const file = join(userDataDir, "host-connector-shared-workspaces.json")
  return {
    load(): Array<{ workspaceId: string; displayName?: string }> {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
        if (!Array.isArray(parsed)) return []
        return parsed.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) return []
          const share = entry as { workspaceId?: unknown; displayName?: unknown }
          if (typeof share.workspaceId !== "string" || !share.workspaceId) return []
          return [{
            workspaceId: share.workspaceId,
            ...(typeof share.displayName === "string" ? { displayName: share.displayName } : {}),
          }]
        })
      } catch {
        return []
      }
    },
    store(shares: readonly { workspaceId: string; displayName?: string }[]) {
      if (shares.length === 0) {
        rmSync(file, { force: true })
        return
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(shares, null, 2)}\n`)
    },
  }
}

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
  onServing?: Parameters<typeof setupHostConnectorChild>[0]["onServing"]
}) {
  const file = machineIdentityFile(input.userDataDir)
  const platform = input.platform ?? process.platform
  const resourceDir = hostConnectorChildResourceDir({
    packaged: input.packaged,
    mainDir: input.mainDir,
    resourcesPath: input.resourcesPath,
  })

  const shares = sharedWorkspacesFile(input.userDataDir)

  return setupHostConnectorChild({
    runAccountOperation: input.runAccountOperation,
    loadSharedWorkspaces: () => shares.load(),
    storeSharedWorkspaces: (next) => shares.store(next),
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
    ...(input.onServing ? { onServing: input.onServing } : {}),
  })
}
