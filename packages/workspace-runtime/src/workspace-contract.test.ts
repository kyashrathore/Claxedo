/**
 * Tests for workspace contract schema validation and fingerprinting.
 */

import { describe, expect, test } from "vitest"
import {
  WorkspaceContract,
  ProcessesContract,
  contractFingerprint,
} from "./workspace-contract"

describe("WorkspaceContract schema", () => {
  test("parses empty contract", () => {
    const result = WorkspaceContract.parse({})
    expect(result).toEqual({})
  })

  test("parses populated contract", () => {
    const result = WorkspaceContract.parse({
      source: { repo: "test/repo", branch: "main" },
      runtime: { node: "20", python: "3.12" },
      compute_class: "large",
      prepare: [
        { name: "install", command: "npm install", timeout_seconds: 300 },
      ],
      verify: [
        { name: "health", command: "curl http://localhost:3000/health" },
      ],
      cache: [
        { path: "node_modules", description: "npm deps" },
      ],
      acceleration: { snapshot: "auto", prepared_image: "manual" },
      secrets: [
        { name: "API_KEY", env_var: "API_KEY", required: true },
      ],
      network: [
        { target: "registry.npmjs.org", kind: "host" },
      ],
    })
    expect(result.runtime?.node).toBe("20")
    expect(result.compute_class).toBe("large")
    expect(result.prepare).toHaveLength(1)
    expect(result.verify).toHaveLength(1)
    expect(result.secrets).toHaveLength(1)
    expect(result.network).toHaveLength(1)
  })

  test("rejects invalid compute class", () => {
    expect(() =>
      WorkspaceContract.parse({ compute_class: "mega" }),
    ).toThrow()
  })

  test("defaults acceleration policies", () => {
    const result = WorkspaceContract.parse({
      acceleration: {},
    })
    expect(result.acceleration?.snapshot).toBe("auto")
    expect(result.acceleration?.prepared_image).toBe("auto")
  })
})

describe("ProcessesContract schema", () => {
  test("parses service with defaulted fields", () => {
    const result = ProcessesContract.parse({
      services: [{ name: "dev", command: "npm run dev" }],
    })
    expect(result.services).toHaveLength(1)
    expect(result.services[0].auto_start).toBe(false)
    expect(result.services[0].restart_policy).toBe("on-failure")
  })

  test("parses populated service definition", () => {
    const result = ProcessesContract.parse({
      services: [
        {
          name: "api",
          command: "node",
          args: ["server.js"],
          cwd: "./api",
          env: { NODE_ENV: "production" },
          port: 3000,
          auto_start: true,
          restart_policy: "always",
          depends_on: ["db"],
          readiness: {
            type: "http",
            target: "http://localhost:3000/health",
            interval_seconds: 10,
            timeout_seconds: 60,
            retries: 5,
          },
        },
      ],
    })
    expect(result.services[0].port).toBe(3000)
    expect(result.services[0].readiness?.type).toBe("http")
  })

  test("rejects empty service name", () => {
    expect(() =>
      ProcessesContract.parse({
        services: [{ name: "", command: "echo" }],
      }),
    ).toThrow()
  })
})

describe("contractFingerprint", () => {
  test("produces same hash for same input", () => {
    const contract: any = {
      runtime: { node: "20" },
      compute_class: "medium",
      prepare: [{ name: "install", command: "npm install" }],
    }
    const h1 = contractFingerprint(contract)
    const h2 = contractFingerprint(contract)
    expect(h1).toBe(h2)
  })

  test("changes when runtime changes", () => {
    const base: any = {
      runtime: { node: "20" },
      prepare: [{ name: "install", command: "npm install" }],
    }
    const changed: any = {
      runtime: { node: "22" },
      prepare: [{ name: "install", command: "npm install" }],
    }
    expect(contractFingerprint(base)).not.toBe(contractFingerprint(changed))
  })

  test("changes when prepare changes", () => {
    const base: any = {
      runtime: { node: "20" },
      prepare: [{ name: "install", command: "npm install" }],
    }
    const changed: any = {
      runtime: { node: "20" },
      prepare: [{ name: "install", command: "yarn install" }],
    }
    expect(contractFingerprint(base)).not.toBe(contractFingerprint(changed))
  })

  test("ignores verify and secrets changes", () => {
    const base: any = {
      runtime: { node: "20" },
      compute_class: "small",
      prepare: [{ name: "install", command: "npm install" }],
      verify: [{ name: "check", command: "echo ok" }],
    }
    const changed: any = {
      runtime: { node: "20" },
      compute_class: "small",
      prepare: [{ name: "install", command: "npm install" }],
      verify: [{ name: "check", command: "curl localhost" }],
      secrets: [{ name: "KEY", env_var: "KEY", required: true }],
    }
    expect(contractFingerprint(base)).toBe(contractFingerprint(changed))
  })
})
