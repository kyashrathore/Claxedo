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
import { sessionCreateRequest } from "@claxedo/server-core/workspace/http/session-create-request"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import type { ControlPlaneServices } from "../authority/services"
import { asRecord, readJsonRecord, stringField } from "@claxedo/server-core/platform/json/index"
import { isComposedAuthorityPort } from "../authority/composed-authority"

export type MachineSessionCaller =
  SignedControlPlaneAuth | { kind: "channel"; identity: ChannelMachineIdentity } | { kind: "actor"; actorId: string }
export type MachineSessionCreate = {
  workspaceId: string
  title?: string
  harness?: SessionHarness
  model?: { providerID: string; modelID: string }
  /** Reasoning effort, under the runtime's own name for it. */
  variant?: string
  /** Retained on the session and reapplied by the runtime on every later turn. */
  instructions?: string
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
    const auth = signedCaller(caller)
    let runtimeOptions = options
    let embeddedHeaders: HeadersInit | undefined
    if (auth || channelIdentity || delegatedActor) {
      if (!services.authority)
        throw new ControlPlaneAuthError(503, "authority_unavailable", "Workspace authority is unavailable")
      const channelAccess = channelIdentity
        ? await services.authority.resolveChannelMachineAccess(channelIdentity, workspaceId)
        : undefined
      const access = delegatedActor
        ? await services.authority.resolveRuntimeMachineAccess(delegatedActor, workspaceId)
        : channelAccess
          ? channelAccess
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
        ...(channelIdentity && channelAccess
          ? { channelIdentity: { ...channelIdentity, identityVersion: channelAccess.identityVersion } }
          : {}),
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
      const authority = services.authority ?? undefined
      if (!isComposedAuthorityPort<Pick<PrivateSessionAuthority, "authorizeRuntimeSession">>(authority, ["authorizeRuntimeSession"])) {
        throw new ControlPlaneAuthError(503, "authority_unavailable", "Workspace authority is unavailable")
      }
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
    create: async (input: MachineSessionCreate, caller?: MachineSessionCaller) => {
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
        const authority = services.authority ?? undefined
        if (!isComposedAuthorityPort<Pick<PrivateSessionAuthority, "reserveSession" | "reserveRuntimeSession">>(
          authority,
          ["reserveSession", "reserveRuntimeSession"],
        ))
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
            ? await authority.reserveRuntimeSession(runtimeActor, intent)
            : await authority.reserveSession(caller, intent)
        if (reservation.sessionId !== id || reservation.operationId !== operationId || reservation.state !== "reserved")
          throw new Error("Machine session reservation did not match admission")
        headers["x-claxedo-session-registration-operation"] = operationId
      }
      const create = sessionCreateRequest({
        ...(id ? { id } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(input.harness ? { harness: input.harness } : {}),
      })
      const response = await client.request(create.path, { method: "POST", headers, body: create.body })
      if (!response.ok) throw await workspaceRuntimeRequestError("session creation", response)
      const session = await readJsonRecord(response)
      const sessionId = stringField(session, "id")
      if (!sessionId || (id && sessionId !== id))
        throw new Error("Machine runtime returned an invalid session identity")
      await services.projectionStore.put_session_meta(sessionId, {
        host: "workspace",
        workspaceID: input.workspaceId,
        directory: stringField(session, "directory"),
        title: stringField(session, "title"),
        ...(input.harness ? { tags: [`harness:${input.harness.id}`] } : {}),
      })
      return { ...session, id: sessionId }
    },
    async *prompt(sessionId: string, body: unknown, caller?: MachineSessionCaller) {
      const client = await sessionClient(sessionId, caller)
      const prompt = asRecord(body) ?? {}
      const messageID =
        typeof prompt.messageID === "string" && prompt.messageID ? prompt.messageID : `msg_${randomUUID()}`
      const abort = new AbortController()
      const stream = await client.request(`/api/wr/events?sessionID=${encodeURIComponent(sessionId)}`, { signal: abort.signal })
      if (!stream.ok || !stream.body) throw await workspaceRuntimeRequestError("session event subscription", stream)
      const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader()
      const queue: unknown[] = []
      let wake: (() => void) | undefined
      // One turn's state, mutated by three concurrent closures — the SSE
      // reader, the prompt POST, and this generator's own `finally`. Held
      // together in one object rather than five `let`s so a reader can see
      // which flags belong to the same handshake, and so each closure is
      // visibly writing shared state rather than a local of its own.
      const progress = {
        turnObserved: false,
        terminalObserved: false,
        responseComplete: false,
        closed: false,
        failure: undefined as unknown,
      }
      let terminalDeadline: ReturnType<typeof setTimeout> | undefined
      const reading = (async () => {
        let buffer = ""
        while (!progress.closed && !progress.terminalObserved) {
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
              progress.turnObserved = true
            if (!progress.turnObserved) continue
            if (queue.length >= 1024) throw new Error("Channel consumer fell behind the machine event stream")
            queue.push(event)
            if (
              event.type === "session.idle" ||
              event.type === "session.error" ||
              (event.type === "session.status" && event.properties?.status?.type === "idle")
            ) {
              progress.terminalObserved = true
              if (terminalDeadline) clearTimeout(terminalDeadline)
            }
            wake?.()
            if (progress.terminalObserved) break
          }
        }
        if (!progress.closed && !progress.terminalObserved) throw new Error("Machine event stream disconnected during the turn")
      })().catch((error) => {
        if (!progress.closed) {
          progress.failure = error
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
          progress.responseComplete = true
          // HTTP and SSE are independent transports. Completion of the POST is
          // not evidence that the observer has received the machine's terminal.
          if (!progress.terminalObserved)
            terminalDeadline = setTimeout(() => {
              progress.failure = new Error("Machine prompt completed without an observed terminal event")
              wake?.()
            }, 15_000)
        })
        .catch((error) => {
          progress.failure = error
        })
        .finally(() => wake?.())
      try {
        while (!progress.responseComplete || !progress.terminalObserved || queue.length) {
          if (progress.failure) throw progress.failure
          if (queue.length) {
            yield queue.shift()
            continue
          }
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
        if (progress.failure) throw progress.failure
      } finally {
        progress.closed = true
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


/**
 * A caller that is a signed account rather than a channel identity or a
 * delegated actor. The union's two other members carry a `kind` discriminant,
 * so this is a real narrowing; the previous `caller as SignedControlPlaneAuth`
 * only asserted the same conclusion.
 */
function signedCaller(caller: MachineSessionCaller | undefined): SignedControlPlaneAuth | undefined {
  return caller === undefined || "kind" in caller ? undefined : caller
}

