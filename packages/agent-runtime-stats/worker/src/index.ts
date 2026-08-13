import { renderOgCard, renderReportPage, renderSharePage } from "./html"
import { bytesFromD1 } from "./blob"
import { InvalidReportError, parseReport, type ReportMetrics, type StoredReport } from "./report"
import {
  PUBLIC_ORIGIN,
  RESEARCH_PATH,
  REPORT_API_PATH,
  SHARE_PATH,
  reportPath,
} from "../../src/share-contract.js"

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
  sessions_without_full_machine_percent: number | null
  turns_analyzed: number
  turn_coverage_percent: number | null
  turns_without_full_machine_percent: number | null
  repeat_full_machine_turn_percent: number | null
  full_machine_return_interval_samples: number
  median_full_machine_return_interval_ms: number | null
  p95_full_machine_return_interval_ms: number | null
  median_calls_after_first_full_machine: number | null
  median_observed_span_after_first_full_machine_ms: number | null
  p95_observed_span_after_first_full_machine_ms: number | null
  // D1 maps SQLite BLOB values back to JavaScript number arrays.
  og_png: number[] | null
  og_retry_after: string | null
}

const REPORT_SELECT = `SELECT id, created_at, schema_version, sessions_analyzed, execution_calls,
  sessions_without_full_machine_percent, turns_analyzed, turn_coverage_percent,
  turns_without_full_machine_percent, repeat_full_machine_turn_percent,
  full_machine_return_interval_samples, median_full_machine_return_interval_ms,
  p95_full_machine_return_interval_ms,
  median_calls_after_first_full_machine, median_observed_span_after_first_full_machine_ms,
  p95_observed_span_after_first_full_machine_ms, og_png, og_retry_after
  FROM reports WHERE id = ?1`

