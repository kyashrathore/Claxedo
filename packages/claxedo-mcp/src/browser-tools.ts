/**
 * MCP tool definitions for the claxedo-desktop agent-browser feature.
 *
 * All five tools route through the desktop HTTP bridge (see
 * `desktop-request.ts`). Each tool:
 *
 *   1. Validates input via a zod schema at the MCP registration layer.
 *   2. Calls `desktopRequest()` with the appropriate path and method.
 *   3. Surfaces network failures / 4xx / missing-desktop as a structured
 *      `{ isError: true, content: [{ type: "text", text }] }` result.
 *   4. Writes an `agent-audit-log`-compatible bridge-side entry implicitly —
 *      the bridge logs each mutating call. Read-only tools (`browser_list_tabs`,
 *      `browser_get_console_logs`) do not audit.
 *
 * Size caps: the bridge refuses to return a screenshot image larger than
 * ~1 MB base64 (dataUrl length > 1_350_000). The tool mirrors the same cap
 * locally as a defence-in-depth before inlining the image into the MCP
 * response.
 */

import { z } from "zod"

import { desktopRequest } from "./desktop-request"
import { bool, num, record, records, text } from "./json"
import type { McpToolResult, RegisterMcpTool } from "./mcp-tool"

// ---------------------------------------------------------------------------
// Types matching the bridge's JSON shapes
// ---------------------------------------------------------------------------

export type BridgeTabSummary = {
  paneId: string
  title: string
  currentUrl: string
  groupId?: string
  agentAllowed: boolean
}

type ConsoleStackFrame = {
  url?: string
  function?: string
  line?: number
  column?: number
}

export type BridgeConsoleEntry = {
  id: number
  time: number
  level: "log" | "warn" | "error" | "debug" | "info"
  args: string[]
  source: "console" | "exception" | "log"
  sessionId?: string
  stack?: ConsoleStackFrame[]
}

export type BridgeScreenshotResponse =
  | { ok: true; dataUrl: string; mimeType: "image/png" | "image/jpeg" }
  | { ok: false; error: { code: string; message?: string } }

export type BridgeEvaluateResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message?: string; stack?: string } }

export type BridgeNavigateResponse =
  | { ok: true }
  | { ok: false; error: { code: string; message?: string } }

// ---------------------------------------------------------------------------
// Parsers for those shapes
//
// `desktopRequest` returns `unknown` on purpose (see desktop-request.ts), so
// each response is narrowed here, next to the type it produces. A bridge that
// answers something else reads as a malformed response at the tool boundary
// rather than as `undefined` inside a template three lines later.
// ---------------------------------------------------------------------------

const CONSOLE_LEVELS = ["log", "warn", "error", "debug", "info"] as const
const CONSOLE_SOURCES = ["console", "exception", "log"] as const

function tabSummaries(value: unknown): BridgeTabSummary[] {
  return records(record(value)?.tabs).flatMap((row) => {
    const paneId = text(row.paneId)
    if (!paneId) return []
    return [{
      paneId,
      title: typeof row.title === "string" ? row.title : "",
      currentUrl: typeof row.currentUrl === "string" ? row.currentUrl : "",
      ...(text(row.groupId) ? { groupId: text(row.groupId) } : {}),
      agentAllowed: bool(row.agentAllowed) ?? false,
    }]
  })
}

function stackFrames(value: unknown): ConsoleStackFrame[] {
  return records(value).map((frame) => ({
    ...(text(frame.url) ? { url: text(frame.url) } : {}),
    ...(text(frame.function) ? { function: text(frame.function) } : {}),
    ...(num(frame.line) === undefined ? {} : { line: num(frame.line) }),
    ...(num(frame.column) === undefined ? {} : { column: num(frame.column) }),
  }))
}

function consoleEntries(value: unknown): BridgeConsoleEntry[] {
  return records(record(value)?.entries).flatMap((row) => {
    const id = num(row.id)
    const level = CONSOLE_LEVELS.find((candidate) => candidate === row.level)
    const source = CONSOLE_SOURCES.find((candidate) => candidate === row.source)
    if (id === undefined || !level || !source) return []
    return [{
      id,
      time: num(row.time) ?? 0,
      level,
      args: Array.isArray(row.args) ? row.args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))) : [],
      source,
      ...(text(row.sessionId) ? { sessionId: text(row.sessionId) } : {}),
      ...(Array.isArray(row.stack) ? { stack: stackFrames(row.stack) } : {}),
    }]
  })
}

