import { hostedOperationTable, type HostedOperationName } from "@claxedo/account-contract"
import { DOCUMENTS_OPERATIONS } from "@claxedo/documents/operations"

/** The operations this desktop's account bridge serves: the core table, then each first-party plugin's. */
export const DESKTOP_HOSTED_OPERATIONS = hostedOperationTable(DOCUMENTS_OPERATIONS)

export type DesktopHostedOperationName = HostedOperationName<typeof DESKTOP_HOSTED_OPERATIONS.operations>
