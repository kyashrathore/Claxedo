import { defineOperation, operationPath, requiredParameter, bodyField, selectBody } from "./operation-definition"
import { operationInput } from "./operation-input"
import { object, withArrays, withRecord } from "./hosted-output"

export const CREDENTIAL_OPERATIONS = {
  "credentials.sources.read": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/credentials/account-sources"),
    input: operationInput({}),
    output: withArrays("org"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "credentials.sources.set": defineOperation({
    method: "PUT", path: operationPath("/api/claxedo/credentials/account-sources"),
    input: operationInput({ provider_ids: bodyField, source: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("provider_ids", "source"),
  }),
  "credentials.sandbox.read": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/credentials/sandbox-drivers"),
    input: operationInput({}),
    output: withArrays("drivers", "keys"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "credentials.sandbox.choose": defineOperation({
    method: "PUT", path: operationPath("/api/claxedo/credentials/sandbox-drivers/default"),
    input: operationInput({ driver: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("driver"),
  }),
  "credentials.save": defineOperation({
    method: "PUT", path: operationPath("/api/claxedo/credentials"),
    input: operationInput({ provider_id: bodyField, kind: bodyField, source: bodyField, owner: bodyField, label: bodyField, secret: bodyField }),
    output: withRecord("credential", object), retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("provider_id", "kind", "source", "owner", "label", "secret"),
  }),
  "credentials.verify": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/credentials/:id/verify"),
    input: operationInput({ id: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
  }),
  "credentials.remove": defineOperation({
    method: "DELETE", path: operationPath("/api/claxedo/credentials/:id"),
    input: operationInput({ id: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
  }),
}
