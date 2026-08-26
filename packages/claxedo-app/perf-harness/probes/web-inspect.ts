#!/usr/bin/env bun
// Phase 2: open sessions, find a paged one (>30 turns), then dump full minimap
// geometry: row boxes, mover states, elementFromPoint hit tests, screenshot.
import { sleep } from "bun"

const PORT = 9333
const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const target = targets.find((t: { type: string; url: string }) => t.type === "page" && t.url.includes("localhost:4444"))
if (!target) throw new Error("no localhost:4444 target; load it first")

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

// Find session entry elements (text contains "Deterministic workspace") and click one.
const clicked = await evaluate(`(() => {
  const els = [...document.querySelectorAll('*')].filter((el) =>
    el.children.length === 0 && /Deterministic workspace \\d+/.test(el.textContent ?? ''))
  if (!els.length) return null
  // climb to the clickable ancestor
  let node = els[0]
  while (node && node.tagName !== 'BUTTON' && node.tagName !== 'A' && node.getAttribute?.('role') !== 'button') node = node.parentElement
  const clickTarget = node ?? els[0]
  const label = els[0].textContent.trim()
  ;clickTarget.click()
  return label
})()`)
console.log("clicked session:", clicked)
await sleep(3500)

const info = await evaluate(`(() => {
  const roots = [...document.querySelectorAll('[data-testid="session-page-root"]')]
  const active = roots.find((r) => r.closest('[data-workbench-content]')?.getAttribute('aria-hidden') !== 'true') ?? roots[0]
  const shell = active?.querySelector('[data-component="message-nav-hovercard"]')
  const nav = active?.querySelector('[data-component="message-nav"]')
  if (!nav || !shell) return { present: false, roots: roots.length }
  const shellBox = shell.getBoundingClientRect()
  const rows = [...nav.querySelectorAll(':scope > li')].map((li) => {
    const btn = li.querySelector('button')
    const line = li.querySelector('[data-slot="message-nav-tick-line"]')
    const box = li.getBoundingClientRect()
    const lineStyle = line ? getComputedStyle(line) : undefined
    const cx = box.left + box.width / 2
    const cy = box.top + box.height / 2
    const hit = document.elementFromPoint(cx, cy)
    return {
      slot: btn?.dataset.slot ?? '?',
      messageId: btn?.dataset.messageId?.slice(-6),
      distance: btn?.dataset.distance,
      disabled: btn?.disabled ?? false,
      y: Math.round(box.top),
      h: Math.round(box.height * 10) / 10,
      lineWidth: lineStyle?.width,
      lineColor: lineStyle?.backgroundColor,
      lineOpacity: lineStyle?.opacity,
      hitTag: hit?.tagName,
      hitSlot: hit?.closest('[data-slot]')?.getAttribute('data-slot') ?? null,
      hitMatchesSelf: hit ? (btn === hit || btn.contains(hit) || hit.contains(btn)) : false,
      cx: Math.round(cx),
      cy: Math.round(cy),
    }
  })
  return {
    present: true,
    surfaces: roots.length,
    shell: { x: Math.round(shellBox.left), y: Math.round(shellBox.top), w: Math.round(shellBox.width), h: Math.round(shellBox.height) },
    rowCount: rows.length,
    rows,
  }
})()`)
console.log(JSON.stringify(info, null, 1))

const shot = await send("Page.captureScreenshot", { format: "png" })
await Bun.write("/tmp/web-diag.png", Buffer.from(shot.data, "base64"))
console.log("screenshot /tmp/web-diag.png")
process.exit(0)
