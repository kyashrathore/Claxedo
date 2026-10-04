import type { Page } from "@playwright/test"
import {
  acpScriptToken,
  cloudTurn,
  expect,
  makeCloudWorkspace,
  sendPrompt,
  sessionRoute,
  signInDesktop,
  startCloudWorkspace,
  stopCloudWorkspace,
  storedMessages,
  test,
  UI,
  type CloudWorkspace,
  type Desktop,
  type SignedStack,
} from "../harness"

const ASLEEP = "This workspace is asleep. Your next message wakes it."
const WAKING = "Waking up the workspace…"

test("24 an asleep draft can explicitly start its workspace before model discovery", async ({ signedCloud, page }) => {
  test.setTimeout(150_000)
  const workspace = await makeCloudWorkspace(signedCloud, "main")
  await startCloudWorkspace(signedCloud, workspace)
  await stopCloudWorkspace(signedCloud, workspace)
  const wakes = wakeRequests(page, workspace)
  await signedCloud.signIn(page, signedCloud.owner)
  const catalog = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/claxedo/agent-config/providers" && new URL(response.url()).searchParams.get("nativeHarness") === "opencode")
  await page.goto(`${signedCloud.url}${sessionRoute(workspace.id)}`)
  await expect(page.getByText(ASLEEP)).toBeVisible()
  await page.getByRole("button", { name: /^Select harness and model/ }).click()
  const picker = page.getByRole("dialog", { name: "Select harness, model and effort" })
  await picker.getByRole("button", { name: /^Harness/ }).click()
  await page.getByRole("button", { name: "OpenCode", exact: true }).click()
  expect(await (await catalog).json()).toMatchObject({ modelAvailability: "runtime_required" })
  await page.keyboard.press("Escape")
  await expect(page.getByText("Start the workspace to discover OpenCode models", { exact: true })).toBeVisible()
  await expect(page.getByText("OpenCode is not set up", { exact: false })).toHaveCount(0)
  expect(wakes).toEqual([])
  const started = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/workspace/${workspace.id}/connection`)
  await page.getByRole("button", { name: "Start workspace", exact: true }).click()
  const response = await started
  expect(response.ok()).toBe(true)
  expect(await response.json()).toMatchObject({ workspaceId: workspace.id, relayUrl: expect.any(String) })
  await expect(page.getByText(ASLEEP)).toHaveCount(0)
  await expect(page.getByText(WAKING)).toHaveCount(0, { timeout: 60_000 })
  expect(wakes.filter((request) => request.startsWith("POST /api/workspace/"))).toHaveLength(1)
})

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
  const workspace = await makeCloudWorkspace(signed, "main")
  await startCloudWorkspace(signed, workspace)
  const sessionId = await cloudTurn(signed, workspace, { title: "Cloud turn", script: "stored", reply: "Stored in the cloud" })
  await stopCloudWorkspace(signed, workspace)
  expect((await storedMessages(signed, workspace, sessionId)).map((message) => message.info.role)).toEqual(["user", "assistant"])
  return { workspace, sessionId }
}

async function openOnDesktop(signed: SignedStack, desktop: Desktop, page: Page, title: string) {
  await desktop.makeWorkspace("local", "Local")
  await desktop.window.reload()
  await signInDesktop(signed, desktop, page)
  const row = desktop.window.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: title, exact: true })
  await expect(row).toBeVisible()
  await row.click()
  return desktop.window
}

function desktopWakes(signed: SignedStack, workspace: CloudWorkspace, from: number) {
  return signed.controlPlaneRequests().slice(from).filter((request) => request === `POST /api/workspace/${workspace.id}/connection`)
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
  await signedCloud.local.acp.write("awake", { steps: [{ kind: "text", text: "Awake again" }] })

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
  const workspace = await makeCloudWorkspace(signedCloud, "main")
  await startCloudWorkspace(signedCloud, workspace)
  const sessionId = await cloudTurn(signedCloud, workspace, { title: "Live turn", script: "first", reply: "First answer" })
  const wakes = wakeRequests(page, workspace)
  await openSession(page, signedCloud, workspace, sessionId)
  await expect(page.getByText("First answer")).toBeVisible()
  await expect(page.getByText(ASLEEP)).toHaveCount(0)
  await signedCloud.local.acp.write("streamed", { steps: [{ kind: "text", text: "Streamed while the sandbox runs" }] })

  await sendPrompt(page, `Go on. ${acpScriptToken("streamed")}`)
  await expect(page.getByText("Streamed while the sandbox runs")).toBeVisible()
  expect(wakes.filter((request) => request.startsWith("POST /api/workspace/"))).toEqual([])
  await expect.poll(async () => (await storedMessages(signedCloud, workspace, sessionId)).length).toBe(4)
})

test("24 a sandbox stopping while its session is open shows sleep and keeps history without waking", async ({ signedCloud, page }) => {
  test.setTimeout(120_000)
  const workspace = await makeCloudWorkspace(signedCloud, "main")
  await startCloudWorkspace(signedCloud, workspace)
  const sessionId = await cloudTurn(signedCloud, workspace, { title: "Idle cloud turn", script: "idle", reply: "Saved before stopping" })
  const wakes = wakeRequests(page, workspace)
  await openSession(page, signedCloud, workspace, sessionId)
  await expect(page.getByText("Saved before stopping")).toBeVisible()
  await expect(page.getByText(ASLEEP)).toHaveCount(0)
  await stopCloudWorkspace(signedCloud, workspace)
  await expect(page.getByText(ASLEEP)).toBeVisible()
  await expect(page.getByText("Saved before stopping")).toBeVisible()
  expect(wakes.filter((request) => request.startsWith("POST /api/workspace/"))).toEqual([])
  expect((await storedMessages(signedCloud, workspace, sessionId)).map((message) => message.info.role)).toEqual(["user", "assistant"])
})

test("24 a terminal on a live sandbox belongs to the open session, and with no session open the creator refuses before asking the sandbox", async ({ signedCloud, page, isMobile }) => {
  test.skip(isMobile, "the terminal creator runs at desktop width")
  test.setTimeout(150_000)
  const workspace = await makeCloudWorkspace(signedCloud, "main")
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

test("24 desktop: a gone sandbox's session reads from the control plane with the asleep card, and nothing wakes it", { tag: "@desktop" }, async ({ signedCloud, signedDesktop, page }) => {
  test.setTimeout(150_000)
  const { workspace } = await asleepWithHistory(signedCloud)
  const mark = signedCloud.controlPlaneRequests().length
  const window = await openOnDesktop(signedCloud, signedDesktop, page, "Cloud turn")
  await expect(window.getByText("Stored in the cloud")).toBeVisible()
  await expect(window.getByText(ASLEEP)).toBeVisible()
  await expect(window.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await window.reload()
  await window.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: "Cloud turn", exact: true }).click()
  await expect(window.getByText("Stored in the cloud")).toBeVisible()
  await expect(window.getByText(ASLEEP)).toBeVisible()
  expect(desktopWakes(signedCloud, workspace, mark)).toEqual([])
})

test("24 desktop: sending to a gone sandbox wakes it, shows the dock waking up, then sends and the reply arrives", { tag: "@desktop" }, async ({ signedCloud, signedDesktop, page }) => {
  test.setTimeout(180_000)
  const { workspace, sessionId } = await asleepWithHistory(signedCloud)
  const mark = signedCloud.controlPlaneRequests().length
  const window = await openOnDesktop(signedCloud, signedDesktop, page, "Cloud turn")
  await expect(window.getByText(ASLEEP)).toBeVisible()
  await signedCloud.local.acp.write("awake", { steps: [{ kind: "text", text: "Awake again" }] })

  await sendPrompt(window, `Are you there? ${acpScriptToken("awake")}`, { waitForSend: false })
  await expect(window.getByText(WAKING)).toBeVisible()
  await expect(window.getByText("Awake again")).toBeVisible({ timeout: 60_000 })
  await expect(window.getByText(ASLEEP)).toHaveCount(0)
  await expect(window.getByText(WAKING)).toHaveCount(0)
  expect(desktopWakes(signedCloud, workspace, mark)).toHaveLength(1)
  await expect.poll(async () => (await storedMessages(signedCloud, workspace, sessionId)).length).toBe(4)
})

test("24 desktop: a live sandbox streams a turn as it runs", { tag: "@desktop" }, async ({ signedCloud, signedDesktop, page }) => {
  test.setTimeout(150_000)
  const workspace = await makeCloudWorkspace(signedCloud, "main")
  await startCloudWorkspace(signedCloud, workspace)
  const sessionId = await cloudTurn(signedCloud, workspace, { title: "Live turn", script: "first", reply: "First answer" })
  const mark = signedCloud.controlPlaneRequests().length
  const window = await openOnDesktop(signedCloud, signedDesktop, page, "Live turn")
  await expect(window.getByText("First answer")).toBeVisible()
  await expect(window.getByText(ASLEEP)).toHaveCount(0)
  await signedCloud.local.acp.write("streamed", { steps: [{ kind: "text", text: "Streamed while the sandbox runs" }] })

  await sendPrompt(window, `Go on. ${acpScriptToken("streamed")}`)
  await expect(window.getByText("Streamed while the sandbox runs")).toBeVisible()
  expect(desktopWakes(signedCloud, workspace, mark)).toEqual([])
  await expect.poll(async () => (await storedMessages(signedCloud, workspace, sessionId)).length).toBe(4)
})

test("24 saved cloud history survives a replaced runtime and offers a new session", async ({ signedCloud, page }) => {
  test.setTimeout(150_000)
  const { workspace, sessionId } = await asleepWithHistory(signedCloud)
  const replaced = await page.request.delete(`${signedCloud.hosted.sandboxOrigin}/sandbox/claxedo-${workspace.id}`, { headers: { authorization: "Bearer hosted-sandbox-test-token" } })
  expect(replaced.status()).toBe(200)
  await startCloudWorkspace(signedCloud, workspace)
  await openSession(page, signedCloud, workspace, sessionId)
  const missing = page.getByText("This session is no longer on the running environment. Your saved history is still available.")
  await expect(page.getByText("Stored in the cloud")).toBeVisible()
  await expect(missing).toBeVisible()
  await expect(page.getByRole("textbox", { name: UI.composer })).toBeHidden()
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.getByText("Stored in the cloud")).toBeVisible()
  await expect(missing).toBeVisible()
  await page.reload()
  await expect(page.getByText("Stored in the cloud")).toBeVisible()
  await page.getByRole("button", { name: "Start new session", exact: true }).click()
  await expect(page).toHaveURL(`${signedCloud.url}${sessionRoute(workspace.id)}`)
  await expect(page.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await expect(missing).toHaveCount(0)
})
