import { asRecord, asRecordOrEmpty } from "@claxedo/helpers/guards"
import type { ScenarioId } from "../types"
import type { fixtureFor } from "./fixtures"
import type { Page } from "playwright-core"

type SessionRequestCountsForValidation = {
  requestCounts: {
    messages: number
    expectedTranscripts: Record<string, string>
    visibleTranscripts: Record<string, boolean>
  }
}

export async function browserFailureDiagnostics(page: Page, monitor: ReturnType<typeof monitorPage>, error: unknown) {
  const base = error instanceof Error ? error.message : String(error)
  // `page.url()` is synchronous; awaiting it inside `Promise.all` said it was
  // fetched alongside the others when it is read immediately.
  const url = page.url()
  const [title, body, boundaryError, snapshot] = await Promise.all([
    page.title().catch(() => ""),
    page.locator("body").innerText({ timeout: 500 }).catch(() => ""),
    readBoundaryError(page),
    // The narrowing runs below, not in the browser: an evaluate body is
    // serialized, so it cannot reach a module-scope import.
    page.evaluate(() => {
      const persisted: unknown = JSON.parse(localStorage.getItem("claxedo.state.v5") ?? "{}")
      return {
        persisted,
        shell: document.querySelector("[data-testid='workspace-panel-shell']")?.getAttribute("data-open"),
        pending: !!document.querySelector("[data-testid='workspace-review-pending']"),
        review: document.querySelectorAll("[data-review-diff-style]").length,
        renderedHunks: Array.from(document.querySelectorAll<HTMLElement>("[data-review-rendered-hunks]"))
          .map((node) => node.dataset.reviewRenderedHunks),
        reviewRoot: document.querySelectorAll("[data-testid='review-pane-root']").length,
        lines: document.querySelectorAll("#review-panel [data-line]").length,
      }
    }).catch(() => undefined),
  ])
  // Persisted state is whatever the last build wrote; this diagnostic reports
  // the three fields it can find and stays silent about the rest.
  const perfState = snapshot && (() => {
    const { persisted, ...dom } = snapshot
    const state = asRecordOrEmpty(persisted)
    const workbench = asRecord(state.workbench)
    return {
      workspacePanel: state.workspacePanel,
      focusedPaneId: workbench?.focusedPaneId,
      panes: workbench?.panes,
      ...dom,
    }
  })()
  const details = [
    base,
    `url=${url}`,
    title ? `title=${title}` : undefined,
    body.trim() ? `body=${body.replace(/\s+/g, " ").trim().slice(0, 240)}` : "body=<empty>",
    boundaryError ? `boundaryError=${boundaryError.replace(/\s+/g, " ").trim().slice(0, 600)}` : undefined,
    perfState ? `perfState=${JSON.stringify(perfState)}` : undefined,
    monitor.pageErrors.length ? `pageErrors=${monitor.pageErrors.slice(-3).join(" | ")}` : undefined,
    monitor.consoleErrors.length ? `consoleErrors=${monitor.consoleErrors.slice(-3).join(" | ")}` : undefined,
    monitor.failedResponses.length ? `failedResponses=${monitor.failedResponses.slice(-5).join(" | ")}` : undefined,
    monitor.failedRequests.length ? `failedRequests=${monitor.failedRequests.slice(-5).join(" | ")}` : undefined,
    monitor.unmatchedMockPaths.length ? `unmatchedMockPaths=${monitor.unmatchedMockPaths.slice(-8).join(" | ")}` : undefined,
  ].filter((item): item is string => !!item)
  return details.join("; ")
}

// The app's single ErrorBoundary (src/app/entry/app.tsx -> routes/error.tsx)
// renders the caught error into a Kobalte textarea [data-slot="input-input"].
// Textarea content lives in .value, not innerText, so every body.innerText
// diagnostic misses it — this read is the eyes for boundary failures.
export async function readBoundaryError(page: Page) {
  return await page
    .locator('[data-slot="input-input"]')
    .first()
    .inputValue({ timeout: 500 })
    .catch(() => "")
}

