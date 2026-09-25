import type { Page } from "@playwright/test"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, UI, type ClaxedoApi, type Stack } from "../harness"

type Target = { readonly directory: string; readonly sessionId: string }

const OTHER_TITLE = "Corpus other session"
const OTHER_REPLY = "The other session answered."

async function openFromRail(app: Page, title: string) {
  const openRail = app.getByRole("button", { name: UI.openRail })
  if (await openRail.isVisible()) await openRail.click()
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: title }).first().click()
}

export async function switchSessions(
  input: { stack: Stack; api: ClaxedoApi; target: Target; app: Page },
  session: { title: string; ready: string; times: number },
) {
  const sessions = await input.api.sessions(input.target.directory)
  if (!sessions.some((row) => row.title === OTHER_TITLE)) {
    await input.stack.acp.write("corpus-other", { steps: [{ kind: "text", text: OTHER_REPLY }] })
    const other = await input.api.createSession(input.target.directory, { title: OTHER_TITLE, harness: SCRIPTED_ACP_HARNESS })
    await input.api.prompt(input.target.directory, other.id, `Answer. ${acpScriptToken("corpus-other")}`)
  }
  for (let round = 0; round < session.times / 2; round += 1) {
    await openFromRail(input.app, OTHER_TITLE)
    await expect(input.app.getByText(OTHER_REPLY).first()).toBeVisible()
    await openFromRail(input.app, session.title)
    await expect(input.app.getByText(session.ready).first()).toBeVisible()
  }
}
