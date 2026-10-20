import { hostedOperationTable, type DecodedHostedResult, type HostedOperationInput, type HostedOperationName } from "./hosted-operations"
import { defineOperation, object, operationInput, operationPath, requiredParameter } from "./operation-definition"

type Equal<A, B> = (<T>(value: T) => T extends A ? 1 : 2) extends <T>(value: T) => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

type PluginInput = HostedOperationInput<"plugin.request">

export type PluginMethodComesFromCodec = Assert<
  Equal<PluginInput["method"], "GET" | "POST" | "PUT" | "PATCH" | "DELETE">
>
export type PluginInputHasOnlyDeclaredFields = Assert<Equal<keyof PluginInput, "pluginId" | "method" | "path" | "body">>
export type PluginOutputComesFromCodec = Assert<
  Equal<DecodedHostedResult<"plugin.request">, { status: number; body?: unknown }>
>

const composed = hostedOperationTable({
  "fixture.read": defineOperation({
    method: "GET", path: operationPath("/fixture/:id"),
    input: operationInput({ id: requiredParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
})
type Composed = typeof composed.operations

export type PluginOperationKeepsItsInput = Assert<Equal<HostedOperationInput<"fixture.read", Composed>["id"], string | number | boolean | bigint>>
export type ComposedTableKeepsCoreNames = Assert<Equal<"account.mode" extends HostedOperationName<Composed> ? true : false, true>>
