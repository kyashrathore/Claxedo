import { expect, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"

/** Prove native failure, persisted error, and a subsequent successful side effect. */
export async function expectToolErrorRecovery(input: {
  page: Page
  directory: string
  backend: string
  sessionID?: () => string
  run: (command: string, marker: string) => Promise<void>
}) {
  const { page, directory, backend, run } = input
  const failure = `EXPECTED_TOOL_FAILURE_${Date.now()}`
  const output = path.join(directory, "recovered.txt")
  const failedScript = path.join(directory, "fail.cjs")
  const successScript = path.join(directory, "recover.cjs")
  await fs.writeFile(failedScript, `console.error(${JSON.stringify(failure)}); process.exit(23);`)
  await fs.writeFile(successScript, `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'recovered'); console.log('RECOVERY_TOOL_OK');`)
  await run(`node '${failedScript}'`, `FAILURE_OBSERVED_${Date.now()}`)
  const sessionUrl = page.url()
  const sessionID = input.sessionID ? input.sessionID() : new URL(sessionUrl).pathname.split("/").at(-1)!
  const readTools = async () => {
    const response = await page.request.get(`${backend}/session/${sessionID}/message?directory=${encodeURIComponent(directory)}`)
    expect(response.ok()).toBe(true)
    const messages = await response.json() as Array<{ parts: Array<{ type: string; id: string; state?: { status: string; error?: string; output?: string } }> }>
    return messages.flatMap((message) => message.parts).filter((part) => part.type === "tool")
  }
  const failed = (await readTools()).filter((part) => part.state?.error?.includes(failure))
  expect(failed, "native nonzero exit must be recorded as a failed tool").toHaveLength(1)
  expect(failed[0]!.state?.status).toBe("error")
  const errorCard = page.locator(`[data-timeline-part-id="${failed[0]!.id}"] [data-kind="tool-error-card"]`)
  await expect(errorCard).toBeVisible()
  if (await errorCard.getAttribute("data-open") !== "true") await errorCard.locator('[data-component="tool-trigger"]').click()
  await expect(errorCard.locator('[data-slot="tool-error-card-content"]')).toContainText(failure)
  await page.reload({ waitUntil: "domcontentloaded" })
  expect((await readTools()).find((part) => part.id === failed[0]!.id)).toEqual(failed[0])
  await expect(errorCard).toBeVisible()
  await run(`node '${successScript}'`, `RECOVERY_OBSERVED_${Date.now()}`)
  expect(await fs.readFile(output, "utf8")).toBe("recovered")
  await expect(page).toHaveURL(sessionUrl)
  const successful = (await readTools()).filter((part) => part.state?.status === "completed" && part.state.output?.includes("RECOVERY_TOOL_OK"))
  expect(successful).toHaveLength(1)
  await page.reload({ waitUntil: "domcontentloaded" })
  const persisted = await readTools()
  expect(persisted.find((part) => part.id === failed[0]!.id)).toEqual(failed[0])
  expect(persisted.find((part) => part.id === successful[0]!.id)).toEqual(successful[0])
  return { sessionID, failed: failed[0]!, successful: successful[0]! }
}
