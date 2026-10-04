type LogExtra = Record<string, unknown>

/**
 * Render one log value as text.
 *
 * Every branch exists because interpolating a non-primitive prints
 * "[object Object]" — in the exact lines a log is read for. An `Error` shows its
 * message, any other object its JSON, and a value JSON cannot serialize (a
 * cycle, a BigInt) falls back to its constructor name rather than that
 * placeholder. One function, so a tag, an extra and the message itself cannot
 * disagree about how a value prints.
 */
function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message
  if (typeof value === "symbol") return value.toString()
  if (value === null || typeof value !== "object") return String(value)
  try {
    return JSON.stringify(value) ?? "[unserializable]"
  } catch {
    return `[${Object.getPrototypeOf(value)?.constructor?.name ?? "object"}]`
  }
}

function formatMsg(level: string, tags: Record<string, unknown>, message: unknown, extra?: LogExtra): string {
  const now = new Date().toISOString().split(".")[0]
  const parts: string[] = []
  for (const [k, v] of Object.entries(tags)) {
    parts.push(`${k}=${formatValue(v)}`)
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) continue
      parts.push(`${k}=${formatValue(v)}`)
    }
  }
  const suffix = parts.length ? " " + parts.join(" ") : ""
  return `${now} ${level} ${formatValue(message)}${suffix}\n`
}

function makeLogger(tags: Record<string, unknown>) {
  const logger = {
    info(message?: unknown, extra?: LogExtra) {
      process.stderr.write(formatMsg("INFO ", tags, message, extra))
    },
    error(message?: unknown, extra?: LogExtra) {
      process.stderr.write(formatMsg("ERROR", tags, message, extra))
    },
    warn(message?: unknown, extra?: LogExtra) {
      process.stderr.write(formatMsg("WARN ", tags, message, extra))
    },
    tag(key: string, value: string) {
      tags[key] = value
      return logger
    },
    clone() {
      return makeLogger({ ...tags })
    },
    time(message: string, extra?: LogExtra) {
      const now = Date.now()
      logger.info(message, { status: "started", ...extra })
      const stop = () => {
        logger.info(message, { status: "completed", duration: Date.now() - now, ...extra })
      }
      return {
        stop,
        [Symbol.dispose]() {
          stop()
        },
      }
    },
  }
  return logger
}

export const Log = {
  create: makeLogger,
}
