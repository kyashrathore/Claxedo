import type { HostedOperationInput } from "@claxedo/account-contract"
import type { DOCUMENTS_OPERATIONS } from "./operations"

type Equal<A, B> = (<T>(value: T) => T extends A ? 1 : 2) extends <T>(value: T) => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

type Documents = typeof DOCUMENTS_OPERATIONS
type DocumentInput = HostedOperationInput<"documents.get", Documents>
type DocumentListInput = HostedOperationInput<"documents.list", Documents>

export type DocumentIdIsRequired = Assert<Equal<{} extends DocumentInput ? true : false, false>>
export type DocumentIdComesFromCodec = Assert<Equal<DocumentInput["id"], string | number | boolean | bigint>>
export type DocumentScopeIsOptional = Assert<Equal<{} extends DocumentListInput ? true : false, true>>