/** The `{ ok: false, error }` half every bridge mutation shares. */
function bridgeError(value: unknown): { code: string; message?: string; stack?: string } {
  const error = record(record(value)?.error)
  return {
    code: text(error?.code) ?? "unknown",
    ...(text(error?.message) ? { message: text(error?.message) } : {}),
    ...(text(error?.stack) ? { stack: text(error?.stack) } : {}),
  }
}

function bridgeOk(value: unknown): boolean {
  return record(value)?.ok === true
}

function screenshotResponse(value: unknown): BridgeScreenshotResponse {
  const row = record(value)
  const dataUrl = text(row?.dataUrl)
  const mimeType = row?.mimeType === "image/jpeg" ? "image/jpeg" : "image/png"
  if (!bridgeOk(value) || !dataUrl) return { ok: false, error: bridgeError(value) }
  return { ok: true, dataUrl, mimeType }
}

function evaluateResponse(value: unknown): BridgeEvaluateResponse {
  if (!bridgeOk(value)) return { ok: false, error: bridgeError(value) }
  return { ok: true, result: record(value)?.result }
}

function navigateResponse(value: unknown): BridgeNavigateResponse {
  return bridgeOk(value) ? { ok: true } : { ok: false, error: bridgeError(value) }
}


// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 1_000_000

const errorResult = (text: string): McpToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

const textResult = (text: string): McpToolResult => ({
  content: [{ type: "text", text }],
})

// ---------------------------------------------------------------------------
// Tool: browser_list_tabs
// ---------------------------------------------------------------------------

export const browserListTabsSchema = {
  // No input — kept explicit so the MCP SDK sees a `{}` schema.
} as const

export async function handleBrowserListTabs(opts: Parameters<typeof desktopRequest>[1] = {}): Promise<McpToolResult> {
  const res = await desktopRequest("/browser/tabs", {
    method: "GET",
    ...opts,
  })
  if (!res.ok) return errorResult(res.error)
  const tabs = tabSummaries(res.data)
  if (tabs.length === 0) {
    return textResult("No browser tabs are currently open.")
  }
  const lines = tabs.map((tab) => {
    const gate = tab.agentAllowed ? "agentAllowed=true" : "agentAllowed=false"
    const group = tab.groupId ? ` group=${tab.groupId}` : ""
    const title = tab.title ? ` "${tab.title}"` : ""
    const url = tab.currentUrl ? ` ${tab.currentUrl}` : ""
    return `- ${tab.paneId}${title}${url}${group} ${gate}`
  })
  const header = `${tabs.length} browser tab${tabs.length === 1 ? "" : "s"} open:`
  const payload = JSON.stringify({ tabs }, null, 2)
  return textResult(`${header}\n${lines.join("\n")}\n\nStructured:\n${payload}`)
}

// ---------------------------------------------------------------------------
// Tool: browser_screenshot
// ---------------------------------------------------------------------------

export const browserScreenshotSchema = {
  pane_id: z.string().min(1).describe("Browser pane id returned by browser_list_tabs."),
  clip: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
      scale: z.number().positive().optional(),
    })
    .optional()
    .describe("Optional viewport-relative clip rectangle. Omit to screenshot the full viewport."),
} as const

export async function handleBrowserScreenshot(
  args: { pane_id: string; clip?: { x: number; y: number; width: number; height: number; scale?: number } },
  opts: Parameters<typeof desktopRequest>[1] = {},
): Promise<McpToolResult> {
  const paneId = args.pane_id.trim()
  if (!paneId) return errorResult("pane_id is required.")
  const res = await desktopRequest(
    `/browser/${encodeURIComponent(paneId)}/screenshot`,
    {
      method: "POST",
      body: JSON.stringify({ clip: args.clip }),
      ...opts,
    },
  )
  if (!res.ok) return errorResult(res.error)
  const data = screenshotResponse(res.data)
  if (!data.ok) {
    return errorResult(`browser_screenshot failed: ${data.error.message ?? data.error.code}`)
  }
  const { dataUrl, mimeType } = data
  const base64 = extractBase64(dataUrl)
  if (!base64) return errorResult("browser_screenshot returned a malformed dataUrl")
  const approxBytes = Math.floor((base64.length * 3) / 4)
  if (approxBytes > MAX_IMAGE_BYTES) {
    return errorResult(
      `browser_screenshot refused: image is ${approxBytes} bytes, exceeds the ${MAX_IMAGE_BYTES}-byte cap.`,
    )
  }
  return {
    content: [{ type: "image", mimeType, data: base64 }],
  }
}

