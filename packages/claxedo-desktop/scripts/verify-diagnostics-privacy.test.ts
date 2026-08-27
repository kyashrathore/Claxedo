import { expect, test } from "bun:test"

import {
  findForbiddenDiagnosticsFields,
  verifyDiagnosticsPrivacy,
} from "./verify-diagnostics-privacy"

test("diagnostics DTO, transport, preload, and retired routes expose no sensitive target fields", async () => {
  expect((await verifyDiagnosticsPrivacy()).findings).toEqual([])
})

test("semantic boundary scan rejects argument, shell, computed, and evidence fields", async () => {
  expect(await findForbiddenDiagnosticsFields(`
    type Boundary = {
      args: string[]
      "shellText": string
      ["headers"]: Record<string, string>
    }
    const evidence = { commandLine: "secret" }
  `)).toEqual([
    { file: "fixture.ts", field: "args" },
    { file: "fixture.ts", field: "shellText" },
    { file: "fixture.ts", field: "headers" },
    { file: "fixture.ts", field: "commandLine" },
  ])
})

test("scoped semantic scan ignores unrelated preload APIs but rejects diagnostics evidence", async () => {
  expect(await findForbiddenDiagnosticsFields(`
    type BrowserBridge = { args: string[] }
    type DiagnosticsEvidence = { env?: Record<string, string> }
  `, "fixture.ts", ["DiagnosticsEvidence"])).toEqual([
    { file: "fixture.ts", field: "env" },
  ])
})
