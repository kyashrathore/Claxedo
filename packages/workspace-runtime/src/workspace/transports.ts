import { asRecord, type SessionHarness } from "@claxedo/agent-runtime-contract"
import type { ConnectionSecretLease } from "@claxedo/agent-sdk-runtime"
import type { createHarnessComposer } from "@claxedo/harness/compose"
import type { HarnessConnectionDescriptor } from "@claxedo/harness/providers"
import { harnessRecord } from "@claxedo/harness/registry"
import type { HarnessTransport, Locality } from "@claxedo/harness/contract"
import { WorkspaceHarnessUnavailableError } from "../harness-unavailable-error"
import type { HarnessHandle, TransportAccess, TransportResolver } from "../host/transports"
import { Log } from "../log"
import type { RuntimeConnectionDescriptor } from "../routes/config"
import { canonicalJson } from "./snapshot"

const log = Log.create({ service: "workspace-runtime" })


export type WorkspaceTransportsInput = {
  composer: ReturnType<typeof createHarnessComposer>
  /** The descriptors the last accepted snapshot applied, by connection id. */
  connections: () => ReadonlyMap<string, RuntimeConnectionDescriptor>
  resolveSecrets: (descriptor: RuntimeConnectionDescriptor, directory: string, access: TransportAccess) =>
    Promise<ConnectionSecretLease> | ConnectionSecretLease
}

/**
 * `unpinned` waits for the admitted turns still running on a superseded
 * transport; `unpin` stops that wait at shutdown, where disposing the
 * transport is what ends those turns.
 */
type Held = HarnessHandle & { directory?: string; ownerKey?: string; unpinned(): Promise<void>; unpin(): void }

function connectionLocality(descriptor: HarnessConnectionDescriptor): Locality {
  return descriptor.providerKey === "acp" && asRecord(asRecord(descriptor.config)?.connection)?.kind !== "process" ? "remote" : "local"
}

/**
 * The transports one workspace host has composed: one per native harness, and
 * one per connection descriptor, directory, session owner and secret lease.
 * A descriptor that changes revision or lease replaces that owner's transport
 * and retires the one it supersedes; a native transport lives as long as the
 * host.
 */
export function createWorkspaceTransports(input: WorkspaceTransportsInput) {
  const held = new Map<string, Held>()
  const building = new Map<string, Promise<Held>>()
  const retiring = new Map<Held, { state: "pending" | "failed"; done: Promise<void> }>()
  const retired = new WeakSet<HarnessTransport>()
  const retireListeners = new Set<(handle: HarnessHandle) => void>()
  let closing = false

  const hold = (key: string, runner: SessionHarness, transport: HarnessTransport, locality: Locality, directory?: string, ownerKey?: string): Held => {
    let pins = 0
    let forced = false
    const waiters: Array<() => void> = []
    const wake = () => { for (const resolve of waiters.splice(0)) resolve() }
    const handle: Held = {
      key, runner, kind: transport.kind, transport, locality, directory, ownerKey,
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
    const previous = retiring.get(handle)
    if (previous?.state === "pending") return previous.done
    retired.add(handle.transport)
    if (held.get(key) === handle) held.delete(key)
    for (const listener of retireListeners) listener(handle)
    const record = { state: "pending" as "pending" | "failed", done: Promise.resolve() }
    record.done = handle.unpinned()
      .then(() => handle.transport.dispose())
      .then(() => { retiring.delete(handle) }, (error: unknown) => { record.state = "failed"; throw error })
    retiring.set(handle, record)
    void record.done.catch((error: unknown) => log.error("Transport retirement failed", { harness: handle.runner, error }))
    return record.done
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

  const buildConnection = async (runner: SessionHarness, directory: string, access: TransportAccess): Promise<Held> => {
    const descriptor = descriptorFor(runner)
    const signature = JSON.stringify(canonicalJson(descriptor))
    const ownerKey = JSON.stringify(access.owner)
    const lease = await input.resolveSecrets(descriptor, directory, access)
    if (closing) throw new Error("Workspace transports are disposed")
    if (JSON.stringify(canonicalJson(descriptorFor(runner))) !== signature) throw new WorkspaceHarnessUnavailableError(runner)
    const key = JSON.stringify([signature, directory, ownerKey, lease.secretLeaseGeneration])
    const existing = held.get(key)
    if (existing) return existing
    const transport = input.composer.connection({ descriptor, expectedRevision: descriptor.configRevision, directory, secrets: lease.secrets })
    const handle = hold(key, runner, transport, connectionLocality(descriptor), directory, ownerKey)
    for (const [otherKey, other] of held) {
      if (otherKey !== key && other.runner.access === "connection" && other.runner.id === runner.id && other.directory === directory
        && other.ownerKey === ownerKey) void retire(otherKey, other)
    }
    return handle
  }

  const resolver: TransportResolver = {
    async forHarness(runner, directory, access) {
      if (closing) throw new Error("Workspace transports are disposed")
      if (runner.access === "native") return held.get(`native:${runner.id}`) ?? buildNative(runner)
      const descriptor = descriptorFor(runner)
      const pendingKey = JSON.stringify(["building", descriptor.connectionId, directory, access.owner, access.authority ?? null])
      const pending = building.get(pendingKey)
      if (pending) return await pending
      const build = buildConnection(runner, directory, access).finally(() => building.delete(pendingKey))
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
      closing = true
      const handles = new Set([...held.values(), ...retiring.keys()])
      for (const handle of handles) handle.unpin()
      const done = [...handles].map((handle) => retire(handle.key, handle))
      const results = await Promise.all([
        Promise.allSettled(done),
        Promise.allSettled(building.values()),
      ])
      const failures = results[0].flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, "Workspace transport disposal failed")
    },
  }
}

export type WorkspaceTransports = ReturnType<typeof createWorkspaceTransports>
