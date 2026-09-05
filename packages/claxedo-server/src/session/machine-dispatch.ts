import {
  embeddedRelayHostAuthFromActor,
  EMBEDDED_RELAY_HOST_AUTH_HEADER,
} from "@claxedo/local-server/self-hosted-execution"
import { eventSessionId } from "@claxedo/agent-sdk-runtime/compat-events"
import { randomUUID } from "node:crypto"
import type { ChannelMachineIdentity } from "@claxedo/server-core/platform/auth/authority"
import type { SessionHarness } from "@claxedo/agent-sdk-runtime"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { PrivateSessionAuthority } from "@claxedo/server-core/platform/auth/private-session-authority"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import {
  createWorkspaceRuntimeClient,
  workspaceRuntimeRequestError,
  type WorkspaceRuntimeClientOptions,
} from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import type { ControlPlaneServices } from "../authority/services"

export type MachineSessionCaller =
  SignedControlPlaneAuth | { kind: "channel"; identity: ChannelMachineIdentity } | { kind: "actor"; actorId: string }
export type MachineSessionCreate = {
  workspaceId: string
  title?: string
  harness?: SessionHarness
  model?: { providerID: string; modelID: string }
}
export type MachineSessionDispatch = ReturnType<typeof createMachineSessionDispatch>

