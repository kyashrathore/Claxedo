import "@testing-library/jest-dom/vitest"

// Node 25 exposes experimental `localStorage`/`sessionStorage` globals even
// when no --localstorage-file is configured. Those objects are incomplete
// (no clear/setItem), and Vitest preserves an existing Node global instead of
// installing jsdom's Storage object. Keep the component-test environment
// deterministic across Node versions by replacing only incomplete globals.
function memoryStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    clear() {
      entries.clear()
    },
    getItem(key) {
      return entries.get(String(key)) ?? null
    },
    key(index) {
      return [...entries.keys()][index] ?? null
    },
    removeItem(key) {
      entries.delete(String(key))
    },
    setItem(key, value) {
      entries.set(String(key), String(value))
    },
  }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  const storage = globalThis[name]
  if (typeof storage?.clear === "function" && typeof storage?.setItem === "function") continue
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    value: memoryStorage(),
  })
}

// jsdom ships no `Element.prototype.scrollTo` at all, and its `window.scrollTo`
// throws "Not implemented" into the virtual console. Components that keep the
// keyboard-active row in view — `@opencode-ai/ui/list`, which backs every
// picker and popover in this app — call them from a reactive effect, where a
// missing method surfaces as an unhandled rejection that fails the whole file
// rather than one assertion. Stubbing them here lets the component run its real
// code path; a test that cares about scrolling overrides the method on the
// element it is watching, which still wins over these prototype defaults.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = (() => undefined) as typeof Element.prototype.scrollTo
}
window.scrollTo = (() => undefined) as typeof window.scrollTo
