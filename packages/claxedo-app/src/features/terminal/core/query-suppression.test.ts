import { describe, expect, test } from "bun:test"
import { createQuerySuppressor } from "./query-suppression"

describe("query suppression", () => {
  test("csi_R_is_suppressed", () => {
    const suppress = createQuerySuppressor()
    const out = suppress.scan("a\u001b[12;34Rb")
    expect(out).toBe("ab")
  })

  test("csi_c_not_suppressed", () => {
    const suppress = createQuerySuppressor()
    const out = suppress.scan("a\u001b[cb")
    expect(out).toBe("a\u001b[cb")
  })

  test("csi_t_not_suppressed", () => {
    const suppress = createQuerySuppressor()
    const out = suppress.scan("a\u001b[22;0tb")
    expect(out).toBe("a\u001b[22;0tb")
  })

  test("cpr_split_across_chunks_is_suppressed", () => {
    const suppress = createQuerySuppressor()
    const first = suppress.scan("prefix\u001b[12;")
    const second = suppress.scan("34Rtail")
    expect(first).toBe("prefix")
    expect(second).toBe("tail")
  })

  test("private_cpr_is_suppressed", () => {
    const suppress = createQuerySuppressor()
    const out = suppress.scan("a\u001b[?1;1Rb")
    expect(out).toBe("ab")
  })

  test("csi_dollar_y_is_suppressed", () => {
    const suppress = createQuerySuppressor()
    const out = suppress.scan("a\u001b[?2004;1$yb")
    expect(out).toBe("ab")
  })

  test("csi_dollar_y_split_across_chunks_is_suppressed", () => {
    const suppress = createQuerySuppressor()
    const first = suppress.scan("x\u001b[?2004;")
    const second = suppress.scan("1$yy")
    expect(first).toBe("x")
    expect(second).toBe("y")
  })

  test("dcs_decrqss_reply_is_suppressed", () => {
    const suppress = createQuerySuppressor()
    const out = suppress.scan("a\u001bP1$r0 q\u001b\\b")
    expect(out).toBe("ab")
  })

  test("dcs_xtgettcap_reply_is_suppressed", () => {
    const suppress = createQuerySuppressor()
    const out = suppress.scan("a\u001bP1+r6b6d3b3130\u001b\\b")
    expect(out).toBe("ab")
  })

  test("dcs_reply_split_across_chunks_is_suppressed", () => {
    const suppress = createQuerySuppressor()
    const first = suppress.scan("x\u001bP1$r")
    const second = suppress.scan("0 q\u001b\\y")
    expect(first).toBe("x")
    expect(second).toBe("y")
  })

  test("non_reply_dcs_is_not_suppressed", () => {
    const suppress = createQuerySuppressor()
    const seq = "\u001bPfoo\u001b\\"
    const out = suppress.scan(`a${seq}b`)
    expect(out).toBe(`a${seq}b`)
  })

  test("da_reply_secondary_is_suppressed", () => {
    const suppress = createQuerySuppressor()
    const out = suppress.scan("a\u001b[>0;136;0cb")
    expect(out).toBe("ab")
  })

  test("da_reply_primary_is_suppressed", () => {
    const suppress = createQuerySuppressor()
    const out = suppress.scan("a\u001b[?62;4;22cb")
    expect(out).toBe("ab")
  })

  // -------------------------------------------------------------------------
  // OSC (ESC ]) — pass-through with atomic buffering
  // Unlike DCS, OSC sequences are not suppressed; they pass through intact.
  // -------------------------------------------------------------------------

  test("osc_bel_terminated_passes_through", () => {
    const suppress = createQuerySuppressor()
    expect(suppress.scan("a\u001b]10;?\u0007b")).toBe("a\u001b]10;?\u0007b")
  })

  test("osc_st_terminated_passes_through", () => {
    const suppress = createQuerySuppressor()
    expect(suppress.scan("a\u001b]10;rgb:d4d4\u001b\\b")).toBe("a\u001b]10;rgb:d4d4\u001b\\b")
  })

  test("osc_split_before_bel_is_output_atomically_on_next_chunk", () => {
    const suppress = createQuerySuppressor()
    const first = suppress.scan("x\u001b]10;?")   // no terminator yet
    const second = suppress.scan("\u0007y")         // BEL arrives
    expect(first).toBe("x")
    expect(second).toBe("\u001b]10;?\u0007y")
  })

  test("osc_split_inside_st_terminator_is_output_atomically_on_next_chunk", () => {
    const suppress = createQuerySuppressor()
    // ESC arrives at end of first chunk; the \ arrives in the next
    const first = suppress.scan("x\u001b]10;rgb:d4d4\u001b")
    const second = suppress.scan("\\y")
    expect(first).toBe("x")
    expect(second).toBe("\u001b]10;rgb:d4d4\u001b\\y")
  })

  test("long_osc_split_past_old_tail_limit_is_output_atomically", () => {
    const suppress = createQuerySuppressor()
    const payload = "x".repeat(80)
    const first = suppress.scan(`pre\u001b]10;${payload}`)
    const second = suppress.scan("\u0007post")

    expect(first).toBe("pre")
    expect(second).toBe(`\u001b]10;${payload}\u0007post`)
  })

  test("long_dcs_reply_split_past_old_tail_limit_is_suppressed", () => {
    const suppress = createQuerySuppressor()
    const first = suppress.scan(`pre\u001bP1$r${"x".repeat(80)}`)
    const second = suppress.scan("\u001b\\post")

    expect(first).toBe("pre")
    expect(second).toBe("post")
  })
})
