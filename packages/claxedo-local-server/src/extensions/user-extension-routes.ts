/**
 * User-extension routes — the server half of user-extendable UI.
 *
 * The desktop-local server publishes extensions the user dropped into
 * `dataDir()/extensions/<name>/` so the renderer can list and import them.
 * Each extension is a directory with a `claxedo-extension.json` manifest and a
 * JS entry module; the renderer loads the entry over HTTP and hands it the
 * contribution API (see `claxedo-app/src/platform/extensions/user-extensions.ts`).
 *
 * Local product only: on a hosted or signed deployment these routes answer 403
 * for every path, so a signed box cannot be made to serve arbitrary local files
 * to its web origin. Same posture the credentials routes take, decided from the
 * same environment facts.
 */

import { Hono } from "hono"
import { z } from "zod"
import { promises as fs } from "node:fs"
import path from "node:path"
import { deploymentMode } from "@claxedo/server-core/authority/deployment-mode"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { errorBody } from "@claxedo/server-core/platform/http/http"

export const USER_EXTENSION_MANIFEST_FILENAME = "claxedo-extension.json"
export const USER_EXTENSION_API_VERSION = 1

/** Directory name and manifest `name` must both match this and each other. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Entry is a relative path inside the extension directory. The serving route
 * has its own realpath guard; this keeps obviously hostile manifests out of
 * the listing so the renderer never even attempts them.
 */
const RELATIVE_FILE_PATTERN = /^[\w][\w./-]*$/

const manifestSchema = z.object({
  name: z.string().regex(NAME_PATTERN),
  version: z.string().min(1).max(64),
  entry: z
    .string()
    .regex(RELATIVE_FILE_PATTERN)
    .refine((value) => !value.split("/").includes(".."), "entry must not traverse upward")
    .refine((value) => /\.(js|mjs)$/.test(value), "entry must be a .js or .mjs module"),
  apiVersion: z.literal(USER_EXTENSION_API_VERSION),
  displayName: z.string().max(128).optional(),
  description: z.string().max(1024).optional(),
})

export type UserExtensionManifest = z.infer<typeof manifestSchema>

/**
 * Files an extension may serve. An allowlist rather than a denylist: the
 * renderer imports modules and loads assets, and nothing else has a reason to
 * come out of this directory.
 */
const SERVABLE_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
}

export function userExtensionsRoot() {
  return path.join(dataDir(), "extensions")
}

export function userExtensionsEnabled(env: NodeJS.ProcessEnv = process.env) {
  return deploymentMode(env) === "local" && env.CLAXEDO_SIGNED_CLOUD_AUTH !== "1"
}

type ListedExtension = UserExtensionManifest & {
  /** Renderer-facing path of the entry module, relative to the server origin. */
  entryPath: string
}

type SkippedExtension = { directory: string; reason: string }

async function listExtensions(root: string): Promise<{ extensions: ListedExtension[]; skipped: SkippedExtension[] }> {
  const extensions: ListedExtension[] = []
  const skipped: SkippedExtension[] = []
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return { extensions, skipped }
  }
  for (const item of entries) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue
    if (!NAME_PATTERN.test(item.name)) {
      skipped.push({ directory: item.name, reason: "invalid directory name" })
      continue
    }
    let raw: string
    try {
      raw = await fs.readFile(path.join(root, item.name, USER_EXTENSION_MANIFEST_FILENAME), "utf8")
    } catch {
      skipped.push({ directory: item.name, reason: `missing ${USER_EXTENSION_MANIFEST_FILENAME}` })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      skipped.push({ directory: item.name, reason: "manifest is not valid JSON" })
      continue
    }
    const manifest = manifestSchema.safeParse(parsed)
    if (!manifest.success) {
      skipped.push({ directory: item.name, reason: `invalid manifest: ${manifest.error.issues[0]?.message ?? "schema mismatch"}` })
      continue
    }
    if (manifest.data.name !== item.name) {
      skipped.push({ directory: item.name, reason: `manifest name "${manifest.data.name}" does not match its directory` })
      continue
    }
    extensions.push({
      ...manifest.data,
      entryPath: `/api/claxedo/extensions/${manifest.data.name}/${manifest.data.entry}`,
    })
  }
  return { extensions, skipped }
}

/**
 * Resolves a requested file to a real path that is provably inside the
 * extension's directory. `realpath` on the FILE (not just the directory) is
 * what makes a symlink pointing outside the directory a 404 instead of a read.
 */
async function resolveServablePath(root: string, name: string, relative: string) {
  const directory = path.join(root, name)
  const resolved = path.resolve(directory, relative)
  let realDirectory: string
  let realFile: string
  try {
    realDirectory = await fs.realpath(directory)
    realFile = await fs.realpath(resolved)
  } catch {
    return undefined
  }
  if (realFile !== realDirectory && !realFile.startsWith(realDirectory + path.sep)) return undefined
  const stat = await fs.stat(realFile).catch(() => undefined)
  if (!stat?.isFile()) return undefined
  return realFile
}

function disabledBody() {
  return errorBody("user_extensions_disabled", "User extensions are disabled on this deployment")
}

export function UserExtensionRoutes(options: { env?: NodeJS.ProcessEnv } = {}) {
  const env = options.env ?? process.env
  return new Hono()
    .use(async (c, next) => {
      if (!userExtensionsEnabled(env)) return c.json(disabledBody(), 403)
      await next()
    })
    .get("/", async (c) => {
      const { extensions, skipped } = await listExtensions(userExtensionsRoot())
      return c.json({ apiVersion: USER_EXTENSION_API_VERSION, extensions, skipped })
    })
    .get("/:name/*", async (c) => {
      const name = c.req.param("name")
      if (!NAME_PATTERN.test(name)) return c.json(errorBody("user_extension_not_found", "Unknown extension"), 404)
      // Decoded from the raw path so an encoded `..%2f` cannot slip past the
      // router's already-decoded param while still reaching path.resolve.
      const prefix = `/${name}/`
      let rawPath: string
      try {
        rawPath = decodeURIComponent(new URL(c.req.url).pathname)
      } catch {
        return c.json(errorBody("user_extension_file_not_found", "File not found"), 404)
      }
      const mountRelative = rawPath.slice(rawPath.indexOf(prefix) + prefix.length)
      const extension = path.extname(mountRelative).toLowerCase()
      const contentType = SERVABLE_TYPES[extension]
      if (!contentType) return c.json(errorBody("user_extension_file_not_servable", "File type is not servable"), 404)
      const file = await resolveServablePath(userExtensionsRoot(), name, mountRelative)
      if (!file) return c.json(errorBody("user_extension_file_not_found", "File not found"), 404)
      const body = await fs.readFile(file)
      return c.body(new Uint8Array(body), 200, { "content-type": contentType })
    })
}
