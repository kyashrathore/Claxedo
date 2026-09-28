import type { Page } from "@playwright/test"
import {
  acpScriptToken,
  cloudTurn,
  expect,
  makeCloudWorkspace,
  sendPrompt,
  sessionRoute,
  startCloudWorkspace,
  stopCloudWorkspace,
  storedMessages,
  test,
  UI,
  type CloudWorkspace,
  type SignedStack,
} from "../harness"

const ASLEEP = "This workspace is asleep. Your next message wakes it."
const WAKING = "Waking up the workspace…"

function wakeRequests(page: Page, workspace: CloudWorkspace) {
  const seen: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    const connect = request.method() === "POST" && url.pathname === `/api/workspace/${workspace.id}/connection`
    const runtime = url.pathname.startsWith(`/workspaces/${workspace.id}/`)
    if (connect || runtime) seen.push(`${request.method()} ${url.pathname}`)
  })
  return seen
}

async function asleepWithHistory(signed: SignedStack) {
  const workspace = await makeCloudWorkspace(signed, "Cloudy")
  await startCloudWorkspace(signed, workspace)
  const sessionId = await cloudTurn(signed, workspace, { title: "Cloud turn", script: "stored", reply: "Stored in the cloud" })
  await stopCloudWorkspace(signed, workspace)
  expect((await storedMessages(signed, workspace, sessionId)).map((message) => message.info.role)).toEqual(["user", "assistant"])
  return { workspace, sessionId }
}

async function openSession(page: Page, signed: SignedStack, workspace: CloudWorkspace, sessionId: string) {
  await signed.signIn(page, signed.owner)
  await page.goto(`${signed.url}${sessionRoute(workspace.id, sessionId)}`)
}

test("24 a gone sandbox: its session reads from the control plane with the asleep card, and nothing wakes it", async ({ signedCloud, page }) => {
  test.setTimeout(120_000)
  const { workspace, sessionId } = await asleepWithHistory(signedCloud)
  const wakes = wakeRequests(page, workspace)

  await openSession(page, signedCloud, workspace, sessionId)
  await expect(page.getByText("Stored in the cloud")).toBeVisible()
  await expect(page.getByText(ASLEEP)).toBeVisible()
  await expect(page.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await expect(page.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Cloud turn" })).toBeVisible()
  await page.reload()
  await expect(page.getByText("Stored in the cloud")).toBeVisible()
  await expect(page.getByText(ASLEEP)).toBeVisible()
  expect(wakes).toEqual([])
})

test("24 sending to a gone sandbox wakes it, shows the dock waking up, then sends and the reply arrives", async ({ signedCloud, page }) => {
  test.setTimeout(150_000)
  const { workspace, sessionId } = await asleepWithHistory(signedCloud)
  const wakes = wakeRequests(page, workspace)
  await openSession(page, signedCloud, workspace, sessionId)
  await expect(page.getByText(ASLEEP)).toBeVisible()
  await signedCloud.stack.acp.write("awake", { steps: [{ kind: "text", text: "Awake again" }] })

  await sendPrompt(page, `Are you there? ${acpScriptToken("awake")}`, { waitForSend: false })
  await expect(page.getByText(WAKING)).toBeVisible()
  await expect(page.getByText("Awake again")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(ASLEEP)).toHaveCount(0)
  await expect(page.getByText(WAKING)).toHaveCount(0)
  expect(wakes.filter((request) => request.startsWith("POST /api/workspace/"))).toHaveLength(1)
  await expect.poll(async () => (await storedMessages(signedCloud, workspace, sessionId)).length).toBe(4)
})

test("24 a live sandbox streams a turn as it runs", async ({ signedCloud, page }) => {
  test.setTimeout(120_000)
  const workspace = await makeCloudWorkspace(signedCloud, "Cloudy")
  await startCloudWorkspace(signedCloud, workspace)
  const sessionId = await cloudTurn(signedCloud, workspace, { title: "Live turn", script: "first", reply: "First answer" })
  const wakes = wakeRequests(page, workspace)
  await openSession(page, signedCloud, workspace, sessionId)
  await expect(page.getByText("First answer")).toBeVisible()
  await expect(page.getByText(ASLEEP)).toHaveCount(0)
  await signedCloud.stack.acp.write("streamed", { steps: [{ kind: "text", text: "Streamed while the sandbox runs" }] })

  await sendPrompt(page, `Go on. ${acpScriptToken("streamed")}`)
  await expect(page.getByText("Streamed while the sandbox runs")).toBeVisible()
  expect(wakes.filter((request) => request.startsWith("POST /api/workspace/"))).toEqual([])
  await expect.poll(async () => (await storedMessages(signedCloud, workspace, sessionId)).length).toBe(4)
})

test("24 a terminal on a live sandbox belongs to the open session, and with no session open the creator refuses before asking the sandbox", async ({ signedCloud, page, isMobile }) => {
  test.skip(isMobile, "the terminal creator runs at desktop width")
  test.setTimeout(150_000)
  const workspace = await makeCloudWorkspace(signedCloud, "Cloudy")
  await startCloudWorkspace(signedCloud, workspace)
  const sessionId = await cloudTurn(signedCloud, workspace, { title: "Terminal turn", script: "terminal", reply: "Ready for a shell" })
  const creates: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/api/wr/pty")) creates.push(request.postData() ?? "")
  })
  await signedCloud.signIn(page, signedCloud.owner)

  await page.goto(`${signedCloud.url}${sessionRoute(workspace.id)}`)
  await page.getByRole("button", { name: "New Terminal", exact: true }).click()
  await page.getByRole("button", { name: /^Shell\b/ }).click()
  await expect(page.getByText("Open a session on this machine to start a terminal")).toBeVisible()
  expect(creates).toEqual([])

  await page.goto(`${signedCloud.url}${sessionRoute(workspace.id, sessionId)}`)
  await expect(page.getByText("Ready for a shell")).toBeVisible()
  await page.getByRole("button", { name: "New Terminal", exact: true }).click()
  await page.getByRole("button", { name: /^Shell\b/ }).click()
  await expect(page).toHaveURL(/\/w\/[^/]+\/terminal\/pty_[^/?]+$/)
  expect(creates.map((body) => (JSON.parse(body) as { sessionId?: string }).sessionId)).toEqual([sessionId])
})
