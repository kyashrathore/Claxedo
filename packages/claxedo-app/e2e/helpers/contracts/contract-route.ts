import type { Page } from "@playwright/test"

/**
 * Registration marker for a route whose handler is bound to a real producer,
 * schema, type, or driven server route under `./contracts/`.
 *
 * Runtime behavior is exactly `page.route`; the distinct call site lets the
 * architecture inventory count evidence without parsing comments.
 */
export function contractRoute(
  page: Page,
  url: Parameters<Page["route"]>[0],
  handler: Parameters<Page["route"]>[1],
) {
  return page.route(url, handler)
}
