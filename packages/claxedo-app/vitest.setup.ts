import "@testing-library/jest-dom/vitest"

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
