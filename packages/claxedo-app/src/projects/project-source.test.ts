import { expect, test } from "bun:test"
import en from "./locales/en"
import { pastedRepositoryHint } from "./project-source"

const t = (key: keyof typeof en, vars: Record<string, string | number> = {}) => en[key].replace(/{{(\w+)}}/g, (_, name: string) => String(vars[name] ?? ""))

test("a pasted URL's hint says a connected code host's account clones it when it can read it", () => {
  expect(pastedRepositoryHint(t, "GitHub", true)).toBe("Claxedo clones it with your GitHub connection when that connection can read it, and as a public repository otherwise.")
})

test("a pasted URL with no connected code host is cloned as a public repository", () => {
  expect(pastedRepositoryHint(t, "GitHub", false)).toBe("Claxedo clones a public repository by its URL.")
  expect(pastedRepositoryHint(t, undefined, false)).toBe("Claxedo clones a public repository by its URL.")
})
