import { isRecord, numberField, recordField, textField } from "./json-fields"
import { optionalPoint, optionalText, rawValue } from "./page-value"

type PageEvent = "framenavigated" | "crash"

export interface BenchmarkLocator {
  click(options?: { timeout?: number }): Promise<void>
  nth(index: number): BenchmarkLocator
  locator(selector: string): BenchmarkLocator
  getAttribute(name: string): Promise<string | null>
}

export interface BenchmarkPage {
  keyboard: {
    press(key: string): Promise<void>
  }
  addInitScript(fn: () => void): Promise<void>
  /**
   * Run `fn` in the page and resolve what it answered.
   *
   * Resolves `unknown`, not `fn`'s declared return type. `fn` is `toString()`d
   * and evaluated in the renderer, so what it declares describes a value in
   * another realm and what arrives here is that value's JSON — `() =>
   * document.querySelector(x)` declares `Element | null` and arrives as `{}`.
   * Callers read the answer with `./page-value`.
   *
   * The signature stays Playwright's `Page.evaluate` shape minus the result
   * type, because `agent-browser-observer` drives a real Playwright page and
   * this one through the same structural type. A string is evaluated as an
   * expression, as Playwright does.
   */
  evaluate<A = undefined>(fn: string | ((arg: A) => unknown) | (() => unknown), arg?: A): Promise<unknown>
  waitForFunction<A = undefined>(
    fn: ((arg: A) => unknown) | (() => unknown),
    arg?: A,
    options?: { polling?: "raf"; timeout?: number },
  ): Promise<void>
  locator(selector: string): BenchmarkLocator
  getByTestId(testId: string): BenchmarkLocator
  on(event: PageEvent, listener: (frame?: BenchmarkPage) => void): void
  mainFrame(): BenchmarkPage
  close(): void
}

