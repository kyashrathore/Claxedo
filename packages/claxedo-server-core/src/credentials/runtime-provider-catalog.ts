import { z } from "zod"

const model = z.object({
  providerID: z.string(), id: z.string(), name: z.string().optional(), variants: z.array(z.string()).optional(),
  cost: z.array(z.object({ input: z.number(), output: z.number() })),
})

export const runtimeProviderCatalog = z.array(z.object({
  id: z.string(), name: z.string(), env: z.array(z.string()), connected: z.boolean(), models: z.array(model),
}))
