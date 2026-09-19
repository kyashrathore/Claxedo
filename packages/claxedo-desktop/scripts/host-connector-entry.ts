import { createHostConnector, type AssignmentDescription } from "@claxedo/host-connector/connector"
import {
  createHostKeyPair,
  enrollmentPayload,
  hostKeyPairFromJwk,
  newHostId,
  type HostKeyPair,
} from "@claxedo/host-connector/host-identity"
import {
  createMachineSealingKeyPair,
  hostMachineSealAad,
  openMachineSeal,
  sealingPublicKeyJwk,
} from "@claxedo/host-connector/machine-seal"
import { createMachineSignedTransport, type FetchLike } from "@claxedo/host-connector/machine-transport"

import { readRecord, readUnknown } from "../src/shared/json-read"

import {
  HOST_ENROLLMENT_OPERATIONS,
  parseHostConnectorParentMessage,
  type HostConnectorBootstrapIdentity,
  type HostConnectorChildMessage,
  type HostConnectorChildState,
  type HostConnectorParentMessage,
  type HostConnectorProviderConfig,
  type HostConnectorServingEndpoints,
  type HostEnrollmentOperation,
} from "../src/main/host-connector/child-protocol"

type ChildPort = {
  postMessage(message: HostConnectorChildMessage): void
  onMessage(listener: (message: unknown) => void): void
}

type ChildDeps = {
  /** The child's own reach to the control plane, for everything after enrollment. */
  fetch: FetchLike
}

