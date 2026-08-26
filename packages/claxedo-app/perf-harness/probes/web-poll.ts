#!/usr/bin/env bun
// Phase 5: navigate once, then dump EVERYTHING about what mounted.
import { sleep } from "bun"

const PORT = 9333
const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const target = targets.find((t: { type: string; url: string }) => t.type === "page" && t.url.includes("localhost:4444"))
if (!target) throw new Error("no localhost:4444 target")

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }) })
let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(String(ev.data))
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)!
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
  }
})
const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async <T>(expression: string): Promise<T> => {
  const r = await send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
  )
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

// Grab two session ids: first row + a row from workspace-00 group (long corpus).
const ids = await evaluate<string[]>(`[...document.querySelectorAll('[data-testid="rail-sidebar-session-row"]')].map((r) => r.dataset.sessionId).filter(Boolean).slice(0, 12)`)
const workspace = "130ee69b76ac7fbc13ad6ca18b03fcfd14074e4d"
await send("Page.navigate", { url: `http://localhost:4444/w/${workspace}/session/${ids[0]}` })

// Poll up to 20s for any message-nav anywhere.
let poll = ""
for (let i = 0; i < 10; i++) {
  await sleep(2000)
  poll = await evaluate(`(() => {
    const roots = [...document.querySelectorAll('[data-testid="session-page-root"]')]
    const navs = document.querySelectorAll('[data-component="message-nav"]')
    return JSON.stringify({
      url: location.pathname,
      ready: document.readyState,
      roots: roots.map((r) => ({
        sid: (r.dataset.sessionId ?? '').slice(0, 8),
        hidden: r.closest('[data-workbench-content]')?.getAttribute('aria-hidden'),
        rows: r.dataset.sessionTimelineRowCount ?? null,
        gutter: r.getAttribute('data-session-timeline-nav-gutter') === '',
      })),
      navsAnywhere: navs.length,
      text: document.body.innerText.slice(0, 200),
    })
  })()`)
  console.log(`t=${(i + 1) * 2}s`, poll)
  if (!poll.includes('"navsAnywhere":0') && !poll.includes('\\"navsAnywhere\\":0')) {
    const parsed = JSON.parse(poll as unknown as string) as { navsAnywhere: number }
    if (parsed.navsAnywhere > 0) break
  }
}
process.exit(0)
