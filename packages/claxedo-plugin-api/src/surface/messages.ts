import { z } from "zod"
import { SURFACE_CATALOG_ID, surfaceComponentSchema } from "./catalog"

export const SURFACE_PROTOCOL_VERSION = "v0.9"
export const SURFACE_MAX_COMPONENTS = 1000

const surfaceId = z.string().min(1).max(256)
const version = z.literal(SURFACE_PROTOCOL_VERSION)
const pointer = z.string().max(1024).regex(/^(?:\/.*)?$/, "a JSON Pointer starts with /")

export const surfaceMessageSchema = z.union([
  z.object({
    version,
    createSurface: z.object({ surfaceId, catalogId: z.literal(SURFACE_CATALOG_ID), theme: z.record(z.string(), z.json()).optional(), sendDataModel: z.boolean().optional() }).strict(),
  }).strict(),
  z.object({
    version,
    updateComponents: z.object({ surfaceId, components: z.array(surfaceComponentSchema).max(SURFACE_MAX_COMPONENTS) }).strict(),
  }).strict(),
  z.object({
    version,
    updateDataModel: z.object({ surfaceId, path: pointer.optional(), value: z.json().optional() }).strict(),
  }).strict(),
  z.object({ version, deleteSurface: z.object({ surfaceId }).strict() }).strict(),
])

export type SurfaceMessage = z.infer<typeof surfaceMessageSchema>

export const surfaceActionEventSchema = z
  .object({
    name: z.string().min(1).max(256),
    surfaceId,
    sourceComponentId: z.string().min(1).max(256),
    timestamp: z.string(),
    context: z.record(z.string(), z.json()),
  })
  .strict()

export type SurfaceActionEvent = z.infer<typeof surfaceActionEventSchema>

export function surfaceMessageSurfaceId(message: SurfaceMessage): string {
  if ("createSurface" in message) return message.createSurface.surfaceId
  if ("updateComponents" in message) return message.updateComponents.surfaceId
  if ("updateDataModel" in message) return message.updateDataModel.surfaceId
  return message.deleteSurface.surfaceId
}
