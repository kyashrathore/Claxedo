import path from "node:path"
import type { FrameLocator, Locator, Page } from "@playwright/test"
import { expect, installAndEnable, pageTransport, readAs, registerLivePlugin, signInDesktop, test, writeLivePlugin } from "../harness"
import {
  expectEveryAttemptBlocked,
  expectEveryOriginViolated,
  expectOutsideImage,
  KINDS,
  PROBE,
  probePlugin,
  targetsFor,
  type ImagePolicy,
  type Target,
} from "./37-plugin-network-lock.probe"

const DESKTOP_WARNING = /runs? inside this app, unsandboxed, with its full access on this computer\. An app plugin sees what you see, acts as you on your server, and can open links in your browser that carry your data out\./

const INSTALLED_ROUTE = "/api/claxedo/app-plugins"

const LEAVE_REFUSALS = (sink: string) => [
  `Blocked opening '${sink}/synthetic-click' in a new window`,
  `Blocked opening '${sink}/window-open' in a new window`,
  [`Framing '${sink}/' violates`, `Refused to frame '${sink}/' because it violates`].map((refusal) => `${refusal} the following Content Security Policy directive: "frame-src 'self'"`),
]

function refused(lines: readonly string[], refusal: string | readonly string[]) {
  return lines.some((line) => (typeof refusal === "string" ? [refusal] : refusal).some((phrasing) => line.includes(phrasing)))
}

const DESKTOP_REFUSALS = (sink: string) => [
  `[security] blocked window.open to ${sink}/synthetic-click`,
  `[security] blocked window.open to ${sink}/window-open`,
  `[security] blocked main-window navigation to ${sink}/navigate`,
]

async function listed(list: Locator) {
  return (await list.getByRole("listitem").allTextContents()).map((line) => line.trim())
}

async function approveInDialog(app: Page, name: string, warning: RegExp) {
  const dialog = app.getByRole("dialog", { name: `Turn on the app plugin ${name}?` })
  await expect(dialog.getByRole("note")).toHaveText(warning)
  await dialog.getByRole("button", { name: "Turn on" }).click()
  await expect(dialog).toHaveCount(0)
}

async function expectProbeBlocked(view: Page | FrameLocator, targets: readonly Target[], imagePolicy: ImagePolicy) {
  const outcomes = view.getByRole("list", { name: "Outcomes" })
  await expect(outcomes.getByRole("listitem").filter({ hasText: /^server / })).toHaveText("server 200")
  await expect.poll(async () => (await listed(outcomes)).filter((line) => !line.startsWith("server ")).length, { timeout: 30_000 }).toBe(targets.length * KINDS.length)
  expectEveryAttemptBlocked((await listed(outcomes)).filter((line) => !line.startsWith("server ")), targets)
  const violations = view.getByRole("list", { name: "Violations" })
  await expect.poll(async () => expectEveryOriginViolated(await listed(violations), targets, imagePolicy)).toBeUndefined()
  await expect.poll(async () => expectOutsideImage(await listed(violations), imagePolicy)).toBeUndefined()
}

async function watchViolations(app: Page) {
  await app.evaluate(() => {
    const lines: string[] = []
    Object.assign(window, { probeViolations: lines })
    document.addEventListener("securitypolicyviolation", (event) => lines.push(`${event.effectiveDirective} ${event.blockedURI}`))
  })
  return () => app.evaluate(() => (window as unknown as { probeViolations: string[] }).probeViolations)
}

test("37 network lock: a script in the app page reaches its own server and nothing else, and loads https images", async ({ stack, app }) => {
  const sink = await stack.connectionSink()
  const targets = targetsFor(stack.url, sink)
  const violations = await watchViolations(app)
  expectEveryAttemptBlocked(await app.evaluate(`(${PROBE})(${JSON.stringify(targets)})`), targets)
  await expect.poll(async () => expectEveryOriginViolated(await violations(), targets, "https images load")).toBeUndefined()
  expect(await app.evaluate(async () => (await fetch("/api/claxedo/health")).status)).toBe(200)
  expect(sink.connections()).toBe(0)
})

