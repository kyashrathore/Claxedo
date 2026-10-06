import { expect, test } from "bun:test"
import { sandboxKeysFromWire } from "./sandbox-keys"

const listing = { drivers: [], keys: [], can_manage: false, default_driver: "boat", managed_driver: "boat" }

test("the sandbox listing carries the machine sizes the new-workspace driver offers, in size order, and none it does not know", () => {
  expect(sandboxKeysFromWire({ ...listing, machine_classes: ["large", "huge", "small", "default"] })).toMatchObject({ machineClasses: ["small", "default", "large"] })
  expect(sandboxKeysFromWire({ ...listing, machine_classes: [] })).toMatchObject({ machineClasses: [] })
  expect(sandboxKeysFromWire(listing)).toMatchObject({ machineClasses: [] })
})
