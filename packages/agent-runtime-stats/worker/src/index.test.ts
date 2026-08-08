import { expect, test } from "bun:test"

import worker from "./index"

test("rate-limits report creation per client address", async () => {
  const keys: string[] = []
  const env = {
    CREATE_REPORT_LIMITER: {
      async limit({ key }: { key: string }) {
        keys.push(key)
        return { success: true }
      },
    },
  }
  for (const address of ["203.0.113.1", "203.0.113.2", "203.0.113.1"]) {
    const response = await worker.fetch(
      new Request("https://claxedo.com/api/agent-runtime-reports", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": address },
        body: "{}",
      }) as never,
      env as never,
    )
    expect(response.status).toBe(400)
  }
  expect(keys[0]).not.toBe(keys[1])
  expect(keys[0]).toBe(keys[2])
  expect(keys[0]).not.toContain("203.0.113.1")
})

test("redirects the legacy worker landing page to the canonical Claxedo study", async () => {
  const response = await worker.fetch(new Request("https://stats.example/") as never, {} as never)
  expect(response.status).toBe(308)
  expect(response.headers.get("location")).toBe(
    "https://claxedo.com/how-often-do-coding-agents-need-a-full-machine",
  )
})

test("keeps the browser review page out of search results", async () => {
  const response = await worker.fetch(
    new Request("https://claxedo.com/agent-runtime-share") as never,
    {} as never,
  )
  expect(response.status).toBe(200)
  expect(response.headers.get("x-robots-tag")).toBe("noindex, follow")
  expect(await response.text()).toContain('fetch("/api/agent-runtime-reports"')
})

test("backs off concurrent or recently failed OG generation", async () => {
  const id = "a".repeat(32)
  let browserCalls = 0
  const row = {
    id,
    created_at: "2026-08-08T00:00:00.000Z",
    schema_version: 3,
    sessions_analyzed: 1,
    execution_calls: 10,
    sessions_without_full_machine_percent: 50,
    turns_analyzed: 2,
    turn_coverage_percent: 100,
    turns_without_full_machine_percent: 50,
    repeat_full_machine_turn_percent: 100,
    full_machine_return_interval_samples: 1,
    median_full_machine_return_interval_ms: 1000,
    p95_full_machine_return_interval_ms: 1000,
    median_calls_after_first_full_machine: 1,
    median_observed_span_after_first_full_machine_ms: 1000,
    p95_observed_span_after_first_full_machine_ms: 2000,
    og_png: null,
    og_retry_after: "2099-01-01T00:00:00.000Z",
  }
  const env = {
    REPORTS: {
      prepare(sql: string) {
        if (sql.startsWith("SELECT")) {
          return { bind: () => ({ first: async () => row }) }
        }
        return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }
      },
    },
    BROWSER: {
      async quickAction() {
        browserCalls++
        throw new Error("must not render")
      },
    },
  }
  const response = await worker.fetch(new Request(`https://stats.example/r/${id}/og.png`) as never, env as never)
  expect(response.status).toBe(503)
  expect(response.headers.get("cache-control")).toBe("public, max-age=300")
  expect(response.headers.get("retry-after")).toBe("300")
  expect(browserCalls).toBe(0)
})
