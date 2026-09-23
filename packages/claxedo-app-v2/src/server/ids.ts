declare const brand: unique symbol

type Branded<Name extends string> = string & { readonly [brand]: Name }

export type ProjectId = Branded<"ProjectId">
export type PlacementId = Branded<"PlacementId">
export type SessionId = Branded<"SessionId">
export type MachineId = Branded<"MachineId">
export type UserId = Branded<"UserId">
export type OrgId = Branded<"OrgId">
export type RequestId = Branded<"RequestId">
export type TerminalId = Branded<"TerminalId">

export const projectId = (value: string) => value as ProjectId
export const placementId = (value: string) => value as PlacementId
export const sessionId = (value: string) => value as SessionId
export const machineId = (value: string) => value as MachineId
export const userId = (value: string) => value as UserId
export const orgId = (value: string) => value as OrgId
export const requestId = (value: string) => value as RequestId
export const terminalId = (value: string) => value as TerminalId
