import { renderLandingPage, renderOgCard, renderReportPage, renderSharePage } from "./html"
import { bytesFromD1 } from "./blob"
import { InvalidReportError, parseReport, type ReportMetrics, type StoredReport } from "./report"

interface Env {
  REPORTS: D1Database
  BROWSER: BrowserRun
  CREATE_REPORT_LIMITER: RateLimit
}

interface ReportRow {
  id: string
  created_at: string
  schema_version: number
  sessions_analyzed: number
  execution_calls: number
  just_bash_percent: number | null
  full_vm_percent: number | null
  median_x_ms: number | null
  p95_x_ms: number | null
  // D1 maps SQLite BLOB values back to JavaScript number arrays.
  og_png: number[] | null
}

const REPORT_SELECT = `SELECT id, created_at, schema_version, sessions_analyzed, execution_calls,
  just_bash_percent, full_vm_percent, median_x_ms, p95_x_ms, og_png
  FROM reports WHERE id = ?1`

function fromRow(row: ReportRow): StoredReport {
  return {
    id: row.id,
    createdAt: row.created_at,
    schemaVersion: 1,
    sessionsAnalyzed: row.sessions_analyzed,
    executionCalls: row.execution_calls,
    justBashPercent: row.just_bash_percent,
    fullVmPercent: row.full_vm_percent,
    medianTimeBeforeFullMachineMs: row.median_x_ms,
    p95TimeBeforeFullMachineMs: row.p95_x_ms,
  }
}

function nonce(): string {
  return crypto.randomUUID().replaceAll("-", "")
}

function securityHeaders(pageNonce?: string): HeadersInit {
  const script = pageNonce ? `'nonce-${pageNonce}'` : "'none'"
  const style = pageNonce ? `'nonce-${pageNonce}'` : "'none'"
  return {
    "content-security-policy": `default-src 'none'; script-src ${script}; style-src ${style}; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  }
}

function html(body: string, pageNonce: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
      ...securityHeaders(pageNonce),
    },
  })
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...securityHeaders() },
  })
}

function reportId(pathname: string, suffix = ""): string | null {
  const expression = suffix ? new RegExp(`^/r/([a-f0-9]{32})/${suffix}$`) : /^\/r\/([a-f0-9]{32})$/
  return pathname.match(expression)?.[1] ?? null
}

async function findReport(
  env: Env,
  id: string,
): Promise<{ report: StoredReport; image: Uint8Array<ArrayBuffer> | null } | null> {
  const row = await env.REPORTS.prepare(REPORT_SELECT).bind(id).first<ReportRow>()
  return row ? { report: fromRow(row), image: bytesFromD1(row.og_png) } : null
}

async function generateOg(env: Env, id: string, report: ReportMetrics): Promise<ArrayBuffer> {
  const response = await env.BROWSER.quickAction("screenshot", {
    html: renderOgCard(report),
    viewport: { width: 1200, height: 630, deviceScaleFactor: 1 },
    screenshotOptions: { type: "png" },
  })
  if (!response.ok) throw new Error(`Browser Run returned ${response.status}: ${await response.text()}`)
  const image = await response.arrayBuffer()
  if (image.byteLength === 0 || image.byteLength > 2_000_000)
    throw new Error("Browser Run returned an invalid image size.")
  await env.REPORTS.prepare(
    "UPDATE reports SET og_png = ?1, og_generated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
  )
    .bind(image, id)
    .run()
  return image
}

async function createReport(request: Request, env: Env): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0")
  if (contentLength > 4_096) return json({ error: "The report body is too large." }, 413)
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415)
  }
  const limited = await env.CREATE_REPORT_LIMITER.limit({ key: "anonymous-reports" })
  if (!limited.success) return json({ error: "Too many reports are being published. Try again in a minute." }, 429)

  const raw = await request.text()
  if (raw.length > 4_096) return json({ error: "The report body is too large." }, 413)
  let report: ReportMetrics
  try {
    report = parseReport(JSON.parse(raw))
  } catch (error) {
    const message = error instanceof InvalidReportError ? error.message : "The request body is not valid JSON."
    return json({ error: message }, 400)
  }

  const id = crypto.randomUUID().replaceAll("-", "")
  await env.REPORTS.prepare(
    `INSERT INTO reports (
    id, schema_version, sessions_analyzed, execution_calls,
    just_bash_percent, full_vm_percent, median_x_ms, p95_x_ms
  ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      report.schemaVersion,
      report.sessionsAnalyzed,
      report.executionCalls,
      report.justBashPercent,
      report.fullVmPercent,
      report.medianTimeBeforeFullMachineMs,
      report.p95TimeBeforeFullMachineMs,
    )
    .run()

  let ogReady = false
  try {
    await generateOg(env, id, report)
    ogReady = true
  } catch (error) {
    console.error("Initial OG generation failed", { id, error: error instanceof Error ? error.message : String(error) })
  }
  const url = new URL(`/r/${id}`, request.url).toString()
  return json({ id, url, ogReady }, 201)
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/") {
    const pageNonce = nonce()
    return html(renderLandingPage(pageNonce), pageNonce)
  }
  if (request.method === "GET" && url.pathname === "/share") {
    const pageNonce = nonce()
    return html(renderSharePage(pageNonce), pageNonce)
  }
  if (request.method === "GET" && url.pathname === "/health") return json({ ok: true })
  if (request.method === "POST" && url.pathname === "/api/reports") return createReport(request, env)

  const id = reportId(url.pathname)
  if (request.method === "GET" && id) {
    const stored = await findReport(env, id)
    if (!stored) return json({ error: "Report not found." }, 404)
    const pageNonce = nonce()
    return html(renderReportPage(stored.report, url.origin, pageNonce), pageNonce)
  }

  const imageId = reportId(url.pathname, "og\\.png")
  if (request.method === "GET" && imageId) {
    const stored = await findReport(env, imageId)
    if (!stored) return json({ error: "Report not found." }, 404)
    const image = stored.image ?? (await generateOg(env, imageId, stored.report))
    return new Response(image, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000, immutable",
        ...securityHeaders(),
      },
    })
  }

  const apiMatch = url.pathname.match(/^\/api\/reports\/([a-f0-9]{32})$/)
  if (request.method === "GET" && apiMatch) {
    const stored = await findReport(env, apiMatch[1])
    return stored ? json(stored.report) : json({ error: "Report not found." }, 404)
  }
  if (request.method === "GET" && url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain; charset=utf-8" } })
  }
  return json({ error: "Not found." }, 404)
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env)
    } catch (error) {
      console.error("Unhandled request error", error)
      return json({ error: "Internal server error." }, 500)
    }
  },
} satisfies ExportedHandler<Env>
