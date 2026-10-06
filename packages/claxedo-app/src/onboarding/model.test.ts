/// <reference types="bun" />
import { expect, test } from "bun:test"
import { executionBlock, executionChoices, executionPlan, offersConnectMachine } from "./model"

const repository = { kind: "repository", url: "https://github.com/acme/widgets" } as const
const folder = { kind: "folder", path: "/home/me/widgets" } as const
const desktop = { localExecution: true, machineName: "Ada's MacBook", cloudAvailable: false, machineConnected: undefined }
const signedDesktop = { localExecution: true, machineName: "Ada's MacBook", cloudAvailable: true, machineConnected: undefined }
const hosted = { localExecution: false, machineName: undefined, cloudAvailable: true, machineConnected: false }

test("a desktop offers its own machine, a signed one the cloud workspace too, and the web only the cloud workspace", () => {
  expect(executionChoices(desktop)).toEqual(["local"])
  expect(executionChoices(signedDesktop)).toEqual(["local", "cloud"])
  expect(executionChoices(hosted)).toEqual(["cloud"])
})

test("the web offers to connect a machine only once it knows no machine is connected; a desktop never does", () => {
  expect(offersConnectMachine(hosted)).toBe(true)
  expect(offersConnectMachine({ ...hosted, machineConnected: true })).toBe(false)
  expect(offersConnectMachine({ ...hosted, machineConnected: undefined })).toBe(false)
  expect(offersConnectMachine({ ...desktop, machineConnected: false })).toBe(false)
})

test("this machine is always ready; the cloud workspace needs a signed control plane and a repository", () => {
  expect(executionBlock(executionPlan("local", "", undefined), desktop, folder)).toBeUndefined()
  expect(executionBlock(executionPlan("cloud", "widgets", undefined), desktop, repository)).toBe("signIn")
  expect(executionBlock(executionPlan("cloud", "widgets", undefined), signedDesktop, folder)).toBe("folder")
  expect(executionBlock(executionPlan("cloud", "widgets", undefined), signedDesktop, repository)).toBeUndefined()
  expect(executionBlock(executionPlan("cloud", "", undefined), hosted, undefined)).toBeUndefined()
  expect(executionBlock(executionPlan("cloud", "widgets", "large"), hosted, { kind: "connectedRepository", connectionId: "gh_1", fullName: "acme/widgets" })).toBeUndefined()
})

test("the cloud plan carries the workspace name and the chosen machine size, and no size when the provider has one", () => {
  expect(executionPlan("cloud", "widgets", "large")).toEqual({ kind: "cloud", name: "widgets", machineClass: "large" })
  expect(executionPlan("cloud", "widgets", undefined)).toEqual({ kind: "cloud", name: "widgets" })
  expect(executionPlan("local", "widgets", "large")).toEqual({ kind: "local" })
})
