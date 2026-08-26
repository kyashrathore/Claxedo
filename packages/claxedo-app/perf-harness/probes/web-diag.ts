#!/usr/bin/env bun
// Minimal CDP driver for the WEB dev server (:4444) — headless Chrome,
// Runtime.evaluate + screenshots. Usage: bun probes/web-diag.ts [eval-script]
import path from "node:path"
import { sleep } from "bun"

const PORT = 9333

try {
  let target: { webSocketDebuggerUrl: string } | undefined
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200)
    const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
    target = targets.find((t: { type: string }) => t.type === "page")
  }
  if (!target) throw new Error("no page target")

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

  await send("Page.enable")
  await send("Page.navigate", { url: "http://localhost:4444/" })
  await sleep(4000)

  // What's on screen? Dump interactive candidates for driving the app.
  const overview = await evaluate(`(() => {
    const roots = document.querySelectorAll('[data-testid="session-page-root"]')
    const buttons = [...document.querySelectorAll('button,a,[role="button"]')]
      .map((el) => ({ tag: el.tagName, testid: el.dataset?.testid, text: (el.textContent ?? '').trim().slice(0, 40), cls: String(el.className).slice(0, 60) }))
      .filter((b) => b.text.length > 0)
      .slice(0, 40)
    return {
      title: document.title,
      url: location.href,
      sessionRoots: roots.length,
      bodySample: document.body.innerText.slice(0, 600),
      buttons,
    }
  })()`)
  console.log(JSON.stringify(overview, null, 1))

  const shot = await send("Page.captureScreenshot", { format: "png" })
  await Bun.write("/tmp/web-diag.png", Buffer.from(shot.data, "base64"))
  console.log("screenshot /tmp/web-diag.png")
  process.exit(0)
} finally {
  void 0
}
