import { z } from "zod"
import { defaultRules } from "./policy"
import { registerLoadout } from "./loadout-registry"

registerLoadout("auto_policy", "default", z.object({
  rules: z.array(z.any()),
}), {
  rules: [...defaultRules],
}, {
  systemDefault: true,
})
