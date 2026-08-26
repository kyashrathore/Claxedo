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

  // -------------------------------------------------------------------------
  // Allocation guards. `scan` avoids rebuilding a chunk character by character:
  // an ESC-free chunk with no pending carry is returned unchanged, and literal
  // runs are copied as spans. Neither may change what `scan` emits, so these
  // pin the boundaries where a span/fast-path bug would first show up.
  // -------------------------------------------------------------------------

  test("esc_free_chunk_is_returned_unchanged", () => {
    const suppress = createQuerySuppressor()
    const chunk = "plain output with no escapes\r\n"
    expect(suppress.scan(chunk)).toBe(chunk)
    expect(suppress.tail()).toBe("")
  })

  test("empty_chunk_emits_nothing_and_keeps_carry_empty", () => {
    const suppress = createQuerySuppressor()
    expect(suppress.scan("")).toBe("")
    expect(suppress.tail()).toBe("")
  })

  test("esc_free_chunk_after_pending_carry_flushes_the_pending_sequence", () => {
    const suppress = createQuerySuppressor()
    // The fast path must not fire while a partial sequence is carried, or the
    // carried bytes would be dropped.
    expect(suppress.scan("a\u001b[12;")).toBe("a")
    expect(suppress.tail()).toBe("\u001b[12;")
    expect(suppress.scan("34Rtail")).toBe("tail")
    expect(suppress.tail()).toBe("")
  })

  test("literal_runs_around_suppressed_and_passed_sequences_are_preserved", () => {
    const suppress = createQuerySuppressor()
    const out = suppress.scan("one\u001b[12;34Rtwo\u001b[0mthree\u001b[>0;1;0cfour")
    expect(out).toBe("one" + "two" + "\u001b[0m" + "three" + "four")
  })

  test("consecutive_escapes_with_no_literal_between_them", () => {
    const suppress = createQuerySuppressor()
    expect(suppress.scan("\u001b[12;34R\u001b[?1;1R\u001b[0m")).toBe("\u001b[0m")
  })

  test("lone_esc_before_an_unknown_introducer_is_passed_through", () => {
    const suppress = createQuerySuppressor()
    expect(suppress.scan("a\u001bXb")).toBe("a\u001bXb")
    expect(suppress.scan("\u001b(B")).toBe("\u001b(B")
  })

  test("trailing_esc_is_carried_not_emitted", () => {
    const suppress = createQuerySuppressor()
    expect(suppress.scan("abc\u001b")).toBe("abc")
    expect(suppress.tail()).toBe("\u001b")
    expect(suppress.scan("[12;34Rz")).toBe("z")
  })

  test("carry_beyond_max_tail_is_flushed_verbatim", () => {
    const suppress = createQuerySuppressor({ maxTail: 8 })
    // An unterminated OSC longer than maxTail must be emitted, not held forever.
    const out = suppress.scan("pre\u001b]10;" + "x".repeat(64))
    expect(out).toBe("pre\u001b]10;" + "x".repeat(64))
    expect(suppress.tail()).toBe("")
  })

  test("byte_identical_across_every_two_chunk_split_of_a_mixed_stream", () => {
    // The span/fast-path logic must never depend on where a chunk boundary
    // lands, so assert the concatenated output is boundary-invariant.
    const stream = "a\u001b[12;34Rb\u001b]10;?\u0007c\u001bP1$r0 q\u001b\\d\u001b[0me\u001b[>0;1;0cf"
    const whole = createQuerySuppressor().scan(stream)
    for (let cut = 0; cut <= stream.length; cut++) {
      const suppress = createQuerySuppressor()
      const joined = suppress.scan(stream.slice(0, cut)) + suppress.scan(stream.slice(cut))
      expect({ cut, joined, tail: suppress.tail() }).toEqual({ cut, joined: whole, tail: "" })
    }
  })
})
