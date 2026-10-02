import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createComposerController } from "./controller"
import { emptyDraft } from "./model"

test("a shared send composer refuses shell mode through every controller entrypoint", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
  Object.defineProperty(globalThis, "document", { configurable: true, value: new EventTarget() })
  try { createRoot((dispose) => {
    const policy = { shellEnabled: () => false }
    const controller = createComposerController({
      ...policy, key: () => "test" as never, store: { draft: emptyDraft } as never, refs: { editor: () => undefined } as never,
      working: () => false, atItems: () => [], slashItems: () => [], submit: () => {}, stop: () => {}, edited: () => {}, runCommand: () => {},
    })
    try {
      controller.setMode("shell")
      expect(controller.state.mode).toBe("normal")
    } finally { dispose() }
  }) } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor)
    else Reflect.deleteProperty(globalThis, "document")
  }
})
