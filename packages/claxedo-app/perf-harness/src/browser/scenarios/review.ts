import { measurement } from "../../isolated-interaction"
import type { FlowResult } from "../../flows"
import { measureInteraction } from "../../frame-sampler"
import { launchTo } from "../actions/common"
import {
  measureWorkspacePanelOpen,
  measureReviewChangedFileReady,
  waitForReviewChangedFiles,
  openFirstReviewDiff,
  waitForReviewStable,
  toggleDiffStyle,
} from "../actions/review"
import { waitForTranscript } from "../actions/session"
import type { BrowserTarget } from "../environment"
import type { fixtureFor } from "../fixtures"
import { sessionPath } from "../state"
import type { Page } from "playwright-core"

export async function largeDiffToggle(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  await launchTo(page, app, sessionPath(fixture.sessions[0], fixture.sessions[0].id))
  await waitForTranscript(page, fixture, fixture.sessions[0].id, fixture.sessions[0].title)
  const reviewPanelOpenMs = await measureWorkspacePanelOpen(page, fixture)
  const vcsLoadMs = await measureReviewChangedFileReady(page, fixture)
  await waitForReviewChangedFiles(page, fixture, { timeout: 2_000 })
  const firstHunkReadyMs = await openFirstReviewDiff(page)
  await waitForReviewStable(page)
  // Headline: toggling split/unified with a 500-file model. The review mounts
  // its first progressive header batch and the opened diff body before timing.
  // Readiness waits are semantic and do not scan every diff line or force layout.
  const headline = await measureInteraction(page, "large-diff-toggle", async () => {
    await toggleDiffStyle(page, { settle: "frame" })
    await toggleDiffStyle(page, { settle: "frame" })
  })
  return {
    headline,
    debug: [
      measurement("review_panel_open_ms", reviewPanelOpenMs),
      measurement("vcs_load_ms", vcsLoadMs),
      measurement("first_hunk_ready_ms", firstHunkReadyMs),
    ],
  }
}
