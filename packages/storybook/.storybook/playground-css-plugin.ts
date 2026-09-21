/**
 * Vite plugin that exposes a POST endpoint for the timeline playground
 * to write CSS changes back to source files on disk.
 *
 * POST /__playground/apply-css
 * Body: { edits: Array<{ file: string; anchor: string; prop: string; value: string }> }
 *
 * For each edit the plugin finds `anchor` in the file, then locates the
 * next `prop: <anything>;` after it and replaces the value portion.
 * `file` is resolved against the UI component packages.
 */
import type { Plugin } from "vite"
import type { IncomingMessage, ServerResponse } from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isLoopbackHostname, isNonEmptyString, isRecord, isString } from "@claxedo/helpers"
import { inside } from "@claxedo/helpers/path"
import { escapeRegExp } from "@claxedo/helpers/string"

const ENDPOINT = "/__playground/apply-css"

type Edit = { file: string; anchor: string; prop: string; value: string }
type Result = { file: string; prop: string; ok: boolean; error?: string }

/** A path spelled the way the filesystem names it; undefined when nothing exists to resolve. */
function resolveExisting(file: string): string | undefined {
  try {
    return path.resolve(fs.realpathSync.native?.(file) ?? fs.realpathSync(file))
  } catch {
    return undefined
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const roots = [
  path.resolve(here, "../../session-ui/src/components"),
  path.resolve(here, "../../ui/src/components"),
].map((dir) => resolveExisting(dir) ?? dir)

/**
 * `name` resolved inside one of `roots`, compared the way the filesystem names
 * both sides. A sibling that shares the root as a string prefix
 * (`components-evil`), a `..` escape, an absolute path elsewhere, and a
 * symlink pointing out of a root each resolve to a candidate `inside` refuses
 * at the separator boundary. A name that resolves to nothing on disk is not a
 * write target either.
 */
export function containedFile(name: string, candidates: readonly string[]): string | undefined {
  for (const dir of candidates) {
    const root = resolveExisting(dir) ?? path.resolve(dir)
    const resolved = resolveExisting(path.resolve(root, name))
    if (resolved !== undefined && inside(root, resolved)) return resolved
  }
  return undefined
}

type DevRequestWires = {
  host?: string | undefined
  origin?: string | undefined
  remoteAddress?: string | undefined
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/**
 * The write endpoint is a dev-server surface, not an app route. A page on any
 * origin can drive a browser into POSTing a loopback port, so the request's
 * own wires decide: the socket must be loopback (`::ffff:`-mapped IPv4
 * included), `Host` must name loopback, and a browser-supplied `Origin` must
 * be loopback too. Non-browser clients send no `Origin` and pass on socket
 * and host alone.
 */
export function devWriteAllowed(request: DevRequestWires): boolean {
  const remote = request.remoteAddress?.replace(/^::ffff:/, "")
  if (!isLoopbackHostname(remote)) return false
  if (!isLoopbackHostname(hostnameOf(`http://${request.host ?? ""}`))) return false
  if (request.origin === undefined) return true
  return isLoopbackHostname(hostnameOf(request.origin))
}

function applyEdits(content: string, edits: Edit[]): { content: string; results: Result[] } {
  const results: Result[] = []
  let out = content

  for (const edit of edits) {
    const name = edit.file
    const idx = out.indexOf(edit.anchor)
    if (idx === -1) {
      results.push({ file: name, prop: edit.prop, ok: false, error: `Anchor not found: ${edit.anchor.slice(0, 50)}` })
      continue
    }

    // From the anchor position, find the next occurrence of `prop: <value>`
    // We match `prop:` followed by any value up to `;`
    const after = out.slice(idx)
    const re = new RegExp(`(${escapeRegExp(edit.prop)}\\s*:\\s*)([^;]+)(;)`)
    const match = re.exec(after)
    if (!match) {
      results.push({ file: name, prop: edit.prop, ok: false, error: `Property "${edit.prop}" not found after anchor` })
      continue
    }

    const start = idx + match.index + match[1].length
    const end = start + match[2].length
    out = out.slice(0, start) + edit.value + out.slice(end)
    results.push({ file: name, prop: edit.prop, ok: true })
  }

  return { content: out, results }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

export function playgroundCssMiddleware(allowedRoots: readonly string[] = roots) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url !== ENDPOINT) return next()
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" })
      return
    }
    if (
      !devWriteAllowed({
        host: req.headers.host,
        origin: req.headers.origin,
        remoteAddress: req.socket.remoteAddress,
      })
    ) {
      sendJson(res, 403, { error: "Writes are accepted from loopback dev pages only" })
      return
    }

    let data = ""
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString()
    })
    req.on("end", () => {
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        sendJson(res, 400, { error: "Invalid JSON" })
        return
      }

      if (!isRecord(payload) || !Array.isArray(payload.edits)) {
        sendJson(res, 400, { error: "Missing edits array" })
        return
      }

      // Group by file
      const grouped = new Map<string, Edit[]>()
      for (const candidate of payload.edits) {
        if (!isRecord(candidate)) continue
        const { file, anchor, prop, value } = candidate
        if (!isNonEmptyString(file) || !isNonEmptyString(anchor) || !isNonEmptyString(prop) || !isString(value)) continue
        const abs = containedFile(file, allowedRoots)
        if (!abs) continue
        if (!grouped.has(abs)) grouped.set(abs, [])
        grouped.get(abs)!.push({ file, anchor, prop, value })
      }

      const results: Result[] = []

      for (const [abs, edits] of grouped) {
        const name = path.basename(abs)
        try {
          const content = fs.readFileSync(abs, "utf-8")
          const applied = applyEdits(content, edits)
          results.push(...applied.results)

          if (applied.results.some((r) => r.ok)) {
            fs.writeFileSync(abs, applied.content, "utf-8")
          }
        } catch (err) {
          for (const e of edits) results.push({ file: name, prop: e.prop, ok: false, error: String(err) })
        }
      }

      sendJson(res, 200, { results })
    })
  }
}

export function playgroundCss(): Plugin {
  return {
    name: "playground-css",
    configureServer(server) {
      server.middlewares.use(playgroundCssMiddleware())
    },
  }
}
