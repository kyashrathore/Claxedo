import { describe, expect, test } from "bun:test"
import {
  decodeSessionEnvErrorBody,
  decodeSessionEnvExecFrame,
  decodeSessionEnvExistsResponse,
  decodeSessionEnvReadFileResponse,
  decodeSessionEnvReaddirResponse,
  decodeSessionEnvStatResponse,
  WorkspaceRuntimeProtocolError,
} from "./session-env-contract"

describe("session-env wire contract", () => {
  test("decodes canonical successful responses", () => {
    expect(decodeSessionEnvReadFileResponse({ encoding: "base64", content: "aGVsbG8=" })).toEqual({
      encoding: "base64",
      content: "aGVsbG8=",
    })
    expect(decodeSessionEnvExistsResponse({ exists: false })).toEqual({ exists: false })
    expect(
      decodeSessionEnvStatResponse({
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        size: 5,
        mtimeMs: 10,
      }),
    ).toEqual({
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      size: 5,
      mtimeMs: 10,
    })
    expect(decodeSessionEnvReaddirResponse(["a", "b"])).toEqual(["a", "b"])
    expect(decodeSessionEnvExecFrame({ type: "exit", exitCode: 0, signal: null })).toEqual({
      type: "exit",
      exitCode: 0,
      signal: null,
    })
  })

  test.each([
    ["error code", () => decodeSessionEnvErrorBody({ error: { code: "typo", message: "bad" } })],
    ["readFile", () => decodeSessionEnvReadFileResponse({})],
    ["readFile base64", () => decodeSessionEnvReadFileResponse({ encoding: "base64", content: "%%%" })],
    ["exists", () => decodeSessionEnvExistsResponse({})],
    ["stat", () => decodeSessionEnvStatResponse({ isFile: true })],
    ["readdir", () => decodeSessionEnvReaddirResponse(["ok", 3])],
    ["exec frame", () => decodeSessionEnvExecFrame({ type: "stdout" })],
    ["exec frame type", () => decodeSessionEnvExecFrame({ type: "mystery", data: "" })],
  ])("rejects malformed %s responses", (_name, decode) => {
    expect(decode).toThrow(WorkspaceRuntimeProtocolError)
  })

  test("decodes canonical error codes", () => {
    expect(
      decodeSessionEnvErrorBody({
        error: { code: "session_env_operation_failed", message: "failed" },
      }),
    ).toEqual({ error: { code: "session_env_operation_failed", message: "failed" } })
  })
})
