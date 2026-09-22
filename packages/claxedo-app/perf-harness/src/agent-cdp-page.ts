import { isRecord, numberField, recordField, textField } from "./json-fields"
import { optionalPoint, optionalText, rawValue, readFlag, readNumber } from "./page-value"


type PageEvent = "framenavigated" | "crash"
type Index = number | "last"

export interface BenchmarkLocator {
  click(options?: { timeout?: number }): Promise<void>
  hover(): Promise<void>
  count(): Promise<number>
  nth(index: number): BenchmarkLocator
  last(): BenchmarkLocator
  locator(selector: string): BenchmarkLocator
  getAttribute(name: string): Promise<string | null>
  waitFor(input: { state: "visible" | "attached" }): Promise<void>
  focus(): Promise<void>
}

export interface BenchmarkPage {
  keyboard: {
    press(key: string): Promise<void>
    type(value: string): Promise<void>
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
   * this one through the same structural type.
   */
  evaluate<A = undefined>(fn: ((arg: A) => unknown) | (() => unknown), arg?: A): Promise<unknown>
  /**
   * Raw CDP escape hatch for diagnostics (profiling, tracing).
   *
   * Resolves `unknown`: a reply's shape is decided by the CDP method, not by
   * the caller. Every caller today issues a command for its effect and ignores
   * the reply; one that needs a field should read it rather than declare it.
   */
  rawCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  onProtocolEvent(method: string, listener: (params: unknown) => void): () => void
  waitForFunction<A = undefined>(
    fn: ((arg: A) => unknown) | (() => unknown),
    arg?: A,
    options?: { polling?: "raf"; timeout?: number },
  ): Promise<void>
  locator(selector: string): BenchmarkLocator
  getByTestId(testId: string): BenchmarkLocator
  setViewportSize(size: { width: number; height: number }): Promise<void>
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
  const protocolListeners = new Map<string, Set<(params: unknown) => void>>()
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
    if (method) protocolListeners.get(method)?.forEach((listener) => listener(message.params))
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
  const evaluate = <A>(fn: ((arg: A) => unknown) | (() => unknown), arg?: A) =>
    evaluateExpression(`(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`, rawValue)

  const key = async (value: string) => {
    const description = keyDescription(value)
    await command("Input.dispatchKeyEvent", { type: "keyDown", ...description })
    await command("Input.dispatchKeyEvent", { type: "keyUp", ...description, text: undefined })
  }

  const typeCharacter = async (value: string) => {
    const description = printableKeyDescription(value)
    await command("Input.dispatchKeyEvent", { type: "keyDown", ...description })
    await command("Input.dispatchKeyEvent", { type: "keyUp", ...description, text: undefined, unmodifiedText: undefined })
  }

  const locator = (selector: string, index: Index = 0, parent?: { selector: string; index: Index }): BenchmarkLocator => {
    const query = `(() => {
      const parents = ${parent ? `document.querySelectorAll(${JSON.stringify(parent.selector)})` : "[document]"};
      const parent = parents[${parent?.index === "last" ? "parents.length - 1" : String(parent?.index ?? 0)}];
      const matches = parent?.querySelectorAll(${JSON.stringify(selector)}) ?? [];
      return { matches, element: matches[${index === "last" ? "matches.length - 1" : String(index)}] };
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
      async hover() {
        const point = await evaluateExpression(`(() => {
          const result = ${query}; const element = result.element;
          if (!(element instanceof HTMLElement)) return null;
          element.scrollIntoView({ block: "center", inline: "center" });
          const rect = element.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`, optionalPoint)
        if (!point) throw new Error(`benchmark hover target is missing: ${selector}`)
        await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y })
      },
      count: () => evaluateExpression(`(${query}).matches.length`, readNumber),
      nth: (next) => locator(selector, next, parent),
      last: () => locator(selector, "last", parent),
      locator: (child) => locator(child, 0, { selector, index }),
      getAttribute: async (name) =>
        // An attribute the element does not carry reads as absent, not as a
        // broken page: the expression already answers `null` for that case.
        (await evaluateExpression(`(${query}).element?.getAttribute(${JSON.stringify(name)}) ?? null`, optionalText)) ?? null,
      async waitFor(input) {
        await waitFor(() => evaluateExpression(`(() => {
          const element = (${query}).element;
          if (!(element instanceof HTMLElement)) return false;
          if (${JSON.stringify(input.state)} === "attached") return true;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
        })()`, readFlag), timeoutMs, input.state === "visible" ? 16 : 50)
      },
      async focus() {
        const focused = await evaluateExpression(`(() => {
          const element = (${query}).element;
          if (!(element instanceof HTMLElement)) return false;
          element.focus(); return document.activeElement === element;
        })()`, readFlag)
        if (!focused) throw new Error(`benchmark focus target is missing: ${selector}`)
      },
    }
  }

  const page: BenchmarkPage = {
    keyboard: {
      press: key,
      async type(value) {
        for (const character of value) await typeCharacter(character)
      },
    },
    async addInitScript(fn) {
      await command("Page.addScriptToEvaluateOnNewDocument", { source: `(${fn.toString()})()` })
    },
    evaluate,
    rawCommand: (method, params = {}) => command(method, params),
    onProtocolEvent(method, listener) {
      const registered = protocolListeners.get(method) ?? new Set()
      registered.add(listener)
      protocolListeners.set(method, registered)
      return () => {
        registered.delete(listener)
        if (registered.size === 0) protocolListeners.delete(method)
      }
    },
    async waitForFunction(fn, arg, options) {
      await waitFor(async () => !!await evaluate(fn, arg), options?.timeout ?? timeoutMs, options?.polling === "raf" ? 16 : 50)
    },
    locator: (selector) => locator(selector),
    getByTestId: (testId) => locator(`[data-testid="${cssEscape(testId)}"]`),
    async setViewportSize() {
      // The packaged process owns the fixed 1440x900 BrowserWindow. CDP device
      // emulation would change renderer semantics, so this is intentionally a
      // verification no-op rather than a synthetic viewport override.
    },
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

function printableKeyDescription(value: string) {
  if (/^[a-z]$/.test(value)) {
    const upper = value.toUpperCase()
    return { key: value, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: value, unmodifiedText: value }
  }
  if (/^[A-Z]$/.test(value)) {
    return { key: value, code: `Key${value}`, windowsVirtualKeyCode: value.charCodeAt(0), modifiers: 8, text: value, unmodifiedText: value.toLowerCase() }
  }
  if (/^[0-9]$/.test(value)) {
    return { key: value, code: `Digit${value}`, windowsVirtualKeyCode: value.charCodeAt(0), text: value, unmodifiedText: value }
  }
  const punctuation: Record<string, { code: string; windowsVirtualKeyCode: number; modifiers?: number; unmodifiedText?: string }> = {
    " ": { code: "Space", windowsVirtualKeyCode: 32 },
    "'": { code: "Quote", windowsVirtualKeyCode: 222 },
    "/": { code: "Slash", windowsVirtualKeyCode: 191 },
    ".": { code: "Period", windowsVirtualKeyCode: 190 },
    "-": { code: "Minus", windowsVirtualKeyCode: 189 },
    _: { code: "Minus", windowsVirtualKeyCode: 189, modifiers: 8, unmodifiedText: "-" },
    ";": { code: "Semicolon", windowsVirtualKeyCode: 186 },
    "\\": { code: "Backslash", windowsVirtualKeyCode: 220 },
  }
  const found = punctuation[value]
  if (!found) throw new Error(`Unsupported benchmark typing character: ${JSON.stringify(value)}`)
  return { key: value, ...found, text: value, unmodifiedText: found.unmodifiedText ?? value }
}

function cssEscape(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}