// ---------------------------------------------------------------------------
// Tool: browser_get_console_logs
// ---------------------------------------------------------------------------

export const browserGetConsoleLogsSchema = {
  pane_id: z.string().min(1).describe("Browser pane id returned by browser_list_tabs."),
  since: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Return only console entries with id > since. Use the highest id seen so far."),
  level: z
    .enum(["log", "warn", "error", "debug", "info"])
    .optional()
    .describe("Filter to a single console level."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Cap on number of entries returned. Default 100."),
} as const

export async function handleBrowserGetConsoleLogs(
  args: {
    pane_id: string
    since?: number
    level?: "log" | "warn" | "error" | "debug" | "info"
    limit?: number
  },
  opts: Parameters<typeof desktopRequest>[1] = {},
): Promise<McpToolResult> {
  const paneId = args.pane_id.trim()
  if (!paneId) return errorResult("pane_id is required.")
  const params = new URLSearchParams()
  if (typeof args.since === "number") params.set("since", String(args.since))
  if (args.level) params.set("level", args.level)
  params.set("limit", String(args.limit ?? 100))
  const path = `/browser/${encodeURIComponent(paneId)}/console?${params.toString()}`

  const res = await desktopRequest(path, {
    method: "GET",
    ...opts,
  })
  if (!res.ok) return errorResult(res.error)
  const entries = consoleEntries(res.data)
  if (entries.length === 0) {
    return textResult(`No console entries for pane ${paneId}${typeof args.since === "number" ? ` since id ${args.since}` : ""}.`)
  }
  const summary = formatConsoleEntries(entries)
  return textResult(summary)
}

function formatConsoleEntries(entries: BridgeConsoleEntry[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    const when = new Date(entry.time).toISOString()
    const prefix = `[${when}] ${entry.level.toUpperCase()} (${entry.source})`
    const body = entry.args.join(" ")
    const stack = entry.stack?.length
      ? "\n  " +
        entry.stack
          .slice(0, 5)
          .map((f) => `${f.function ?? "(anonymous)"} (${f.url ?? "?"}:${f.line ?? 0}:${f.column ?? 0})`)
          .join("\n  ")
      : ""
    lines.push(`${prefix} id=${entry.id}\n  ${body}${stack}`)
  }
  return lines.join("\n\n")
}

// ---------------------------------------------------------------------------
// Tool: browser_evaluate_js
// ---------------------------------------------------------------------------

export const browserEvaluateJsSchema = {
  pane_id: z.string().min(1).describe("Browser pane id returned by browser_list_tabs."),
  expression: z
    .string()
    .min(1)
    .max(200_000)
    .describe("JavaScript expression to evaluate in the page's top frame."),
} as const

export async function handleBrowserEvaluateJs(
  args: { pane_id: string; expression: string },
  opts: Parameters<typeof desktopRequest>[1] = {},
): Promise<McpToolResult> {
  const paneId = args.pane_id.trim()
  if (!paneId) return errorResult("pane_id is required.")
  const expression = args.expression
  if (!expression) return errorResult("expression is required.")

  const res = await desktopRequest(
    `/browser/${encodeURIComponent(paneId)}/evaluate`,
    {
      method: "POST",
      body: JSON.stringify({ expression }),
      ...opts,
    },
  )
  if (!res.ok) return errorResult(res.error)
  const data = evaluateResponse(res.data)
  if (!data.ok) {
    if (data.error.code === "eval-denied") {
      return errorResult(
        `browser_evaluate_js is disabled for pane ${paneId}. ` +
          `Ask the user to enable "Allow agent to run JS" on this browser tab and retry.`,
      )
    }
    const { code, message = "", stack = "" } = data.error
    return errorResult(
      `browser_evaluate_js failed (${code})${message ? `: ${message}` : ""}${stack ? `\n\n${stack}` : ""}`,
    )
  }
  return textResult(`Evaluated on pane ${paneId}. Result:\n${JSON.stringify(data.result, null, 2)}`)
}

// ---------------------------------------------------------------------------
// Tool: browser_navigate
// ---------------------------------------------------------------------------

export const browserNavigateSchema = {
  pane_id: z.string().min(1).describe("Browser pane id returned by browser_list_tabs."),
  // The protocol refine mirrors the desktop bridge's own scheme check
  // (http-bridge.ts `bad-scheme`); a bare `.url()` accepts file:, data: and
  // javascript:, so without it the description promised more than it enforced.
  url: z
    .string()
    .url({ protocol: /^https?$/ })
    .describe("Absolute http:// or https:// URL to load."),
} as const

export async function handleBrowserNavigate(
  args: { pane_id: string; url: string },
  opts: Parameters<typeof desktopRequest>[1] = {},
): Promise<McpToolResult> {
  const paneId = args.pane_id.trim()
  if (!paneId) return errorResult("pane_id is required.")
  const target = args.url.trim()
  if (!target) return errorResult("url is required.")

  const res = await desktopRequest(
    `/browser/${encodeURIComponent(paneId)}/navigate`,
    {
      method: "POST",
      body: JSON.stringify({ url: target }),
      ...opts,
    },
  )
  if (!res.ok) return errorResult(res.error)
  const data = navigateResponse(res.data)
  if (!data.ok) {
    const { code, message = "" } = data.error
    return errorResult(`browser_navigate failed (${code})${message ? `: ${message}` : ""}`)
  }
  return textResult(`Navigated pane ${paneId} to ${target}.`)
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * How a browser tool is registered. Generic over the tool's own schema so a
 * handler receives the shape its `inputSchema` declares: an erased port hands
 * every handler a bare record and makes each one re-assert arguments zod has
 * already parsed. The server passes its own registration wrapper, which is the
 * single place the SDK's wider result union is bridged.
 */
export function registerBrowserTools(register: RegisterMcpTool, options: { readOnly?: boolean } = {}): void {
  register(
    "browser_list_tabs",
    {
      description:
        "[Browser] List all browser tabs currently open in the Claxedo desktop app. " +
        "Returns paneId, title, currentUrl, groupId, and agentAllowed (per-tab JS gate).",
      inputSchema: browserListTabsSchema,
    },
    async () => handleBrowserListTabs(),
  )

  register(
    "browser_screenshot",
    {
      description:
        "[Browser] Capture a PNG (or JPEG if oversized) screenshot of a browser pane. " +
        "Returns an inline image content part. Enforces a 1 MB image size cap.",
      inputSchema: browserScreenshotSchema,
    },
    async (args) => handleBrowserScreenshot(args),
  )

  register(
    "browser_get_console_logs",
    {
      description:
        "[Browser] Pull console + exception + log entries from a browser pane's ring buffer. " +
        "Supports since/level/limit filters. Read-only.",
      inputSchema: browserGetConsoleLogsSchema,
    },
    async (args) => handleBrowserGetConsoleLogs(args),
  )

  if (!options.readOnly) {
    register(
      "browser_evaluate_js",
      {
        description:
          "[Browser] Evaluate a JavaScript expression in a browser pane's top frame. " +
          "Only runs when the user has explicitly opted the pane into agent JS; otherwise returns a legible denial.",
        inputSchema: browserEvaluateJsSchema,
      },
      async (args) => handleBrowserEvaluateJs(args),
    )

    register(
      "browser_navigate",
      {
        description:
          "[Browser] Load a URL in a browser pane. " +
          "Only http:// and https:// are allowed. Agent-initiated; logged to the bound session's audit trail.",
        inputSchema: browserNavigateSchema,
      },
      async (args) => handleBrowserNavigate(args),
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

export function extractBase64(dataUrl: string): string | undefined {
  if (typeof dataUrl !== "string") return undefined
  const comma = dataUrl.indexOf(",")
  if (comma === -1) return undefined
  return dataUrl.slice(comma + 1)
}
