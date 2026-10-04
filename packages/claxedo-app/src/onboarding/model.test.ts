/// <reference types="bun" />
import { expect, test } from "bun:test"
import { executionBlock, executionChoices, executionPlan, offersConnectComputer } from "./model"

const repository = { kind: "repository", url: "https://github.com/acme/widgets" } as const
const folder = { kind: "folder", path: "/home/me/widgets" } as const
const desktop = { localExecution: true, cloudAvailable: false, machineConnected: undefined }
const signedDesktop = { localExecution: true, cloudAvailable: true, machineConnected: undefined }
const hosted = { localExecution: false, cloudAvailable: true, machineConnected: false }

test("a desktop offers this machine, a signed one the cloud workspace too, and the web only the cloud workspace", () => {
  expect(executionChoices(desktop)).toEqual(["local"])
  expect(executionChoices(signedDesktop)).toEqual(["local", "cloud"])
  expect(executionChoices(hosted)).toEqual(["cloud"])
})

test("the web offers to connect this computer only once it knows no machine is connected; a desktop never does", () => {
  expect(offersConnectComputer(hosted)).toBe(true)
  expect(offersConnectComputer({ ...hosted, machineConnected: true })).toBe(false)
  expect(offersConnectComputer({ ...hosted, machineConnected: undefined })).toBe(false)
  expect(offersConnectComputer({ ...desktop, machineConnected: false })).toBe(false)
})

test("this machine is always ready; the cloud workspace needs a signed control plane, a repository and a name", () => {
  expect(executionBlock(executionPlan("local", ""), desktop, folder)).toBeUndefined()
  expect(executionBlock(executionPlan("cloud", "Widgets"), desktop, repository)).toBe("signIn")
  expect(executionBlock(executionPlan("cloud", "Widgets"), signedDesktop, folder)).toBe("folder")
  expect(executionBlock(executionPlan("cloud", "   "), signedDesktop, repository)).toBe("name")
  expect(executionBlock(executionPlan("cloud", " Widgets "), signedDesktop, repository)).toBeUndefined()
  expect(executionBlock(executionPlan("cloud", "Widgets"), hosted, { kind: "connectedRepository", connectionId: "gh_1", fullName: "acme/widgets" })).toBeUndefined()
})

test("the cloud plan carries the trimmed name", () => {
  expect(executionPlan("cloud", " Payments ")).toEqual({ kind: "cloud", name: "Payments" })
  expect(executionPlan("local", "ignored")).toEqual({ kind: "local" })
})
