/**
 * Canonical WorkGraph browser contract.
 *
 * Every test owns a fresh file-backed SQLite database and the real embedded
 * WorkGraph HTTP router. Playwright never intercepts a route, and fixture setup
 * uses only public commands plus the same source-planning and Recap background
 * runtimes used by the product.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { AxeBuilder } from "@axe-core/playwright"
import type {
  AdmissionProposalDto,
  CommandResult,
  DecisionDto,
  WorkGraphCommandRequest,
} from "@claxedo/workgraph/contracts"
import fs from "node:fs"
import path from "node:path"
import { createRealWorkGraphHarness, type RealWorkGraphHarness } from "../helpers/real-workgraph-harness"

const apiPort = Number(process.env.CLAXEDO_WORKGRAPH_E2E_API_PORT ?? 4311)
const repositoryDirectory = path.resolve(import.meta.dirname, "../../../..")
let harness: RealWorkGraphHarness

test.describe.serial("@core @workgraph-real personal WorkGraph real local journey", () => {
  test.beforeEach(async ({}, testInfo) => {
    const realSessions = testInfo.title.includes("real Session V2")
    // This one journey boots a separate production OpenCode process and native
    // SQLite runtime. Give that test-infrastructure cold start its own budget;
    // user-visible WorkGraph and Session readiness retain their strict assertions.
    if (realSessions) testInfo.setTimeout(testInfo.title.includes("GitHub, Linear, and Jira") ? 240_000 : 120_000)
    harness = await createRealWorkGraphHarness({
      port: apiPort,
      realSessions,
    })
  })

  test.afterEach(async ({ page }) => {
    // Closing the page aborts WorkGraph's in-flight bounded /changes long-poll.
    // The embedded HTTP server can then shut down without waiting for another
    // poll window; this exercises the production unmount/navigation cleanup.
    await test.step("close the WorkGraph page", () => page.close())
    await test.step("close the real WorkGraph harness", () => harness.close())
  })

  test("uses one WorkspacePanel and supports manual streams, tasks, and tabless settings", async ({
    page,
    request,
  }) => {
    await configureGeneration(request)
    await page.goto("/workgraph")
    await expect(page.getByRole("main", { name: "WorkGraph" })).toBeVisible()
    await expectNoSeriousAxeViolations(page, 'main[aria-label="WorkGraph"]')

    await page.getByRole("button", { name: "Needs you", exact: true }).click()
    const panel = page.getByRole("complementary", { name: "Workspace panel" })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole("tab", { name: "Needs you" })).toHaveAttribute("aria-selected", "true")
    await expect(panel.getByRole("tab", { name: "Settings" })).toBeVisible()
    await expect(panel.getByText("Nothing needs you right now", { exact: true })).toBeVisible()
    await expect(page.getByRole("dialog", { name: "Waiting on you" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Close workspace panel" })).toHaveCount(1)
    await panel.getByRole("button", { name: "Close workspace panel" }).click()

    await page.getByRole("button", { name: "New stream" }).click()
    const create = page.getByRole("dialog", { name: "New stream" })
    await create.getByRole("textbox", { name: "What are you trying to ship?" }).fill("Ship the browser contract")
    await create.getByRole("textbox", { name: "Description" }).fill("Keep the WorkGraph state visible and organized.")
    await create.getByLabel("Project directory").selectOption(repositoryDirectory)
    await create.getByLabel("Base revision").fill("HEAD")
    await create.getByRole("button", { name: "Create" }).click()
    await expect(create).toBeHidden()

    await expect(page.getByRole("button", { name: "Collapse Ship the browser contract" })).toBeVisible()
    await page.getByRole("button", { name: "Add task" }).click()
    const taskTitle = page.getByRole("textbox", { name: "Add task to Ship the browser contract" })
    await taskTitle.fill("Verify the real SQLite journey")
    await taskTitle.press("Enter")
    await expect(page.getByText("Verify the real SQLite journey", { exact: true })).toBeVisible()

    await page.getByRole("button", { name: "WorkGraph settings" }).click()
    await expect(panel).toBeVisible()
    await expect(panel.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true")
    await expect(panel.getByRole("heading", { name: "WorkGraph settings" })).toBeVisible()
    await expectNoSeriousAxeViolations(page, 'aside[aria-label="Workspace panel"]')
    await expect(panel.getByRole("tablist", { name: "WorkGraph panel" })).toHaveCount(1)
    await panel.getByLabel("Harness").selectOption("opencode")
    await panel.getByLabel("Agent").selectOption("build")
    await panel.getByLabel("Provider", { exact: true }).selectOption("openai")
    await panel.getByLabel("Model", { exact: true }).selectOption("openai/gpt-5")
    await panel.getByLabel("Effort", { exact: true }).selectOption("high")
    await panel.getByRole("button", { name: "Save" }).click()
    await expect
      .poll(async () => (await readJson<DefaultsResponse>(request, "/api/workgraph/defaults")).defaults.execution)
      .toMatchObject({
        harness: "opencode",
        agent: "build",
        model: { providerId: "openai", modelId: "gpt-5" },
        effort: "high",
      })
    await panel.getByRole("button", { name: "Close workspace panel" }).click()

    await page.getByRole("button", { name: "Stream settings for Ship the browser contract" }).click()
    const streamSettings = panel
    await expect(streamSettings.getByRole("heading", { name: "Stream settings" })).toBeVisible()
    await expect(page.getByRole("dialog", { name: "Stream settings" })).toHaveCount(0)
    await expect(streamSettings.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true")
    await streamSettings.getByLabel("Environment").selectOption("local_worktree")
    await streamSettings.getByLabel("Project directory").selectOption(repositoryDirectory)
    await streamSettings.getByLabel("Base revision").fill("HEAD")
    await streamSettings.getByLabel("Harness").selectOption("opencode")
    await streamSettings.getByLabel("Recap model").selectOption("openai/gpt-5")
    await streamSettings.getByLabel("Recap effort").selectOption("high")
    await streamSettings.getByLabel("Quiet hours").fill("6")
    await streamSettings.getByRole("button", { name: "Save" }).click()
    await expect(panel).toBeHidden()

    const streamId = await streamIdByTitle(request, "Ship the browser contract")
    await expect
      .poll(async () => readJson<StreamResponse>(request, `/api/workgraph/streams/${encodeURIComponent(streamId)}`))
      .toMatchObject({
        executionDefaults: {
          environment: { kind: "local_worktree", directory: repositoryDirectory },
          repository: { baseRevision: "HEAD" },
        },
        recapDefaults: {
          model: { providerId: "openai", modelId: "gpt-5" },
          effort: "high",
          quietHours: 6,
        },
      })
    harness.assertHealthy()
  })

  test("reviews and confirms a real background-planned source proposal in Needs you", async ({ page, request }) => {
    await configureGeneration(request)
    const source = await command(request, {
      version: 1,
      type: "create_work_source",
      title: "Launch brief",
      content: "Ship Claxedo Cloud and verify launch readiness.",
    })
    const revision = await readJson<SourceRevisionResponse>(
      request,
      `/api/workgraph/sources/${encodeURIComponent(String(source.value.workSourceId))}/revisions/${encodeURIComponent(String(source.value.revisionId))}`,
    )
    const proposed = await command(request, {
      version: 1,
      type: "propose_admission",
      source: {
        workSourceId: String(source.value.workSourceId) as never,
        revisionId: String(source.value.revisionId) as never,
        contentHash: revision.contentHash as never,
      },
    })
    const planning = await harness.runSourcePlanning()
    expect(
      planning,
      JSON.stringify({ ...planning, ...("error" in planning ? { error: String(planning.error) } : {}) }),
    ).toMatchObject({ state: "completed" })

    await page.goto("/workgraph")
    const card = page.getByRole("complementary", { name: "Waiting on you" })
    await expect(card).toBeVisible()
    await card.getByRole("button", { name: /Review proposed work/ }).click()
    const panel = page.getByRole("complementary", { name: "Workspace panel" })
    await expect(panel.getByRole("tab", { name: "Needs you" })).toHaveAttribute("aria-selected", "true")
    const proposal = panel.getByRole("button", { name: /Review proposed work/ })
    await expectNoSeriousAxeViolations(page, 'aside[aria-label="Workspace panel"]')
    await proposal.click()
    const dialog = page.getByRole("dialog", { name: "Review proposed work" })
    await expect(dialog).toBeVisible()
    await expectNoSeriousAxeViolations(page, '[role="dialog"]')
    await expect(dialog.getByText("New stream · Planned from AI context", { exact: true })).toBeVisible()
    await expect(dialog.getByRole("heading", { name: "Outcomes (1)" })).toBeVisible()
    await expect(dialog.getByRole("heading", { name: "Tasks (1)" })).toBeVisible()
    await dialog.getByRole("button", { name: "Confirm" }).click()
    await expect(dialog).toBeHidden()
    await expect(proposal).toBeHidden()
    await expect
      .poll(async () =>
        readJson<ProposalResponse>(
          request,
          `/api/workgraph/proposals/${encodeURIComponent(String(proposed.value.proposalId))}`,
        ),
      )
      .toMatchObject({ state: "confirmed" })
    // Confirmation is durable before the overview projection refreshes. A real
    // navigation reload proves the confirmed plan is materialized from SQLite;
    // no route interception or client-side substitute is involved.
    await page.reload()
    await expect(page.getByRole("button", { name: /^(?:Expand|Collapse) Planned from AI context$/ })).toBeVisible()
    harness.assertHealthy()
  })

  test("keeps exact source-revision provenance through the review dialog and records its disposition", async ({
    page,
    request,
  }) => {
    await configureGeneration(request)
    const created = await command(request, {
      version: 1,
      type: "create_work_source",
      title: "Cloud launch plan",
      content: "Ship the initial cloud launch checklist.",
    })
    const firstRef = await sourceRevisionReference(
      request,
      String(created.value.workSourceId),
      String(created.value.revisionId),
    )
    const firstAdmission = await command(request, { version: 1, type: "propose_admission", source: firstRef as never })
    expect(await harness.runSourcePlanning()).toMatchObject({ state: "completed" })
    const firstProposal = await readJson<ReviewableProposalResponse>(
      request,
      `/api/workgraph/proposals/${encodeURIComponent(String(firstAdmission.value.proposalId))}`,
    )
    const firstConfirmation = await command(
      request,
      confirmProposalCommand(firstProposal, { mode: "create", streamTitle: "Cloud launch" }),
    )
    const streamId = String(firstConfirmation.value.streamId)

    const revised = await command(request, {
      version: 1,
      type: "revise_work_source",
      workSourceId: String(created.value.workSourceId) as never,
      expectedRevisionId: String(created.value.revisionId) as never,
      content: "Ship the cloud launch checklist and preserve the existing Stream while adding readiness work.",
    })
    const secondRef = await sourceRevisionReference(
      request,
      String(created.value.workSourceId),
      String(revised.value.revisionId),
    )
    const secondAdmission = await command(request, {
      version: 1,
      type: "propose_admission",
      source: secondRef as never,
      targetStreamId: streamId as never,
    })
    expect(await harness.runSourcePlanning()).toMatchObject({ state: "completed" })
    const secondProposal = await readJson<ReviewableProposalResponse>(
      request,
      `/api/workgraph/proposals/${encodeURIComponent(String(secondAdmission.value.proposalId))}`,
    )
    expect(secondProposal.source).toEqual(secondRef)
    expect(secondProposal.previousSource).toEqual(firstRef)
    expect(secondProposal.diffSummary).toEqual(expect.any(String))

    await page.goto("/workgraph")
    const panel = await openWaitingItemPanel(page, /Review proposed work/)
    await panel.getByRole("button", { name: /Review proposed work/ }).click()
    const dialog = page.getByRole("dialog", { name: "Review proposed work" })
    await expect(dialog.getByText(firstRef.revisionId, { exact: true })).toBeVisible()
    await expect(dialog.getByText(secondRef.revisionId, { exact: true })).toBeVisible()
    await expect(dialog.getByText(String(secondProposal.diffSummary), { exact: true })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Keep" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Replace" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Fork" })).toBeVisible()
    await dialog.getByRole("button", { name: "Keep" }).click()
    await expect(dialog).toBeHidden()

    const stream = await readJson<StreamWithSourcesResponse>(
      request,
      `/api/workgraph/streams/${encodeURIComponent(streamId)}`,
    )
    expect(stream.sourceRevisionRefs).toEqual(expect.arrayContaining([firstRef, secondRef]))
    await expect
      .poll(async () =>
        readJson<ProposalResponse>(
          request,
          `/api/workgraph/proposals/${encodeURIComponent(String(secondAdmission.value.proposalId))}`,
        ),
      )
      .toMatchObject({ state: "confirmed" })
    const archive = await readJson<ArchiveResponse>(request, "/api/workgraph/archive")
    const archived = archive.records.find(
      (record) => record.kind === "admission_proposal" && record.id === String(secondAdmission.value.proposalId),
    )
    expect(archived?.value).toMatchObject({
      state: "confirmed",
      source: secondRef,
      previousSource: firstRef,
      disposition: { selection: { mode: "keep", streamId }, streamId },
    })
    harness.assertHealthy()
  })

  test("executes GitHub, Linear, and Jira issues through real Session V2 Connections end to end", async ({
    page,
    request,
  }) => {
    await configureRealGeneration(request)
    const connection = harness.connectionEvidence()
    const issues = [
      {
        integration: "github",
        provider: "github" as const,
        identity: "octocat",
        filterLabel: /Repository/,
        filterValue: "claxedo/claxedo",
        externalId: "101",
        externalKey: "#101",
        title: "Connection-filtered launch issue",
      },
      {
        integration: "linear",
        provider: "linear" as const,
        identity: "linear-user",
        filterLabel: /Team/,
        filterValue: "ENG",
        externalId: "linear-101",
        externalKey: "LIN-101",
        title: "Linear launch issue",
      },
      {
        integration: "atlassian",
        provider: "jira" as const,
        identity: "jira-user",
        filterLabel: /JQL/,
        filterValue: "project = CLX AND status != Done",
        externalId: "jira-101",
        externalKey: "CLX-101",
        title: "Jira launch issue",
      },
    ]

    await page.goto("/workgraph")
    const settings = await openConnectionsSettings(page)
    for (const issue of issues) {
      const integration = settings.locator(`[data-integration="${issue.integration}"]`)
      await integration.getByRole("button", { name: "Add issue source" }).click()
      const form = settings.locator('[data-component="source-view-form"]')
      await form.getByLabel(/Your provider identity/).fill(issue.identity)
      await form.getByLabel(issue.filterLabel).fill(issue.filterValue)
      await form.getByLabel(/Project/).selectOption(repositoryDirectory)
      await form.getByLabel(/Base revision/).fill("HEAD")
      await form.getByLabel(/Result sync/).selectOption("announce")
      await form.getByRole("button", { name: "Save source" }).click()
      await expect(form).toHaveCount(0)
      await integration.getByRole("button", { name: "Refresh" }).click()
      await expect(integration.getByText(/1 new · 0 updated/)).toBeVisible()
    }

    const sourceViews = (await readJson<SourceViewsResponse>(request, "/api/workgraph/source-views")).sourceViews
    expect(sourceViews).toHaveLength(3)
    for (const issue of issues) {
      const sourceView = sourceViews.find((view) => view.provider === issue.provider)
      if (!sourceView) throw new Error(`${issue.provider} Source View did not persist through Settings`)
      expect(sourceView.teamConnectionId).toBe(connection.connectionIds[issue.provider])
    }
    await expect
      .poll(() => harness.connectionEvidence().requests)
      .toEqual([
        {
          provider: "github",
          providerUserId: "octocat",
          filters: { repo: "claxedo/claxedo", state: "open" },
          authorized: true,
        },
        {
          provider: "linear",
          providerUserId: "linear-user",
          filters: { team: "ENG" },
          authorized: true,
        },
        {
          provider: "jira",
          providerUserId: "jira-user",
          filters: { jql: "project = CLX AND status != Done" },
          authorized: true,
        },
      ])

    await page.keyboard.press("Escape")
    await expect(settings).toBeHidden()
    const discoveredCandidates = (await readJson<CandidatePageResponse>(request, "/api/workgraph/intake?limit=50")).candidates
      .filter((candidate) => candidate.candidateKind === "external_issue")
    expect(discoveredCandidates).toHaveLength(3)
    const panel = await openWaitingItemPanel(page, /Unorganized AI work/)
    await panel.getByRole("button", { name: /Unorganized AI work/ }).click()
    const dialog = page.getByRole("dialog", { name: "Unorganized AI work" })
    for (const issue of issues) {
      const row = dialog.locator(".workgraph-detail-candidate").filter({ hasText: `${issue.externalKey} · ${issue.title}` })
      await expect(row.getByText(`${issue.provider} · open · unorganized`, { exact: true })).toBeVisible()
      await row.getByRole("button", { name: "Add to WorkGraph" }).click()
      const candidateId = discoveredCandidates.find((candidate) => candidate.externalId === issue.externalId)?.id
      if (!candidateId) throw new Error(`${issue.provider} refresh did not persist its external issue candidate`)
      await expect.poll(async () =>
        (await readJson<CandidateResponse>(request, `/api/workgraph/intake/${encodeURIComponent(candidateId)}`)).state,
      ).toBe("staged")
    }

    const staged = await Promise.all(discoveredCandidates.map((candidate) =>
      readJson<CandidateResponse>(request, `/api/workgraph/intake/${encodeURIComponent(candidate.id)}`)))
    expect(staged).toHaveLength(3)
    expect(staged.every((candidate) => candidate.state === "staged" && candidate.admissionProposalId)).toBe(true)
    for (let index = 0; index < issues.length; index++) {
      expect(await harness.runSourcePlanning()).toMatchObject({ state: "completed" })
    }

    await page.keyboard.press("Escape")
    await page.reload()
    const proposalsPanel = page.locator('aside[aria-label="Workspace panel"]:visible')
    await expect(proposalsPanel).toBeVisible()
    await expect(proposalsPanel.getByRole("tab", { name: "Needs you" })).toHaveAttribute("aria-selected", "true")
    for (let index = 0; index < issues.length; index++) {
      await proposalsPanel.getByRole("button", { name: /Review proposed work/ }).first().click()
      const proposal = page.getByRole("dialog", { name: "Review proposed work" })
      await expect(proposal.getByText(/New stream/)).toBeVisible()
      await proposal.getByRole("button", { name: "Confirm" }).click()
      await expect(proposal).toBeHidden()
    }

    await page.reload()
    for (const issue of issues) {
      const streamTitle = `${issue.externalKey} · ${issue.title}`
      const taskTitle = `Resolve ${issue.externalKey}`
      await expect(page.getByRole("button", { name: new RegExp(`^(?:Expand|Collapse) ${escapeRegex(streamTitle)}$`) })).toBeVisible()
      await page.getByRole("button", { name: `Execute stream ${streamTitle}` }).click()
      await page.getByRole("menu", { name: `Execute stream ${streamTitle}` })
        .getByRole("menuitem", { name: "Autonomous" })
        .click()
      const workItemId = await workItemIdByTitle(request, taskTitle)
      await expect.poll(async () => {
        await harness.runReconcile()
        return (await readJson<WorkItemResponse>(request, `/api/workgraph/work-items/${encodeURIComponent(workItemId)}`)).state
      }, { timeout: 30_000 }).toBe("completed").catch(async (error) => {
        throw new Error(`${String(error)}\nReal Session diagnostics: ${JSON.stringify(harness.realSessionDiagnostics())}`)
      })

      const session = harness.realSessionEvidence().find((record) => record.title === taskTitle)
      if (!session) throw new Error(`${issue.provider} execution did not create its real project Session`)
      await page.reload()
      const streamToggle = page.getByRole("button", {
        name: new RegExp(`^(?:Expand|Collapse) ${escapeRegex(streamTitle)}$`),
      })
      await expect(streamToggle).toBeVisible()
      if (await streamToggle.getAttribute("aria-expanded") !== "true") await streamToggle.click()
      await page.getByRole("button", { name: `Open session for ${taskTitle}` }).click()
      await expect(page).toHaveURL(`/s/${session.sessionId}`)
      await expect(page.locator("[data-session-title]").getByText(taskTitle, { exact: true }))
        .toBeVisible({ timeout: 30_000 })
      await expect(page.getByText("Completed the WorkGraph Task in the real project Session.", { exact: true })).toBeVisible()
      await expect.poll(() => harness.connectionEvidence().effects.filter((effect) =>
        effect.provider === issue.provider && effect.externalId === issue.externalId,
      )).toEqual([{
        provider: issue.provider,
        action: "comment",
        externalId: issue.externalId,
        body: `Claxedo completed the requested work for ${issue.externalId} in a project-scoped autonomous Session.`,
        idempotencyKey: `workgraph-e2e:${issue.externalId}:result`,
        authorized: true,
      }]).catch((error) => {
        throw new Error(`${String(error)}\nReal Session diagnostics: ${JSON.stringify(harness.realSessionDiagnostics())}`)
      })
      await expect(page.getByText("Thread not found", { exact: false })).toHaveCount(0)
      await expect(page.getByText("Session unavailable", { exact: false })).toHaveCount(0)
      await page.goto("/workgraph")
    }

    await expect.poll(() => harness.connectionEvidence().effects).toEqual(issues.map((issue) => ({
      provider: issue.provider,
      action: "comment",
      externalId: issue.externalId,
      body: `Claxedo completed the requested work for ${issue.externalId} in a project-scoped autonomous Session.`,
      idempotencyKey: `workgraph-e2e:${issue.externalId}:result`,
      authorized: true,
    })))
    const confirmed = await Promise.all(discoveredCandidates.map((candidate) =>
      readJson<CandidateResponse>(request, `/api/workgraph/intake/${encodeURIComponent(candidate.id)}`)))
    expect(confirmed.every((candidate) => candidate.state === "confirmed")).toBe(true)

    await page.reload()
    for (const issue of issues) {
      const streamTitle = `${issue.externalKey} · ${issue.title}`
      const streamId = await streamIdByTitle(request, streamTitle)
      const detail = await readJson<StreamResponse>(request, `/api/workgraph/streams/${encodeURIComponent(streamId)}`)
      expect(detail.durableEffectCount).toBe(1)
      const closeTrigger = page.getByRole("button", { name: `Close stream ${streamTitle}` })
      await closeTrigger.click()
      const closePopoverId = await closeTrigger.getAttribute("aria-controls")
      if (!closePopoverId) throw new Error(`${streamTitle} close action did not open its confirmation`)
      await page.locator(`#${closePopoverId}`).getByRole("button", { name: "Close stream", exact: true }).click()
      await expect.poll(async () =>
        (await readJson<StreamDetailResponse>(request, `/api/workgraph/streams/${encodeURIComponent(streamId)}`)).lifecycleState,
      ).toBe("closed")
    }
    harness.assertHealthy()
  })

  test("organizes and dismisses meaningful independent AI Sessions through Needs you", async ({ page, request }) => {
    await configureGeneration(request)
    expect(
      await harness.projectIndependentSession({
        sessionId: "session_launch_brainstorm",
        title: "Launch architecture brainstorm",
        summary: "The cloud launch needs a deployment-readiness checklist.",
      }),
    ).toBe("created")
    const sessionCandidateId = (
      await readJson<CandidatePageResponse>(request, "/api/workgraph/intake?limit=50")
    ).candidates.find(
      (candidate) => candidate.candidateKind === "session" && candidate.sessionId === "session_launch_brainstorm",
    )?.id
    expect(sessionCandidateId).toBeTruthy()

    await page.goto("/workgraph")
    const panel = await openWaitingItemPanel(page, /Unorganized AI work/)
    await panel.getByRole("button", { name: /Unorganized AI work/ }).click()
    const candidates = page.getByRole("dialog", { name: "Unorganized AI work" })
    await expect(candidates.getByText("Launch architecture brainstorm", { exact: true })).toBeVisible()
    await candidates.getByRole("button", { name: "Add to WorkGraph" }).click()
    const staged = await readJson<CandidateResponse>(
      request,
      `/api/workgraph/intake/${encodeURIComponent(String(sessionCandidateId))}`,
    )
    expect(staged).toMatchObject({ state: "staged", admissionProposalId: expect.any(String) })

    expect(await harness.runSourcePlanning()).toMatchObject({ state: "completed" })
    await page.reload()
    await openWaitingItemPanel(page, /Review proposed work/)
    await panel.getByRole("button", { name: /Review proposed work/ }).click()
    const proposal = page.getByRole("dialog", { name: "Review proposed work" })
    await proposal.getByRole("button", { name: "Confirm" }).click()
    await page.reload()
    await expect(page.getByRole("button", { name: /^(?:Expand|Collapse) Planned from AI context$/ })).toBeVisible()

    expect(
      await harness.projectIndependentSession({
        sessionId: "session_discarded_note",
        title: "Discarded AI note",
        summary: "This exploration is not part of current work.",
      }),
    ).toBe("created")
    const dismissedCandidateId = (
      await readJson<CandidatePageResponse>(request, "/api/workgraph/intake?limit=50")
    ).candidates.find(
      (candidate) => candidate.candidateKind === "session" && candidate.sessionId === "session_discarded_note",
    )?.id
    expect(dismissedCandidateId).toBeTruthy()
    await page.reload()
    await openWaitingItemPanel(page, /Unorganized AI work/)
    await panel.getByRole("button", { name: /Unorganized AI work/ }).click()
    await expect(candidates.getByText("Discarded AI note", { exact: true })).toBeVisible()
    await candidates.getByRole("button", { name: "Dismiss" }).click()
    const dismissed = await readJson<CandidateResponse>(
      request,
      `/api/workgraph/intake/${encodeURIComponent(String(dismissedCandidateId))}`,
    )
    expect(dismissed).toMatchObject({ state: "dismissed" })
    harness.assertHealthy()
  })

  test("persists Attention mark-read and clear acknowledgements across reloads", async ({ page }) => {
    expect(
      await harness.projectIndependentSession({
        sessionId: "session_attention_acknowledgement",
        title: "Review the durable Attention acknowledgement",
        summary: "This meaningful Session should remain visible until the owner clears Attention.",
      }),
    ).toBe("created")

    await page.goto("/workgraph")
    let panel = await openWaitingItemPanel(page, /Unorganized AI work/)
    await expect(panel.getByLabel(/unread/)).toBeVisible()
    await panel.getByRole("button", { name: "Mark all read" }).click()
    await expect(panel.getByRole("button", { name: "Mark all read" })).toBeDisabled()
    await expect(panel.getByLabel(/unread/)).toHaveCount(0)

    await page.reload()
    panel = await openNeedsYouPanel(page)
    await expect(panel.getByRole("button", { name: "Mark all read" })).toBeDisabled()
    await expect(panel.getByRole("button", { name: /Unorganized AI work/ })).toBeVisible()
    await panel.getByRole("button", { name: "Clear" }).click()
    await expect(panel.getByText("Nothing needs you right now", { exact: true })).toBeVisible()

    await page.reload()
    panel = await openNeedsYouPanel(page)
    await expect(panel.getByText("Nothing needs you right now", { exact: true })).toBeVisible()
    await expect(page.getByRole("complementary", { name: "Waiting on you" })).toHaveCount(0)
    harness.assertHealthy()
  })

  test("publishes an agent-session Recap and lazy-loads its Stream row preview on hover and focus", async ({
    page,
    request,
  }) => {
    await configureGeneration(request)
    await page.goto("/workgraph")
    await page.getByRole("button", { name: "New stream" }).click()
    const create = page.getByRole("dialog", { name: "New stream" })
    await create.getByRole("textbox", { name: "What are you trying to ship?" }).fill("Recap the launch")
    await create.getByLabel("Project directory").selectOption(repositoryDirectory)
    await create.getByLabel("Base revision").fill("HEAD")
    await create.getByRole("button", { name: "Create" }).click()
    const streamId = await streamIdByTitle(request, "Recap the launch")

    await page.getByRole("button", { name: "Stream settings for Recap the launch" }).click()
    const streamSettings = page.getByRole("complementary", { name: "Workspace panel" })
    await expect(streamSettings.getByRole("heading", { name: "Stream settings" })).toBeVisible()
    await expect(page.getByRole("dialog", { name: "Stream settings" })).toHaveCount(0)
    await streamSettings.getByLabel("Harness").selectOption("opencode")
    await streamSettings.getByLabel("Recap model").selectOption("openai/gpt-5")
    await streamSettings.getByLabel("Recap effort").selectOption("high")
    await streamSettings.getByLabel("Quiet hours").fill("8")
    await streamSettings.getByRole("button", { name: "Save" }).click()
    await expect(streamSettings).toBeHidden()

    harness.advanceTime(9 * 60 * 60 * 1000)
    expect(await harness.scheduleRecaps()).toBe(1)
    const recap = await harness.runRecap()
    if (recap.state !== "completed") throw new Error(`Recap runtime did not complete: ${recap.state}`)
    expect(recap.output.generation).toMatchObject({ method: "agent_session" })
    expect(recap.output.actionableReferences).toEqual([{ type: "stream", id: streamId }])

    const recapRequests: string[] = []
    page.on("request", (request) => {
      if (/\/api\/workgraph\/recaps\//.test(new URL(request.url()).pathname)) recapRequests.push(request.url())
    })
    await page.reload()
    const trigger = page.getByRole("button", { name: "Latest recap for Recap the launch" })
    await expect(trigger).toBeVisible()
    expect(recapRequests).toHaveLength(0)

    await trigger.hover()
    const recapPreview = page.getByRole("group", { name: "Latest recap" })
    await expect(recapPreview.getByText("Stream activity is ready for review.", { exact: true })).toBeVisible()
    await expect.poll(() => recapRequests.length).toBe(1)

    await page.mouse.move(0, 0)
    await page.reload()
    recapRequests.length = 0
    const focusTrigger = page.getByRole("button", { name: "Latest recap for Recap the launch" })
    await expect(focusTrigger).toBeVisible()
    expect(recapRequests).toHaveLength(0)
    await focusTrigger.focus()
    await expect(recapPreview.getByText("Stream activity is ready for review.", { exact: true })).toBeVisible()
    await expect.poll(() => recapRequests.length).toBe(1)
    harness.assertHealthy()
  })

  test("executes and retries a Task in a real worktree, then inspects the true latest result from Attention", async ({
    page,
    request,
  }) => {
    await configureGeneration(request)
    const stream = await command(request, {
      version: 1,
      type: "create_stream",
      title: "Execution inspection",
      execution: streamExecution(),
    })
    const streamId = String(stream.value.streamId)
    const task = await command(request, {
      version: 1,
      type: "create_work_item",
      streamId: streamId as never,
      title: "Execute and inspect the launch",
      completionContract: ownerConfirmation("Inspect the real execution result"),
    })
    const workItemId = String(task.value.workItemId)

    harness.queueExecutionResults({ state: "failed", message: "Controlled first attempt failed" })
    await page.goto("/workgraph")
    await page.getByRole("button", { name: "Execute stream Execution inspection" }).click()
    const executeMenu = page.getByRole("menu", { name: "Execute stream Execution inspection" })
    await expect(executeMenu).toBeVisible()
    await executeMenu.getByRole("menuitem", { name: "Supervised" }).click()
    await expect(executeMenu).toBeHidden()
    await expect
      .poll(async () => {
        await harness.runReconcile()
        return (
          await readJson<WorkItemResponse>(request, `/api/workgraph/work-items/${encodeURIComponent(workItemId)}`)
        ).state
      })
      .toBe("failed")
    expect(fs.existsSync(path.join(harness.worktreeDirectory(streamId), ".git"))).toBe(true)
    await expect
      .poll(async () => {
        const attention = await readJson<AttentionResponse>(request, "/api/workgraph/attention?limit=50")
        return attention.items.map((item) => ({ id: item.id, kind: item.kind, state: item.record?.state }))
      })
      .toContainEqual({ id: workItemId, kind: "work_item", state: "failed" })

    const panel = await openWaitingItemPanel(page, /Execute and inspect the launch/)
    await panel.getByRole("button", { name: /Execute and inspect the launch/ }).click()
    const dialog = page.getByRole("dialog", { name: "Task" })
    await expect(dialog).toBeVisible()
    await expectNoSeriousAxeViolations(page, '[role="dialog"]')
    await expect(dialog.getByText("#1 · failed", { exact: true })).toBeVisible()
    await expect(dialog.getByText("Controlled first attempt failed", { exact: true })).toBeVisible()

    harness.queueExecutionResults({
      state: "succeeded",
      summary: "Retry completed in the retained worktree",
      artifacts: ["commit:retry-e2e"],
    })
    await dialog.getByRole("button", { name: "Run again" }).click()
    await expect
      .poll(async () => {
        const attempts = await readJson<AttemptPageResponse>(
          request,
          `/api/workgraph/work-items/${encodeURIComponent(workItemId)}/attempts?limit=10`,
        )
        return attempts.attempts.at(-1)?.attempt.state
      })
      .toBe("running")
    await expect(harness.runReconcile()).resolves.toContainEqual({
      settled: false,
      awaitingExplicitCompletion: true,
    })
    await expect(
      harness.completeControlledAttempt(
        workItemId,
        "Retry completed in the retained worktree",
        ["commit:retry-e2e"],
      ),
    ).resolves.toMatchObject({ ok: true })
    await expect
      .poll(async () => {
        return (
          await readJson<WorkItemResponse>(request, `/api/workgraph/work-items/${encodeURIComponent(workItemId)}`)
        ).state
      })
      .toBe("result_ready")
      .catch(async (error) => {
        const attempts = await readJson<unknown>(
          request,
          `/api/workgraph/work-items/${encodeURIComponent(workItemId)}/attempts?limit=10`,
        )
        throw new Error(
          `${String(error)}\nAttempts: ${JSON.stringify(attempts)}\nControlled runtime: ${JSON.stringify(harness.controlledExecutionDiagnostics())}`,
        )
      })
    await expect
      .poll(async () => {
        const attention = await readJson<AttentionResponse>(request, "/api/workgraph/attention?limit=50")
        return attention.items.map((item) => ({ id: item.id, kind: item.kind, state: item.record?.state }))
      })
      .toContainEqual({ id: workItemId, kind: "work_item", state: "result_ready" })

    await page.reload()
    await openWaitingItemPanel(page, /Execute and inspect the launch/)
    await panel.getByRole("button", { name: /Execute and inspect the launch/ }).click()
    await expect(dialog.getByText("#2 · result", { exact: true })).toBeVisible()
    await expect(dialog.getByText("Retry completed in the retained worktree", { exact: true })).toBeVisible()
    await expect(dialog.getByText("commit:retry-e2e", { exact: true })).toBeVisible()
    await expect(dialog.getByText("session:", { exact: false })).toBeVisible()
    harness.assertHealthy()
  })

  test("executes through a real Session V2 and renders its project transcript", async ({ page, request }) => {
    const stream = await command(request, {
      version: 1,
      type: "create_stream",
      title: "Real Session execution",
      execution: {
        ...streamTarget(),
        harness: "opencode",
        agent: "build",
        model: { providerId: "workgraph-e2e", modelId: "workgraph-model" },
        effort: "high",
        tools: ["read", "edit"],
        connectionIds: [],
      },
    })
    const streamId = String(stream.value.streamId)
    const task = await command(request, {
      version: 1,
      type: "create_work_item",
      streamId: streamId as never,
      title: "Prove the real Session transcript",
      completionContract: {
        version: 1,
        mode: "all",
        requirements: [{
          id: "real-session-proof",
          kind: "test",
          description: "The project Session completes through its scoped WorkGraph tool",
        }],
      },
    })
    const workItemId = String(task.value.workItemId)

    await page.goto("/workgraph")
    await page.getByRole("button", { name: "Execute stream Real Session execution" }).click()
    await page.getByRole("menu", { name: "Execute stream Real Session execution" })
      .getByRole("menuitem", { name: "Supervised" })
      .click()
    await expect.poll(async () => {
      await harness.runReconcile()
      return (await readJson<WorkItemResponse>(request, `/api/workgraph/work-items/${encodeURIComponent(workItemId)}`)).state
    }, { timeout: 10_000 }).toBe("completed").catch(async (error) => {
      const attempts = await readJson<unknown>(request, `/api/workgraph/work-items/${encodeURIComponent(workItemId)}/attempts?limit=10`)
      throw new Error(`${String(error)}\nAttempts: ${JSON.stringify(attempts)}\nReal Session diagnostics: ${JSON.stringify(harness.realSessionDiagnostics())}`)
    })

    const session = harness.realSessionEvidence()[0]
    expect(session).toBeDefined()
    expect(session?.directory).toBe(harness.worktreeDirectory(streamId))
    const durableSession = await readJson<{ title: string }>(
      request,
      `/session/${encodeURIComponent(session!.sessionId)}?directory=${encodeURIComponent(session!.directory)}`,
    )
    expect(durableSession.title, JSON.stringify(harness.realSessionDiagnostics())).toBe("Prove the real Session transcript")
    await page.reload()
    await page.getByRole("button", { name: "Expand Real Session execution" }).click()
    await page.getByRole("button", { name: "Open session for Prove the real Session transcript" }).click()
    await expect(page).toHaveURL(`/s/${session!.sessionId}`)
    await expect(page.getByText("Completed the WorkGraph Task in the real project Session.", { exact: true }))
      .toBeVisible({ timeout: 30_000 })
      .catch((error) => {
        throw new Error(`${String(error)}\nReal Session diagnostics: ${JSON.stringify(harness.realSessionDiagnostics())}`)
      })
    const project = page.locator('[data-testid="project-header"]').filter({ hasText: "Claxedo" })
    await expect(project).toBeVisible()
    const projectDisclosure = project.locator('[role="button"][aria-label$="project"]')
    if (await projectDisclosure.getAttribute("aria-expanded") !== "true") await projectDisclosure.click()
    const sessionRow = page.locator(
      `[data-testid="rail-sidebar-session-row"][data-session-id="${session!.sessionId}"]`,
    )
    await expect(sessionRow).toBeVisible()
    await expect(sessionRow).toContainText("Prove the real Session transcript")
    await expect(page.getByText("Thread not found", { exact: false })).toHaveCount(0)
    await expect(page.getByText("Session unavailable", { exact: false })).toHaveCount(0)
    harness.assertHealthy()
  })

  test("destroys a disposable Stream worktree but explicitly closes durable-effect work", async ({ page, request }) => {
    await configureGeneration(request)
    const disposable = await command(request, {
      version: 1,
      type: "create_stream",
      title: "Disposable implementation",
      execution: streamExecution(),
    })
    const disposableStreamId = String(disposable.value.streamId)
    const disposableTask = await command(request, {
      version: 1,
      type: "create_work_item",
      streamId: disposableStreamId as never,
      title: "Try the disposable implementation",
      completionContract: ownerConfirmation("Owner reviews the disposable implementation"),
    })
    harness.queueExecutionResults({ state: "failed", message: "Partial disposable implementation" })
    await command(request, {
      version: 1,
      type: "execute_work_item",
      workItemId: String(disposableTask.value.workItemId) as never,
      executionMode: "supervised",
    })
    await expect
      .poll(async () => {
        await harness.runReconcile()
        return (
          await readJson<WorkItemResponse>(
            request,
            `/api/workgraph/work-items/${encodeURIComponent(String(disposableTask.value.workItemId))}`,
          )
        ).state
      })
      .toBe("failed")
    expect(fs.existsSync(path.join(harness.worktreeDirectory(disposableStreamId), ".git"))).toBe(true)

    await page.goto("/workgraph")
    await page.getByRole("button", { name: "Delete stream Disposable implementation" }).click()
    await page.getByRole("button", { name: "Delete stream", exact: true }).click()
    await expect
      .poll(async () =>
        (
          await request.get(`${harness.apiUrl}/api/workgraph/streams/${encodeURIComponent(disposableStreamId)}`)
        ).status(),
      )
      .toBe(404)
    await expect.poll(() => fs.existsSync(harness.worktreeDirectory(disposableStreamId))).toBe(false)

    const durable = await command(request, {
      version: 1,
      type: "create_stream",
      title: "Merged durable implementation",
      execution: streamExecution(),
    })
    const durableStreamId = String(durable.value.streamId)
    const shippedTask = await command(request, {
      version: 1,
      type: "create_work_item",
      streamId: durableStreamId as never,
      title: "Merge the durable change",
      completionContract: {
        version: 1,
        mode: "all",
        requirements: [
          {
            id: "merged-pr" as never,
            kind: "integration",
            description: "The pull request is merged",
            target: "pull_request",
          },
        ],
      },
    })
    const remainingTask = await command(request, {
      version: 1,
      type: "create_work_item",
      streamId: durableStreamId as never,
      title: "Follow-up work that will be abandoned",
      completionContract: ownerConfirmation("Owner confirms the follow-up"),
    })
    harness.queueExecutionResults({
      state: "succeeded",
      summary: "Merged through the real retained worktree",
      artifacts: ["pr:482"],
    })
    await command(request, {
      version: 1,
      type: "execute_work_item",
      workItemId: String(shippedTask.value.workItemId) as never,
      executionMode: "supervised",
    })
    await expect
      .poll(async () => {
        const attempts = await readJson<AttemptPageResponse>(
          request,
          `/api/workgraph/work-items/${encodeURIComponent(String(shippedTask.value.workItemId))}/attempts?limit=10`,
        )
        return attempts.attempts.at(-1)?.attempt.state
      })
      .toBe("running")
    await expect(harness.runReconcile()).resolves.toContainEqual({
      settled: false,
      awaitingExplicitCompletion: true,
    })
    await expect(
      harness.completeControlledAttempt(
        String(shippedTask.value.workItemId),
        "Merged through the real retained worktree",
        ["pr:482"],
      ),
    ).resolves.toMatchObject({ ok: true })
    await expect
      .poll(async () => {
        return (
          await readJson<WorkItemResponse>(
            request,
            `/api/workgraph/work-items/${encodeURIComponent(String(shippedTask.value.workItemId))}`,
          )
        ).state
      })
      .toBe("result_ready")
    await command(request, {
      version: 1,
      type: "record_evidence",
      subject: { type: "work_item", workItemId: String(shippedTask.value.workItemId) as never },
      requirementId: "merged-pr",
      evidence: { kind: "integration", summary: "PR #482 merged", effect: "merged", reference: "pr:482" },
    })
    const durableBeforeClose = await readJson<StreamDetailResponse>(
      request,
      `/api/workgraph/streams/${encodeURIComponent(durableStreamId)}`,
    )
    const rejectedDelete = await rawCommand(request, {
      version: 1,
      type: "delete_stream",
      streamId: durableStreamId as never,
      expectedVersion: durableBeforeClose.version,
      reason: "Delete durable Stream",
    })
    expect(rejectedDelete).toMatchObject({ ok: false, error: { code: "close_required" } })
    await command(request, {
      version: 1,
      type: "close_stream",
      streamId: durableStreamId as never,
      expectedVersion: durableBeforeClose.version,
      reason: "Close after durable merge",
    })
    await expect
      .poll(async () =>
        readJson<StreamDetailResponse>(request, `/api/workgraph/streams/${encodeURIComponent(durableStreamId)}`),
      )
      .toMatchObject({ lifecycleState: "closed" })
    await expect
      .poll(async () =>
        readJson<WorkItemResponse>(
          request,
          `/api/workgraph/work-items/${encodeURIComponent(String(remainingTask.value.workItemId))}`,
        ),
      )
      .toMatchObject({ state: "abandoned" })
    harness.assertHealthy()
  })

  test("inspects a Decision, restores focus on close, and removes it from Attention only after answering", async ({
    page,
    request,
  }) => {
    const stream = await command(request, {
      version: 1,
      type: "create_stream",
      title: "Decision focus",
    })
    const streamId = String(stream.value.streamId)
    const task = await command(request, {
      version: 1,
      type: "create_work_item",
      streamId: streamId as never,
      title: "Implement authentication",
      completionContract: ownerConfirmation("Confirm authentication is implemented"),
    })
    const workItemId = String(task.value.workItemId)
    const proposed = await command(request, {
      version: 1,
      type: "propose_decision",
      streamId: streamId as never,
      question: "Which authentication strategy should we ship?",
      options: [
        { id: "oauth", label: "Use OAuth", description: "Delegate authentication to the provider." },
        { id: "passkeys", label: "Use passkeys", description: "Use WebAuthn credentials." },
      ],
      recommendationOptionId: "oauth",
      rationale: "OAuth fits the launch window.",
      affectedWorkItemIds: [workItemId as never],
    })
    const decisionId = String(proposed.value.decisionId)

    await page.goto("/workgraph")
    const panel = await openWaitingItemPanel(page, /Which authentication strategy should we ship\?/)
    const row = panel.getByRole("button", { name: /Which authentication strategy should we ship\?/ })
    await row.focus()
    await expect(row).toBeFocused()
    await row.click()
    const dialog = page.getByRole("dialog", { name: "Decision" })
    await expect(dialog).toBeVisible()
    await expectNoSeriousAxeViolations(page, '[role="dialog"]')
    await expect(dialog.getByText("OAuth fits the launch window.", { exact: true })).toBeVisible()
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    await expect(row).toBeFocused()

    await row.click()
    await dialog.getByRole("button", { name: /Use OAuth/ }).click()
    await expect(dialog).toBeHidden()
    await expect(row).toBeHidden()
    await expect
      .poll(async () => {
        const decision = await readJson<DecisionDto>(
          request,
          `/api/workgraph/decisions/${encodeURIComponent(decisionId)}`,
        )
        const attention = await readJson<AttentionResponse>(request, "/api/workgraph/attention?limit=50")
        return { state: decision.state, answer: decision.answer, attention: attention.total }
      })
      .toMatchObject({
        state: "answered",
        answer: {
          optionId: "oauth",
          answeredAt: expect.any(Number),
          answeredBy: { type: "user", id: "local" },
        },
        attention: 0,
      })
    harness.assertHealthy()
  })

  test("continues an unrelated branch, shares one Stream envelope, and requires evidence beyond successful Attempts", async ({
    page,
    request,
  }) => {
    await configureGeneration(request)
    const stream = await command(request, {
      version: 1,
      type: "create_stream",
      title: "Parallel launch branches",
      execution: streamExecution(),
    })
    const streamId = String(stream.value.streamId)
    const affected = await command(request, {
      version: 1,
      type: "create_work_item",
      streamId: streamId as never,
      title: "Choose and implement authentication",
      completionContract: testCompletion("auth-test", "Authentication tests pass"),
    })
    const affectedId = String(affected.value.workItemId)
    const unrelated = await command(request, {
      version: 1,
      type: "create_work_item",
      streamId: streamId as never,
      title: "Prepare unrelated deployment manifest",
      completionContract: testCompletion("manifest-test", "Deployment manifest validates"),
    })
    const unrelatedId = String(unrelated.value.workItemId)
    await command(request, {
      version: 1,
      type: "propose_decision",
      streamId: streamId as never,
      question: "Which authentication strategy unblocks the affected branch?",
      options: [
        { id: "oauth", label: "Use OAuth" },
        { id: "passkeys", label: "Use passkeys" },
      ],
      recommendationOptionId: "oauth",
      affectedWorkItemIds: [affectedId as never],
    })

    harness.queueExecutionResults({
      state: "succeeded",
      summary: "Manifest branch executed",
      artifacts: ["manifest.yaml"],
    })
    await command(request, {
      version: 1,
      type: "execute_work_item",
      workItemId: unrelatedId as never,
      executionMode: "supervised",
    })
    await completeControlledExecution(request, unrelatedId, "Manifest branch executed", ["manifest.yaml"])
    await expect
      .poll(async () => {
        return (
          await readJson<WorkItemResponse>(request, `/api/workgraph/work-items/${encodeURIComponent(unrelatedId)}`)
        ).state
      })
      .toBe("result_ready")
    await expect
      .poll(async () =>
        readJson<WorkItemResponse>(request, `/api/workgraph/work-items/${encodeURIComponent(affectedId)}`),
      )
      .toMatchObject({ state: "pending" })

    await page.goto("/workgraph")
    const panel = await openWaitingItemPanel(page, /Which authentication strategy unblocks the affected branch/)
    await panel.getByRole("button", { name: /Which authentication strategy unblocks the affected branch/ }).click()
    await page
      .getByRole("dialog", { name: "Decision" })
      .getByRole("button", { name: /Use OAuth/ })
      .click()

    harness.queueExecutionResults({
      state: "succeeded",
      summary: "Authentication branch executed",
      artifacts: ["auth.ts"],
    })
    await command(request, {
      version: 1,
      type: "execute_work_item",
      workItemId: affectedId as never,
      executionMode: "supervised",
    })
    await completeControlledExecution(request, affectedId, "Authentication branch executed", ["auth.ts"])
    await expect
      .poll(async () => {
        return (
          await readJson<WorkItemResponse>(request, `/api/workgraph/work-items/${encodeURIComponent(affectedId)}`)
        ).state
      })
      .toBe("result_ready")

    const unrelatedAttempts = await readJson<AttemptPageResponse>(
      request,
      `/api/workgraph/work-items/${encodeURIComponent(unrelatedId)}/attempts?limit=100`,
    )
    const affectedAttempts = await readJson<AttemptPageResponse>(
      request,
      `/api/workgraph/work-items/${encodeURIComponent(affectedId)}/attempts?limit=100`,
    )
    expect(unrelatedAttempts.attempts).toHaveLength(1)
    expect(affectedAttempts.attempts).toHaveLength(1)
    expect(unrelatedAttempts.attempts[0]?.executionReferences?.workspaceId).toBe(harness.worktreeDirectory(streamId))
    expect(affectedAttempts.attempts[0]?.executionReferences?.workspaceId).toBe(
      unrelatedAttempts.attempts[0]?.executionReferences?.workspaceId,
    )
    expect(fs.existsSync(path.join(harness.worktreeDirectory(streamId), ".git"))).toBe(true)

    await command(request, {
      version: 1,
      type: "record_evidence",
      subject: { type: "work_item", workItemId: unrelatedId as never },
      requirementId: "manifest-test",
      sourceAttemptId: unrelatedAttempts.attempts[0]!.attempt.id as never,
      evidence: {
        kind: "test_result",
        summary: "Manifest validation passed",
        passed: true,
        command: "validate-manifest",
      },
    })
    await expect
      .poll(async () =>
        readJson<WorkItemResponse>(request, `/api/workgraph/work-items/${encodeURIComponent(unrelatedId)}`),
      )
      .toMatchObject({ state: "completed" })
    await expect
      .poll(async () =>
        readJson<WorkItemResponse>(request, `/api/workgraph/work-items/${encodeURIComponent(affectedId)}`),
      )
      .toMatchObject({ state: "result_ready" })
    harness.assertHealthy()
  })

  test("persists the single WorkGraph surface and shared WorkspacePanel across a fresh narrow page", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto("/workgraph")
    await page.getByRole("button", { name: "New stream" }).click()
    const create = page.getByRole("dialog", { name: "New stream" })
    await create.getByRole("textbox", { name: "What are you trying to ship?" }).fill("Persist the narrow surface")
    await create.getByLabel("Project directory").selectOption(repositoryDirectory)
    await create.getByLabel("Base revision").fill("HEAD")
    await create.getByRole("button", { name: "Create" }).click()
    await expect(create).toBeHidden()

    await page.close()
    const fresh = await context.newPage()
    await fresh.setViewportSize({ width: 390, height: 844 })
    await fresh.goto("/workgraph")
    await expect(fresh.getByRole("main", { name: "WorkGraph" })).toBeVisible()
    await expect(fresh.getByText("Persist the narrow surface", { exact: true })).toBeVisible()
    await fresh.getByRole("button", { name: "Needs you", exact: true }).click()
    await expect(fresh.getByRole("complementary", { name: "Workspace panel" })).toBeVisible()
    await expect(fresh.getByRole("button", { name: "Close workspace panel" })).toHaveCount(1)
    await expect(fresh.getByRole("dialog", { name: "Waiting on you" })).toHaveCount(0)
    await expectNoSeriousAxeViolations(fresh, 'main[aria-label="WorkGraph"]')
    await expectNoSeriousAxeViolations(fresh, 'aside[aria-label="Workspace panel"]')
    harness.assertHealthy()
  })
})

const generationDefaults = {
  execution: {
    harness: "opencode",
    agent: "build",
    model: { providerId: "openai", modelId: "gpt-5" },
    effort: "high",
    tools: ["read", "edit"],
    connectionIds: [],
  },
  recap: {},
}

const realGenerationDefaults = {
  execution: {
    ...generationDefaults.execution,
    model: { providerId: "workgraph-e2e", modelId: "workgraph-model" },
  },
  recap: {},
}

function streamTarget() {
  return {
    environment: { kind: "local_worktree" as const, directory: repositoryDirectory },
    repository: { baseRevision: "HEAD" },
  }
}

function streamExecution() {
  return { ...generationDefaults.execution, ...streamTarget() }
}

async function configureGeneration(request: APIRequestContext) {
  await command(request, {
    version: 1,
    type: "update_workgraph_defaults",
    expectedVersion: 1,
    defaults: generationDefaults,
  })
}

async function configureRealGeneration(request: APIRequestContext) {
  await command(request, {
    version: 1,
    type: "update_workgraph_defaults",
    expectedVersion: 1,
    defaults: realGenerationDefaults,
  })
}

async function completeControlledExecution(
  request: APIRequestContext,
  workItemId: string,
  summary: string,
  artifacts: readonly string[],
) {
  await expect
    .poll(async () => {
      const attempts = await readJson<AttemptPageResponse>(
        request,
        `/api/workgraph/work-items/${encodeURIComponent(workItemId)}/attempts?limit=10`,
      )
      return attempts.attempts.at(-1)?.attempt.state
    })
    .toBe("running")
  await expect(harness.runReconcile()).resolves.toContainEqual({
    settled: false,
    awaitingExplicitCompletion: true,
  })
  const result = await harness.completeControlledAttempt(workItemId, summary, artifacts)
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
}

async function openWaitingItemPanel(page: Page, name: RegExp) {
  const card = page.getByRole("complementary", { name: "Waiting on you" })
  const panel = page.getByRole("complementary", { name: "Workspace panel" })
  await expect.poll(async () => await card.isVisible() || await panel.isVisible()).toBe(true)
  if (!(await card.isVisible())) {
    await page.getByRole("button", { name: /Needs you/ }).click()
    await expect(card).toBeVisible()
  }
  await card.getByRole("button", { name }).click()
  await expect(panel).toBeVisible()
  return panel
}

async function openNeedsYouPanel(page: Page) {
  const panel = page.getByRole("complementary", { name: "Workspace panel" })
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Needs you", exact: true }).click()
  await expect(panel).toBeVisible()
  await expect(panel.getByRole("tab", { name: "Needs you" })).toHaveAttribute("aria-selected", "true")
  return panel
}

async function openConnectionsSettings(page: Page) {
  await page.getByTestId("rail-account-trigger").click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  const dialog = page.locator('[data-slot="dialog-container"]').last()
  await expect(dialog).toBeVisible()
  await dialog.getByRole("tab", { name: "Connections", exact: true }).click()
  await expect(dialog.getByRole("heading", { name: "Connections", exact: true })).toBeVisible()
  return dialog
}

async function command(request: APIRequestContext, input: WorkGraphCommandRequest["command"]) {
  const result = await rawCommand(request, input)
  if (!result.ok) throw new Error(result.error.message)
  return result
}

async function rawCommand(request: APIRequestContext, input: WorkGraphCommandRequest["command"]) {
  const response = await request.post(`${harness.apiUrl}/api/workgraph/commands`, {
    data: { operationId: crypto.randomUUID(), command: input },
  })
  const result = (await response.json()) as CommandResult
  if (!response.ok() && result.ok) throw new Error(`WorkGraph command returned HTTP ${response.status()}`)
  return result
}

async function readJson<Value>(request: APIRequestContext, pathname: string) {
  const response = await request.get(`${harness.apiUrl}${pathname}`)
  if (!response.ok())
    throw new Error(`WorkGraph read failed (${response.status()}): ${pathname}: ${await response.text()}`)
  return (await response.json()) as Value
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function streamIdByTitle(request: APIRequestContext, title: string) {
  await expect
    .poll(
      async () =>
        (await readJson<SnapshotResponse>(request, "/api/workgraph/snapshot")).records.find(
          (record) => record.recordType === "stream" && record.title === title,
        )?.id,
    )
    .toBeTruthy()
  const records = (await readJson<SnapshotResponse>(request, "/api/workgraph/snapshot")).records
  const stream = records.find((record) => record.recordType === "stream" && record.title === title)
  if (!stream) throw new Error(`Stream was not found: ${title}`)
  return stream.id
}

async function workItemIdByTitle(request: APIRequestContext, title: string) {
  await expect.poll(async () =>
    (await readJson<SnapshotResponse>(request, "/api/workgraph/snapshot")).records.find(
      (record) => record.recordType === "work_item" && record.title === title,
    )?.id,
  ).toBeTruthy()
  const workItem = (await readJson<SnapshotResponse>(request, "/api/workgraph/snapshot")).records.find(
    (record) => record.recordType === "work_item" && record.title === title,
  )
  if (!workItem) throw new Error(`Task was not found: ${title}`)
  return workItem.id
}

async function sourceRevisionReference(request: APIRequestContext, workSourceId: string, revisionId: string) {
  const revision = await readJson<SourceRevisionResponse>(
    request,
    `/api/workgraph/sources/${encodeURIComponent(workSourceId)}/revisions/${encodeURIComponent(revisionId)}`,
  )
  return { workSourceId, revisionId, contentHash: revision.contentHash }
}

function confirmProposalCommand(
  proposal: ReviewableProposalResponse,
  selection: { mode: "create"; streamTitle: string } | { mode: "keep"; streamId: never },
) {
  return {
    version: 1 as const,
    type: "confirm_admission" as const,
    proposalId: proposal.id as never,
    expectedVersion: proposal.version,
    source: proposal.source as never,
    selection,
    outcomes: proposal.proposedOutcomes.map((outcome) => ({
      proposalKey: outcome.key,
      title: outcome.title,
      successCriteria: outcome.successCriteria,
      execution: outcome.execution,
    })),
    workItems: proposal.proposedWorkItems.map((workItem) => ({
      proposalKey: workItem.key,
      ...(workItem.outcomeKey ? { outcomeProposalKey: workItem.outcomeKey } : {}),
      title: workItem.title,
      dependencyProposalKeys: workItem.dependencyKeys,
      completionContract: workItem.completionContract,
      execution: workItem.execution,
    })),
  }
}

function ownerConfirmation(description: string) {
  return {
    version: 1 as const,
    mode: "all" as const,
    requirements: [{ id: crypto.randomUUID(), kind: "owner_confirmation" as const, description }],
  }
}

function testCompletion(id: string, description: string) {
  return {
    version: 1 as const,
    mode: "all" as const,
    requirements: [{ id, kind: "test" as const, description }],
  }
}

async function expectNoSeriousAxeViolations(page: import("@playwright/test").Page, selector: string) {
  const results = await new AxeBuilder({ page }).include(selector).analyze()
  const violations = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    }))
  expect(violations, `Serious accessibility violations in ${selector}`).toEqual([])
}

type DefaultsResponse = Readonly<{
  defaults: Readonly<{ execution: Record<string, unknown>; recap: Record<string, unknown> }>
}>
type SnapshotResponse = Readonly<{ records: Array<Readonly<{ recordType: string; id: string; title?: string }>> }>
type StreamResponse = Readonly<{
  executionDefaults: Record<string, unknown>
  recapDefaults: Record<string, unknown>
  durableEffectCount: number
}>
type StreamDetailResponse = Readonly<{ version: number; lifecycleState: string }>
type StreamWithSourcesResponse = Readonly<{
  sourceRevisionRefs: Array<Readonly<{ workSourceId: string; revisionId: string; contentHash: string }>>
}>
type SourceRevisionResponse = Readonly<{ contentHash: string }>
type ProposalResponse = Readonly<{ state: string }>
type ReviewableProposalResponse = Extract<AdmissionProposalDto, { state: "proposed" }>
type SourceViewsResponse = Readonly<{
  sourceViews: Array<Readonly<{ id: string; teamConnectionId: string; provider: "github" | "linear" | "jira" }>>
}>
type CandidatePageResponse = Readonly<{
  candidates: Array<
    Readonly<{
      id: string
      candidateKind: "external_issue" | "session"
      state: string
      admissionProposalId?: string
      sourceViewId?: string
      externalId?: string
      sessionId?: string
    }>
  >
}>
type CandidateResponse = CandidatePageResponse["candidates"][number]
type WorkItemResponse = Readonly<{ version: number; state: string }>
type AttemptPageResponse = Readonly<{
  attempts: Array<
    Readonly<{
      attempt: Readonly<{ id: string; state: string }>
      executionReferences?: Readonly<{ workspaceId?: string }>
    }>
  >
}>
type AttentionResponse = Readonly<{
  total: number
  items: Array<Readonly<{ id: string; kind: string; record?: Readonly<{ state: string }> }>>
}>
type ArchiveResponse = Readonly<{
  records: Array<Readonly<{ kind: string; id: string; value: Record<string, unknown> }>>
}>
