import { asRecord, asString } from "@claxedo/helpers/guards"
import type { SandboxDriverField, SandboxDriverOption, SandboxKeys } from "../account-types"
import type { MachineClass } from "../cloud-types"
import { accountFromWire, rowsFromWire } from "./accounts"

function fieldFromWire(value: unknown): SandboxDriverField | undefined {
  const row = asRecord(value)
  const key = asString(row?.key)
  const label = asString(row?.label)
  return key && label ? { key, label, secret: row?.secret === true } : undefined
}

function driverFromWire(value: unknown): SandboxDriverOption | undefined {
  const row = asRecord(value)
  const id = asString(row?.id)
  const label = asString(row?.label)
  const fields = rowsFromWire(row, "fields", fieldFromWire)
  return id && label && fields ? { id, label, fields } : undefined
}

const MACHINE_CLASSES: readonly MachineClass[] = ["small", "default", "large"]

function machineClassesFromWire(value: unknown): readonly MachineClass[] {
  return Array.isArray(value) ? MACHINE_CLASSES.filter((machineClass) => value.includes(machineClass)) : []
}

export function sandboxKeysFromWire(value: unknown): SandboxKeys | undefined {
  const row = asRecord(value)
  const drivers = rowsFromWire(value, "drivers", driverFromWire)
  const keys = rowsFromWire(value, "keys", accountFromWire)
  if (!row || !drivers || !keys || typeof row.can_manage !== "boolean") return undefined
  const defaultDriver = asString(row.default_driver)
  const managedDriver = asString(row.managed_driver)
  return {
    kind: "listed",
    drivers,
    keys,
    canManage: row.can_manage,
    machineClasses: machineClassesFromWire(row.machine_classes),
    ...(defaultDriver ? { defaultDriver } : {}),
    ...(managedDriver ? { managedDriver } : {}),
  }
}
