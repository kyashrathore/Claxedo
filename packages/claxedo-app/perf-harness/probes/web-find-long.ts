#!/usr/bin/env bun
// Phase 3: figure out WHY the rail didn't mount — gate checks + try several
// sessions until one has >30 turns, then dump minimap geometry.
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

// Diagnose the current (just-opened) session first.
const diag = await evaluate(`(() => {
  const root = document.querySelector('[data-testid="session-page-root"]')
  return {
    url: location.pathname,
    rootWidth: root ? Math.round(root.getBoundingClientRect().width) : -1,
    innerWidth,
    rowCount: root?.dataset.sessionTimelineRowCount ?? null,
    gutterFlag: root?.dataset.sessionTimelineNavGutter === '' ,
    navInDom: !!root?.querySelector('[data-component="message-nav"]'),
  }
})()`)
console.log("current session:", JSON.stringify(diag))

// Iterate sessions until paged rail (>30 ticks incl movers) appears.
let opened = ""
for (let attempt = 0; attempt < 6; attempt++) {
  const pick = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-testid="rail-sidebar-session-row"]')]
    const row = rows[${attempt}]
    if (!row) return null
    row.click()
    return (row.textContent ?? '').trim().slice(0, 40)
  })()`)
  if (!pick) break
  await sleep(3000)
  const state = await evaluate(`(() => {
    const roots = [...document.querySelectorAll('[data-testid="session-page-root"]')]
    const active = roots.find((r) => r.closest('[data-workbench-content]')?.getAttribute('aria-hidden') !== 'true') ?? roots[roots.length - 1]
    const nav = active?.querySelector('[data-component="message-nav"]')
    const ticks = nav ? nav.querySelectorAll("[data-slot='message-nav-tick-button']").length : 0
    const movers = nav ? nav.querySelectorAll("[data-slot^='message-nav-page-']").length : 0
    return {
      label: ${JSON.stringify("x")} && (active?.dataset.sessionId ?? '').slice(-8),
      rows: nav ? nav.querySelectorAll(':scope > li').length : 0,
      ticks, movers,
      gutterFlag: !!active?.dataset.sessionTimelineNavGutter !== undefined ? active?.getAttribute('data-session-timeline-nav-gutter') === '' : false,
      rootW: active ? Math.round(active.getBoundingClientRect().width) : -1,
    }
  })()`)
  console.log(`session "${pick}" →`, JSON.stringify(state))
  if (state.movers > 0) {
    opened = pick
    break
  }
}
console.log("paged session:", opened || "none found")
process.exit(opened ? 0 : 1)
