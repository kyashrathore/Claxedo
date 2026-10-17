import { defineOperation, operationPath, requiredParameter } from "./operation-definition"
import { operationInput } from "./operation-input"
import { withArrays } from "./hosted-output"

export const USAGE_OPERATIONS = {
  "usage.credentialSpend": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/usage/credentials", { query: ["since", "until", "scope"] }),
    input: operationInput({ since: requiredParameter, until: requiredParameter, scope: requiredParameter }),
    output: withArrays("credentials"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "usage.machineTime": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/usage/machine-time", { query: ["since"] }),
    input: operationInput({ since: requiredParameter }),
    output: withArrays("workspaces", "providers"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "usage.cloudFacts": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/usage/cloud-facts", { query: ["since", "until"] }),
    input: operationInput({ since: requiredParameter, until: requiredParameter }),
    output: withArrays("facts"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
}
