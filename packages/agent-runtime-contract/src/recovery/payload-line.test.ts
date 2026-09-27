import { readRecoveryPayloadLine, RECOVERY_PAYLOAD_PREFIX } from "./payload-line"
import { describe, test, expect } from "bun:test"

describe("reading a marked tool payload", () => {
  test("decodes the line the tool marked", () => {
    expect(readRecoveryPayloadLine(`Stopped.\n${RECOVERY_PAYLOAD_PREFIX}{"ok":1}`)).toBe('{"ok":1}')
  })

  // The owner's prose comes first and can quote a marker back at the caller;
  // the tool writes its own payload last.
  test("takes the last marked line, not the first", () => {
    const text = [
      `The owner refused: ${RECOVERY_PAYLOAD_PREFIX}{"quoted":true}`,
      `${RECOVERY_PAYLOAD_PREFIX}{"payload":true}`,
    ].join("\n")
    expect(readRecoveryPayloadLine(text)).toBe('{"payload":true}')
  })

  test("text with no marker carries no payload", () => {
    expect(readRecoveryPayloadLine('Stopped.\n{"ok":1}')).toBeUndefined()
    expect(readRecoveryPayloadLine("")).toBeUndefined()
  })
})
