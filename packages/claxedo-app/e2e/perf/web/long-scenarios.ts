import type { Page } from "@playwright/test"
import { STREAM_END, streamScript } from "../stream-script"
import { MARK_TIMEOUT_MS, measure, railPress, readProbe, sessionMarks, summarizeStep, waitForMark, type Measure, type RunInput, type Session, type Span, type StepResult } from "./steps"
import type { Recording } from "./recorder"

const STREAM_TIMEOUT_MS = 240_000
const STREAM_POLL_MS = 250

type Attempt = (name: string, page: Page | undefined, run: () => Promise<StepResult>) => Promise<void>

const pressStep = (page: Page, scenario: string, step: string, sessionId: string): Measure => ({
  scenario, step, cache: "warm", reference: "input", ...sessionMarks(sessionId), ...railPress(page, sessionId),
})

export async function runLongSteps(input: RunInput, chain: Session, attempt: Attempt) {
  const { page } = chain
  const [first] = input.target.sessions
  const long = input.target.long
  if (!first || long.length === 0) return
  for (const session of long) await attempt(`open-long/press-${session.label}`, page, () => measure(input, chain, pressStep(page, "open-long", `press-${session.label}`, session.id)))
  const [smallest] = long
  if (long.length > 1) await attempt(`switch-long/return-${smallest.label}`, page, () => measure(input, chain, pressStep(page, "switch-long", `return-${smallest.label}`, smallest.id)))
  await attempt("switch-long/return-short", page, () => measure(input, chain, pressStep(page, "switch-long", "return-short", first.id)))
}

async function showSession(page: Page, sessionId: string) {
  const press = railPress(page, sessionId)
  await press.before?.()
  await page.evaluate(() => window.__webPerf?.arm())
  await press.act()
  await waitForMark(page, `session-text:${sessionId}`, MARK_TIMEOUT_MS)
}

async function streamEnd(page: Page, sessionId: string) {
  await page.waitForFunction(({ id, text }) => {
    const scroller = document.querySelector(`section[data-component="session-screen"][data-session-id="${CSS.escape(id)}"] [data-slot="session-timeline-scroll"]`)
    return (scroller?.textContent ?? "").includes(text)
  }, { id: sessionId, text: STREAM_END }, { timeout: STREAM_TIMEOUT_MS, polling: STREAM_POLL_MS })
}

export async function runStreamStep(input: RunInput, chain: Session, attempt: Attempt, streamIndex: number) {
  const stream = input.target.stream
  const session = stream?.sessions[streamIndex]
  if (!stream || !session) return
  const { page, recorder } = chain
  await attempt("stream-turn/report", page, async () => {
    await showSession(page, session.id)
    await recorder.begin({ trace: true, profile: true })
    await page.evaluate(() => window.__webPerf?.pause())
    let recording: Recording
    let span: Span
    try {
      const referenceMs = await page.evaluate(() => performance.now())
      await stream.prompt(session.id, `stream-${input.profile.name}-${input.rep}`, streamScript(stream.directory))
      await streamEnd(page, session.id)
      span = { referenceMs, endMs: (await page.evaluate(() => performance.now())) - referenceMs }
    } finally {
      recording = await recorder.end()
      await page.evaluate(() => window.__webPerf?.resume())
    }
    const spec: Measure = { scenario: "stream-turn", step: "report", cache: "warm", reference: "prompt", required: [], settle: undefined, act: async () => undefined }
    return summarizeStep(input, chain, spec, recording, await readProbe(page), span)
  })
}
