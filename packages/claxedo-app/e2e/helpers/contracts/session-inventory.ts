import { sessionInventoryResponse } from "../../../../claxedo-server/src/session/list"

export function emptySessionInventoryResponse() {
  return sessionInventoryResponse([])
}
