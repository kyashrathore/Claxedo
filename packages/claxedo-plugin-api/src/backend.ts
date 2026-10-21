import type { SessionRef } from "@claxedo/agent-runtime-contract"
import type { PluginPermission } from "./manifest"

/** The one header a request to a backend carries about its caller: an opaque handle only `identity.caller` resolves. */
export const PLUGIN_CALLER_HEADER = "x-claxedo-caller"

/**
 * The name the backend gave `env.PLATFORM.object`, on every request one of its
 * objects receives. Every object's `ctx.id` is the supervisor's, so this is the
 * only way an object tells itself from its siblings.
 */
export const PLUGIN_OBJECT_NAME_HEADER = "x-claxedo-object-name"

/** Where the platform delivers a due wake: `POST /_wake/<name>`, with a system caller. No public request reaches a path under `/_`. */
export const PLUGIN_WAKE_PATH_PREFIX = "/_wake/"

export const PLUGIN_BLOB_LIMITS = Object.freeze({
  keyPattern: /^[A-Za-z0-9._/-]{1,512}$/,
  objectBytes: 16 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  listPage: 1000,
})

export const PLUGIN_EVENT_LIMITS = Object.freeze({ topicPattern: /^[A-Za-z0-9._:-]{1,128}$/, dataBytes: 8 * 1024, perSecond: 10 })

export const PLUGIN_WAKE_LIMITS = Object.freeze({ namePattern: /^[A-Za-z0-9._-]{1,128}$/, count: 100, minLeadMs: 30_000, payloadBytes: 4 * 1024 })

export const PLUGIN_LINK_LIMITS = Object.freeze({ pathMaxLength: 1024, perPlugin: 1000 })

export const PLUGIN_SESSION_LIMITS = Object.freeze({
  originPartMaxLength: 256,
  titleMaxLength: 200,
  instructionsBytes: 64 * 1024,
  textBytes: 64 * 1024,
  attachments: 6,
  attachmentBytes: 1_572_864,
  attachmentTypes: Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp"] as const),
  originsPerState: 100,
  selectionReferences: 256,
})

/** Who a request or a wake acts for. A `person` and an `agent` carry a user; a `link` request and a `system` wake carry none. */
export type PluginCallerOrigin = "person" | "agent" | "link" | "system"

/**
 * An `agent` caller also names the session it acts from, and whether a person
 * other than that session's owner drives it: a member-driven session's agent
 * may not start a session of its own.
 */
export type PluginCaller = Readonly<{ orgId: string; origin: PluginCallerOrigin; userId?: string; session?: SessionRef; ownerDriven?: boolean }>

export type PluginProject = Readonly<{ id: string; repoKey: string }>

export type PluginProjectAccess = "read" | "write"

export type PluginBlobHead = Readonly<{ key: string; size: number; contentType?: string; uploadedAt: number }>

export type PluginBlob = PluginBlobHead & Readonly<{ bytes: Uint8Array }>

export type PluginBlobPage = Readonly<{ blobs: readonly PluginBlobHead[]; cursor?: string }>

export type PluginEventAudience = "caller" | "project" | "org"

export type PluginWake = Readonly<{ name: string; at: number; payload?: unknown }>

export type PluginLink = Readonly<{ token: string; url: string; path: string; expiresAt?: number }>

/**
 * What a backend starts a session for: a scope it names, such as a project,
 * and a key unique within it, such as a task's slot and attempt. One origin
 * has at most one session, so a start sent again answers the one it created.
 */
export type PluginSessionOrigin = Readonly<{ scope: string; key: string }>

/** `local` runs in the project's own workspace; `cloud` in an isolated cloud workspace of the origin's own, which needs `workspaces.cloud`. */
export type PluginSessionPlacement = "local" | "cloud"

export type PluginSessionConfiguration = Readonly<{
  harness: Readonly<{ id: string; access: "native" | "connection" }>
  model: Readonly<{ providerID: string; modelID: string }>
  /** Null leaves the model's own default. */
  effort: string | null
}>

