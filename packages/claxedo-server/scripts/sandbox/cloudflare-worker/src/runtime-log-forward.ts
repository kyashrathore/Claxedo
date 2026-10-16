import { bounded, type WorkspaceContainer } from "./container-api"
import { redactRuntimeLog } from "./runtime-log"
import type { RuntimeLaunch } from "./runtime-process"

/** Prints `<size> <from>` and the log's bytes from `from`: the offset, or the newest `max` bytes when more than that is new. */
export const READ_RUNTIME_LOG = `file=$1; offset=$2; max=$3
[ -f "$file" ] || exit 0
size=$(($(wc -c <"$file")))
from=$offset
[ $((size - from)) -le "$max" ] || from=$((size - max))
echo "$size $from"
tail -c +$((from + 1)) "$file" | head -c $((size - from))`

const READ_BYTES = 65_536
const READ_TIMEOUT_MS = 3_000
const LINES = 40
const LINE_CHARS = 500
const CHARS = 8_000
const NEWLINE = 10

/** How far into one launch's operator log the Worker's log has been brought; `missing` once a ready launch's log was found absent and reported. */
export type RuntimeLogCursor = { launchId: string; offset: number; missing?: true }

/**
 * What of a stretch of the operator log reaches the Worker's log: redacted as
 * a whole so a private key's lines are blanked together, then at most `LINES`
 * lines of `LINE_CHARS` characters and `CHARS` in all; the rest is only counted.
 */
export function runtimeLogExcerpt(text: string) {
  const redacted = redactRuntimeLog(text).split("\n").filter((line) => line.trim())
  const lines: string[] = []
  let chars = 0
  for (const line of redacted) {
    const cut = line.slice(0, LINE_CHARS)
    if (lines.length === LINES || chars + cut.length > CHARS) break
    lines.push(cut)
    chars += cut.length
  }
  return { lines, dropped: redacted.length - lines.length }
}

/**
 * Brings the warning and error lines the runtime's own logger wrote since
 * `cursor` into the Worker's log, where Workers Logs keeps them. The runtime's
 * stderr is never read here: harness children share it, and what they print
 * can carry a person's prompt or transcript. The operator log is a
 * memory-backed file that no snapshot carries and that ends with the
 * container. Only complete lines are read, so a line still being written
 * waits for the next call.
 */
export async function forwardRuntimeLog(
  container: WorkspaceContainer,
  file: string,
  launch: RuntimeLaunch,
  cursor: RuntimeLogCursor | undefined,
  context: Record<string, unknown>,
): Promise<RuntimeLogCursor> {
  const offset = cursor?.launchId === launch.id ? cursor.offset : 0
  const read = await bounded(
    container.exec(["sh", "-c", READ_RUNTIME_LOG, "read", file, String(offset), String(READ_BYTES)]).then((process) => process.output()),
    "workspace-runtime log forward",
    READ_TIMEOUT_MS,
  )
  const bytes = new Uint8Array(read.stdout)
  const header = bytes.indexOf(NEWLINE)
  if (header < 0) {
    if (!launch.ready) return { launchId: launch.id, offset }
    if (cursor?.launchId !== launch.id || !cursor.missing) console.warn("workspace-runtime operator log missing", { ...context, launchId: launch.id, file })
    return { launchId: launch.id, offset, missing: true }
  }
  const [, fromText = ""] = new TextDecoder().decode(bytes.subarray(0, header)).split(" ")
  const from = Number(fromText)
  const body = bytes.subarray(header + 1)
  const start = from > offset ? body.indexOf(NEWLINE) + 1 : 0
  const end = body.lastIndexOf(NEWLINE) + 1
  if (end <= start) return { launchId: launch.id, offset: from + (end === 0 && body.length === READ_BYTES ? body.length : start) }
  const { lines, dropped } = runtimeLogExcerpt(new TextDecoder().decode(body.subarray(start, end)))
  if (lines.length || dropped) console.warn("workspace-runtime log", { ...context, launchId: launch.id, lines, dropped, skippedBytes: from + start - offset })
  return { launchId: launch.id, offset: from + end }
}
