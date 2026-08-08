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
      new Request("https://stats.example/api/reports", {
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

test("backs off concurrent or recently failed OG generation", async () => {
  const id = "a".repeat(32)
  let browserCalls = 0
  const row = {
    id,
    created_at: "2026-08-08T00:00:00.000Z",
    schema_version: 2,
    sessions_analyzed: 1,
    execution_calls: 10,
    sessions_without_full_machine_percent: 50,
    turns_analyzed: 2,
    turn_coverage_percent: 100,
    turns_without_full_machine_percent: 50,
    repeat_full_machine_turn_percent: 100,
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