/** Admission and transport only. The workspace runtime owns every harness turn. */
export function createMachineSessionDispatch(services: ControlPlaneServices, options: WorkspaceRuntimeClientOptions) {
  async function target(workspaceId: string, caller?: MachineSessionCaller) {
    if (!workspaceId)
      throw new ControlPlaneAuthError(400, "workspace_required", "Select a machine workspace before starting a session")
    const workspace = await resolveWorkspace({ workspaceId })
    if (!workspace)
      throw new ClaxedoError({
        status: 404,
        code: "workspace_not_found",
        message: "Register or open this machine workspace first",
      })
    const channelIdentity = caller && "identity" in caller ? caller.identity : undefined
    const delegatedActor = caller && "kind" in caller && caller.kind === "actor" ? caller.actorId : undefined
    const auth = caller && !channelIdentity && !delegatedActor ? (caller as SignedControlPlaneAuth) : undefined
    let runtimeOptions = options
    let embeddedHeaders: HeadersInit | undefined
    if (auth || channelIdentity || delegatedActor) {
      if (!services.authority)
        throw new ControlPlaneAuthError(503, "authority_unavailable", "Workspace authority is unavailable")
      const access = delegatedActor
        ? await services.authority.resolveRuntimeMachineAccess(delegatedActor, workspaceId)
        : channelIdentity
          ? await services.authority.resolveChannelMachineAccess(channelIdentity, workspaceId)
          : await services.authority
              .openWorkspace(auth!, { workspaceId })
              .then(async (result) => ({
                ...(await resolveRuntimeActor(services.authority!, auth!)),
                orgId: result.workspace?.org_id,
                role: result.role,
              }))
      const actor = access
      const orgId = access.orgId
      const role = access.role
      if (!orgId || (role !== "owner" && role !== "admin" && role !== "editor"))
        throw new ControlPlaneAuthError(
          403,
          "workspace_authorization_denied",
          "Machine dispatch requires workspace write access",
        )
      runtimeOptions = {
        ...options,
        auth,
        channelIdentity,
        delegatedActor: !!delegatedActor,
        orgId,
        role,
        runtimeActor: { ...actor, principalKind: actor.actorKind === "human" ? "user" : "service" },
      }
      if (workspace.kind !== "cloud")
        embeddedHeaders = {
          [EMBEDDED_RELAY_HOST_AUTH_HEADER]: JSON.stringify(
            embeddedRelayHostAuthFromActor({ ...actor, orgId, role }, workspaceId),
          ),
        }
    }
    const actor = runtimeOptions.runtimeActor
    const runtimeActor =
      actor?.actorKind === "human"
        ? { actorId: actor.actorId, actorKind: "human" as const, principalKind: "user" as const }
        : actor?.actorKind === "agent"
          ? { actorId: actor.actorId, actorKind: "agent" as const, principalKind: "service" as const }
          : undefined
    return {
      workspace,
      runtimeActor,
      client: createWorkspaceRuntimeClient({ workspace, options: runtimeOptions, headers: () => embeddedHeaders }),
    }
  }
  async function sessionClient(sessionId: string, caller?: MachineSessionCaller) {
    const meta = await services.projectionStore.session_meta(sessionId)
    if (meta?.host !== "workspace" || !meta.workspaceID)
      throw new ControlPlaneAuthError(400, "workspace_required", "Select an existing machine session before dispatch")
    const resolved = await target(meta.workspaceID, caller)
    if (caller) {
      const authority = services.authority as unknown as PrivateSessionAuthority
      if (!resolved.runtimeActor) throw new Error("Machine dispatch actor is unavailable")
      await authority.authorizeRuntimeSession({
        ...resolved.runtimeActor,
        sessionId,
        workspaceId: meta.workspaceID,
        action: "write",
      })
    }
    return resolved.client
  }
  return {
    async authorize(sessionId: string, caller?: MachineSessionCaller) {
      await sessionClient(sessionId, caller)
      const meta = await services.projectionStore.session_meta(sessionId)
      return { workspaceId: meta!.workspaceID! }
    },
    async create(input: MachineSessionCreate, caller?: MachineSessionCaller) {
      const { workspace, client, runtimeActor } = await target(input.workspaceId, caller)
      const headers: Record<string, string> = { "content-type": "application/json" }
      let id: string | undefined
      if (workspace.kind === "cloud" || caller) {
        if (!caller || !runtimeActor)
          throw new ControlPlaneAuthError(
            403,
            "session_identity_required",
            "Create and bind a machine session using your signed account before channel dispatch",
          )
        const authority = services.authority as unknown as Partial<PrivateSessionAuthority>
        if (!authority.reserveSession)
          throw new ControlPlaneAuthError(
            503,
            "session_registration_unavailable",
            "Session registration is unavailable",
          )
        id = `ses_${randomUUID()}`
        const operationId = `session_registration_${randomUUID()}`
        const intent = {
          operationId,
          sessionId: id,
          workspaceId: input.workspaceId,
          kind: "create" as const,
          ...(input.title ? { title: input.title } : {}),
        }
        const reservation =
          "kind" in caller
            ? await authority.reserveRuntimeSession!(runtimeActor, intent)
            : await authority.reserveSession(caller, intent)
        if (reservation.sessionId !== id || reservation.operationId !== operationId || reservation.state !== "reserved")
          throw new Error("Machine session reservation did not match admission")
        headers["x-claxedo-session-registration-operation"] = operationId
      }
      const query = input.harness
        ? `?${input.harness.access === "native" ? "nativeHarness" : "connectionId"}=${encodeURIComponent(input.harness.id)}`
        : ""
      const response = await client.request(`/session${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...(id ? { id } : {}), title: input.title, model: input.model }),
      })
      if (!response.ok) throw await workspaceRuntimeRequestError("session creation", response)
      const session = (await response.json()) as { id?: string; directory?: string; title?: string }
      if (!session.id || (id && session.id !== id))
        throw new Error("Machine runtime returned an invalid session identity")
      await services.projectionStore.put_session_meta(session.id, {
        host: "workspace",
        workspaceID: input.workspaceId,
        directory: session.directory,
        title: session.title,
        ...(input.harness ? { tags: [`harness:${input.harness.id}`] } : {}),
      })
      return { ...session, id: session.id }
    },
    async *prompt(sessionId: string, body: unknown, caller?: MachineSessionCaller) {
      const client = await sessionClient(sessionId, caller)
      const prompt = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
      const messageID =
        typeof prompt.messageID === "string" && prompt.messageID ? prompt.messageID : `msg_${randomUUID()}`
      const abort = new AbortController()
      const stream = await client.request(`/event?sessionID=${encodeURIComponent(sessionId)}`, { signal: abort.signal })
      if (!stream.ok || !stream.body) throw await workspaceRuntimeRequestError("session event subscription", stream)
      const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader()
      const queue: unknown[] = []
      let wake: (() => void) | undefined
      let turnObserved = false
      let terminalObserved = false
      let responseComplete = false
      let closed = false
      let failure: unknown
      let terminalDeadline: ReturnType<typeof setTimeout> | undefined
      const reading = (async () => {
        let buffer = ""
        while (!closed && !terminalObserved) {
          const item = await reader.read()
          if (item.done) break
          buffer += item.value
          if (buffer.length > 4 * 1024 * 1024) throw new Error("Machine event frame exceeded the channel buffer limit")
          let match: RegExpExecArray | null
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, match.index)
            buffer = buffer.slice(match.index + match[0].length)
            const data = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n")
            if (!data) continue
            const envelope = JSON.parse(data)
            const event = envelope.payload ?? envelope
            if (eventSessionId(event) !== sessionId) continue
            const info = event.properties?.info
            if (event.type === "message.updated" && (info?.id === messageID || info?.parentID === messageID))
              turnObserved = true
            if (!turnObserved) continue
            if (queue.length >= 1024) throw new Error("Channel consumer fell behind the machine event stream")
            queue.push(event)
            if (
              event.type === "session.idle" ||
              event.type === "session.error" ||
              (event.type === "session.status" && event.properties?.status?.type === "idle")
            ) {
              terminalObserved = true
              if (terminalDeadline) clearTimeout(terminalDeadline)
            }
            wake?.()
            if (terminalObserved) break
          }
        }
        if (!closed && !terminalObserved) throw new Error("Machine event stream disconnected during the turn")
      })().catch((error) => {
        if (!closed) {
          failure = error
          wake?.()
        }
      })
      const turn = client
        .request(`/session/${encodeURIComponent(sessionId)}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...prompt, messageID }),
          signal: abort.signal,
        })
        .then(async (response) => {
          if (!response.ok) throw await workspaceRuntimeRequestError("channel prompt", response)
          await response.arrayBuffer()
          responseComplete = true
          // HTTP and SSE are independent transports. Completion of the POST is
          // not evidence that the observer has received the machine's terminal.
          if (!terminalObserved)
            terminalDeadline = setTimeout(() => {
              failure = new Error("Machine prompt completed without an observed terminal event")
              wake?.()
            }, 15_000)
        })
        .catch((error) => {
          failure = error
        })
        .finally(() => wake?.())
      try {
        while (!responseComplete || !terminalObserved || queue.length) {
          if (failure) throw failure
          if (queue.length) {
            yield queue.shift()
            continue
          }
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
        if (failure) throw failure
      } finally {
        closed = true
        if (terminalDeadline) clearTimeout(terminalDeadline)
        abort.abort()
        await reader.cancel().catch(() => {})
        await reading
        // Losing the observer never replays an admitted machine turn.
        await turn
      }
    },
    async request(sessionId: string, resource: string, init: RequestInit, caller?: MachineSessionCaller) {
      const client = await sessionClient(sessionId, caller)
      return client.request(`/session/${encodeURIComponent(sessionId)}/${resource}`, init)
    },
  }
}