test.describe("an installed plugin", () => {
  test.use({ signedAppPluginRegistry: true })

  test("37 network lock: an installed plugin on the web reaches its own server through the host and nothing else, not even an https image", async ({ signed, page: app }) => {
    const sink = await signed.local.connectionSink()
    const targets = targetsFor(signed.url, sink)
    const folder = await writeLivePlugin(path.join(signed.local.dataDir, "registry-plugins", "probe"), {
      id: "probe",
      name: "Network probe",
      routes: [INSTALLED_ROUTE],
      app: probePlugin(targets, sink.url, INSTALLED_ROUTE),
    })
    await signed.appPluginRegistry?.publish(folder)
    await installAndEnable(signed, { id: "probe", version: "0.1.0" })
    await signed.signIn(app, signed.owner)

    await app.goto(`${signed.url}/network-probe`)
    const probe = app.getByTitle("Network probe", { exact: true }).contentFrame()
    await expectProbeBlocked(probe, targets, "no outside image")

    const consoleLines: string[] = []
    app.on("console", (message) => consoleLines.push(message.text()))
    await probe.getByRole("button", { name: "Leave" }).click()
    await expect
      .poll(() => LEAVE_REFUSALS(sink.url).filter((refusal) => !refused(consoleLines, refusal)))
      .toEqual([])
    expect(sink.connections()).toBe(0)
    expect(await readAs(signed, signed.owner, "/api/claxedo/app-plugins")).toMatchObject({ status: 200, body: [{ id: "probe" }] })
  })
})

test("37 network lock: a live plugin on a signed desktop reaches its own server and nothing else, and cannot leave the window", { tag: "@desktop" }, async ({ signedCloud: signed, signedDesktop: desktop, page }) => {
  await signInDesktop(signed, desktop, page)
  const sink = await desktop.connectionSink()
  const targets = targetsFor(desktop.url, sink)
  await desktop.electron.evaluate(({ shell }) => {
    const opened: string[] = []
    Object.assign(globalThis, { openedExternally: opened })
    shell.openExternal = async (url: string) => {
      opened.push(url)
    }
  })
  const openedExternally = () => desktop.electron.evaluate(() => (globalThis as unknown as { openedExternally: string[] }).openedExternally)
  const folder = await writeLivePlugin(path.join(desktop.dataDir, "plugins", "probe"), {
    id: "probe",
    name: "Network probe",
    routes: ["/api/claxedo/projects"],
    app: probePlugin(targets, sink.url, "/api/claxedo/projects"),
  })
  const window = desktop.window
  expect(await registerLivePlugin(desktop.url, folder, pageTransport(window))).toMatchObject({ id: "probe", status: "ready", lastError: null })
  await desktop.makeWorkspace("probe", "Probe")
  await window.reload()

  await approveInDialog(window, "Network probe", DESKTOP_WARNING)
  await window.getByRole("button", { name: "Network probe" }).click()
  await expectProbeBlocked(window, targets, "https images load")

  await window.getByRole("link", { name: "Plugin docs" }).click()
  await expect.poll(openedExternally).toEqual([`${sink.url}/clicked`])

  const shell = window.url()
  await window.getByRole("button", { name: "Leave" }).dispatchEvent("click")
  await expect
    .poll(() => DESKTOP_REFUSALS(sink.url).filter((refusal) => !desktop.log().includes(refusal)))
    .toEqual([])
  const windowUrls = await desktop.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((opened) => opened.webContents.getURL()))
  expect(windowUrls).toContain(shell)
  expect(windowUrls.filter((url) => url.startsWith(sink.url))).toEqual([])
  expect(await openedExternally()).toEqual([`${sink.url}/clicked`])
  expect(sink.connections()).toBe(0)
})
