import { createContext, useContext } from "solid-js"

export type RowActionRole = "row-primary" | "row-secondary"

const RepeatedContext = createContext(false)
const RowActionRoleContext = createContext<RowActionRole | undefined>(undefined)

export const RepeatedProvider = RepeatedContext.Provider
export const RowActionRoleProvider = RowActionRoleContext.Provider

export function useRepeated(): boolean {
  return useContext(RepeatedContext)
}

export function useRowActionRole(): RowActionRole | undefined {
  return useContext(RowActionRoleContext)
}

export function isDestructiveIcon(icon: string | undefined): boolean {
  return icon === "delete"
}
