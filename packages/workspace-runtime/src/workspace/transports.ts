import { asRecord, type SessionHarness } from "@claxedo/agent-runtime-contract"
import type { ConnectionSecretLease } from "@claxedo/agent-sdk-runtime"
import type { createHarnessComposer } from "@claxedo/harness/compose"
import type { HarnessConnectionDescriptor } from "@claxedo/harness/providers"
import { harnessRecord } from "@claxedo/harness/registry"
import type { HarnessTransport, Locality } from "@claxedo/harness/contract"
import { WorkspaceHarnessUnavailableError } from "../harness-unavailable-error"
import type { HarnessHandle, TransportResolver } from "../host/transports"
import { Log } from "../log"
import type { RuntimeConnectionDescriptor } from "../routes/config"

const log = Log.create({ service: "workspace-runtime" })


export type WorkspaceTransportsInput = {
  composer: ReturnType<typeof createHarnessComposer>
  /** The descriptors the last accepted snapshot applied, by connection id. */
  connections: () => ReadonlyMap<string, RuntimeConnectionDescriptor>
  resolveSecrets: (descriptor: RuntimeConnectionDescriptor, directory: string) => Promise<ConnectionSecretLease> | ConnectionSecretLease
}

/**
 * `unpinned` waits for the admitted turns still running on a superseded
 * transport; `unpin` stops that wait at shutdown, where disposing the
 * transport is what ends those turns.
 */
type Held = HarnessHandle & { directory?: string; unpinned(): Promise<void>; unpin(): void }

function connectionLocality(descriptor: HarnessConnectionDescriptor): Locality {
  return descriptor.providerKey === "acp" && asRecord(asRecord(descriptor.config)?.connection)?.kind !== "process" ? "remote" : "local"
}

/**
 * The transports one workspace host has composed: one per native harness, and
 * one per connection descriptor, directory and secret lease. A descriptor that
 * changes revision or lease replaces its transport and retires the one it
 * supersedes; a native transport lives as long as the host.
 */
export function createWorkspaceTransports(input: WorkspaceTransportsInput) {
  const held = new Map<string, Held>()
  const building = new Map<string, Promise<Held>>()
  const retiring = new Map<string, { handle: Held; done: Promise<void> }>()
  const retired = new WeakSet<HarnessTransport>()
  const retireListeners = new Set<(handle: HarnessHandle) => void>()

  const hold = (key: string, runner: SessionHarness, transport: HarnessTransport, locality: Locality, directory?: string): Held => {
    let pins = 0
    let forced = false
    const waiters: Array<() => void> = []
    const wake = () => { for (const resolve of waiters.splice(0)) resolve() }
    const handle: Held = {
      key, runner, kind: transport.kind, transport, locality, directory,
      retired: () => retired.has(transport),
      pin() {
        pins += 1
        let released = false
        return () => {
          if (released) return
          released = true
          pins -= 1
          if (pins === 0) wake()
        }
      },
      unpinned: () => pins === 0 || forced ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push(resolve) }),
      unpin: () => { forced = true; wake() },
    }
    held.set(key, handle)
    return handle
  }

  const retire = (key: string, handle: Held) => {
    const previous = retiring.get(key)
    if (previous) return previous.done
    retired.add(handle.transport)
    if (held.get(key) === handle) held.delete(key)
    for (const listener of retireListeners) listener(handle)
    const done = handle.unpinned()
      .then(() => handle.transport.dispose())
      .catch((error: unknown) => log.error("Transport retirement failed", { key, error }))
      .finally(() => retiring.delete(key))
    retiring.set(key, { handle, done })
    return done
  }

  const descriptorFor = (runner: SessionHarness): RuntimeConnectionDescriptor => {
    const descriptor = input.connections().get(runner.id)
    if (!descriptor || !descriptor.enabled) throw new WorkspaceHarnessUnavailableError(runner)
    return descriptor
  }

  const buildNative = (runner: SessionHarness): Held => {
    const record = harnessRecord(runner.id)
    if (!record || record.access !== "native") throw new WorkspaceHarnessUnavailableError(runner)
    return hold(`native:${runner.id}`, runner, input.composer.builtIn(record.id), "local")
  }

  const buildConnection = async (runner: SessionHarness, directory: string): Promise<Held> => {
    const descriptor = descriptorFor(runner)
    const lease = descriptor.secretRefs && Object.keys(descriptor.secretRefs).length > 0
      ? await input.resolveSecrets(descriptor, directory)
      : { secrets: {}, secretLeaseGeneration: "none" }
    const key = JSON.stringify([descriptor.providerKey, descriptor.connectionId, directory, descriptor.configRevision, lease.secretLeaseGeneration])
    const existing = held.get(key)
    if (existing) return existing
    const transport = input.composer.connection({ descriptor, expectedRevision: descriptor.configRevision, directory, secrets: lease.secrets })
    const handle = hold(key, runner, transport, connectionLocality(descriptor), directory)
    for (const [otherKey, other] of held) {
      if (otherKey !== key && other.runner.access === "connection" && other.runner.id === runner.id && other.directory === directory) void retire(otherKey, other)
    }
    return handle
  }

  const resolver: TransportResolver = {
    async forHarness(runner, directory) {
      if (runner.access === "native") return held.get(`native:${runner.id}`) ?? buildNative(runner)
      const descriptor = descriptorFor(runner)
      const pendingKey = JSON.stringify(["building", descriptor.connectionId, directory])
      const pending = building.get(pendingKey)
      if (pending) return await pending
      const build = buildConnection(runner, directory).finally(() => building.delete(pendingKey))
      building.set(pendingKey, build)
      return await build
    },
    composed() {
      return [...held.values()]
    },
    onRetire(listener) {
      retireListeners.add(listener)
      return () => { retireListeners.delete(listener) }
    },
  }

  return {
    ...resolver,
    /** Retires every transport of a connection the snapshot disabled or removed. */
    retireConnection(connectionId: string) {
      for (const [key, handle] of held) {
        if (handle.runner.access === "connection" && handle.runner.id === connectionId) void retire(key, handle)
      }
    },
    async disposeAll() {
      const done = [...held.entries()].map(([key, handle]) => retire(key, handle))
      for (const { handle } of retiring.values()) handle.unpin()
      await Promise.all([...done, ...[...retiring.values()].map((record) => record.done)])
    },
  }
}

export type WorkspaceTransports = ReturnType<typeof createWorkspaceTransports>
