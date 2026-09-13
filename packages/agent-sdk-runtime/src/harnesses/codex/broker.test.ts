import { expect, test } from "bun:test"
import { codexAuthFailure } from "./broker"

/**
 * Codex writes its transport failures to stderr, and the driver turns a 401
 * there into the turn's error. What that error says decides which account the
 * operator goes and re-authenticates.
 */
test("a 401 that carries a broker code keeps it, so the classifier can read it", () => {
  const stderr = 'ERROR reqwest: 401 Unauthorized {"error":{"code":"binding_not_permitted",'
    + '"message":"This runtime token does not name that binding"}}'

  expect(codexAuthFailure(stderr, true)).toBe(stderr)
})

test("a brokered 401 with no code names the placeholder, not a login", () => {
  expect(codexAuthFailure("ERROR reqwest: 401 Unauthorized", true))
    .toMatch(/credential binding this turn ran on/)
  // `codex login` signs the operator's own account in, which a brokered turn
  // deliberately never uses.
  expect(codexAuthFailure("ERROR reqwest: 401 Unauthorized", true)).not.toMatch(/codex login/)
})

test("an unbrokered 401 still sends the operator to codex login", () => {
  expect(codexAuthFailure("ERROR reqwest: 401 Unauthorized", false)).toMatch(/codex login/)
})
