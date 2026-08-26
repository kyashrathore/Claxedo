#!/usr/bin/env bun
// Phase 6: robust end-to-end — boot app, wait for sidebar, iterate session
// URLs, find paged rail, dump geometry + screenshot.
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
const waitFor = async (expr: string, tries: number, gapMs = 1000): Promise<boolean> => {
  for (let i = 0; i < tries; i++) {
    if (await evaluate<boolean>(expr)) return true
    await sleep(gapMs)
  }
  return false
}

await send("Page.navigate", { url: "http://localhost:4444/" })
await waitFor(`document.querySelectorAll('[data-testid="rail-sidebar-session-row"]').length > 0`, 25)
const ids = await evaluate<string[]>(
  `[...document.querySelectorAll('[data-testid="rail-sidebar-session-row"]')].map((r) => r.dataset.sessionId).filter(Boolean).slice(0, 14)`,
)
console.log("ids:", ids.length)

const workspace = "130ee69b76ac7fbc13ad6ca18b03fcfd14074e4d"
let found = false
for (const id of ids) {
  await send("Page.navigate", { url: `http://localhost:4444/w/${workspace}/session/${id}` })
  const ready = await waitFor(
    `(() => { const n = document.querySelector('[data-component="message-nav"]'); return !!n && document.querySelectorAll("[data-slot='message-nav-tick-button']").length > 0 })()`,
    8,
  )
  const st = await evaluate(`(() => {
    const navs = [...document.querySelectorAll('[data-component="message-nav"]')]
    const nav = navs[navs.length - 1]
    return {
      ticks: nav ? nav.querySelectorAll("[data-slot='message-nav-tick-button']").length : -1,
      movers: nav ? nav.querySelectorAll("[data-slot^='message-nav-page-']").length : -1,
      navCount: navs.length,
    }
  })()`)
  console.log(id.slice(0, 10), JSON.stringify(st), "ready:", ready)
  if ((st.movers ?? 0) > 0) {
    found = true
    break
  }
}
if (!found) {
  console.log("no paged session found")
  process.exit(1)
}

await sleep(1200)
const info = await evaluate(`(() => {
  const navs = [...document.querySelectorAll('[data-component="message-nav"]')]
  const nav = navs[navs.length - 1]
  const shell = nav.closest('[data-component="message-nav-hovercard"]')
  const shellBox = shell.getBoundingClientRect()
  const rows = [...nav.querySelectorAll(':scope > li')].map((li) => {
    const btn = li.querySelector('button')
    const line = li.querySelector('[data-slot="message-nav-tick-line"]')
    const box = li.getBoundingClientRect()
    const ls = line ? getComputedStyle(line) : undefined
    const cx = box.left + box.width / 2
    const cy = box.top + box.height / 2
    const hit = document.elementFromPoint(cx, cy)
    return {
      slot: btn?.dataset.slot ?? '?',
      dist: btn?.dataset.distance,
      dis: btn?.disabled ?? false,
      y: Math.round(box.top),
      h: Math.round(box.height * 10) / 10,
      w: ls?.width,
      col: ls?.backgroundColor,
      op: ls?.opacity,
      hitSlot: hit ? (hit.closest('[data-slot]')?.getAttribute('data-slot') ?? hit.tagName.toLowerCase()) : 'none',
      hitSelf: hit ? (btn === hit || btn.contains(hit)) : false,
      cy: Math.round(cy),
    }
  })
  return { surfaces: navs.length, shell: { x: Math.round(shellBox.left), y: Math.round(shellBox.top), h: Math.round(shellBox.height) }, rows }
})()`)
console.log(JSON.stringify(info, null, 1))

const shot = await send("Page.captureScreenshot", { format: "png" })
await Bun.write("/tmp/web-diag.png", Buffer.from(shot.data, "base64"))
console.log("screenshot /tmp/web-diag.png")
process.exit(0)
