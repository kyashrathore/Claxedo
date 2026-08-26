import { afterEach, describe, expect, test, vi } from "bun:test"
import { BP_MD } from "@/ui/controls/breakpoints"
import { MAX_WEBGL_RENDERERS, loadRenderer, probeWebGL, shouldAttemptWebGL, shouldPreferDomRenderer } from "./renderer"
import type { Terminal as XTerm } from "@xterm/xterm"

// ---------------------------------------------------------------------------
// shouldAttemptWebGL — the WebGL renderer decision (probe/ceiling/fallback)
// ---------------------------------------------------------------------------

describe("shouldAttemptWebGL", () => {
  const base = {
    pref: "",
    preferDom: false,
    webglSupported: () => true,
    activeCount: 0,
    max: MAX_WEBGL_RENDERERS,
  }

  test("attempts WebGL by default when supported, off a DOM-preferring device, under the ceiling", () => {
    expect(shouldAttemptWebGL(base)).toBe(true)
  })

  test('pref "dom" never attempts WebGL, even when everything else says yes', () => {
    expect(shouldAttemptWebGL({ ...base, pref: "dom" })).toBe(false)
  })

  test("a DOM-preferring device (coarse pointer / narrow) falls back to DOM", () => {
    expect(shouldAttemptWebGL({ ...base, preferDom: true })).toBe(false)
  })

  test("unsupported WebGL falls back to DOM", () => {
    expect(shouldAttemptWebGL({ ...base, webglSupported: () => false })).toBe(false)
  })

  test('pref "webgl" forces WebGL past the DOM-preference and support checks', () => {
    expect(shouldAttemptWebGL({ ...base, pref: "webgl", preferDom: true, webglSupported: () => false })).toBe(true)
  })

  test("the concurrency ceiling blocks a new WebGL context even when forced", () => {
    expect(shouldAttemptWebGL({ ...base, activeCount: MAX_WEBGL_RENDERERS })).toBe(false)
    // Forcing does not override the ceiling — it is a hard browser-context limit.
    expect(shouldAttemptWebGL({ ...base, pref: "webgl", activeCount: MAX_WEBGL_RENDERERS })).toBe(false)
  })

  test("one slot below the ceiling still attempts", () => {
    expect(shouldAttemptWebGL({ ...base, activeCount: MAX_WEBGL_RENDERERS - 1 })).toBe(true)
  })

  test("does not probe WebGL support on the DOM-forced path (short-circuits before the probe thunk)", () => {
    let probeCalls = 0
    const webglSupported = () => {
      probeCalls++
      return true
    }
    expect(shouldAttemptWebGL({ ...base, pref: "dom", webglSupported })).toBe(false)
    expect(probeCalls).toBe(0)
  })

  test("does not probe WebGL support on the mobile/coarse-pointer path (short-circuits before the probe thunk)", () => {
    let probeCalls = 0
    const webglSupported = () => {
      probeCalls++
      return true
    }
    expect(shouldAttemptWebGL({ ...base, preferDom: true, webglSupported })).toBe(false)
    expect(probeCalls).toBe(0)
  })

  test("forced webgl pref never invokes the support probe (the result is forced)", () => {
    let probeCalls = 0
    const webglSupported = () => {
      probeCalls++
      return false
    }
    expect(shouldAttemptWebGL({ ...base, pref: "webgl", webglSupported })).toBe(true)
    expect(probeCalls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// probeWebGL — support probe over an injected document
// ---------------------------------------------------------------------------

describe("probeWebGL", () => {
  function fakeDoc(getContext: unknown) {
    // as-any: minimal canvas/document stand-in; probeWebGL only touches createElement().getContext.
    const el = { getContext } as unknown as HTMLCanvasElement
    // as-any: fake document exposing just the createElement surface probeWebGL uses.
    return { createElement: () => el } as unknown as Pick<Document, "createElement">
  }

  test("returns true and releases the probe context when a GL context is available", () => {
    const loseContext = vi.fn()
    const gl = { getExtension: () => ({ loseContext }) }
    expect(probeWebGL(fakeDoc(() => gl))).toBe(true)
    // The throwaway probe context must be released so it doesn't count against
    // the browser's ~16-context limit.
    expect(loseContext).toHaveBeenCalledTimes(1)
  })

  test("returns false when getContext yields no GL context", () => {
    expect(probeWebGL(fakeDoc(() => null))).toBe(false)
  })

  test("returns false when the canvas element has no getContext (jsdom-ish)", () => {
    expect(probeWebGL(fakeDoc(undefined))).toBe(false)
  })

  test("returns false (never throws) when getContext throws", () => {
    expect(
      probeWebGL(
        fakeDoc(() => {
          throw new Error("context creation blocked")
        }),
      ),
    ).toBe(false)
  })

  test("returns false when there is no document at all (SSR)", () => {
    expect(probeWebGL(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// shouldPreferDomRenderer — mobile / coarse-pointer fallback
// ---------------------------------------------------------------------------

describe("shouldPreferDomRenderer", () => {
  function fakeWin(input: { coarse: boolean; innerWidth: number }) {
    return {
      matchMedia: (query: string) => ({ matches: query.includes("coarse") && input.coarse }),
      innerWidth: input.innerWidth,
      // as-any: fake window exposing only matchMedia + innerWidth (the two inputs to shouldPreferDomRenderer).
    } as unknown as Pick<Window, "matchMedia" | "innerWidth">
  }

  test("coarse pointer (touch) prefers the DOM renderer regardless of width", () => {
    expect(shouldPreferDomRenderer(fakeWin({ coarse: true, innerWidth: 1920 }))).toBe(true)
  })

  test("narrow viewport (just below BP_MD) prefers the DOM renderer", () => {
    expect(shouldPreferDomRenderer(fakeWin({ coarse: false, innerWidth: BP_MD - 1 }))).toBe(true)
  })

  test("exactly BP_MD with a fine pointer keeps WebGL (the boundary belongs to the wide side)", () => {
    expect(shouldPreferDomRenderer(fakeWin({ coarse: false, innerWidth: BP_MD }))).toBe(false)
  })

  test("wide viewport with a fine pointer keeps WebGL", () => {
    expect(shouldPreferDomRenderer(fakeWin({ coarse: false, innerWidth: 1280 }))).toBe(false)
  })

  test("no window (SSR) does not force DOM", () => {
    expect(shouldPreferDomRenderer(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// loadRenderer — synchronous return + pref short-circuit
// ---------------------------------------------------------------------------

describe("loadRenderer", () => {
  afterEach(() => {
    try {
      localStorage.removeItem("opencode.terminal.renderer")
    } catch {}
  })

  function fakeXterm() {
    // as-any: loadRenderer only calls xterm.loadAddon (async, WebGL path); a spy stand-in suffices.
    return { loadAddon: vi.fn() } as unknown as XTerm & { loadAddon: ReturnType<typeof vi.fn> }
  }

  test("returns a DOM renderer ref synchronously (WebGL upgrades async, if at all)", () => {
    const ref = loadRenderer(fakeXterm())
    expect(ref.kind).toBe("dom")
    // The default ref is safe to dispose even if no addon ever loaded.
    expect(() => ref.dispose()).not.toThrow()
  })

  test('pref "dom" short-circuits: never loads a WebGL addon onto the terminal', async () => {
    localStorage.setItem("opencode.terminal.renderer", "dom")
    const xterm = fakeXterm()
    const ref = loadRenderer(xterm)
    // Let any (erroneous) async addon import settle.
    await new Promise((r) => setTimeout(r, 10))
    expect(ref.kind).toBe("dom")
    expect(xterm.loadAddon).not.toHaveBeenCalled()
  })

  test('pref "dom" performs ZERO WebGL support probes (regression: probe fired before the short-circuit)', () => {
    localStorage.setItem("opencode.terminal.renderer", "dom")
    let probeCalls = 0
    const ref = loadRenderer(fakeXterm(), {
      webglSupported: () => {
        probeCalls++
        return true
      },
    })
    expect(ref.kind).toBe("dom")
    // The DOM-forced path must never create (and lose) a throwaway WebGL context.
    expect(probeCalls).toBe(0)
  })

  test("mobile/coarse-pointer path performs ZERO WebGL support probes (regression guard)", () => {
    let probeCalls = 0
    const ref = loadRenderer(fakeXterm(), {
      preferDom: () => true,
      webglSupported: () => {
        probeCalls++
        return true
      },
    })
    expect(ref.kind).toBe("dom")
    expect(probeCalls).toBe(0)
  })
})