/** The Marketplace plugins and skills a cloud session's workspace is prepared with. */
export type PluginSessionSelection = Readonly<{
  plugins: readonly Readonly<{ sourceId: string; pluginName: string }>[]
  skills: readonly Readonly<{ sourceId: string; skillName: string }>[]
}>

export type PluginSessionStart = Readonly<{
  origin: PluginSessionOrigin
  projectId: string
  placement: PluginSessionPlacement
  configuration: PluginSessionConfiguration
  /** Kept on the session and reapplied on every later turn. */
  instructions?: string
  /** Cloud placement only. */
  selection?: PluginSessionSelection
  /** A session whose transcript is carried into the instructions; the caller must be allowed to open it at the read. */
  continueFrom?: SessionRef
  title?: string
}>

/** Why a start cannot run where it would, in a sentence a person reads. */
export type PluginSessionBlocker = Readonly<{ code: string; detail: string }>

/** What a start would run, named by `digest`: a start whose digest no longer matches is refused. */
export type PluginSessionPreview = Readonly<{ digest: string; blockers: readonly PluginSessionBlocker[] }>

/** The origin's session, or the cloud workspace whose start is still under way: send the same start again once it runs. */
export type PluginSessionStarted = Readonly<{ session: SessionRef; continuedFrom?: SessionRef }> | Readonly<{ preparing: Readonly<{ workspaceId: string }> }>

/** One of the plugin's own blobs, sent as a file beside a first message. */
export type PluginSessionAttachment = Readonly<{ key: string; filename?: string }>

export type PluginSessionLiveness = "live" | "archived" | "deleted" | "unavailable"

/** Whether the origin's first message reached its session; `unknown` when nothing should be sent on the strength of the answer. */
export type PluginSessionHandoff = "sent" | "pending" | "unknown"

export type PluginSessionState = Readonly<{ origin: PluginSessionOrigin; session: SessionRef; state: PluginSessionLiveness; handoff: PluginSessionHandoff }>

/** A harness a session can start with at a placement, and the models it offers there; none listed means it was not asked. */
export type PluginSessionHarness = Readonly<{
  id: string
  access: "native" | "connection"
  label: string
  models: readonly Readonly<{ providerID: string; modelID: string; name?: string }>[]
}>

/** One call a backend makes of the platform, as `env.PLATFORM.call` carries it. */
export type PluginPlatformCall =
  | { readonly name: "identity.caller" }
  | { readonly name: "projects.list" }
  | { readonly name: "projects.authorize"; readonly projectId: string; readonly access: PluginProjectAccess }
  | { readonly name: "blobs.put"; readonly key: string; readonly bytes: Uint8Array; readonly contentType?: string }
  | { readonly name: "blobs.get"; readonly key: string }
  | { readonly name: "blobs.head"; readonly key: string }
  | { readonly name: "blobs.delete"; readonly key: string }
  | { readonly name: "blobs.list"; readonly prefix?: string; readonly cursor?: string }
  | { readonly name: "events.publish"; readonly audience: PluginEventAudience; readonly projectId?: string; readonly topic: string; readonly data?: unknown }
  | { readonly name: "schedule.at"; readonly wake: string; readonly at: number; readonly payload?: unknown }
  | { readonly name: "schedule.cancel"; readonly wake: string }
  | { readonly name: "schedule.list" }
  | { readonly name: "links.create"; readonly path: string; readonly expiresAt?: number }
  | { readonly name: "links.revoke"; readonly token: string }
  | { readonly name: "sessions.harnesses"; readonly projectId: string; readonly placement: PluginSessionPlacement }
  | ({ readonly name: "sessions.preview" } & PluginSessionStart)
  | ({ readonly name: "sessions.start"; readonly digest: string } & PluginSessionStart)
  | {
      readonly name: "sessions.handoff"
      readonly origin: PluginSessionOrigin
      readonly session: SessionRef
      readonly text: string
      readonly attachments?: readonly PluginSessionAttachment[]
    }
  | { readonly name: "sessions.abandon"; readonly origin: PluginSessionOrigin; readonly session: SessionRef }
  | { readonly name: "sessions.state"; readonly origins: readonly PluginSessionOrigin[] }
  | { readonly name: "sessions.authorizeOpen"; readonly session: SessionRef }

