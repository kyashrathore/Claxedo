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

/** Who a request or a wake acts for. A `person` and an `agent` carry a user; a `link` request and a `system` wake carry none. */
export type PluginCallerOrigin = "person" | "agent" | "link" | "system"

export type PluginCaller = Readonly<{ orgId: string; origin: PluginCallerOrigin; userId?: string }>

export type PluginProject = Readonly<{ id: string; repoKey: string }>

export type PluginProjectAccess = "read" | "write"

export type PluginBlobHead = Readonly<{ key: string; size: number; contentType?: string; uploadedAt: number }>

export type PluginBlob = PluginBlobHead & Readonly<{ bytes: Uint8Array }>

export type PluginBlobPage = Readonly<{ blobs: readonly PluginBlobHead[]; cursor?: string }>

export type PluginEventAudience = "caller" | "project" | "org"

export type PluginWake = Readonly<{ name: string; at: number; payload?: unknown }>

export type PluginLink = Readonly<{ token: string; url: string; path: string; expiresAt?: number }>

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
})

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
