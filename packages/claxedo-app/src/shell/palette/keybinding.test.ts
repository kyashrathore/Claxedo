/// <reference types="bun" />
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { eventSignature, formatKeybindParts, keybindSignature, parseKeybind } from "./keybinding"

const SOURCE = join(import.meta.dir, "../..")

function defaultKeybinds(): readonly string[] {
  const files = readdirSync(SOURCE, { recursive: true, encoding: "utf8" }).filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."))
  return files.flatMap((file) => [...readFileSync(join(SOURCE, file), "utf8").matchAll(/keybind: "([^"]+)"/g)].map((match) => match[1]!))
}

function press(key: string, modifiers: { readonly meta: boolean; readonly ctrl: boolean }): KeyboardEvent {
  return { key, metaKey: modifiers.meta, ctrlKey: modifiers.ctrl, shiftKey: false, altKey: false } as KeyboardEvent
}

test("keybinding: every default binding a command registers names a key, so it is shown whole and can be pressed", () => {
  const keybinds = defaultKeybinds().filter((keybind) => keybind !== "none")
  expect(keybinds.length).toBeGreaterThan(5)
  expect(keybinds.filter((keybind) => parseKeybind(keybind).some((combo) => combo.key === ""))).toEqual([])
})

test("keybinding: mod+comma is shown with its comma and matches a mod+, key press", () => {
  expect(formatKeybindParts("mod+comma", (key) => key).at(-1)).toBe(",")
  const [combo] = parseKeybind("mod+comma")
  expect(keybindSignature(combo!)).toBe(eventSignature(press(",", combo!)))
})