function fromRow(row: ReportRow): StoredReport {
  return {
    id: row.id,
    createdAt: row.created_at,
    schemaVersion: 3,
    sessionsAnalyzed: row.sessions_analyzed,
    executionCalls: row.execution_calls,
    sessionsWithoutFullMachinePercent: row.sessions_without_full_machine_percent,
    turnsAnalyzed: row.turns_analyzed,
    turnCoveragePercent: row.turn_coverage_percent,
    turnsWithoutFullMachinePercent: row.turns_without_full_machine_percent,
    repeatFullMachineTurnPercent: row.repeat_full_machine_turn_percent,
    fullMachineReturnIntervalSamples: row.full_machine_return_interval_samples,
    medianFullMachineReturnIntervalMs: row.median_full_machine_return_interval_ms,
    p95FullMachineReturnIntervalMs: row.p95_full_machine_return_interval_ms,
    medianCallsAfterFirstFullMachine: row.median_calls_after_first_full_machine,
    medianObservedSpanAfterFirstFullMachineMs: row.median_observed_span_after_first_full_machine_ms,
    p95ObservedSpanAfterFirstFullMachineMs: row.p95_observed_span_after_first_full_machine_ms,
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

function html(body: string, pageNonce: string, status = 200, noindex = false): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
      ...(noindex ? { "x-robots-tag": "noindex, follow" } : {}),
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

function apiReportId(pathname: string): string | null {
  for (const prefix of [REPORT_API_PATH, "/api/reports"]) {
    if (!pathname.startsWith(`${prefix}/`)) continue
    const id = pathname.slice(prefix.length + 1)
    if (/^[a-f0-9]{32}$/.test(id)) return id
  }
  return null
}

async function findReport(
  env: Env,
  id: string,
): Promise<{ report: StoredReport; image: Uint8Array<ArrayBuffer> | null } | null> {
  const row = await env.REPORTS.prepare(REPORT_SELECT).bind(id).first<ReportRow>()
  return row
    ? {
        report: fromRow(row),
        image: bytesFromD1(row.og_png),
      }
    : null
}

class OgGenerationUnavailable extends Error {}

async function generateOg(env: Env, id: string, report: ReportMetrics): Promise<ArrayBuffer> {
  const claim = await env.REPORTS.prepare(
    `UPDATE reports
     SET og_retry_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes')
     WHERE id = ?1 AND og_png IS NULL
       AND (og_retry_after IS NULL OR og_retry_after <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  )
    .bind(id)
    .run()
  if (claim.meta.changes !== 1) throw new OgGenerationUnavailable("OG generation is already running or backed off.")
  try {
    const response = await env.BROWSER.quickAction("screenshot", {
      html: renderOgCard(report),
      viewport: { width: 1200, height: 630, deviceScaleFactor: 1 },
      screenshotOptions: { type: "png" },
    })
    if (!response.ok) throw new Error(`Browser Run returned ${response.status}: ${await response.text()}`)
    const image = await response.arrayBuffer()
    if (image.byteLength === 0 || image.byteLength > 2_000_000) {
      throw new Error("Browser Run returned an invalid image size.")
    }
    await env.REPORTS.prepare(
      `UPDATE reports SET og_png = ?1,
       og_generated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), og_retry_after = NULL
       WHERE id = ?2`,
    )
      .bind(image, id)
      .run()
    return image
  } catch (error) {
    await env.REPORTS.prepare(
      "UPDATE reports SET og_retry_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour') WHERE id = ?1",
    )
      .bind(id)
      .run()
    throw error
  }
}

async function rateLimitKey(request: Request): Promise<string> {
  const address = request.headers.get("cf-connecting-ip") ?? "missing-client-address"
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function createReport(request: Request, env: Env): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0")
  if (contentLength > 4_096) return json({ error: "The report body is too large." }, 413)
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415)
  }
  const limited = await env.CREATE_REPORT_LIMITER.limit({ key: await rateLimitKey(request) })
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
    sessions_without_full_machine_percent, turns_analyzed, turn_coverage_percent,
    turns_without_full_machine_percent, repeat_full_machine_turn_percent,
    full_machine_return_interval_samples, median_full_machine_return_interval_ms,
    p95_full_machine_return_interval_ms,
    median_calls_after_first_full_machine, median_observed_span_after_first_full_machine_ms,
    p95_observed_span_after_first_full_machine_ms
  ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
  )
    .bind(
      id,
      report.schemaVersion,
      report.sessionsAnalyzed,
      report.executionCalls,
      report.sessionsWithoutFullMachinePercent,
      report.turnsAnalyzed,
      report.turnCoveragePercent,
      report.turnsWithoutFullMachinePercent,
      report.repeatFullMachineTurnPercent,
      report.fullMachineReturnIntervalSamples,
      report.medianFullMachineReturnIntervalMs,
      report.p95FullMachineReturnIntervalMs,
      report.medianCallsAfterFirstFullMachine,
      report.medianObservedSpanAfterFirstFullMachineMs,
      report.p95ObservedSpanAfterFirstFullMachineMs,
    )
    .run()

  let ogReady = false
  try {
    await generateOg(env, id, report)
    ogReady = true
  } catch (error) {
    console.error("Initial OG generation failed", { id, error: error instanceof Error ? error.message : String(error) })
  }
  const url = new URL(reportPath(id), request.url).toString()
  return json({ id, url, ogReady }, 201)
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/") {
    return Response.redirect(`${PUBLIC_ORIGIN}${RESEARCH_PATH}`, 308)
  }
  if (request.method === "GET" && [SHARE_PATH, "/share"].includes(url.pathname)) {
    const pageNonce = nonce()
    return html(renderSharePage(pageNonce), pageNonce, 200, true)
  }
  if (request.method === "GET" && url.pathname === "/health") return json({ ok: true })
  if (request.method === "POST" && [REPORT_API_PATH, "/api/reports"].includes(url.pathname)) {
    return createReport(request, env)
  }

  const id = reportId(url.pathname)
  if (request.method === "GET" && id) {
    const stored = await findReport(env, id)
    if (!stored) return json({ error: "Report not found." }, 404)
    const pageNonce = nonce()
    return html(renderReportPage(stored.report, url.origin, pageNonce), pageNonce, 200, true)
  }

  const imageId = reportId(url.pathname, "og\\.png")
  if (request.method === "GET" && imageId) {
    const stored = await findReport(env, imageId)
    if (!stored) return json({ error: "Report not found." }, 404)
    let image = stored.image
    if (!image) {
      try {
        image = new Uint8Array(await generateOg(env, imageId, stored.report))
      } catch (error) {
        if (!(error instanceof OgGenerationUnavailable)) {
          console.error("OG generation failed", {
            id: imageId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return new Response("Social preview generation is temporarily unavailable.", {
          status: 503,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=300",
            "retry-after": "300",
            ...securityHeaders(),
          },
        })
      }
    }
    return new Response(image, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000, immutable",
        ...securityHeaders(),
      },
    })
  }

  const apiId = apiReportId(url.pathname)
  if (request.method === "GET" && apiId) {
    const stored = await findReport(env, apiId)
    return stored ? json(stored.report) : json({ error: "Report not found." }, 404)
  }
  if (request.method === "GET" && url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
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
