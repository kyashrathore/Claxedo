import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdirSync, openSync, writeSync, closeSync, renameSync, unlinkSync } from "node:fs"
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

/**
 * Node-only. Never re-exported from the package root: the fs-touching Codex
 * module is dynamically imported specifically to stay OFF the worker import
 * graph, and a root export would drag `node:fs` back onto it.
 */

function tempPathFor(file: string): string {
  // Exclusive-create plus a random component, so a colliding temp is a hard
  // error rather than a silent overwrite of another writer's staging file.
  return join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`)
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle
  try {
    handle = await open(directory, "r")
    await handle.sync()
  } catch {
    // Directory fsync is unsupported on some platforms and filesystems; the
    // rename itself is still atomic there.
  } finally {
    await handle?.close()
  }
}

/**
 * Writes to a sibling temp with the exclusive `wx` flag, then renames over the
 * target. Does NOT serialize concurrent writers and does NOT JSON.stringify —
 * both stay caller policy.
 */
export async function writeFileAtomic(
  file: string,
  contents: string | Uint8Array,
  options?: { mode?: number; mkdir?: boolean; fsync?: boolean },
): Promise<void> {
  const mode = options?.mode ?? 0o600
  const directory = dirname(file)
  if (options?.mkdir) await mkdir(directory, { recursive: true })

  const temp = tempPathFor(file)
  const handle = await open(temp, "wx", mode)
  try {
    await handle.writeFile(contents)
    if (options?.fsync !== false) await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    await rename(temp, file)
    if (options?.fsync !== false) await fsyncDirectory(directory)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/**
 * Identical semantics to the async form, for the call sites that live inside
 * synchronous exported functions whose tests assert a synchronous return value
 * and therefore cannot be awaited. No directory fsync — those callers do not
 * need the crash-durability guarantee.
 */
export function writeFileAtomicSync(
  file: string,
  contents: string | Uint8Array,
  options?: { mode?: number; mkdir?: boolean },
): void {
  const mode = options?.mode ?? 0o600
  if (options?.mkdir) mkdirSync(dirname(file), { recursive: true })

  const temp = tempPathFor(file)
  const fd = openSync(temp, "wx", mode)
  try {
    // `writeSync` overloads on string versus buffer; the union has to be split.
    if (typeof contents === "string") writeSync(fd, contents)
    else writeSync(fd, contents)
  } finally {
    closeSync(fd)
  }

  try {
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // Already gone.
    }
    throw error
  }
}

/**
 * Nothing is swallowed: a missing file surfaces the fs ENOENT and malformed
 * JSON surfaces the SyntaxError, both with the path visible. Callers that want
 * a friendlier message wrap the call. The document's shape is the caller's to
 * narrow.
 */
export function readJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"))
}

/**
 * Accepts a `--private-key-pem` argument that is EITHER the PEM text itself or
 * a filesystem path. Inline text gets its literal `\n` sequences rewritten —
 * that is the shell/env-var transport form — while a file's bytes are returned
 * verbatim, because a real file already has real newlines.
 */
export async function resolvePem(value: string): Promise<string> {
  if (value.includes("BEGIN")) return value.replaceAll("\\n", "\n")
  return readFile(value, "utf8")
}
