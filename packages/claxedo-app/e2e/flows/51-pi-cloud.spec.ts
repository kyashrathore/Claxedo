import type { Page } from "@playwright/test"
import {
  assistantText,
  cloudMessages,
  cloudPrompt,
  createCloudSession,
  expect,
  listedSessions,
  makeCloudWorkspace,
  sendPrompt,
  sessionConnection,
  sessionRoute,
  startCloudWorkspace,
  storeOwnerKey,
  test,
  UI,
  type CloudWorkspace,
  type MessageRow,
  type SignedStack,
  showHarnesses,
} from "../harness"

async function runningCloudWorkspace(signed: SignedStack) {
  await storeOwnerKey(signed, "openai", "cloud-owner-key")
  const workspace = await makeCloudWorkspace(signed, "main")
  await startCloudWorkspace(signed, workspace)
  return workspace
}

async function startPiFromComposer(page: Page, signed: SignedStack, workspace: CloudWorkspace, prompt: string) {
  await page.goto(`${signed.url}${sessionRoute(workspace.id)}`)
  await page.getByRole("button", { name: /^Select harness and model/ }).click()
  const picker = page.getByRole("dialog", { name: "Select harness, model and effort" })
  await showHarnesses(picker)
  await page.getByRole("button", { name: "Pi", exact: true }).click()
  await picker.getByRole("button", { name: "GPT-4.1", exact: true }).click()
  await page.keyboard.press("Escape")
  const reserved = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/control/session-registrations/reserve")
  await sendPrompt(page, prompt)
  return await (await reserved).json() as { sessionId: string; sessionHostRoot?: string }
}

test("51 Pi started from the composer on a cloud workspace runs in its own session host, writes on the workspace machine, reloads from the host and is deleted there", async ({ signedCloud, page, isMobile }) => {
  test.skip(isMobile, "workspace file panel coverage runs at desktop width")
  test.setTimeout(240_000)
  const workspace = await runningCloudWorkspace(signedCloud)
  signedCloud.hosted.model.scriptTool({ name: "write", input: { path: "cloud-pi.txt", content: "written by cloud Pi" }, whenPromptIncludes: "CLOUDPIWROTE" })
  const release = signedCloud.hosted.model.holdTextReplies("CLOUDPIWROTE")
  await signedCloud.signIn(page, signedCloud.owner)

  const reservation = await startPiFromComposer(page, signedCloud, workspace, "Write the file, then reply with exactly this one token: CLOUDPIWROTE")
  const sessionId = reservation.sessionId
  expect(reservation.sessionHostRoot).toBe(sessionId)
  await expect(page.getByRole("button", { name: /^Write/ })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole("button", { name: UI.stop, exact: true })).toBeVisible()
  release()
  await expect(page.getByText("CLOUDPIWROTE", { exact: true })).toBeVisible({ timeout: 60_000 })
  expect((await listedSessions(signedCloud, workspace)).find((row) => row.sessionId === sessionId)?.sessionHostRoot).toBe(sessionId)

  const mints: string[] = []
  page.on("request", (request) => { if (new URL(request.url()).pathname === `/api/workspace/${workspace.id}/connection`) mints.push(request.url()) })
  for (let reload = 0; reload < 3; reload++) {
    await page.reload()
    await expect(page.getByText("CLOUDPIWROTE", { exact: true })).toBeVisible()
  }
  expect(mints, "reloads reuse the tab's still-valid links").toEqual([])
  await sendPrompt(page, "Reply with exactly this one token: CLOUDPIAGAIN")
  await expect(page.getByText("CLOUDPIAGAIN", { exact: true })).toBeVisible({ timeout: 60_000 })

  await page.getByRole("button", { name: "Open workspace panel" }).click()
  await expect(page.getByRole("tree", { name: "File tree" }).getByText("cloud-pi.txt", { exact: true })).toBeVisible()

  const host = await sessionConnection(signedCloud, workspace, sessionId)
  expect(assistantText(await host.call("GET", `/session/${sessionId}/message`) as MessageRow[])).toContain("CLOUDPIWROTE")
  await host.call("DELETE", `/session/${sessionId}`)
  await expect.poll(async () => (await listedSessions(signedCloud, workspace)).map((row) => row.sessionId)).not.toContain(sessionId)
  await page.goto(`${signedCloud.url}${sessionRoute(workspace.id)}`)
  await expect(page.getByRole("navigation", { name: UI.rail }).getByText("No sessions match the current view.")).toBeVisible()
})

test("51 a cloud Pi session opens by its URL, and a Codex session on the same workspace runs on the workspace machine", async ({ signedCloud, page, isMobile }) => {
  test.skip(isMobile, "cross-harness placement coverage runs at desktop width")
  test.setTimeout(240_000)
  const workspace = await runningCloudWorkspace(signedCloud)
  await signedCloud.signIn(page, signedCloud.owner)
  const pi = await startPiFromComposer(page, signedCloud, workspace, "Reply with exactly this one token: CLOUDPIFIRST")
  await expect(page.getByText("CLOUDPIFIRST", { exact: true })).toBeVisible({ timeout: 60_000 })
  expect(pi.sessionHostRoot).toBe(pi.sessionId)
  const opened = await page.context().newPage()
  await opened.goto(`${signedCloud.url}${sessionRoute(workspace.id, pi.sessionId)}`)
  await expect(opened.getByText("CLOUDPIFIRST", { exact: true })).toBeVisible()

  const sessionId = await createCloudSession(signedCloud, workspace, { title: "Cloud Codex", harness: { id: "codex", access: "native" } })
  await cloudPrompt(signedCloud, workspace, sessionId, "Reply with exactly this one token: CLOUDCODEX")
  await expect.poll(async () => (await cloudMessages(signedCloud, workspace, sessionId)).map((message) => message.info.role)).toEqual(["user", "assistant"])
  expect((await cloudMessages(signedCloud, workspace, sessionId))[1]?.info.providerID).toBe("codex")
  const listed = await listedSessions(signedCloud, workspace)
  expect(listed.find((row) => row.sessionId === sessionId)).toBeDefined()
  expect(listed.find((row) => row.sessionId === sessionId)).not.toHaveProperty("sessionHostRoot")
  expect(listed.find((row) => row.sessionId === pi.sessionId)?.sessionHostRoot).toBe(pi.sessionId)
})

