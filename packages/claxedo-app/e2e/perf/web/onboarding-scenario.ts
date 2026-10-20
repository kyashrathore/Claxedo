import type { Page } from "@playwright/test"
import { measure, openSession, pressByRole, type RunInput, type StepResult } from "./steps"

type Attempt = (name: string, page: Page | undefined, run: () => Promise<StepResult>) => Promise<void>

const SCENARIO = "onboarding"

function button(page: Page, name: string) {
  return () => page.getByRole("button", { name, exact: true })
}

async function pasteRepositoryUrl(page: Page, url: string) {
  const paste = page.getByRole("button", { name: "Paste URL", exact: true })
  if ((await paste.count()) > 0) await paste.click()
  await page.getByRole("textbox", { name: "Repository URL" }).fill(url)
}

export async function runOnboardingSteps(input: RunInput, attempt: Attempt) {
  const { target } = input
  if (!target.newcomer) return
  const newcomer = await target.newcomer(`${input.profile.name}-${input.rep}`)
  const session = await openSession(input, newcomer.cookies)
  const { page } = session
  const step = (name: string, required: string, press: () => ReturnType<Page["locator"]>) =>
    attempt(`${SCENARIO}/${name}`, page, () => measure(input, session, { scenario: SCENARIO, step: name, cache: "warm", reference: "input", required: [required], settle: undefined, act: () => pressByRole(page, press) }))
  try {
    await attempt(`${SCENARIO}/boot`, page, () => measure(input, session, { scenario: SCENARIO, step: "boot", cache: "cold", reference: "navigation", required: ["onboarding:execution"], settle: undefined, act: () => page.goto(`${target.url}/`, { waitUntil: "commit" }).then(() => undefined) }))
    await step("next-to-project", "onboarding:project", button(page, "Next"))
    await pasteRepositoryUrl(page, newcomer.repositoryUrl)
    await step("continue-to-ai", "onboarding:ai", button(page, "Continue"))
    await step("create-to-draft", "draft", button(page, "Create workspace"))
  } finally {
    await session.context.close()
  }
}
