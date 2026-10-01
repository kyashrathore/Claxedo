import { z } from "zod"
import { PluginManifestError } from "./manifest"

const command = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/)
const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
    "path must stay inside its root",
  )
const homePath = z
  .string()
  .startsWith("~/")
  .refine((value) => relativePath.safeParse(value.slice(2)).success, "path must stay inside the home directory")
const payload = z
  .object({
    path: z.string(),
    sessionId: z.string(),
    transcriptPath: z.string().optional(),
    prompt: z.string().optional(),
    requireSession: z.boolean().optional(),
  })
  .strict()
const status = z.enum(["running", "waiting", "done", "ignored"])
const eventRule = z
  .object({
    status,
    outcome: z.enum(["done", "error", "cancelled"]).optional(),
    when: z.record(z.string(), z.unknown()).optional(),
    toolCompletion: z.boolean().optional(),
    payload: payload.optional(),
  })
  .strict()
const merge = z
  .object({
    type: z.literal("config-merge"),
    path: homePath,
    entries: z.union([z.string(), z.record(z.string(), z.unknown())]),
    shape: z.enum(["flat", "nested", "named", "text"]),
    base: z.array(z.string()).optional(),
    managedScript: relativePath.optional(),
    ownedPrefix: z.string().min(1).optional(),
    defaults: z.record(z.string(), z.unknown()).optional(),
    effectiveFile: z
      .object({ path: homePath, base: z.array(z.string()) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.shape === "text"
        ? typeof value.entries !== "string" || !value.ownedPrefix
        : typeof value.entries === "string" || !value.managedScript
    ) {
      context.addIssue({
        code: "custom",
        message:
          "text installs require content and an ownership prefix; JSON installs require entries and a managed script",
      })
    }
  })

export const statusHookTemplateSchema = z
  .object({
    command,
    provider: command,
    id: command.optional(),
    aliases: z.array(command).optional(),
    install: z.union([
      z.object({ type: z.literal("wrapper-flags"), args: z.array(z.string()) }).strict(),
      merge,
      z
        .object({
          type: z.literal("project-file"),
          path: relativePath,
          entries: z.record(z.string(), z.unknown()),
          hookFile: relativePath,
        })
        .strict(),
    ]),
    artifacts: z
      .array(
        z
          .object({ file: relativePath, content: z.string(), mode: z.union([z.literal(0o644), z.literal(0o755)]) })
          .strict(),
      )
      .optional(),
    wrapper: z.union([z.string(), z.literal(false)]).optional(),
    events: z.record(z.string(), z.union([status, eventRule, z.array(eventRule)])),
    subagent: z.array(z.string()),
    payload: payload.optional(),
    typeProvider: z.boolean().optional(),
    replayGuard: z
      .object({ env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) })
      .strict()
      .optional(),
  })
  .strict()

export type StatusHookTemplate = z.infer<typeof statusHookTemplateSchema>
export type StatusHookEventRule = z.infer<typeof eventRule>

export function readStatusHookTemplates(value: unknown): StatusHookTemplate[] {
  const parsed = z.array(statusHookTemplateSchema).safeParse(value)
  if (parsed.success) return parsed.data
  throw new PluginManifestError(
    parsed.error.issues.map((issue) => `statusHooks${issue.path.map((part) => `.${String(part)}`).join("")}: ${issue.message}`),
  )
}