test("51 cloud Pi keeps its model available after first-turn credential delivery without reloading", async ({ signedCloud, page }) => {
  test.setTimeout(240_000)
  const workspace = await runningCloudWorkspace(signedCloud)
  await signedCloud.signIn(page, signedCloud.owner)
  const reservation = await startPiFromComposer(page, signedCloud, workspace, "Reply with exactly this one token: PIMODELREADY")
  await expect(page.getByText("PIMODELREADY", { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole("button", { name: "Select harness and model" })).toContainText("GPT-4.1")
  await expect(page.getByRole("status", { name: /Pi is not set up/ })).toHaveCount(0)
  await sendPrompt(page, "Reply with exactly this one token: PIMODELAGAIN")
  await expect(page.getByText("PIMODELAGAIN", { exact: true })).toBeVisible({ timeout: 60_000 })
  const host = await sessionConnection(signedCloud, workspace, reservation.sessionId)
  expect(assistantText(await host.call("GET", `/session/${reservation.sessionId}/message`) as MessageRow[])).toContain("PIMODELAGAIN")
})

test("51 a Pi draft on an asleep cloud workspace lists the account's models, never asks the workspace and never says Pi is not set up", async ({ signedCloud, page }, testInfo) => {
  test.setTimeout(180_000)
  await storeOwnerKey(signedCloud, "openai", "cloud-owner-key")
  const workspace = await makeCloudWorkspace(signedCloud, "asleep")
  await signedCloud.signIn(page, signedCloud.owner)
  const connections: string[] = []
  page.on("request", (request) => { if (new URL(request.url()).pathname === `/api/workspace/${workspace.id}/connection`) connections.push(request.url()) })
  await page.goto(`${signedCloud.url}${sessionRoute(workspace.id)}`)
  await page.getByRole("button", { name: /^Select harness and model/ }).click()
  const picker = page.getByRole("dialog", { name: "Select harness, model and effort" })
  await picker.getByRole("button", { name: /^Harness/ }).click()
  await page.getByRole("button", { name: "Pi", exact: true }).click()
  await expect(picker.getByRole("button", { name: "GPT-4.1", exact: true })).toBeVisible()
  if (testInfo.repeatEachIndex === 0) await page.screenshot({ path: testInfo.outputPath("pi-draft-asleep-picker.png") })
  await picker.getByRole("button", { name: "GPT-4.1", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Select harness and model" })).toContainText("GPT-4.1")
  await expect(page.getByText(/is not set up/)).toHaveCount(0)
  if (testInfo.repeatEachIndex === 0) await page.screenshot({ path: testInfo.outputPath("pi-draft-asleep.png") })
  expect(connections, "a draft's models never wake or reach the workspace").toEqual([])
})

test("51 a terminal on a cloud workspace opens beside a cloud Pi session, which another host serves", async ({ signedCloud, page, isMobile }, testInfo) => {
  test.skip(isMobile, "terminal coverage runs at desktop width")
  test.setTimeout(240_000)
  const workspace = await runningCloudWorkspace(signedCloud)
  await signedCloud.signIn(page, signedCloud.owner)
  const pi = await startPiFromComposer(page, signedCloud, workspace, "Reply with exactly this one token: CLOUDPITERMINAL")
  await expect(page.getByText("CLOUDPITERMINAL", { exact: true })).toBeVisible({ timeout: 60_000 })
  expect(pi.sessionHostRoot).toBe(pi.sessionId)
  await page.getByRole("button", { name: "New Terminal", exact: true }).click()
  const creator = page.getByTestId("terminal-creator")
  await expect(creator.getByRole("button", { name: /^Gemini\b/ })).toHaveCount(0)
  await expect(creator.getByText(/--dangerously|model_reasoning_effort/)).toHaveCount(0)
  await creator.getByRole("button", { name: /^Shell\b/ }).click()
  await expect(page).toHaveURL(/\/w\/[^/]+\/terminal\/pty_[^/?]+$/)
  const terminalId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "")
  await expect(page.locator(`[data-testid="terminal-pane"][data-terminal-id="${terminalId}"]`)).toBeVisible()
  await expect(page.getByText(/sign-in expired/)).toHaveCount(0)
  const listed = new URL("/api/wr/pty", signedCloud.hosted.workerUrl)
  listed.searchParams.set("directory", `workspace:${workspace.id}`)
  const rows = JSON.parse((await signedCloud.runtime(workspace.id)({ method: "GET", url: listed.toString(), headers: {} })).body) as Array<{ id: string; sessionId?: string }>
  expect(rows.find((row) => row.id === terminalId), "the workspace's terminal carries no session").toEqual(expect.not.objectContaining({ sessionId: expect.anything() }))
  if (testInfo.repeatEachIndex === 0) await page.screenshot({ path: testInfo.outputPath("cloud-terminal.png") })
})