type Pending<T> = {
  resolve(value: T): void
  reject(error: Error): void
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

function requireString(value: unknown, field: string, operation: string): string {
  if (typeof value !== "string" || !value) throw new Error(`operation "${operation}" returned no ${field}`)
  return value
}

/** What a withdrawal opens to: the sealed shape with no providers, so the daemon replaces rather than keeps. */
const EMPTY_PROVIDER_CONFIG = JSON.stringify({ version: 1, providers: {} })

/**
 * Run the connector against a private parent port.
 *
 * Exported so the boot test can exercise the real entry without launching an
 * Electron process. The executable path below adapts Electron's parentPort to
 * this same interface; there is no second runtime implementation.
 */
export function runHostConnectorChild(port: ChildPort, deps: ChildDeps = { fetch: (input, init) => fetch(input, init) }) {
  const account = new Map<string, Pending<unknown>>()
  const identityStored = new Map<string, Pending<void>>()
  const sealingKeyStored = new Map<string, Pending<void>>()
  const providerConfigStored = new Map<string, Pending<void>>()
  let connector: ReturnType<typeof createHostConnector> | undefined
  let machine: { keys: HostKeyPair; hostId: string; sealingPrivateKeyJwk: JsonWebKey } | undefined
  let bootstrapped = false
  /**
   * Workspaces the user of THIS machine asked it to serve, by id.
   *
   * The owner's assignment is a separate statement made with the account by
   * Electron main; this is the machine's half, and the two must both hold. A
   * description the owner created from another device for a workspace nobody
   * shared here is therefore never acked — consent does not follow intent.
   */
  const consented = new Map<string, { displayName?: string }>()
  /**
   * The addresses the control plane last named, held because it names them
   * only when they change while the daemon needs them on every push — it is
   * told nothing else about which ack a credential came from.
   */
  let endpoints: HostConnectorServingEndpoints | undefined
  /**
   * Set the moment the parent asks to stop, or the runtime is torn down.
   *
   * Enrollment runs AFTER the bootstrap reply, so a `stop` can land while the
   * handshake is still waiting on the control plane. The connector that
   * handshake creates would otherwise be born started — with a heartbeat timer
   * nothing cancels — after the parent had already retired it.
   */
  let closed = false

  const send = (message: HostConnectorChildMessage) => port.postMessage(message)
  /**
   * The connector's state, with the acked set stapled on when enrolled: the
   * parent's status projection reads this to say which workspaces this machine
   * actually routes, and only an ack at the owner's current revision does.
   */
  const snapshot = (): HostConnectorChildState => {
    const state = connector?.state() ?? { status: "idle" as const }
    if (state.status !== "enrolled" || !connector) return state
    return { ...state, sharedWorkspaceIds: connector.acked().map((ack) => ack.workspaceId) }
  }
  const requestAccountOperation = (
    name: HostEnrollmentOperation,
    input?: Record<string, unknown>,
  ): Promise<unknown> => {
    const requestId = crypto.randomUUID()
    const pending = deferred<unknown>()
    account.set(requestId, pending)
    send({ type: "account-operation", requestId, name, ...(input ? { input } : {}) })
    return pending.promise.finally(() => account.delete(requestId))
  }

  /**
   * The two account operations of a machine's life, in order: a one-use nonce,
   * then the enrollment the machine key signs. Both are POSTs main makes with
   * the owner's credential — the child never holds one — and the
   * `enrollment_id` they produce is the identity every later request carries
   * instead.
   */
  const enrollMachine = async (keys: HostKeyPair, hostId: string, displayName?: string) => {
    const nonceOperation = HOST_ENROLLMENT_OPERATIONS.createRequest
    const challenge = await requestAccountOperation(nonceOperation, { hostId })
    const requestId = requireString(readUnknown(challenge, "request_id"), "request_id", nonceOperation)
    const nonce = requireString(readUnknown(challenge, "nonce"), "nonce", nonceOperation)

    const enrollOperation = HOST_ENROLLMENT_OPERATIONS.enroll
    const enrollment = readRecord(
      await requestAccountOperation(enrollOperation, {
        hostId,
        publicKey: keys.publicKey,
        requestId,
        signature: await keys.sign(enrollmentPayload({ hostId, requestId, nonce })),
        ...(displayName ? { displayName } : {}),
      }),
      "enrollment",
    )
    return requireString(readUnknown(enrollment, "enrollment_id"), "enrollment_id", enrollOperation)
  }

  /**
   * Consent to what the owner has declared, for the workspaces this machine
   * was asked to serve. A description the owner has withdrawn takes its
   * consent with it, so a workspace unshared from another device is not
   * re-published by a later restart of this one.
   */
  const reconcileAssignments = async (descriptions: readonly AssignmentDescription[]) => {
    const active = connector
    if (!active) return
    const present = new Set(descriptions.map((description) => description.workspaceId))
    // Deleting during iteration is defined for Map: a removed key is skipped, nothing is revisited.
    for (const workspaceId of consented.keys()) {
      if (!present.has(workspaceId)) consented.delete(workspaceId)
    }
    const acked = new Map(active.acked().map((ack) => [ack.workspaceId, ack.revision]))
    for (const description of descriptions) {
      if (!consented.has(description.workspaceId)) continue
      if (acked.get(description.workspaceId) === description.revision) continue
      await active.ack({ workspaceId: description.workspaceId, revision: description.revision })
    }
  }

  const createIdentity = async (requestId: string) => {
    const [created, sealing] = await Promise.all([createHostKeyPair(), createMachineSealingKeyPair()])
    const { privateKeyJwk, ...keys } = created
    const identity: HostConnectorBootstrapIdentity = {
      hostId: newHostId(),
      privateKeyJwk,
      sealingPrivateKeyJwk: sealing.privateKeyJwk,
    }
    const stored = deferred<void>()
    identityStored.set(requestId, stored)
    send({ type: "identity-created", requestId, identity })
    await stored.promise.finally(() => identityStored.delete(requestId))
    return { identity, keys }
  }

  /**
   * A sealing key for a machine enrolled before it could receive secrets.
   * Persisted by the parent before the first beat declares it, for the same
   * reason the host key is: a key the control plane seals for and the parent
   * lost leaves an enrollment nobody can configure.
   */
  const createSealingKey = async (requestId: string) => {
    const sealing = await createMachineSealingKeyPair()
    const stored = deferred<void>()
    sealingKeyStored.set(requestId, stored)
    send({ type: "sealing-key-created", requestId, sealingPrivateKeyJwk: sealing.privateKeyJwk })
    await stored.promise.finally(() => sealingKeyStored.delete(requestId))
    return sealing.privateKeyJwk
  }

  /**
   * Hand the ciphertext to the parent and wait for its store to answer. A
   * refusal throws so the connector leaves the revision unacked and the
   * control plane delivers it again: the ack is its evidence that this
   * machine is configured, and the store is what makes that true.
   */
  const storeProviderConfig = async (config: HostConnectorProviderConfig) => {
    const requestId = crypto.randomUUID()
    const stored = deferred<void>()
    providerConfigStored.set(requestId, stored)
    send({ type: "provider-config", requestId, ...config })
    await stored.promise.finally(() => providerConfigStored.delete(requestId))
  }

  const openProviderConfig = async (enrollmentId: string, config: HostConnectorProviderConfig) => {
    if (!machine) throw new Error("Host Connector has no sealing key")
    if (config.sealed === null) return EMPTY_PROVIDER_CONFIG
    return await openMachineSeal(
      machine.sealingPrivateKeyJwk,
      config.sealed,
      hostMachineSealAad({ enrollmentId, revision: config.revision }),
    )
  }

  /**
   * Enroll, then beat as a machine, after the bootstrap has already been
   * answered.
   *
   * The two enrollment POSTs are proxied through Electron main, each bounded
   * by the account layer's own per-request deadline — a bound wide enough that
   * awaiting the pair inline, before answering bootstrap, would make a merely
   * slow (not stuck) chain look like a dead child to the supervisor's much
   * tighter startup budget. So bootstrap answers first and this outcome
   * reaches the parent on the `status` channel instead, the same channel
   * `onError` and every later heartbeat transition already use.
   */
  const enroll = async (message: Extract<HostConnectorParentMessage, { type: "bootstrap" }>) => {
    const identity = machine
    if (!identity || closed) return
    const enrollmentId = await enrollMachine(identity.keys, identity.hostId, message.displayName)
    if (closed || machine !== identity) return

    // The revision the parent stored before this restart, re-opened for a
    // daemon that restarted with it. Declared to the control plane only when
    // it opens: the AAD binds it to this enrollment, and a blob this machine
    // cannot open must be delivered again, not acked as held.
    let held: { revision: number; providers: string } | undefined
    if (message.providerConfig) {
      try {
        held = {
          revision: message.providerConfig.revision,
          providers: await openProviderConfig(enrollmentId, message.providerConfig),
        }
      } catch {
        held = undefined
      }
    }
    if (closed || machine !== identity) return

    const active = createHostConnector({
      mode: "machine",
      hostId: identity.hostId,
      enrollmentId,
      // No `roots`/`resolvePath`: the daemon this machine beats for keys its
      // runtimes by workspace id and never opens the directory a description
      // names, so there is no path here to confine. Consent is the workspace
      // id, and it comes from this machine's own user.
      transport: createMachineSignedTransport({
        controlPlaneUrl: message.controlPlaneUrl,
        keys: identity.keys,
        enrollmentId,
        hostId: identity.hostId,
        fetch: deps.fetch,
      }),
      heartbeatIntervalMs: message.heartbeatIntervalMs,
      sealingPublicKey: JSON.stringify(sealingPublicKeyJwk(identity.sealingPrivateKeyJwk)),
      ...(held ? { providerConfigRevision: held.revision } : {}),
      setInterval: (fn, ms) => {
        const handle = setInterval(fn, ms)
        handle.unref?.()
        return { cancel: () => clearInterval(handle) }
      },
      // The daemon's composition, carried verbatim onto every beat. Absent
      // when the parent could not read it; the control plane then records an
      // undeclared machine rather than a guessed one.
      ...(message.sessionAuthority ? { sessionAuthority: message.sessionAuthority } : {}),
      onAssignments: reconcileAssignments,
      onError: (stage, error) => {
        // A stage the connector recovered from leaves the status unchanged, so
        // the reason would otherwise exist only in this process. A sealed
        // revision this machine cannot open is the case that matters: nothing
        // else on the machine says why the acked revision stopped moving.
        send({ type: "child-error", stage, detail: String(error) })
        // `createHostConnector` settles its stopped state immediately after
        // invoking this callback. Announce after that synchronous transition.
        queueMicrotask(() => {
          if (connector) send({ type: "status", status: snapshot() })
        })
      },
      // Delivered inside the beat's reconciliation, which finishes before
      // `onServing` runs, so a first ack that carries both is pushed as one
      // message rather than leaving the daemon a beat behind.
      onEndpoints: (delivered) => {
        const next: HostConnectorServingEndpoints = {
          ...(delivered.relay ? { relayJwksUrl: delivered.relay.jwksUrl } : {}),
          ...(delivered.authority ? { sessionAuthorityUrl: delivered.authority.sessionAuthorityUrl } : {}),
        }
        endpoints = next.relayJwksUrl === undefined && next.sessionAuthorityUrl === undefined ? undefined : next
      },
      onServing: (tunnel) => send({ type: "serving", tunnel: tunnel ?? null, ...(endpoints ? { endpoints } : {}) }),
      // Stored, then opened, then forwarded — as three steps on purpose. The
      // parent's store answers on the ciphertext alone, so the plaintext is
      // never something main has to hold to say "stored", and the artifact
      // on disk is only ever the ciphertext.
      onProviderConfig: async (config) => {
        await storeProviderConfig(config)
        const providers = await openProviderConfig(enrollmentId, config)
        send({ type: "provider-config-ready", revision: config.revision, providers })
      },
      // A timer-driven heartbeat renews the lease with nobody on this side
      // waiting for it — the parent's copy of the status only advances when
      // told. Push the fresh snapshot (renewed `expires_at`, reconciled acks)
      // every time, not only on the request/response paths below.
      onLeaseRenewed: () => {
        if (connector) send({ type: "status", status: snapshot() })
      },
    })
    connector = active
    // Before the first beat: a newer revision that beat delivers is forwarded
    // from inside it, and the restored one must not land after it.
    if (held) send({ type: "provider-config-ready", ...held })
    await active.start()
    if (connector !== active) return
    if (closed) {
      // The parent stopped us mid-handshake. `start()` claimed a generation
      // and installed a heartbeat timer, so close it for real rather than
      // announcing an enrollment nobody asked to keep.
      active.close()
      return
    }
    send({ type: "status", status: snapshot() })
  }

  const bootstrap = async (message: Extract<HostConnectorParentMessage, { type: "bootstrap" }>) => {
    if (bootstrapped) throw new Error("Host Connector child has already been bootstrapped")
    bootstrapped = true

    const restored = message.identity
      ? { identity: message.identity, keys: await hostKeyPairFromJwk(message.identity.privateKeyJwk) }
      : await createIdentity(message.requestId)
    const sealingPrivateKeyJwk = restored.identity.sealingPrivateKeyJwk ?? (await createSealingKey(message.requestId))
    machine = { keys: restored.keys, hostId: restored.identity.hostId, sealingPrivateKeyJwk }
    // The shares this machine held before the restart. Their assignments are
    // still the owner's, recorded at the control plane, so nothing has to be
    // re-declared: the first beat's descriptions are acked back into service.
    for (const share of message.sharedWorkspaces ?? []) {
      consented.set(share.workspaceId, share.displayName ? { displayName: share.displayName } : {})
    }

    // Bootstrapped means "this process is alive and holds its machine
    // identity", not "the enrollment network calls succeeded". The caller
    // sends this pre-start snapshot as the bootstrap reply and only then runs
    // `enroll`, so the reply cannot be delayed by a stalled control-plane POST.
    return {
      status: snapshot(),
      // Nothing awaits `enroll`, so its rejection has no caller to reach. The
      // parent is waiting on a status, and an enrollment that died without one
      // would leave it waiting for its whole budget.
      enroll: () =>
        void enroll(message).catch((error) => {
          try {
            send({ type: "status", status: { status: "stopped", reason: "error", detail: String(error) } })
          } catch {
            // The port is gone; there is nobody left to tell.
          }
        }),
    }
  }

  const onMessage = async (value: unknown) => {
    const message = parseHostConnectorParentMessage(value)
    if (!message) return

    if (message.type === "account-result") {
      const pending = account.get(message.requestId)
      if (!pending) return
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new Error(message.error))
      return
    }

    if (message.type === "identity-stored") {
      identityStored.get(message.requestId)?.resolve()
      return
    }

    if (message.type === "sealing-key-stored") {
      sealingKeyStored.get(message.requestId)?.resolve()
      return
    }

    if (message.type === "provider-config-stored") {
      const pending = providerConfigStored.get(message.requestId)
      if (!pending) return
      if (message.ok) pending.resolve()
      else pending.reject(new Error(`the parent did not store the provider configuration: ${message.error}`))
      return
    }

    if (message.type === "stop") {
      closed = true
      connector?.close()
      const status = connector
        ? snapshot()
        : { status: "stopped" as const, reason: "closed" as const, detail: "connector closed" }
      send({ type: "status", status })
      send({ type: "response", requestId: message.requestId, ok: true, status })
      return
    }

    if (message.type === "unshare-workspace") {
      try {
        if (!connector) throw new Error("Host Connector has not been bootstrapped")
        consented.delete(message.workspaceId)
        // Withdrawn in one beat, so the control plane stops routing the
        // workspace within a round trip rather than at the next interval.
        await connector.unack(message.workspaceId)
        const status = snapshot()
        send({ type: "status", status })
        send({ type: "response", requestId: message.requestId, ok: true, status })
      } catch (error) {
        send({ type: "response", requestId: message.requestId, ok: false, error: String(error) })
      }
      return
    }

    if (message.type === "share-workspace") {
      try {
        if (!connector) throw new Error("Host Connector has not been bootstrapped")
        if (connector.state().status !== "enrolled") {
          throw new Error("remote access is not active on this machine — enable it first")
        }
        consented.set(message.workspaceId, message.displayName ? { displayName: message.displayName } : {})
        // The owner's assignment landed before this message, so the beat this
        // forces is the one that carries its description back — and the ack
        // for it runs inside that beat's reconciliation, not after.
        const beaten = await connector.beat()
        if (beaten.status !== "enrolled") {
          consented.delete(message.workspaceId)
          throw new Error("remote access stopped while the share was registering")
        }
        if (!connector.acked().some((ack) => ack.workspaceId === message.workspaceId)) {
          consented.delete(message.workspaceId)
          throw new Error("the control plane has no assignment for this workspace on this machine")
        }
        const status = snapshot()
        send({ type: "status", status })
        send({ type: "response", requestId: message.requestId, ok: true, status })
      } catch (error) {
        send({ type: "response", requestId: message.requestId, ok: false, error: String(error) })
      }
      return
    }

    try {
      const booted = await bootstrap(message)
      send({ type: "response", requestId: message.requestId, ok: true, status: booted.status })
      // Strictly after the reply is on the wire, so no ordering of microtasks
      // can let an enrollment status push overtake the bootstrap response.
      booted.enroll()
    } catch (error) {
      send({ type: "response", requestId: message.requestId, ok: false, error: String(error) })
    }
  }

  port.onMessage((message) => {
    void onMessage(message)
  })
  send({ type: "ready" })

  return {
    close() {
      closed = true
      connector?.close()
      for (const pending of account.values()) pending.reject(new Error("Host Connector child closed"))
      for (const pending of identityStored.values()) pending.reject(new Error("Host Connector child closed"))
      for (const pending of sealingKeyStored.values()) pending.reject(new Error("Host Connector child closed"))
      for (const pending of providerConfigStored.values()) pending.reject(new Error("Host Connector child closed"))
      account.clear()
      identityStored.clear()
      sealingKeyStored.clear()
      providerConfigStored.clear()
    },
  }
}

if (process.parentPort) {
  runHostConnectorChild({
    postMessage: (message) => process.parentPort.postMessage(message),
    onMessage: (listener) => {
      process.parentPort.on("message", (event) => listener(event.data))
    },
  })
}
