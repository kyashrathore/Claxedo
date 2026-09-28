import type { SessionHarness } from "@claxedo/agent-runtime-contract"
import type { ConnectionSecretAuthority } from "@claxedo/agent-sdk-runtime"
import type { HarnessTransport, Locality, TransportKind, TurnActor } from "@claxedo/harness/contract"

/**
 * One composed transport the host may run sessions on: the runner it was
 * built for, the transport itself and where its harness runs. The workspace
 * host owns construction, caching and retirement; a handle that was retired
 * answers `retired()` true, and a session attached on it must be re-attached
 * on the replacement. A retired transport is disposed only once every pin on
 * it is released, so a turn admitted on it keeps its cancellation and its
 * requests on the process that is running it.
 */
export type HarnessHandle = {
  key: string
  runner: SessionHarness
  kind: TransportKind
  transport: HarnessTransport
  locality: Locality
  retired: () => boolean
  /** Holds the transport undisposed until the returned release runs; releasing twice is a no-op. */
  pin: () => () => void
}

/** Whose accounts a connection spends, and the proof its secrets are leased under when the caller holds one. */
export type TransportAccess = { owner: TurnActor; authority?: ConnectionSecretAuthority }

export type TransportResolver = {
  /**
   * The transport for a runner in a directory, composed on first use. A
   * connection's secrets are leased again on every call, for the owner in
   * `access`, and one owner's transport never replaces another's.
   */
  forHarness(harness: SessionHarness, directory: string, access: TransportAccess): Promise<HarnessHandle>
  /** Every transport currently composed, for reads that span harnesses. */
  composed(): readonly HarnessHandle[]
  /** Calls `listener` with each handle as it is retired; the returned function unsubscribes. */
  onRetire(listener: (handle: HarnessHandle) => void): () => void
}
