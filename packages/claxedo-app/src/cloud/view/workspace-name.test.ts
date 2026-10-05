/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { CloudText } from "../i18n"
import { workspaceName } from "./workspace-name"

test("a workspace with no name of its own reads the dictionary's word with its branch, and a named one reads its name alone", () => {
  const name = workspaceName(((key) => (key === "cloud.unnamed" ? "Espace cloud" : key)) as CloudText)
  expect(name(undefined, "dev")).toBe("Espace cloud · dev")
  expect(name(undefined, undefined)).toBe("Espace cloud")
  expect(name("payments", "dev")).toBe("payments")
})
