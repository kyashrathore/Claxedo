import { expect, test } from "vitest"
import { workspaceRuntimeBootEnv } from "./runtime-env"

test("boot env preserves target, workspace, and operator control precedence", () => {
  const env = workspaceRuntimeBootEnv({
    workspaceId: "ws-1",
    hostId: "host-1",
    directory: "/workspace",
    port: 4096,
    host: "0.0.0.0",
    source: { kind: "git", repoUrl: "https://example.com/repo.git", branch: "main" },
    env: {
      WORKSPACE_RUNTIME_DIRECTORY: "/custom",
      WORKSPACE_RUNTIME_RUNNER: "workspace-runner",
      WORKSPACE_RUNTIME_RELAY_JWKS_URL: "https://workspace.test/jwks",
      CUSTOM: "kept",
    },
    runner: "operator-runner",
    controlEnv: {
      relayJwksUrl: "https://operator.test/jwks",
      relayVerifyPem: "public-key",
      managementJwksUrl: "https://management.test/jwks",
      sessionAuthorityUrl: "https://authority.test",
    },
  })
  expect(env).toEqual({
    WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-1",
    WORKSPACE_RUNTIME_HOST_ID: "host-1",
    WORKSPACE_RUNTIME_DIRECTORY: "/custom",
    WORKSPACE_RUNTIME_PORT: "4096",
    WORKSPACE_RUNTIME_HOST: "0.0.0.0",
    WORKSPACE_RUNTIME_SOURCE_KIND: "git",
    WORKSPACE_RUNTIME_GIT_REPO_URL: "https://example.com/repo.git",
    WORKSPACE_RUNTIME_GIT_BRANCH: "main",
    WORKSPACE_RUNTIME_RUNNER: "operator-runner",
    WORKSPACE_RUNTIME_RELAY_JWKS_URL: "https://operator.test/jwks",
    WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: "public-key",
    WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: "https://management.test/jwks",
    WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: "https://authority.test",
    CUSTOM: "kept",
  })
})

test.each([
  "WORKSPACE_RUNTIME_WORKSPACE_ID",
  "WORKSPACE_RUNTIME_HOST_ID",
  "WORKSPACE_RUNTIME_RELAY_WORKSPACE_IDS",
])("boot env refuses caller env that restates runtime identity key %s", (key) => {
  expect(() => workspaceRuntimeBootEnv({
    workspaceId: "ws-1",
    hostId: "host-1",
    directory: "/workspace",
    port: 4096,
    env: { [key]: "foreign" },
  })).toThrow(key)
})

test("boot env keeps caller env that does not touch runtime identity", () => {
  const env = workspaceRuntimeBootEnv({
    workspaceId: "ws-1",
    hostId: "host-1",
    directory: "/workspace",
    port: 4096,
    env: { CUSTOM: "kept", WORKSPACE_RUNTIME_DIRECTORY: "/custom" },
  })
  expect(env.WORKSPACE_RUNTIME_HOST_ID).toBe("host-1")
  expect(env.WORKSPACE_RUNTIME_WORKSPACE_ID).toBe("ws-1")
  expect(env.CUSTOM).toBe("kept")
})

test("absent operator settings preserve supplied values without inventing optional env keys", () => {
  expect(workspaceRuntimeBootEnv({
    workspaceId: "ws-1",
    directory: "/workspace",
    port: 4096,
    env: { WORKSPACE_RUNTIME_RUNNER: "injected" },
    runner: "",
    controlEnv: { relayJwksUrl: "" },
  })).toEqual({
    WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-1",
    WORKSPACE_RUNTIME_DIRECTORY: "/workspace",
    WORKSPACE_RUNTIME_PORT: "4096",
    WORKSPACE_RUNTIME_SOURCE_KIND: "empty",
    WORKSPACE_RUNTIME_RUNNER: "injected",
  })
})
