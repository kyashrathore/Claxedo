type LogExtra = Record<string, unknown>

/**
 * One rendering for every value a log line carries. Objects are serialized
 * rather than stringified (a bare template produced "[object Object]" for every
 * structured field), and a cyclic or otherwise unserializable value is named
 * instead of throwing inside the logger.
 */
function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message
  if (value === null || value === undefined) return String(value)
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  if (typeof value === "symbol") return value.toString()
  if (typeof value === "function") return value.name ? `[function ${value.name}]` : "[function]"
  try {
    return JSON.stringify(value) ?? "undefined"
  } catch {
    return "[unserializable]"
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
