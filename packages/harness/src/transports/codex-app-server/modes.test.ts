import { expect, test } from "bun:test"
import { CODEX_PERMISSION_MODES } from "@claxedo/agent-runtime-contract"
import { codexModeState, codexPermissionSettings, protocolModeMap } from "./modes"

test("every mode in the contract's Codex table sends its own approval policy and sandbox, and nothing else does", () => {
  expect(Object.keys(protocolModeMap).sort()).toEqual(CODEX_PERMISSION_MODES.modes.map((mode) => mode.id).sort())
})

test("a session that chose nothing, or a mode Codex no longer offers, runs the table's default", () => {
  expect(codexModeState(undefined)).toEqual({ modes: [...CODEX_PERMISSION_MODES.modes], currentModeId: "workspace-write", appliesFrom: "next-turn" })
  expect(codexPermissionSettings("plan")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" })
})
