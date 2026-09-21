import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdirSync, openSync, writeSync, closeSync, renameSync, unlinkSync } from "node:fs"
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { sleep } from "./async"
import { isRecord } from "./guards"
import { writeWindowsPrivateFile } from "./windows-private-file"

export { PrivateFileError } from "./windows-private-file"

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
 *
 * `mode` is POSIX permission bits. On Windows the only bit that reaches the
 * filesystem is the write bit, which toggles the read-only attribute; the
 * file's actual protection is the DACL it inherits from its parent. Use
 * {@link writePrivateFileAtomic} for anything that must not be readable by
 * another account.
 */
export async function writeFileAtomic(
  file: string,
  contents: string | Uint8Array,
  options?: { mode?: number; mkdir?: boolean; fsync?: boolean },
): Promise<void> {
  await stageAndReplace(file, contents, {
    mode: options?.mode ?? 0o600,
    mkdir: options?.mkdir,
    fsync: options?.fsync,
    protect: false,
  })
}

/**
 * The same replacement, for a file only its owner may read: POSIX mode 0600,
 * and on Windows a descriptor the staging file is born with, verified through
 * that same handle before a single byte of `contents` is written. The Windows
 * half lives in {@link writeWindowsPrivateFile}, which explains why later
 * narrowing is not an option there.
 *
 * The protection rides on the file, so the target ends up owner-only however
 * permissive its parent is and whatever a file already at that path carried. No
 * directory's permissions are read or written on Windows, and an existing
 * directory is left alone on both platforms: a directory the caller supplied is
 * the caller's, and a shared `$CLAXEDO_HOME` is a legitimate choice this must
 * not silently rewrite. A directory `mkdir` creates does get 0700, which is
 * POSIX-only defence in depth.
 *
 * Fails closed. A file that cannot be created private and confirmed private
 * throws {@link PrivateFileError} with the secret unwritten.
 */
export async function writePrivateFileAtomic(
  file: string,
  contents: string | Uint8Array,
  options?: { mkdir?: boolean; fsync?: boolean },
): Promise<void> {
  await stageAndReplace(file, contents, {
    mode: 0o600,
    mkdir: options?.mkdir,
    fsync: options?.fsync,
    protect: true,
  })
}

/**
 * A reader that has the target open can block the replacement on Windows,
 * depending on the share mask its runtime chose. Readers hold these files for
 * one read, so a bounded wait turns a collision into a pause; past it the error
 * is the caller's, with the staging file removed.
 */
const REPLACE_TIMEOUT_MS = 2_000
const REPLACE_POLL_MS = 25
const SHARING_VIOLATION = new Set(["EPERM", "EACCES", "EBUSY"])

async function replace(temp: string, file: string): Promise<void> {
  const deadline = Date.now() + REPLACE_TIMEOUT_MS
  for (;;) {
    try {
      return await rename(temp, file)
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined
      if (typeof code !== "string" || !SHARING_VIOLATION.has(code) || Date.now() >= deadline) throw error
      await sleep(REPLACE_POLL_MS)
    }
  }
}

async function stageAndReplace(
  file: string,
  contents: string | Uint8Array,
  options: { mode: number; mkdir?: boolean; fsync?: boolean; protect: boolean },
): Promise<void> {
  const directory = dirname(file)
  if (options.mkdir) await mkdir(directory, { recursive: true, mode: options.protect ? 0o700 : undefined })

  const temp = tempPathFor(file)
  if (options.protect && process.platform === "win32") {
    // Node never opens this file. Its permissions have to exist before it does,
    // which only the create itself can arrange.
    return await writeWindowsPrivateFile({
      target: file,
      staging: temp,
      contents: typeof contents === "string" ? Buffer.from(contents) : contents,
    })
  }

  const handle = await open(temp, "wx", options.mode)
  try {
    await handle.writeFile(contents)
    if (options.fsync !== false) await handle.sync()
    await handle.close()
    await replace(temp, file)
  } catch (error) {
    // Every failure after the exclusive create owns the temp, not just a failed
    // rename: a staging file left behind holds the secret at a name no one will
    // clean up.
    await handle.close().catch(() => undefined)
    await unlink(temp).catch(() => undefined)
    throw error
  }
  if (options.fsync !== false) await fsyncDirectory(directory)
}

/**
 * Identical semantics to {@link writeFileAtomic}, for the call sites that live
 * inside synchronous exported functions whose tests assert a synchronous return
 * value and therefore cannot be awaited. No directory fsync — those callers do
 * not need the crash-durability guarantee.
 *
 * There is deliberately no synchronous private form: protecting a path on
 * Windows runs an interpreter, and blocking the loop on a process spawn is a
 * cost no caller has asked to pay.
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
    closeSync(fd)
    renameSync(temp, file)
  } catch (error) {
    try {
      closeSync(fd)
    } catch {
      // Already closed on the success path above.
    }
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