export type PluginPlatformCallName = PluginPlatformCall["name"]

/** The permission each call needs in the manifest's `permissions`; `identity.caller` needs none. */
export const PLATFORM_CALL_PERMISSIONS: Readonly<Record<PluginPlatformCallName, PluginPermission | undefined>> = Object.freeze({
  "identity.caller": undefined,
  "projects.list": "projects.read",
  "projects.authorize": "projects.read",
  "blobs.put": "blobs",
  "blobs.get": "blobs",
  "blobs.head": "blobs",
  "blobs.delete": "blobs",
  "blobs.list": "blobs",
  "events.publish": "events",
  "schedule.at": "schedule",
  "schedule.cancel": "schedule",
  "schedule.list": "schedule",
  "links.create": "links",
  "links.revoke": "links",
  "sessions.harnesses": "sessions.start",
  "sessions.preview": "sessions.start",
  "sessions.start": "sessions.start",
  "sessions.handoff": "sessions.start",
  "sessions.abandon": "sessions.start",
  "sessions.state": "sessions.read",
  "sessions.authorizeOpen": "sessions.read",
})

/** Every permission a call needs: its own, and `workspaces.cloud` for a preview or start that would place a cloud workspace. */
export function platformCallPermissions(call: PluginPlatformCall): readonly PluginPermission[] {
  const own = PLATFORM_CALL_PERMISSIONS[call.name]
  const cloud = (call.name === "sessions.preview" || call.name === "sessions.start") && call.placement === "cloud"
  return [...(own ? [own] : []), ...(cloud ? (["workspaces.cloud"] as const) : [])]
}

export type PluginPlatformRefusal = Readonly<{ ok: false; status: number; code: string; message: string }>

export type PluginPlatformAnswer = Readonly<{ ok: true; value?: unknown }> | PluginPlatformRefusal

/** `env.PLATFORM` as the runtime binds it into a loaded backend. */
export interface PluginPlatformBinding {
  object(className: string, name: string, request: Request): Promise<Response>
  active(): Promise<boolean>
  call(call: PluginPlatformCall, handle?: string): Promise<PluginPlatformAnswer>
}

export class PluginPlatformError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "PluginPlatformError"
  }
}

/** The typed platform a backend's handlers receive, bound to the request it is answering. */
export type PluginBackendPlatform = Readonly<{
  /** Whether this backend's activation is still the current one. */
  active(): Promise<boolean>
  /** One of the plugin's objects, named by the backend; the object receives `name` in `x-claxedo-object-name`. */
  object(className: string, name: string, request: Request): Promise<Response>
  identity: { caller(): Promise<PluginCaller> }
  projects: {
    list(): Promise<readonly PluginProject[]>
    authorize(projectId: string, access: PluginProjectAccess): Promise<boolean>
  }
  blobs: {
    put(key: string, bytes: Uint8Array, options?: { contentType?: string }): Promise<PluginBlobHead>
    get(key: string): Promise<PluginBlob | undefined>
    head(key: string): Promise<PluginBlobHead | undefined>
    delete(key: string): Promise<void>
    list(options?: { prefix?: string; cursor?: string }): Promise<PluginBlobPage>
  }
  events: { publish(event: { audience: PluginEventAudience; projectId?: string; topic: string; data?: unknown }): Promise<{ recipients: number }> }
  schedule: {
    at(wake: string, at: number, payload?: unknown): Promise<void>
    cancel(wake: string): Promise<void>
    list(): Promise<readonly PluginWake[]>
  }
  links: {
    create(link: { path: string; expiresAt?: number }): Promise<PluginLink>
    revoke(token: string): Promise<void>
  }
  sessions: {
    harnesses(input: { projectId: string; placement: PluginSessionPlacement }): Promise<readonly PluginSessionHarness[]>
    preview(start: PluginSessionStart): Promise<PluginSessionPreview>
    start(start: PluginSessionStart & { digest: string }): Promise<PluginSessionStarted>
    handoff(input: { origin: PluginSessionOrigin; session: SessionRef; text: string; attachments?: readonly PluginSessionAttachment[] }): Promise<{ sent: boolean }>
    abandon(input: { origin: PluginSessionOrigin; session: SessionRef }): Promise<{ removed: boolean }>
    state(origins: readonly PluginSessionOrigin[]): Promise<readonly PluginSessionState[]>
    authorizeOpen(session: SessionRef): Promise<boolean>
  }
}>

