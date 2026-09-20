import { describe, expect, test } from "bun:test"
import { signInGate } from "./deployment-posture"

describe("signInGate", () => {
  test("holds while the server has not answered, so a signed deployment never flashes an anonymous shell", () => {
    expect(signInGate({ posture: { status: "pending" }, session: "anonymous" })).toEqual({
      surface: "hold",
      redirectToLogin: false,
    })
  })

  // The state the whole three-way split exists for. An unreadable declaration
  // is not "this server has no accounts": every way a read ends without an
  // answer — refused, undeclared, unreachable — can happen to a deployment that
  // requires a signed session, and rendering through would put its shell in
  // front of someone who never signed in.
  test("refuses to render the shell when the declaration could not be read", () => {
    expect(signInGate({ posture: { status: "unreadable", reason: "It refused the request (HTTP 503)." }, session: "anonymous" })).toEqual({
      surface: "unreadable",
      reason: "It refused the request (HTTP 503).",
    })
  })

  test("an unreadable declaration holds even for a signed session, because the rule it would satisfy is unknown", () => {
    expect(signInGate({ posture: { status: "unreadable", reason: "It could not be reached." }, session: "signed" }).surface).toBe(
      "unreadable",
    )
  })

  test("a server that declares it issues no sessions renders the shell for a visitor with none", () => {
    expect(signInGate({ posture: { status: "declared", issuesSessions: false }, session: "anonymous" })).toEqual({
      surface: "shell",
    })
  })

  test("a server that issues sessions sends an anonymous visitor to /login", () => {
    expect(signInGate({ posture: { status: "declared", issuesSessions: true }, session: "anonymous" })).toEqual({
      surface: "hold",
      redirectToLogin: true,
    })
  })

  test("a session still loading holds without redirecting, so a reload does not bounce a signed user", () => {
    expect(signInGate({ posture: { status: "declared", issuesSessions: true }, session: "loading" })).toEqual({
      surface: "hold",
      redirectToLogin: false,
    })
  })

  test("a signed session on a session-issuing server renders the shell", () => {
    expect(signInGate({ posture: { status: "declared", issuesSessions: true }, session: "signed" })).toEqual({
      surface: "shell",
    })
  })
})
