import type { Page } from "@playwright/test"
import path from "node:path"
import { runLongSteps, runStreamStep } from "./long-scenarios"
import { MARK_TIMEOUT_MS, measure, openSession, pressByRole, railPress, sessionMarks, type RunInput, type StepResult } from "./steps"

const TYPED = "Measuring how the composer keeps up"
const SWITCHES = 4

export type ScenarioRun = { readonly results: readonly StepResult[]; readonly failures: readonly string[] }

export async function runScenarios(input: RunInput, streamIndex: number): Promise<ScenarioRun> {
  const { target } = input
  const [first, second] = target.sessions
  if (!first || !second) throw new Error("the target names fewer than two sessions")
  const results: StepResult[] = []
  const failures: string[] = []
  const attempt = async (name: string, page: Page | undefined, run: () => Promise<StepResult>) => {
    try {
      results.push(await run())
    } catch (error) {
      const shot = page ? path.join(input.out, `${input.label}-${input.profile.name}-${name.replace(/\//g, "-")}-rep${input.rep}-failed.png`) : undefined
      if (shot) await page?.screenshot({ path: shot }).catch(() => undefined)
      const message = `${input.profile.name} ${name} rep ${input.rep} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}${shot ? ` (${shot})` : ""}`
      failures.push(message)
      input.log(message)
    }
  }
  const coldStep = async (scenario: string, url: string, signedIn: boolean, until: { required: readonly string[]; settle?: string }) => {
    const session = await openSession(input, signedIn)
    try {
      await attempt(`${scenario}/boot`, session.page, () => measure(input, session, { scenario, step: "boot", cache: "cold", reference: "navigation", required: until.required, settle: until.settle, act: () => session.page.goto(url, { waitUntil: "commit" }).then(() => undefined) }))
      return session
    } catch (error) {
      await session.context.close()
      throw error
    }
  }
  const root = await coldStep("cold-root", `${target.url}/`, true, { required: ["rail"] })
  try {
    await attempt("first-session/press", root.page, () => measure(input, root, { scenario: "first-session", step: "press", cache: "warm", reference: "input", ...sessionMarks(first.id), ...railPress(root.page, first.id) }))
  } finally {
    await root.context.close()
  }

  const chain = await coldStep("cold-session", first.url, true, sessionMarks(first.id))
  const { page } = chain
  try {
    await attempt("warm-session/reload", page, () => measure(input, chain, { scenario: "warm-session", step: "reload", cache: "warm", reference: "navigation", ...sessionMarks(first.id), act: () => page.goto(first.url, { waitUntil: "commit" }).then(() => undefined) }))
    await attempt("open-session/press", page, () => measure(input, chain, { scenario: "open-session", step: "press", cache: "warm", reference: "input", ...sessionMarks(second.id), ...railPress(page, second.id) }))
    await attempt("open-session/type", page, async () => {
      await pressByRole(page, () => page.locator('[data-component="prompt-input"][contenteditable="true"]').first())
      return measure(input, chain, { scenario: "open-session", step: "type", cache: "warm", reference: "input", required: [], settle: undefined, act: async () => {
        await page.keyboard.type(TYPED, { delay: 80 })
        await page.waitForFunction((count) => (window.__webPerf?.read().keys.length ?? 0) >= count, TYPED.length, { timeout: MARK_TIMEOUT_MS, polling: 50 })
      } })
    })
    for (let index = 0; index < SWITCHES; index += 1) {
      const destination = index % 2 === 0 ? first : second
      await attempt(`switch-sessions/return-${index + 1}`, page, () => measure(input, chain, { scenario: "switch-sessions", step: `return-${index + 1}`, cache: "warm", reference: "input", ...sessionMarks(destination.id), ...railPress(page, destination.id) }))
    }
    await runLongSteps(input, chain, attempt)
    await runStreamStep(input, chain, attempt, streamIndex)
    await attempt("lazy-pages/marketplace", page, () => measure(input, chain, { scenario: "lazy-pages", step: "marketplace", cache: "warm", reference: "input", required: ["marketplace"], settle: undefined, act: () => pressByRole(page, () => page.getByRole("button", { name: /Marketplace/ }).first()) }))
    await attempt("lazy-pages/settings", page, async () => {
      await pressByRole(page, () => page.getByTestId("rail-account-trigger"))
      return measure(input, chain, { scenario: "lazy-pages", step: "settings", cache: "warm", reference: "input", required: ["settings"], settle: undefined, act: () => pressByRole(page, () => page.getByRole("menuitem", { name: "Settings", exact: true })) })
    })
  } finally {
    await chain.context.close()
  }

  const signedOut = await coldStep("signed-out-login", `${target.url}/`, false, { required: ["login"] })
  await signedOut.context.close()
  return { results, failures }
}
