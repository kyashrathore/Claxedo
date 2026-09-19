import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import type { SafeStorageApi } from "../account/credential-store"
import { readString } from "../../shared/json-read"
import { hostConnectorChildResourceDir, verifyHostConnectorChildArtifact } from "./child-artifact"
import type { HostConnectorSharedWorkspace } from "./child-protocol"
import {
  setupHostConnectorChild,
  type AccountOperationRunner,
  type HostConnectorChildProcess,
} from "./child-supervisor"
import {
  loadHostConnectorIdentity,
  machineIdentityFile,
  storeHostConnectorIdentity,
  storeHostConnectorSealingKey,
  storeHostProviderConfig,
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
    load(): HostConnectorSharedWorkspace[] {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
        if (!Array.isArray(parsed)) return []
        return parsed.flatMap((entry) => {
          const workspaceId = readString(entry, "workspaceId")
          if (!workspaceId) return []
          const displayName = readString(entry, "displayName")
          return [{ workspaceId, ...(displayName === undefined ? {} : { displayName }) }]
        })
      } catch {
        return []
      }
    },
    store(shares: readonly HostConnectorSharedWorkspace[]) {
      if (shares.length === 0) {
        rmSync(file, { force: true })
        return
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(shares, null, 2)}\n`)
    },
  }
}

/**
 * The name the OWNER gave this machine, which outranks the derived one.
 *
 * Plain JSON beside the shares, and for the same reason: a display name is
 * neither a secret nor a proof. It is stored at all because every enable
 * re-enrolls and the enroll route overwrites `display_name`, so a rename the
 * machine did not remember would be undone by the next enable.
 */
function machineNameFile(userDataDir: string) {
  const file = join(userDataDir, "host-machine-name.json")
  return {
    load(): string | undefined {
      try {
        return readString(JSON.parse(readFileSync(file, "utf8")) as unknown, "displayName")
      } catch {
        return undefined
      }
    },
    store(displayName: string) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify({ displayName }, null, 2)}\n`)
    },
  }
}

/** Production adapter from Electron primitives to the dependency-light supervisor. */
export function setupElectronHostConnector(input: {
  runAccountOperation: AccountOperationRunner
  /** The account's control-plane origin; the child beats there itself once enrolled. */
  controlPlaneUrl?: string
  describeWorkspace?: Parameters<typeof setupHostConnectorChild>[0]["describeWorkspace"]
  safeStorage: SafeStorageApi
  userDataDir: string
  fork: HostConnectorUtilityFork
  packaged: boolean
  mainDir: string
  resourcesPath: string
  platform?: NodeJS.Platform
  /** What this computer calls itself. The owner's stored rename wins over it. */
  derivedDisplayName?: string
  heartbeatIntervalMs?: number
  onError?: (stage: string, error: unknown) => void
  onStatusChange?: Parameters<typeof setupHostConnectorChild>[0]["onStatusChange"]
  onServing?: Parameters<typeof setupHostConnectorChild>[0]["onServing"]
  onProviderConfig?: Parameters<typeof setupHostConnectorChild>[0]["onProviderConfig"]
  sessionAuthority?: Parameters<typeof setupHostConnectorChild>[0]["sessionAuthority"]
}) {
  const file = machineIdentityFile(input.userDataDir)
  const platform = input.platform ?? process.platform
  const resourceDir = hostConnectorChildResourceDir({
    packaged: input.packaged,
    mainDir: input.mainDir,
    resourcesPath: input.resourcesPath,
  })

  const shares = sharedWorkspacesFile(input.userDataDir)
  const names = machineNameFile(input.userDataDir)

  return setupHostConnectorChild({
    runAccountOperation: input.runAccountOperation,
    ...(input.controlPlaneUrl ? { controlPlaneUrl: input.controlPlaneUrl } : {}),
    ...(input.describeWorkspace ? { describeWorkspace: input.describeWorkspace } : {}),
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
    storeSealingKey: async (sealingPrivateKeyJwk) => {
      const result = storeHostConnectorSealingKey({ safeStorage: input.safeStorage, file, platform, sealingPrivateKeyJwk })
      return result.ok ? result : { ok: false as const, detail: result.detail }
    },
    storeProviderConfig: async (providerConfig) => {
      const result = storeHostProviderConfig({ safeStorage: input.safeStorage, file, platform, providerConfig })
      return result.ok ? result : { ok: false as const, detail: result.detail }
    },
    clearIdentity: () => file.clear(),
    displayName: () => names.load() ?? input.derivedDisplayName,
    storeDisplayName: (displayName) => names.store(displayName),
    ...(input.heartbeatIntervalMs ? { heartbeatIntervalMs: input.heartbeatIntervalMs } : {}),
    ...(input.onError ? { onError: input.onError } : {}),
    ...(input.onStatusChange ? { onStatusChange: input.onStatusChange } : {}),
    ...(input.onServing ? { onServing: input.onServing } : {}),
    ...(input.onProviderConfig ? { onProviderConfig: input.onProviderConfig } : {}),
    ...(input.sessionAuthority ? { sessionAuthority: input.sessionAuthority } : {}),
  })
}
