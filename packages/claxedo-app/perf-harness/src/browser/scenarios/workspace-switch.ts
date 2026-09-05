import type { FlowResult } from "../../flows"
import { measureInteraction } from "../../frame-sampler"
import { launchTo, recordVisualFailure, settleForVideo } from "../actions/common"
import { waitForTranscript, showSessionInventory, measureInPageSessionFirstFoldSwitch } from "../actions/session"
import { measureWorkspaceFiles } from "../actions/workspace"
import type { BrowserTarget } from "../environment"
import type { fixtureFor } from "../fixtures"
import { sessionPath } from "../state"
import type { Page } from "playwright-core"

export async function workspaceSwitch(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  await launchTo(page, app, sessionPath(fixture.sessions[0]!, fixture.sessions[0]!.id))
  await waitForTranscript(page, fixture, fixture.sessions[0]!.id, fixture.sessions[0]!.title)
  const target = fixture.sessions.find((session) => session.directory !== fixture.sessions[0]!.directory) ?? fixture.sessions[1]!
  await showSessionInventory(page, fixture, Math.min(5, fixture.sessions.length), { settle: "frame" })
  // Headline: selecting a session whose route is owned by another workspace.
  const headline = await measureInteraction(page, "workspace-switch", async () => {
    const elapsed = await measureInPageSessionFirstFoldSwitch(page, target)
    if (elapsed >= 10_000) recordVisualFailure(fixture, "workspace target session did not render its first fold")
  })
  await waitForTranscript(page, fixture, target.id, target.title)
  const files = await measureWorkspaceFiles(page, fixture, { settle: "frame" })
  await settleForVideo(page)
  return { headline, debug: files }
}
