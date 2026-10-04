import { expect, test } from "bun:test"

import { CLAXEDO_SERVER_IDENTITY_UNREADABLE_EXIT_CODE, claxedoServerExitedBeforeListening } from "./claxedo-server-lifecycle"

test("a daemon that could not read its own identity is reported as that, with the log that holds the cause", () => {
  const message = claxedoServerExitedBeforeListening(CLAXEDO_SERVER_IDENTITY_UNREADABLE_EXIT_CODE, "/logs/claxedo-server.log")
  expect(message).toContain("could not read its own process identity")
  expect(message).toContain(`exit code ${CLAXEDO_SERVER_IDENTITY_UNREADABLE_EXIT_CODE}`)
  expect(message).toContain("/logs/claxedo-server.log")
})

test("any other early exit keeps its code and names no identity failure", () => {
  expect(claxedoServerExitedBeforeListening(1, "/logs/claxedo-server.log")).toBe("claxedo-server exited before listening (code 1)")
  expect(claxedoServerExitedBeforeListening(null, "/logs/claxedo-server.log")).toBe("claxedo-server exited before listening (code null)")
})
