import { DurableObject } from "cloudflare:workers"
import type { TurnExecutionAccess } from "@claxedo/harness/contract"
import { adoptSessionTurnLease, errorBody, remoteWorkspaceSessionAccessPolicy, type SessionAccessPolicy } from "@claxedo/session-core"
import { createRelayHostAuthMiddleware, loadRelayHostVerificationKeyOrJwks, type RelayHostAuthOptions } from "@claxedo/session-core/relay-host"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import { Lifecycle } from "agents/lifecycle"
import { PiHarness } from "agents/harness/pi"
import { Hono } from "hono"
import { composeSessionHost, type SessionHost } from "./composition"
import { DurablePiPlacement } from "./pi-placement"
import { SessionHostMeta } from "./session-host-meta"
import { SessionHostTurns, TurnAuthorityError } from "./turn-delivery"
import { TurnLeases, type StoredTurnLease } from "./turn-leases"

export type SessionHostEnv = {
  CONTROL_PLANE: { fetch(input: string, init?: RequestInit): Promise<Response> }
  WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: string
  WORKSPACE_RUNTIME_RELAY_JWKS_URL?: string
  WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM?: string
}

/**
 * One top-level Pi session, named by its id: Pi's agent loop on `PiHarness`
 * over this object's SQLite, the session core beside it, and Pi's tools on the
 * workspace machine. Nothing is composed until a relay host token names the
 * workspace, which is then this object's for good.
 */
export class SessionDO extends DurableObject<SessionHostEnv> {
  private readonly root: string
  private readonly meta: SessionHostMeta
  private readonly leases: TurnLeases
  private readonly turns: SessionHostTurns
  private readonly policy: SessionAccessPolicy
  private readonly pi: PiHarness
  private readonly placement: DurablePiPlacement
  private key: Promise<RelayHostAuthOptions["key"]> | undefined
  private hosting: Promise<SessionHost> | undefined
  private deleted = false

  constructor(ctx: DurableObjectState, env: SessionHostEnv) {
    super(ctx, env)
    const root = ctx.id.name
    if (!root) throw new Error("A session host is addressed by its root session's id")
    this.root = root
    const controlPlane = (input: RequestInfo | URL, init?: RequestInit) => env.CONTROL_PLANE.fetch(String(input instanceof Request ? input.url : input), init)
    this.meta = new SessionHostMeta(ctx.storage.sql)
    this.turns = new SessionHostTurns({ fetch: controlPlane, authorityUrl: env.WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL, leases: () => this.leases })
    this.leases = new TurnLeases(ctx.storage.sql, (lease) => this.turns.forget(lease))
    this.policy = this.leases.observe(remoteWorkspaceSessionAccessPolicy({ url: env.WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL, fetch: controlPlane }))
    this.pi = new PiHarness({ harness: (input) => this.placement.factory(() => this.boot())(input) })
    this.placement = new DurablePiPlacement({
      root, pi: this.pi, report: (error) => console.error("Pi extension failure", error),
      execution: (signal) => this.execution(signal),
      turnContext: async () => {
        await this.turns.delivery(root)
        return (await this.host()).turnContext()
      },
      refresh: async (credentialProviderId) => {
        const { delivery } = await this.turns.delivery(root, { renew: true })
        return delivery.auth.direct?.[delivery.auth.machineOwnerUserId]?.[credentialProviderId]
      },
    })
    Lifecycle.install(this).use(this.pi)
  }

  async onStart(): Promise<void> {
    if (this.meta.workspaceId()) await (await this.host()).sessions.recoverQueuedPrompts()
  }

  async onRequest(request: Request): Promise<Response> {
    const claimed = this.meta.workspaceId()
    const workspaceId = claimed ?? request.headers.get("x-workspace-id")
    if (!workspaceId) return Response.json(errorBody("relay_workspace_required", "Relay request workspace header is required"), { status: 400 })
    const response = claimed ? await (await this.host()).app.fetch(request) : await this.firstRequest(workspaceId, request)
    if (this.deleted) await this.wipe()
    return response
  }

  private async firstRequest(workspaceId: string, request: Request): Promise<Response> {
    const gate = new Hono()
      .use("*", createRelayHostAuthMiddleware({ key: await this.verificationKey(), workspaceId, hostId: sessionHostId(this.root) }))
      .all("*", async (c) => {
        this.meta.claimWorkspace(workspaceId)
        return (await this.host()).app.fetch(c.req.raw)
      })
    return gate.fetch(request)
  }

  private verificationKey() {
    this.key ??= loadRelayHostVerificationKeyOrJwks(this.env)
    return this.key
  }

  private host(): Promise<SessionHost> {
    this.hosting ??= this.verificationKey().then((key) => composeSessionHost({
      root: this.root, workspaceId: this.meta.workspaceId()!, storage: this.ctx.storage, key, policy: this.policy,
      placement: this.placement, held: () => this.turns.held(this.root),
      deleted: (sessionId) => { if (sessionId === this.root) this.deleted = true },
    }))
    return this.hosting
  }

  private async execution(signal: AbortSignal): Promise<TurnExecutionAccess> {
    const access = await this.turns.execution(this.root, signal)
    if (!this.meta.claimDirectory(access.directory)) throw new TurnAuthorityError(409, "session_host_directory_mismatch")
    return access
  }

  private async boot(): Promise<void> {
    if (!this.meta.workspaceId()) return
    const host = await this.host()
    host.store.recoverBusySessions()
    const stored = this.leases.current(this.root)
    const lease = stored ? await this.adopt(stored) : undefined
    if (host.store.getSession(this.root)) await host.runtime.resumeDurableRuns([this.root])
    const harness = await this.placement.harness()
    if (lease) void harness.waitForIdle(BACKGROUND_CONTEXT).finally(() => lease.release())
    else if ((await harness.inspect(BACKGROUND_CONTEXT)).tasks.length > 0) await this.abortRun()
  }

  private async adopt(stored: StoredTurnLease) {
    const lease = adoptSessionTurnLease({
      policy: this.policy, access: { ...stored.access, operation: "prompt", sessionId: this.root }, lease: stored,
      onLost: async () => {
        await this.abortRun()
        await lease.release()
        return { kind: "refused", refusal: { kind: "unauthorized", message: "The session host lost the turn lease it adopted, so Pi's run was aborted" } }
      },
    })
    try {
      await this.turns.delivery(this.root)
      return lease
    } catch (error) {
      console.error("The session host could not take over its turn", error)
      await lease.release()
      return undefined
    }
  }

  private async abortRun(): Promise<void> {
    const conversation = await (await this.placement.harness()).conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)
    await conversation?.abort(BACKGROUND_CONTEXT)
  }

  private async wipe(): Promise<void> {
    await this.pi.dispose()
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    setTimeout(() => this.ctx.abort("The session was deleted"), 0)
  }
}
