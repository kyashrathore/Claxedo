/**
 * Real harness replies may carry multiple text and reasoning parts, so row counts
 * are not turn counts. These observations supplement the shared reply oracle with
 * per-marker counts and transient streaming paint; they do not replace it.
 */
import { expect, type Page } from "@playwright/test"
import { SELECTORS } from "./turn-oracle"

/** Exactly one user row per turn — the count real multi-part replies can't distort. */
export async function expectLiveUserRowCount(page: Page, count: number) {
  await expect(page.locator(SELECTORS.userMessageContent), `expected exactly ${count} user row(s)`).toHaveCount(count, {
    timeout: 20_000,
  })
}

/**
 * The strict per-marker duplicate-render check — call it ONLY after
 * `page.reload()`, never mid-session. A confirmed client-store defect
 * (`mergeStoredItems` in `src/session/store/message-page.ts:41-56` never prunes
 * a part id that a later canonical fetch/event no longer contains) can
 * transiently render a turn's reply in two `session-turn-assistant-content`
 * rows with byte-identical text while the session is live — verified by
 * cross-checking the SAME turn's real `GET /session/:id/message` response,
 * which never contains more than one text part for that message. A full reload
 * discards the incrementally-merged client history and rehydrates purely from
 * that clean response, so the check is both valid and load-bearing there.
 */
export async function expectLiveTurnsSettledAfterReload(page: Page, markers: string[]) {
  await expectLiveUserRowCount(page, markers.length)
  for (const marker of markers) {
    await expect(
      page.locator(SELECTORS.assistantContentVisible).filter({ hasText: new RegExp(marker) }),
      `expected exactly one visible assistant row containing marker ${marker} (duplicate-render check)`,
    ).toHaveCount(1, { timeout: 20_000 })
  }
}

/**
 * Active transcript rows carry aria-hidden even while painted. Streaming observations
 * inspect paint directly; completed replies still go through the strict reply oracle.
 */
export async function observeStreamingReply(page: Page) {
  const probe = await page.evaluateHandle(({ content, submit }) => {
    const samples: Array<{ at: number; text: string; busy: boolean }> = []
    let frame = 0
    const sample = () => {
      const text = [...document.querySelectorAll<HTMLElement>(content)]
        .filter(element => {
          const rect = element.getBoundingClientRect()
          if (!rect.width || !rect.height) return false
          for (let parent: Element | null = element; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent)
            if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false
          }
          return true
        })
        .map(element => element.innerText).join("\n")
      samples.push({ at: performance.timeOrigin + performance.now(), text, busy: document.querySelector(submit)?.getAttribute("data-icon") === "stop" })
      frame = requestAnimationFrame(sample)
    }
    sample()
    return { samples, stop: () => cancelAnimationFrame(frame) }
  }, { content: SELECTORS.assistantContent, submit: SELECTORS.submitControl })
  return async () => {
    const samples = await probe.evaluate(probe => {
      probe.stop()
      return probe.samples
    })
    await probe.dispose()
    return samples
  }
}

export function expectStreamingSegmentsOnce(
  samples: Array<{ text: string; busy: boolean }>,
  segments: string[],
) {
  const partial = samples.filter(sample => sample.busy && sample.text.includes(segments[0]) && !sample.text.includes(segments.at(-1)!))
  expect(new Set(partial.map(sample => sample.text)).size, "the actual reply visibly grows during the live stream").toBeGreaterThanOrEqual(3)
  const duplicated = samples.flatMap((sample, frame) => segments
    .filter(segment => sample.text.split(segment).length - 1 > 1)
    .map(segment => ({ frame, segment, text: sample.text })))
  expect(duplicated, "streamed text segments appear more than once in a painted assistant turn").toEqual([])
  const final = samples.at(-1)?.text ?? ""
  for (const segment of segments) {
    expect(final.split(segment).length - 1, `completed reply retains ${segment} exactly once`).toBe(1)
  }
}

/** Observes a cloned runtime SSE body; the application receives the original response unchanged. */
export async function observeRuntimeTextTraffic(page: Page) {
  await page.addInitScript(() => {
    const target = window as typeof window & { runtimeTextTraffic?: Array<{ at: number; url: string; data: string }> }
    target.runtimeTextTraffic = []
    window.fetch = new Proxy(window.fetch, {
      async apply(request, scope, args: Parameters<typeof fetch>) {
        const response: Response = await Reflect.apply(request, scope, args)
        if (response.url.includes("/api/wr/events") && response.headers.get("content-type")?.includes("text/event-stream")) {
          const reader = response.clone().body?.getReader()
          if (reader) void (async () => {
            const decoder = new TextDecoder()
            try {
              while (true) {
                const chunk = await reader.read()
                if (chunk.done) break
                target.runtimeTextTraffic!.push({ at: Date.now(), url: response.url, data: decoder.decode(chunk.value, { stream: true }) })
              }
            } catch (error) {
              target.runtimeTextTraffic!.push({ at: Date.now(), url: response.url, data: `reader ended: ${String(error)}` })
            } finally { reader.releaseLock() }
          })()
        }
        return response
      },
    })
  })
  return () => page.evaluate(() => (window as typeof window & { runtimeTextTraffic?: Array<{ at: number; url: string; data: string }> }).runtimeTextTraffic ?? [])
}
