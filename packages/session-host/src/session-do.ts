import { DurableObject } from "cloudflare:workers"
import type { TurnExecutionAccess } from "@claxedo/harness/contract"
import {
  adoptSessionTurnLease, errorBody, remoteWorkspaceSessionAccessPolicy, RuntimeStoreSchemaMismatchError, type SessionAccessPolicy,
} from "@claxedo/session-core"
import { createRelayHostAuthMiddleware, loadRelayHostVerificationKeyOrJwks, type RelayHostAuthOptions } from "@claxedo/session-core/relay-host"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import { Lifecycle } from "agents/lifecycle"
import { PiHarness } from "agents/harness/pi"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { composeSessionHost, type SessionHost } from "./composition"
import { DurablePiPlacement } from "./pi-placement"
import { SessionHostMeta } from "./session-host-meta"
import { SessionHostTurns, TurnAuthorityError } from "./turn-delivery"
import { TurnLeases, type StoredTurnLease } from "./turn-leases"

/** A request or control-plane call at or past this is logged with its timing, so a slow composer read can be placed. */
const SLOW_REQUEST_MS = 1_000

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
  private readonly lifecycle: Lifecycle
  private readonly controlPlane: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  private key: Promise<RelayHostAuthOptions["key"]> | undefined
  private hosting: Promise<SessionHost> | undefined
  private erasing = false

  constructor(ctx: DurableObjectState, env: SessionHostEnv) {
    super(ctx, env)
    const root = ctx.id.name
    if (!root) throw new Error("A session host is addressed by its root session's id")
    this.root = root
    this.controlPlane = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      const askedAt = Date.now()
      const response = await env.CONTROL_PLANE.fetch(url, init)
      const ms = Date.now() - askedAt
      if (ms >= SLOW_REQUEST_MS) console.warn("Slow control plane call from the session host", { path: new URL(url).pathname, status: response.status, ms })
      return response
    }
    this.meta = new SessionHostMeta(ctx.storage.sql)
    this.turns = new SessionHostTurns({ fetch: this.controlPlane, authorityUrl: env.WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL, leases: () => this.leases })
    this.leases = new TurnLeases(ctx.storage.sql, (lease) => this.turns.forget(lease))
    this.policy = this.leases.observe(remoteWorkspaceSessionAccessPolicy({ url: env.WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL, fetch: this.controlPlane }))
    this.pi = new PiHarness({ harness: (input) => this.placement.factory(() => this.boot())(input) })
    this.placement = new DurablePiPlacement({
      root, pi: this.pi, report: (error) => console.error("Pi extension failure", error),
      execution: (signal) => this.execution(signal),
      turnContext: async () => {
        await this.turns.delivery(root)
        return (await this.host()).turnContext()
      },
      controlPlane: (input, init) => this.controlPlane(input, init),
      firstPartyMcpToken: async () => (await this.turns.delivery(root)).delivery.firstPartyMcp?.token,
      refresh: async (credentialProviderId) => {
        await this.turns.delivery(root, { renew: true })
        return (await (await this.host()).turnContext()).credentials.direct?.[credentialProviderId]
      },
    })
    this.lifecycle = Lifecycle.install(this).use(this.pi)
  }

  /**
   * The Lifecycle's own `fetch` answers a startup failure with its stack. An
   * object that cannot start (a store this build refuses, say) instead answers
   * a typed refusal, and can still be deleted.
   */
  async fetch(request: Request): Promise<Response> {
    const arrivedAt = Date.now()
    let failure: unknown
    const started = await this.lifecycle.start().then(() => true, (error: unknown) => { failure = error; return false })
    const startedAt = Date.now()
    const response = started ? await this.lifecycle.fetch(request) : await this.unstarted(request, failure)
    const ms = Date.now() - arrivedAt
    if (ms >= SLOW_REQUEST_MS) {
      console.warn("Slow session host request", { method: request.method, path: new URL(request.url).pathname, status: response.status, ms, startMs: startedAt - arrivedAt })
    }
    return response
  }

  private unstarted(request: Request, failure: unknown): Promise<Response> {
    console.error("The session host could not start", failure)
    return this.serve(request, failure instanceof RuntimeStoreSchemaMismatchError
      ? { status: 409, code: "session_host_unsupported_store", message: "This session's stored state was written by a build this one does not read" }
      : { status: 503, code: "session_host_unavailable", message: "The session host could not start" })
  }

  async onStart(): Promise<void> {
    if (this.meta.workspaceId()) await (await this.host()).sessions.recoverQueuedPrompts()
  }

  async onRequest(request: Request): Promise<Response> {
    const response = await this.serve(request)
    if (this.erasing) await this.erase()
    return response
  }

  private async serve(request: Request, unstarted?: { status: 409 | 503; code: string; message: string }): Promise<Response> {
    const claimed = this.meta.workspaceId()
    if (claimed && !unstarted) return (await this.host()).app.fetch(request)
    const workspaceId = claimed ?? request.headers.get("x-workspace-id")
    if (!workspaceId) return Response.json(errorBody("relay_workspace_required", "Relay request workspace header is required"), { status: 400 })
    const gate = new Hono().use("*", createRelayHostAuthMiddleware({ key: await this.verificationKey(), workspaceId, hostId: sessionHostId(this.root) }))
    if (!unstarted) {
      return gate.all("*", async (c) => {
        this.meta.claimWorkspace(workspaceId)
        return (await this.host()).app.fetch(c.req.raw)
      }).fetch(request)
    }
    return gate
      .delete(`/session/${this.root}`, async (c) => {
        const refused = await this.deleteAtControlPlane(c.req.header("authorization"))
        if (refused) return c.json(errorBody("session_delete_failed", refused.message), refused.status)
        await this.erase()
        return c.json({ ok: true, deletedSessionIds: [this.root] })
      })
      .all("*", (c) => c.json(errorBody(unstarted.code, unstarted.message), unstarted.status))
      .fetch(request)
  }

  private verificationKey() {
    this.key ??= loadRelayHostVerificationKeyOrJwks(this.env)
    return this.key
  }

  private host(): Promise<SessionHost> {
    const hosting = this.hosting ?? this.verificationKey().then((key) => composeSessionHost({
      root: this.root, workspaceId: this.meta.workspaceId()!, storage: this.ctx.storage, key, policy: this.policy,
      placement: this.placement, held: () => this.turns.held(this.root),
      beforeDelete: async (sessionId, credential) => {
        const refused = sessionId === this.root ? await this.deleteAtControlPlane(credential) : undefined
        if (refused) throw new HTTPException(refused.status, { message: refused.message })
        this.erasing = true
      },
    }))
    this.hosting = hosting
    hosting.catch(() => { if (this.hosting === hosting) this.hosting = undefined })
    return hosting
  }

  /** Why the control plane did not delete the session as the request's actor; nothing once it deleted it. */
  private async deleteAtControlPlane(credential: string | undefined): Promise<{ status: 403 | 502; message: string } | undefined> {
    const answer = await this.controlPlane(new URL("session-host-delete", this.env.WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL).href, {
      method: "POST", headers: { "content-type": "application/json", ...(credential ? { authorization: credential } : {}) },
      body: JSON.stringify({ sessionId: this.root }),
    })
    if (answer.ok) return undefined
    return { status: answer.status === 401 || answer.status === 403 ? 403 : 502, message: `The control plane did not delete the session: ${answer.status} ${await answer.text()}` }
  }

  private async execution(signal: AbortSignal): Promise<TurnExecutionAccess> {
    const access = await this.turns.execution(this.root, signal)
    if (!this.meta.claimDirectory(access)) throw new TurnAuthorityError(409, "session_host_directory_mismatch")
    return access
  }

  private async boot(): Promise<void> {
    if (!this.meta.workspaceId()) return
    const host = await this.host()
    host.store.recoverBusySessions()
    const stored = this.leases.current(this.root)
    const lease = stored ? await this.adopt(stored) : undefined
    if (lease) this.placement.turnStarted(lease.signal)
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

  private async erase(): Promise<void> {
    await this.pi.dispose()
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    setTimeout(() => this.ctx.abort("The session was deleted"), 0)
  }
}
