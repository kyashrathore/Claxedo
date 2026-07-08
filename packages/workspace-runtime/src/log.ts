type LogExtra = Record<string, unknown>

function formatMsg(level: string, tags: Record<string, unknown>, message: unknown, extra?: LogExtra): string {
  const now = new Date().toISOString().split(".")[0]
  const parts: string[] = []
  for (const [k, v] of Object.entries(tags)) {
    parts.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) continue
      parts.push(`${k}=${v instanceof Error ? v.message : typeof v === "object" ? JSON.stringify(v) : v}`)
    }
  }
  const suffix = parts.length ? " " + parts.join(" ") : ""
  return `${now} ${level} ${message}${suffix}\n`
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
