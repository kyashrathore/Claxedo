/// <reference types="bun" />
import { expect, test } from "bun:test"
import { responseError } from "./errors"

const reply = (status: number, error: object) => new Response(JSON.stringify({ ok: false, error }), { status })

test("a harness that names why it has no options is not asked again", async () => {
  const error = await responseError(reply(502, { code: "harness_config_options_unavailable", message: "Cursor SDK requires an explicit cursor-sdk API key." }), "Model options")
  expect(error.class).toBe("network")
  expect(error.retryable).toBe(false)
  expect(error.message).toBe("Cursor SDK requires an explicit cursor-sdk API key.")
})

test("a gateway failure without a settled code is still retried", async () => {
  const error = await responseError(reply(502, { code: "upstream_timeout", message: "timed out" }))
  expect(error.retryable).toBe(true)
})

test("the server's explicit retry decision survives the HTTP error envelope", async () => {
  const error = await responseError(reply(503, { code: "auth_verifier_unavailable", message: "Application identity mapping is unavailable", retryable: false }))
  expect(error.retryable).toBe(false)
})

test("a 403 is a sign-in failure only when it names a token, proof or credential", async () => {
  const classes = await Promise.all([
    responseError(reply(401, { code: "session_expired", message: "expired" })),
    responseError(reply(403, { code: "relay_host_token_invalid", message: "invalid" })),
    responseError(reply(403, { code: "session_proof_required", message: "proof" })),
    responseError(reply(403, { code: "session_host_mismatch", message: "This session is served by another host" })),
    responseError(reply(403, { code: "session_private", message: "private" })),
    responseError(reply(403, { code: "relay_scope_denied", message: "scope" })),
    responseError(reply(403, { code: "terminal_role_denied", message: "role" })),
    responseError(new Response("Forbidden", { status: 403 })),
  ])
  expect(classes.map((error) => error.class)).toEqual(["auth", "auth", "auth", "forbidden", "forbidden", "forbidden", "forbidden", "forbidden"])
  expect(classes.every((error) => !error.retryable)).toBe(true)
})
