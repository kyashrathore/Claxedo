import { createDebugLogger } from "../../overrides/utils/debug"
import { collapse, clip } from "./text"

export type TerminalLogSummary = {
  title: string
  task: string
  recent: string[]
}

type CacheEntry = {
  value: TerminalLogSummary | null
  at: number
}

const HIT_TTL_MS = 5_000
const MISS_TTL_MS = 2_000

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<TerminalLogSummary | null>>()

const terminalLogDebug = createDebugLogger("terminal.log.preview", "terminal:log", {
  defaultLevel: 0,
})

const text = (value: unknown) => {
  if (typeof value !== "string") return ""
  return value.trim()
}

const stripAnsi = (value: string) => value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
const stripOsc = (value: string) => value.replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
const stripControl = (value: string) => value.replace(/[\u0000-\u001F\u007F]/g, " ")

const hasSignal = (value: string) => /[A-Za-z0-9]/.test(value)
const divider = (value: string) => /^[-_=~─━]{3,}$/.test(value)
const glyphOnly = (value: string) => /^[✳✢✽·•⏺⏵❯>$#.:…\s]+$/.test(value)
const fragment = (value: string) => /^[A-Za-z]{1,4}(?:…)?$/.test(value)

const keepLine = (value: string) => {
  if (!value) return false
  if (divider(value)) return false
  if (glyphOnly(value)) return false
  if (fragment(value)) return false
  if (hasSignal(value)) {
    const words = value.split(/\s+/).filter(Boolean)
    if (value.length < 8 && words.length <= 1) return false
    if (!value.includes(" ") && value.length < 14 && !/[\/_.:=-]/.test(value)) return false
    return true
  }
  return value.length >= 12
}

const statusLine = (value: string) =>
  /scampering|thinking|running stop hook|bypass permissions|shift\+tab|esc to interrupt/i.test(value)

const origin = (url: string) => {
  try {
    return new URL(url).origin
  } catch {
    if (typeof window !== "undefined") return window.location.origin
    return ""
  }
}

const target = (sdkUrl: string, terminalId: string, directory: string) => {
  const site = origin(sdkUrl)
  if (!site) return
  const id = text(terminalId)
  if (!id) return
  const dir = text(directory)
  if (!dir) return
  return {
    site,
    id,
    dir,
    cacheKey: `${site}|${id}|${dir}`,
  }
}

const PRUNE_INTERVAL_MS = 60_000
let lastPrune = 0

const pruneCache = () => {
  const now = Date.now()
  if (now - lastPrune < PRUNE_INTERVAL_MS) return
  lastPrune = now
  for (const [key, entry] of cache) {
    if (stale(entry)) cache.delete(key)
  }
}

const stale = (entry: CacheEntry | undefined) => {
  if (!entry) return true
  const ttl = entry.value ? HIT_TTL_MS : MISS_TTL_MS
  return Date.now() - entry.at > ttl
}

const parse = (value: string): TerminalLogSummary | null => {
  const lines = value
    .split(/\r?\n/)
    .map((line) => collapse(stripControl(stripOsc(stripAnsi(line)))))
    .filter(keepLine)
  if (!lines.length) return null

  const signal = lines.filter((line) => !statusLine(line))
  const pick = signal.length ? signal.slice(-24) : lines.slice(-24)
  const recent = pick.slice(-4).map((line) => `Terminal: ${clip(line, 120)}`)
  const taskRaw = (signal[0] || lines[0] || "").trim()
  const titleRaw = (pick[pick.length - 1] || taskRaw).trim()
  const title = clip(titleRaw, 56)
  const task = clip(taskRaw, 180)
  if (!title) return null
  return {
    title,
    task,
    recent,
  }
}

export const cachedTerminalLogSummary = (sdkUrl: string, terminalId: string, directory: string) => {
  const next = target(sdkUrl, terminalId, directory)
  if (!next) return undefined
  const entry = cache.get(next.cacheKey)
  if (!entry || stale(entry)) return undefined
  return entry.value
}

export const loadTerminalLogSummary = (
  sdkUrl: string,
  terminalId: string,
  directory: string,
  request: typeof fetch = fetch,
) => {
  pruneCache()
  const nextTarget = target(sdkUrl, terminalId, directory)
  if (!nextTarget) return Promise.resolve(null)

  const existing = cache.get(nextTarget.cacheKey)
  if (!stale(existing)) return Promise.resolve(existing?.value ?? null)

  const running = inflight.get(nextTarget.cacheKey)
  if (running) return running

  if (terminalLogDebug.enabled(2)) {
    terminalLogDebug.verbose("load start", {
      terminalId,
      directory,
    })
  }

  const query = new URLSearchParams({
    pty_id: nextTarget.id,
    lines: "180",
    directory: nextTarget.dir,
  })

  const next = request(`${nextTarget.site}/process/logs?${query.toString()}`)
    .then((res) => {
      if (!res.ok) {
        if (terminalLogDebug.enabled(2)) {
          terminalLogDebug.verbose("load status", {
            terminalId,
            directory,
            status: res.status,
          })
        }
        return ""
      }
      return res.text()
    })
    .then(parse)
    .catch((error) => {
      if (terminalLogDebug.enabled(1)) {
        terminalLogDebug.log("load failed", {
          terminalId,
          directory,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return null
    })
    .then((value) => {
      cache.set(nextTarget.cacheKey, { value, at: Date.now() })
      if (terminalLogDebug.enabled(2)) {
        terminalLogDebug.verbose("load resolved", {
          terminalId,
          directory,
          title: value?.title,
          recentCount: value?.recent.length ?? 0,
        })
      }
      return value
    })
    .finally(() => {
      inflight.delete(nextTarget.cacheKey)
    })

  inflight.set(nextTarget.cacheKey, next)
  return next
}