export function monitorPage(page: Page) {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  const failedRequests: string[] = []
  const unmatchedMockPaths: string[] = []
  page.on("pageerror", (error) => {
    pageErrors.push(error.message)
  })
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.failure()?.errorText ?? "failed"} ${request.method()} ${request.url()}`)
  })
  return { pageErrors, consoleErrors, failedResponses, failedRequests, unmatchedMockPaths }
}

export async function validationFailures(
  page: Page,
  monitor: ReturnType<typeof monitorPage>,
  scenario: ScenarioId,
  fixture: ReturnType<typeof fixtureFor>,
) {
  const text = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "")
  const boundaryRendered = text.includes("Something went wrong") || text.includes("An error occurred while loading the application")
  // The boundary's error text lives in a textarea's .value, which
  // body.innerText excludes — read it so the failure carries the actual error
  // instead of only "error boundary rendered".
  const boundaryError = boundaryRendered ? await readBoundaryError(page) : ""
  // The composer's model control (`[data-action='prompt-model']`, named by
  // 302c88e5f). The old literal checks ("Model unavailable" / "Select agent")
  // matched strings the app no longer renders anywhere, so they could never
  // fire; a broken model surface now shows as a control with an empty
  // accessible name (label empty while the provider list never resolves).
  const composerModel = await page.evaluate(() => {
    const control = document.querySelector<HTMLElement>("[data-action='prompt-model']")
    if (!control) return { present: false, named: false }
    const name = control.getAttribute("aria-label") ?? control.textContent ?? ""
    return { present: true, named: !!name.trim() }
  }).catch(() => ({ present: false, named: false }))
  return [
    ...monitor.pageErrors.map((error) => `page error: ${error}`),
    ...monitor.consoleErrors.filter(significantConsoleError).map((error) => `console error: ${error}`),
    ...(boundaryRendered
      ? [`error boundary rendered for ${scenario}${boundaryError ? `: ${boundaryError.replace(/\s+/g, " ").trim().slice(0, 400)}` : ""}`]
      : []),
    ...(!text.trim() ? [`blank page rendered for ${scenario}`] : []),
    ...(missingSessionMessageRequest(scenario, fixture) ? [`session messages were not requested for ${scenario}`] : []),
    ...(sessionScenario(scenario) && loadingOnly(text) ? [`session page was still loading for ${scenario}`] : []),
    ...(sessionScenario(scenario) && !boundaryRendered && composerModel.present && !composerModel.named
      ? [`composer model control had no label for ${scenario}`]
      : []),
    ...fixture.visualFailures,
    ...Object.entries(fixture.requestCounts.expectedTranscripts).flatMap(([sessionID, expected]) =>
      fixture.requestCounts.visibleTranscripts[sessionID] ? [] : [`transcript text was not visible for ${scenario}: ${expected}`],
    ),
  ].filter((failure, index, failures) => failures.indexOf(failure) === index)
}

function significantConsoleError(text: string) {
  // The harness serves the app against a route-mocked fixture with no real
  // backend on :3001; the global-sdk SSE stream cannot be route-mocked, so its
  // eventual "TypeError: Failed to fetch" is environmental here — every flow
  // would fail on it while the app is healthy. Everything else stays fatal.
  if (text.includes("[global-sdk] event stream failed") && text.includes("Failed to fetch")) return false
  return ["Cannot read properties", "ReferenceError", "TypeError", "Uncaught", "Something went wrong"].some((needle) => text.includes(needle))
}

function loadingOnly(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized === "Loading..." || normalized === "Loading" || normalized.endsWith(" Loading...")
}

function sessionScenario(_scenario: ScenarioId) {
  // Every surviving flow navigates into a specific session, so this always
  // qualifies for the "session messages were requested" check.
  return true
}

export function missingSessionMessageRequest(scenario: ScenarioId, fixture: SessionRequestCountsForValidation) {
  if (!sessionScenario(scenario)) return false
  if (fixture.requestCounts.messages > 0) return false
  const expected = Object.keys(fixture.requestCounts.expectedTranscripts)
  if (expected.length === 0) return true
  return expected.every((sessionID) => !fixture.requestCounts.visibleTranscripts[sessionID])
}
