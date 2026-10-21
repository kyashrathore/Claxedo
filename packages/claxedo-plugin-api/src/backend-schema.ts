import { z } from "zod"
import { PLUGIN_BLOB_LIMITS, PLUGIN_EVENT_LIMITS, PLUGIN_LINK_LIMITS, PLUGIN_SESSION_LIMITS, PLUGIN_WAKE_LIMITS, type PluginPlatformCall } from "./backend"

const blobKey = z.string().regex(PLUGIN_BLOB_LIMITS.keyPattern).refine((key) => !key.split("/").some((part) => part === "" || part === "." || part === ".."), "a blob key has no empty, '.' or '..' segment")
const blobPrefix = z.string().max(512).regex(/^[A-Za-z0-9._/-]*$/)
const contentType = z.string().min(1).max(255).regex(/^[\x21-\x7e][\x20-\x7e]*$/)
const projectId = z.string().min(1).max(128)
const linkPath = z
  .string()
  .max(PLUGIN_LINK_LIMITS.pathMaxLength)
  .regex(/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/)
  .refine((path) => !path.startsWith("/_") && !path.split("/").some((part) => part === "." || part === ".."), "a link's path is a public route of the backend")

const textByteLength = (value: string) => new TextEncoder().encode(value).byteLength
const boundedText = (bytes: number) => z.string().refine((value) => textByteLength(value) <= bytes, `at most ${bytes} bytes`)
const identifier = z.string().min(1).max(256)
const originPart = z.string().min(1).max(PLUGIN_SESSION_LIMITS.originPartMaxLength).regex(/^[\x21-\x7e]+$/)
const sessionOrigin = z.object({ scope: originPart, key: originPart }).strict()
const sessionRef = z.object({ sessionId: identifier, workspaceId: identifier }).strict()
const placement = z.enum(["local", "cloud"])
const sessionStart = {
  origin: sessionOrigin,
  projectId,
  placement,
  configuration: z
    .object({
      harness: z.object({ id: identifier, access: z.enum(["native", "connection"]) }).strict(),
      model: z.object({ providerID: identifier, modelID: identifier }).strict(),
      effort: z.string().min(1).max(64).nullable(),
    })
    .strict(),
  instructions: boundedText(PLUGIN_SESSION_LIMITS.instructionsBytes).optional(),
  selection: z
    .object({
      plugins: z.array(z.object({ sourceId: identifier, pluginName: identifier }).strict()).max(PLUGIN_SESSION_LIMITS.selectionReferences),
      skills: z.array(z.object({ sourceId: identifier, skillName: identifier }).strict()).max(PLUGIN_SESSION_LIMITS.selectionReferences),
    })
    .strict()
    .optional(),
  continueFrom: sessionRef.optional(),
  title: z.string().min(1).max(PLUGIN_SESSION_LIMITS.titleMaxLength).optional(),
}
const onlyCloudSelects = (call: { placement: string; selection?: unknown }) => call.placement === "cloud" || call.selection === undefined

/**
 * The calls the runtime accepts from a loaded backend. Whatever crosses
 * `env.PLATFORM.call` is the plugin's own value, so every field is parsed here
 * before a check or a host reads it.
 */
export const pluginPlatformCallSchema: z.ZodType<PluginPlatformCall> = z.discriminatedUnion("name", [
  z.object({ name: z.literal("identity.caller") }).strict(),
  z.object({ name: z.literal("projects.list") }).strict(),
  z.object({ name: z.literal("projects.authorize"), projectId, access: z.enum(["read", "write"]) }).strict(),
  z.object({ name: z.literal("blobs.put"), key: blobKey, bytes: z.instanceof(Uint8Array), contentType: contentType.optional() }).strict(),
  z.object({ name: z.literal("blobs.get"), key: blobKey }).strict(),
  z.object({ name: z.literal("blobs.head"), key: blobKey }).strict(),
  z.object({ name: z.literal("blobs.delete"), key: blobKey }).strict(),
  z.object({ name: z.literal("blobs.list"), prefix: blobPrefix.optional(), cursor: z.string().max(1024).optional() }).strict(),
  z
    .object({
      name: z.literal("events.publish"),
      audience: z.enum(["caller", "project", "org"]),
      projectId: projectId.optional(),
      topic: z.string().regex(PLUGIN_EVENT_LIMITS.topicPattern),
      data: z.json().optional(),
    })
    .strict()
    .refine((call) => (call.audience === "project") === (call.projectId !== undefined), "a project event names its project, and only a project event does"),
  z.object({ name: z.literal("schedule.at"), wake: z.string().regex(PLUGIN_WAKE_LIMITS.namePattern), at: z.number().int().positive(), payload: z.json().optional() }).strict(),
  z.object({ name: z.literal("schedule.cancel"), wake: z.string().regex(PLUGIN_WAKE_LIMITS.namePattern) }).strict(),
  z.object({ name: z.literal("schedule.list") }).strict(),
  z.object({ name: z.literal("links.create"), path: linkPath, expiresAt: z.number().int().positive().optional() }).strict(),
  z.object({ name: z.literal("links.revoke"), token: z.string().min(1).max(128) }).strict(),
  z.object({ name: z.literal("sessions.harnesses"), projectId, placement }).strict(),
  z.object({ name: z.literal("sessions.preview"), ...sessionStart }).strict().refine(onlyCloudSelects, "only a cloud session selects plugins and skills"),
  z
    .object({ name: z.literal("sessions.start"), ...sessionStart, digest: z.string().regex(/^[0-9a-f]{64}$/) })
    .strict()
    .refine(onlyCloudSelects, "only a cloud session selects plugins and skills"),
  z
    .object({
      name: z.literal("sessions.handoff"),
      origin: sessionOrigin,
      session: sessionRef,
      text: boundedText(PLUGIN_SESSION_LIMITS.textBytes),
      attachments: z
        .array(z.object({ key: blobKey, filename: z.string().min(1).max(255).optional() }).strict())
        .max(PLUGIN_SESSION_LIMITS.attachments)
        .optional(),
    })
    .strict(),
  z.object({ name: z.literal("sessions.abandon"), origin: sessionOrigin, session: sessionRef }).strict(),
  z.object({ name: z.literal("sessions.state"), origins: z.array(sessionOrigin).max(PLUGIN_SESSION_LIMITS.originsPerState) }).strict(),
  z.object({ name: z.literal("sessions.authorizeOpen"), session: sessionRef }).strict(),
])

/** The bytes `value` takes as JSON, for the limits on event data and wake payloads. */
export function jsonByteLength(value: unknown): number {
  return value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).byteLength
}
