import type { AgentEventEnvelope, AgentTurnOutcome, ConnectionSecretResolver } from "@claxedo/agent-runtime-contract"
import type { MachineLoginPolicy } from "@claxedo/harness/contract"
import type { CustomHarnessProvider } from "@claxedo/harness/providers"
import type { RuntimeEventEnvelope, RuntimeEventHub, RuntimeStore, SessionAccessPolicy, WorkspaceEventParents } from "@claxedo/session-core"
import type { WorkspaceFirstPartyMcpLaunchOptions } from "../first-party-mcp/index"
import type { RuntimeHarnessSelection } from "../routes/config"
import type { WorkspaceTarget } from "../target"
import type { WorkspaceTranscriptRoutesOptions } from "./core"

export type WorkspaceRuntimeStore = RuntimeStore

export type WorkspaceRuntimeStoreFactory = (input: { storeRoot?: string }) => WorkspaceRuntimeStore

export type WorkspaceHostOptions = {
  /** Host observer for the durable turn.finish outcome after store commit. */
  onTurnOutcome?: (input: { sessionId: string; assistantMessageId?: string; outcome: AgentTurnOutcome }) => void
  /** Direct observer for the presentation events produced by this host. */
  onPresentationEvent?: (event: AgentEventEnvelope) => void
  /**
   * Direct observer for the canonical runtime events produced by this host.
   *
   * The presentation stream carries session metadata; this one carries what the harness
   * said during the turn. A host that has to keep something a harness reports —
   * a plan's quota windows outliving the session that heard about them — reads
   * it here rather than off the SSE stream.
   */
  onRuntimeEvent?: (event: RuntimeEventEnvelope) => void
  /** Parent lookup for scoping a subagent child's frames as its parent's; defaults to this host's own store. */
  sessionParents?: WorkspaceEventParents
  /** Host-mediated resolver endpoint for opaque file-backed transcript handles. */
  transcripts?: WorkspaceTranscriptRoutesOptions
  /** Host-owned projection write that completes before the created lifecycle event. */
  afterCreateSession?: (input: { directory: string; session: unknown }) => Promise<void> | void
  /** The workspace that already holds a session id on this host; a create naming an id another workspace holds is refused before any harness launches. */
  sessionIdWorkspace: (sessionId: string) => Promise<string | undefined> | string | undefined
  /** Private-session authority selected by the host composition. */
  sessionAccessPolicy?: SessionAccessPolicy
  harness?: RuntimeHarnessSelection
  /** Where this runtime runs and whose machine it is; every transport's own-login decision reads it. */
  placement: MachineLoginPolicy
  /** Connection providers this host installs beside the built-in ACP and Pi RPC ones. */
  connectionProviders?: readonly CustomHarnessProvider<unknown>[]
  /** Host-owned resolver for opaque descriptor secret references. */
  resolveConnectionSecrets?: ConnectionSecretResolver
  target: WorkspaceTarget
  storeRoot?: string
  /** Where Claxedo-owned harness homes live; defaults to `~/.claxedo/harness` of the process user. */
  harnessStateRoot?: string
  /** The environment harness processes inherit and executables are resolved from. */
  env?: NodeJS.ProcessEnv
  /**
   * Durable config-apply receipts (`accepted-snapshot.json`,
   * `apply-status.json`). OFF by default: the live `configApply` status is
   * already exposed through `host.detail()` and `/api/wr/health`, so receipt
   * files are a diagnostics opt-in, not the source of truth. Hosts that need
   * durable receipts (cloud/sandbox postmortems) pass a directory they own —
   * never derived from the workspace checkout.
   */
  configApplyReceiptDir?: string
  /** Embedded owner applies its canonical snapshot before any harness is acquired. */
  beforeHarnessAcquire?: () => Promise<void>
  /**
   * Called synchronously after every change to what `activity()` and
   * `activeTurns()` report, so an owner deciding residency never has to poll
   * them. It must not start a turn, a checkpoint write, or a disposal.
   */
  onActivityChange?: () => void
  eventHub?: RuntimeEventHub
  /**
   * Host-supplied shared store factory. Defaults to the SQLite-backed
   * `RuntimeStore`. See {@link WorkspaceRuntimeStoreFactory}.
   */
  storeFactory?: WorkspaceRuntimeStoreFactory
  /**
   * The first-party MCP entry every launched session receives: the loopback
   * origin serving `/api/claxedo/mcp` and this runtime's credential issuer.
   * Absent, no harness receives the entry — the host that mounts the route is
   * the one that enables injection.
   */
  firstPartyMcpLaunch?: WorkspaceFirstPartyMcpLaunchOptions
}

