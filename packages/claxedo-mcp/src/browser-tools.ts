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

// Shared tool-result shape.
export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; mimeType: "image/png" | "image/jpeg"; data: string }
  >
  isError?: boolean
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 1_000_000

const errorResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
})

// ---------------------------------------------------------------------------
// Tool: browser_list_tabs
// ---------------------------------------------------------------------------

export const browserListTabsSchema = {
  // No input — kept explicit so the MCP SDK sees a `{}` schema.
} as const

export async function handleBrowserListTabs(opts: Parameters<typeof desktopRequest>[1] = {}): Promise<ToolResult> {
  const res = await desktopRequest<{ tabs: BridgeTabSummary[] }>("/browser/tabs", {
    method: "GET",
    ...opts,
  })
  if (!res.ok) return errorResult(res.error)
  const tabs = res.data?.tabs ?? []
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
): Promise<ToolResult> {
  const paneId = args.pane_id.trim()
  if (!paneId) return errorResult("pane_id is required.")
  const res = await desktopRequest<BridgeScreenshotResponse>(
    `/browser/${encodeURIComponent(paneId)}/screenshot`,
    {
      method: "POST",
      body: JSON.stringify({ clip: args.clip }),
      ...opts,
    },
  )
  if (!res.ok) return errorResult(res.error)
  const data = res.data
  if (!data || data.ok === false) {
    const message = data && data.ok === false ? data.error.message ?? data.error.code : "unknown screenshot error"
    return errorResult(`browser_screenshot failed: ${message}`)
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
): Promise<ToolResult> {
  const paneId = args.pane_id.trim()
  if (!paneId) return errorResult("pane_id is required.")
  const params = new URLSearchParams()
  if (typeof args.since === "number") params.set("since", String(args.since))
  if (args.level) params.set("level", args.level)
  params.set("limit", String(args.limit ?? 100))
  const path = `/browser/${encodeURIComponent(paneId)}/console?${params.toString()}`

  const res = await desktopRequest<{ entries: BridgeConsoleEntry[] }>(path, {
    method: "GET",
    ...opts,
  })
  if (!res.ok) return errorResult(res.error)
  const entries = res.data?.entries ?? []
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
): Promise<ToolResult> {
  const paneId = args.pane_id.trim()
  if (!paneId) return errorResult("pane_id is required.")
  const expression = args.expression
  if (!expression) return errorResult("expression is required.")

  const res = await desktopRequest<BridgeEvaluateResponse>(
    `/browser/${encodeURIComponent(paneId)}/evaluate`,
    {
      method: "POST",
      body: JSON.stringify({ expression }),
      ...opts,
    },
  )
  if (!res.ok) return errorResult(res.error)
  const data = res.data
  if (!data || data.ok === false) {
    if (data && data.ok === false && data.error.code === "eval-denied") {
      return errorResult(
        `browser_evaluate_js is disabled for pane ${paneId}. ` +
          `Ask the user to enable "Allow agent to run JS" on this browser tab and retry.`,
      )
    }
    const code = data && data.ok === false ? data.error.code : "unknown"
    const message = data && data.ok === false ? data.error.message ?? "" : ""
    const stack = data && data.ok === false ? data.error.stack ?? "" : ""
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
): Promise<ToolResult> {
  const paneId = args.pane_id.trim()
  if (!paneId) return errorResult("pane_id is required.")
  const target = args.url.trim()
  if (!target) return errorResult("url is required.")

  const res = await desktopRequest<BridgeNavigateResponse>(
    `/browser/${encodeURIComponent(paneId)}/navigate`,
    {
      method: "POST",
      body: JSON.stringify({ url: target }),
      ...opts,
    },
  )
  if (!res.ok) return errorResult(res.error)
  const data = res.data
  if (!data || data.ok === false) {
    const code = data && data.ok === false ? data.error.code : "unknown"
    const message = data && data.ok === false ? data.error.message ?? "" : ""
    return errorResult(`browser_navigate failed (${code})${message ? `: ${message}` : ""}`)
  }
  return textResult(`Navigated pane ${paneId} to ${target}.`)
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

type McpServerLike = {
  registerTool: (
    name: string,
    spec: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (args: Record<string, unknown>) => Promise<ToolResult>,
  ) => unknown
}

export function registerBrowserTools(server: McpServerLike, options: { readOnly?: boolean } = {}): void {
  server.registerTool(
    "browser_list_tabs",
    {
      description:
        "[Browser] List all browser tabs currently open in the Claxedo desktop app. " +
        "Returns paneId, title, currentUrl, groupId, and agentAllowed (per-tab JS gate).",
      inputSchema: browserListTabsSchema as Record<string, z.ZodTypeAny>,
    },
    async () => handleBrowserListTabs(),
  )

  server.registerTool(
    "browser_screenshot",
    {
      description:
        "[Browser] Capture a PNG (or JPEG if oversized) screenshot of a browser pane. " +
        "Returns an inline image content part. Enforces a 1 MB image size cap.",
      inputSchema: browserScreenshotSchema as Record<string, z.ZodTypeAny>,
    },
    async (args) =>
      handleBrowserScreenshot(args as { pane_id: string; clip?: { x: number; y: number; width: number; height: number; scale?: number } }),
  )

  server.registerTool(
    "browser_get_console_logs",
    {
      description:
        "[Browser] Pull console + exception + log entries from a browser pane's ring buffer. " +
        "Supports since/level/limit filters. Read-only.",
      inputSchema: browserGetConsoleLogsSchema as Record<string, z.ZodTypeAny>,
    },
    async (args) =>
      handleBrowserGetConsoleLogs(
        args as {
          pane_id: string
          since?: number
          level?: "log" | "warn" | "error" | "debug" | "info"
          limit?: number
        },
      ),
  )

  if (!options.readOnly) {
    server.registerTool(
      "browser_evaluate_js",
      {
        description:
          "[Browser] Evaluate a JavaScript expression in a browser pane's top frame. " +
          "Only runs when the user has explicitly opted the pane into agent JS; otherwise returns a legible denial.",
        inputSchema: browserEvaluateJsSchema as Record<string, z.ZodTypeAny>,
      },
      async (args) => handleBrowserEvaluateJs(args as { pane_id: string; expression: string }),
    )

    server.registerTool(
      "browser_navigate",
      {
        description:
          "[Browser] Load a URL in a browser pane. " +
          "Only http:// and https:// are allowed. Agent-initiated; logged to the bound session's audit trail.",
        inputSchema: browserNavigateSchema as Record<string, z.ZodTypeAny>,
      },
      async (args) => handleBrowserNavigate(args as { pane_id: string; url: string }),
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
