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
