/// <reference types="bun" />
import { expect, test } from "bun:test"
import { executionBlock, executionChoices } from "./model"

const repository = { kind: "repository", url: "https://github.com/acme/widgets" } as const
const folder = { kind: "folder", path: "/home/me/widgets" } as const

test("an unsigned desktop offers no cloud row; a signed one offers it between this machine and another", () => {
  expect(executionChoices({ localExecution: true, cloudAvailable: false })).toEqual(["local", "connected"])
  expect(executionChoices({ localExecution: true, cloudAvailable: true })).toEqual(["local", "cloud", "connected"])
  expect(executionChoices({ localExecution: false, cloudAvailable: true })).toEqual(["cloud", "connected"])
})

test("this machine is ready only where local execution exists", () => {
  expect(executionBlock("local", { localExecution: true, cloudAvailable: false }, folder)).toBeUndefined()
  expect(executionBlock("local", { localExecution: false, cloudAvailable: true }, repository)).toBe("machine")
  expect(executionBlock("connected", { localExecution: false, cloudAvailable: true }, repository)).toBe("machine")
})

test("the cloud needs a signed control plane and a repository, never a local folder", () => {
  expect(executionBlock("cloud", { localExecution: true, cloudAvailable: false }, repository)).toBe("signIn")
  expect(executionBlock("cloud", { localExecution: true, cloudAvailable: true }, folder)).toBe("folder")
  expect(executionBlock("cloud", { localExecution: true, cloudAvailable: true }, repository)).toBeUndefined()
  expect(executionBlock("cloud", { localExecution: false, cloudAvailable: true }, { kind: "connectedRepository", connectionId: "gh_1", fullName: "acme/widgets" })).toBeUndefined()
})
