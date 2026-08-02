import { expect, test } from "bun:test"
import { codexAcpLaunch } from "./codex-config"

test("translates ordered legacy Codex flags into CODEX_CONFIG", () => {
  const launch = codexAcpLaunch([
    "-c",
    "model=gpt-5.5",
    "-c",
    'sandbox_workspace_write.writable_roots=["/workspace"]',
    "--config=model=gpt-5.6-sol",
    "--version",
  ], {
    CODEX_CONFIG: JSON.stringify({
      service_tier: "fast",
      sandbox_workspace_write: { network_access: true },
    }),
  })

  expect(launch.args).toEqual(["--version"])
  expect(JSON.parse(launch.env.CODEX_CONFIG!)).toEqual({
    service_tier: "fast",
    model: "gpt-5.6-sol",
    sandbox_workspace_write: {
      network_access: true,
      writable_roots: ["/workspace"],
    },
  })
})

test("preserves quoted dotted TOML keys", () => {
  const launch = codexAcpLaunch([
    "-c",
    'model_providers."corp.gateway".base_url="https://example.test"',
  ], {})

  expect(JSON.parse(launch.env.CODEX_CONFIG!)).toEqual({
    model_providers: {
      "corp.gateway": {
        base_url: "https://example.test",
      },
    },
  })
})

test("requires CODEX_CONFIG to contain a JSON object", () => {
  expect(() => codexAcpLaunch([], { CODEX_CONFIG: "null" })).toThrow("CODEX_CONFIG must be a JSON object")
  expect(() => codexAcpLaunch([], { CODEX_CONFIG: "[]" })).toThrow("CODEX_CONFIG must be a JSON object")
})
