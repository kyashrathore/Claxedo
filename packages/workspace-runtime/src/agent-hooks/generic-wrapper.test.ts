import { expect, test } from "bun:test"
import { generateGenericWrapper } from "./core/wrappers"

test("the generic wrapper produces canonical Busy, Idle and Error fields", () => {
  const script = generateGenericWrapper("custom-tool", "/tmp/notify.sh")
  for (const eventType of ["Busy", "Idle", "Error"]) expect(script).toContain(JSON.stringify({ eventType }))
})