export async function connectCdpPage(input: {
  port: number
  process: Bun.Subprocess
  timeoutMs: number
}): Promise<BenchmarkPage> {
  const deadline = performance.now() + input.timeoutMs
  let target: { webSocketDebuggerUrl?: string; url?: string } | undefined
  while (performance.now() < deadline) {
    if (input.process.exitCode !== null) {
      throw new Error(`Claxedo exited before CDP was ready (${String(input.process.exitCode)})`)
    }
    try {
      const listed: unknown = await fetch(`http://127.0.0.1:${String(input.port)}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      }).then((response) => response.json())
      // The DevTools target list is HTTP JSON; these are the three fields the
      // search below reads.
      const targets = (Array.isArray(listed) ? listed : []).filter(isRecord).map((candidate) => ({
        type: textField(candidate, "type"),
        webSocketDebuggerUrl: textField(candidate, "webSocketDebuggerUrl"),
        url: textField(candidate, "url"),
      }))
      target = targets.find((candidate) => candidate.type === "page" && candidate.url?.includes("index.local.html"))
      if (target?.webSocketDebuggerUrl) break
    } catch {
      // The packaged process starts before its renderer target. Poll the exact
      // requested loopback endpoint; timeout remains the failure boundary.
    }
    await Bun.sleep(100)
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("Timed out waiting for packaged Claxedo renderer CDP")
  return createCdpPage(target.webSocketDebuggerUrl, input.timeoutMs)
}

async function createCdpPage(url: string, timeoutMs: number): Promise<BenchmarkPage> {
  const socket = new WebSocket(url)
  const pending = new Map<number, {
    resolve(value: unknown): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
  }>()
  const listeners: Record<PageEvent, Array<(frame?: BenchmarkPage) => void>> = {
    framenavigated: [],
    crash: [],
  }
  let sequence = 0
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to packaged renderer CDP")), timeoutMs)
    socket.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Packaged renderer CDP failed")) }, { once: true })
  })
  const fail = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }
  socket.addEventListener("message", (event) => {
    // A CDP frame is JSON off a socket: an id-carrying command reply, or a
    // method-carrying event. Read as the protocol describes it rather than
    // asserted into a shape the socket never promised.
    const parsed: unknown = JSON.parse(String(event.data))
    const message = isRecord(parsed) ? parsed : {}
    const id = numberField(message, "id")
    if (id !== undefined) {
      const request = pending.get(id)
      if (!request) return
      pending.delete(id)
      clearTimeout(request.timer)
      const failure = recordField(message, "error")
      if (failure) request.reject(new Error(textField(failure, "message") ?? "CDP command failed"))
      else request.resolve(message.result)
      return
    }
    const method = textField(message, "method")
    if (method === "Page.frameNavigated") listeners.framenavigated.forEach((listener) => listener(page))
    if (method === "Inspector.targetCrashed") listeners.crash.forEach((listener) => listener())
  })
  socket.addEventListener("close", () => fail(new Error("Packaged renderer CDP closed")))
  socket.addEventListener("error", () => fail(new Error("Packaged renderer CDP failed")))

  // Resolves `unknown`: a CDP reply's shape is decided by the method, and the
  // socket cannot promise the caller's type. The one call site that reads a
  // reply narrows it below.
  const command = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Packaged renderer CDP command timed out: ${method}`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })

  const evaluateExpression = async <T>(expression: string, read: (value: unknown) => T) => {
    const reply = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    // `Runtime.evaluate` answers with either an exception report or a result
    // envelope. Both are read here; the payload inside the envelope is the
    // page's own JSON, so `read` decides what it is.
    const envelope = isRecord(reply) ? reply : {}
    const exception = recordField(envelope, "exceptionDetails")
    if (exception) {
      const thrown = recordField(exception, "exception")
      throw new Error(
        (thrown && textField(thrown, "description")) ?? textField(exception, "text") ?? "Renderer evaluation failed",
      )
    }
    return read((recordField(envelope, "result") ?? {}).value)
  }
  const evaluate = <A>(fn: string | ((arg: A) => unknown) | (() => unknown), arg?: A) =>
    evaluateExpression(
      typeof fn === "string" ? fn : `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`,
      rawValue,
    )

  const key = async (value: string) => {
    const description = keyDescription(value)
    await command("Input.dispatchKeyEvent", { type: "keyDown", ...description })
    await command("Input.dispatchKeyEvent", { type: "keyUp", ...description, text: undefined })
  }

  const locator = (selector: string, index = 0, parent?: { selector: string; index: number }): BenchmarkLocator => {
    const query = `(() => {
      const parents = ${parent ? `document.querySelectorAll(${JSON.stringify(parent.selector)})` : "[document]"};
      const parent = parents[${String(parent?.index ?? 0)}];
      const matches = parent?.querySelectorAll(${JSON.stringify(selector)}) ?? [];
      return { matches, element: matches[${String(index)}] };
    })()`
    return {
      async click() {
        const point = await evaluateExpression(`(() => {
          const result = ${query}; const element = result.element;
          if (!(element instanceof HTMLElement)) return null;
          element.scrollIntoView({ block: "center", inline: "center" });
          const rect = element.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`, optionalPoint)
        if (!point) throw new Error(`benchmark click target is missing: ${selector}`)
        // Playwright's click, which drives the compared app, moves the pointer
        // onto the target and lets hover render before pressing.
        await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y })
        await evaluateExpression("new Promise((resolve) => requestAnimationFrame(() => resolve(true)))", () => undefined)
        await command("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 })
        await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 })
      },
      nth: (next) => locator(selector, next, parent),
      locator: (child) => locator(child, 0, { selector, index }),
      getAttribute: async (name) =>
        // An attribute the element does not carry reads as absent, not as a
        // broken page: the expression already answers `null` for that case.
        (await evaluateExpression(`(${query}).element?.getAttribute(${JSON.stringify(name)}) ?? null`, optionalText)) ?? null,
    }
  }

  const page: BenchmarkPage = {
    keyboard: { press: key },
    async addInitScript(fn) {
      await command("Page.addScriptToEvaluateOnNewDocument", { source: `(${fn.toString()})()` })
    },
    evaluate,
    async waitForFunction(fn, arg, options) {
      await waitFor(async () => !!await evaluate(fn, arg), options?.timeout ?? timeoutMs, options?.polling === "raf" ? 16 : 50)
    },
    locator: (selector) => locator(selector),
    getByTestId: (testId) => locator(`[data-testid="${cssEscape(testId)}"]`),
    on(event, listener) { listeners[event].push(listener) },
    mainFrame: () => page,
    close() { socket.close() },
  }
  await Promise.all([command("Runtime.enable"), command("Page.enable")])
  return page
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, intervalMs: number) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await check()) return
    await Bun.sleep(intervalMs)
  }
  throw new Error("Timed out waiting for packaged Claxedo semantic condition")
}

function keyDescription(value: string) {
  const special: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; text?: string; modifiers?: number }> = {
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    "Meta+A": { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 },
  }
  const found = special[value]
  if (found) return found
  const codePoint = value.codePointAt(0) ?? 0
  return { key: value, code: "", windowsVirtualKeyCode: codePoint, text: value }
}

function cssEscape(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}
