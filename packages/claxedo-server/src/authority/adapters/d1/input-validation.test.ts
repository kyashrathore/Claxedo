import { expect, test } from "vitest"
import { D1SessionAuthority, D1SessionAuthorityError } from "./session-authority"
import { D1AccessAuthorityError, requireText } from "./access-context"

test("session input rejects non-text with its typed validation error", () => {
  try {
    new D1SessionAuthority({} as never, { deploymentId: 42 } as never)
    throw new Error("expected validation to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(D1SessionAuthorityError)
    expect(error).toMatchObject({ code: "invalid_input", status: 400, retryable: false })
  }
})

test("access input rejects non-text with its typed validation error", () => {
  try {
    requireText(42 as never, "name")
    throw new Error("expected validation to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(D1AccessAuthorityError)
    expect(error).toMatchObject({ code: "invalid_input", status: 400, retryable: false })
  }
})