/**
 * The platform as one request's handlers see it: every call that acts as the
 * caller carries the request's caller handle, and a refused call throws
 * `PluginPlatformError` with the platform's code.
 */
export function pluginPlatform(binding: PluginPlatformBinding, request?: Request): PluginBackendPlatform {
  const handle = request?.headers.get(PLUGIN_CALLER_HEADER) ?? undefined
  const call = async <T>(platformCall: PluginPlatformCall): Promise<T> => {
    const answer = await binding.call(platformCall, handle)
    if (!answer.ok) throw new PluginPlatformError(answer.status, answer.code, answer.message)
    // The answer crosses RPC untyped; the platform answers each call with the
    // value `PluginBackendPlatform` names for it, and the runtime is its one producer.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return answer.value as T
  }
  return {
    active: () => binding.active(),
    object: (className, name, objectRequest) => binding.object(className, name, objectRequest),
    identity: { caller: () => call({ name: "identity.caller" }) },
    projects: {
      list: () => call({ name: "projects.list" }),
      authorize: (projectId, access) => call({ name: "projects.authorize", projectId, access }),
    },
    blobs: {
      put: (key, bytes, options) => call({ name: "blobs.put", key, bytes, ...(options?.contentType ? { contentType: options.contentType } : {}) }),
      get: (key) => call({ name: "blobs.get", key }),
      head: (key) => call({ name: "blobs.head", key }),
      delete: (key) => call({ name: "blobs.delete", key }),
      list: (options) => call({ name: "blobs.list", ...options }),
    },
    events: { publish: (event) => call({ name: "events.publish", ...event }) },
    schedule: {
      at: (wake, at, payload) => call({ name: "schedule.at", wake, at, ...(payload === undefined ? {} : { payload }) }),
      cancel: (wake) => call({ name: "schedule.cancel", wake }),
      list: () => call({ name: "schedule.list" }),
    },
    links: {
      create: (link) => call({ name: "links.create", ...link }),
      revoke: (token) => call({ name: "links.revoke", token }),
    },
    sessions: {
      harnesses: (input) => call({ name: "sessions.harnesses", ...input }),
      preview: (start) => call({ name: "sessions.preview", ...start }),
      start: (start) => call({ name: "sessions.start", ...start }),
      handoff: (input) => call({ name: "sessions.handoff", ...input }),
      abandon: (input) => call({ name: "sessions.abandon", ...input }),
      state: (origins) => call({ name: "sessions.state", origins }),
      authorizeOpen: (session) => call({ name: "sessions.authorizeOpen", session }),
    },
  }
}

export type PluginBackendEnv = { PLATFORM: PluginPlatformBinding }

export type PluginBackendDefinition = Readonly<{
  /** Answers a request to one of the manifest's routes. */
  fetch(request: Request, platform: PluginBackendPlatform): Response | Promise<Response>
  /** Runs a wake `schedule.at` set, once, when it is due; its caller is `system`. */
  wake?(name: string, payload: unknown, platform: PluginBackendPlatform): void | Promise<void>
}>

/**
 * A backend's default export. Requests reach `fetch` with the platform bound
 * to their caller; a due wake reaches `wake`, and a wake for a backend that
 * declares none is answered and dropped.
 */
export function definePluginBackend(definition: PluginBackendDefinition) {
  return {
    async fetch(request: Request, env: PluginBackendEnv): Promise<Response> {
      const platform = pluginPlatform(env.PLATFORM, request)
      const path = new URL(request.url).pathname
      if (!path.startsWith(PLUGIN_WAKE_PATH_PREFIX)) return definition.fetch(request, platform)
      const payload: unknown = await request.json().catch(() => undefined)
      await definition.wake?.(decodeURIComponent(path.slice(PLUGIN_WAKE_PATH_PREFIX.length)), payload, platform)
      return new Response(null, { status: 204 })
    },
  }
}
