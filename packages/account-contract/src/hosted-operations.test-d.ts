import type { DecodedHostedResult, HostedOperationInput } from "./hosted-operations"

type Equal<A, B> = (<T>(value: T) => T extends A ? 1 : 2) extends <T>(value: T) => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

type PluginInput = HostedOperationInput<"plugin.request">
type DocumentInput = HostedOperationInput<"documents.get">
type DocumentListInput = HostedOperationInput<"documents.list">

export type PluginMethodComesFromCodec = Assert<
  Equal<PluginInput["method"], "GET" | "POST" | "PUT" | "PATCH" | "DELETE">
>
export type PluginInputHasOnlyDeclaredFields = Assert<Equal<keyof PluginInput, "pluginId" | "method" | "path" | "body">>
export type DocumentIdIsRequired = Assert<Equal<{} extends DocumentInput ? true : false, false>>
export type DocumentIdComesFromCodec = Assert<Equal<DocumentInput["id"], string | number | boolean | bigint>>
export type DocumentScopeIsOptional = Assert<Equal<{} extends DocumentListInput ? true : false, true>>
export type PluginOutputComesFromCodec = Assert<
  Equal<DecodedHostedResult<"plugin.request">, { status: number; body?: unknown }>
>
