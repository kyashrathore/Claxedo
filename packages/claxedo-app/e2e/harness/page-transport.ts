import type { Page } from "@playwright/test"
import type { HttpTransport } from "../../../harness/e2e/harness/transport"

export function pageTransport(page: Page): HttpTransport {
  return (request) =>
    page.evaluate(async (input) => {
      const response = await fetch(input.url, { method: input.method, headers: input.headers, body: input.body })
      return { status: response.status, body: await response.text() }
    }, request)
}
