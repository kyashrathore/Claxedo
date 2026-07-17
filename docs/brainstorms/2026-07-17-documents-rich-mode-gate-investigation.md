# Investigation: should the Documents rich-mode byte-exact gate change?

Date: 2026-07-17. Branch `codex/feat-documents-core`. All measurements ran
against the real `detectMarkdown` / `MarkdownManager` pipeline pinned at
`@tiptap/markdown@3.23.4` via a temporary `probe.vitest.ts` executed with
`bun run test:vitest` (probe archived outside the repo; every number below is
from actual runs, commands and raw output quoted where it matters).

## Verdict up front

**Keep the byte-exact gate. Kill the semantic-equivalence gate and the
permissive mode with prejudice — the pinned serializer does not merely
normalize, it corrupts content. The serializer-config hypothesis is dead as a
primary fix (2.6% of the mismatch bucket, 0% of `docs/**`). The path that
actually moves the number is: (1) fix two serializer *fidelity bugs* — HTML
entity encoding and bare-URL autolink wrapping — which together account for
~42% of all round-trip mismatches and flip those files to rich with zero
contract change; then (2) ship the consent flow ("Format this document for
rich editing?") with a diff preview for everything that remains.**

## Q1 — How bad is it, empirically?

Corpus: every `*.md` in the repo (excluding `node_modules`, `.git`, `dist`,
`build`, `.next`, `coverage`, `.turbo`, `.bun`). 5,235 files.

```
status: {"source":4071,"rich":1164}
reasons: { "roundtrip_mismatch": 2890, "unsupported_syntax": 1181 }
```

No file hit `crlf_body`, `rich_limit_exceeded`, `complexity_limit_exceeded`,
`parser_failed`, or rejection. Per-bucket (the whole-repo number is inflated by
`.claude/worktrees/**` and cache duplicates — "dot-vendored"):

| bucket | files | rich | roundtrip_mismatch | unsupported_syntax |
|---|---|---|---|---|
| `docs/**` | 64 | 2 (3.1%) | 33 | 29 |
| `packages/**` | 1629 | 102 (6.3%) | 1456 | 71 |
| dot-vendored | 3526 | 1059 | 1393 | 1074 |
| other | 16 | 1 | 8 | 7 |

So for real product-relevant corpora, rich admission is **3–6%**, confirming
"rich mode is effectively dead for documents not written by Tiptap itself."
The `docs/**` number matches the fidelity report already in
`packages/claxedo-app/src/features/documents/markdown/contract.md` (2/61 on
2026-07-17), which also establishes the gate was a **deliberate, argued
decision** — the contract explicitly says "There is no syntax-wide
normalization allowance in the admission comparison" and explains why (first
mutation must not rewrite unrelated regions). Git history concurs: the
detector landed whole with the Documents feature (`115def4fbf`) and was
hardened once (`c960f799bf`); byte-exactness was never an accident.

### `roundtrip_mismatch` broken down by cause

Classified by the **first differing line** between the input and the actual
pinned-serializer output for each of the 2,890 mismatch files (not by regex
guessing over the source):

| cause | all | docs/** | note |
|---|---|---|---|
| entity_encoding | 1170 (40%) | 2 | serializer emits `&amp;` for `&`, `&gt;` for `>`, etc. |
| blank_lines | 1091 (38%) | 11 | see Q5 — quantized representation |
| indentation | 430 (15%) | 19 | mostly list-continuation indent widths |
| emphasis_delim | 90 (3%) | 0 | `_x_` vs `*x*` |
| autolink | 52 (2%) | 0 | bare URL → `[url](url)` |
| other | 54 (2%) | 1 | includes real corruption — see Q3 |
| bullet_char | 2 | 0 | `* ` vs `- ` — nearly nonexistent in practice |
| ordered_delim | 1 | 0 | `1)` vs `1.` |

The headline surprise: **the canonical demo failures (asterisk bullets,
underscore emphasis, paren-ordered lists) are statistically irrelevant** —
93 files out of 2,890. The mass is entity encoding, blank lines, and
indentation.

## Q2 — Can the serializer be configured per document? (verdict: NO as a fix, YES as a technique)

What `@tiptap/markdown@3.23.4` exposes: the `MarkdownManager` constructor
takes only `marked`, `markedOptions`, `indentation: {style: 'space'|'tab',
size}`, and `extensions`. **No** bullet-marker / emphasis-delimiter /
ordered-delimiter options exist. `- ` is hard-coded in `listItem`'s
`renderMarkdown` (`@tiptap/extension-list`), `*` in `italic`'s
(`@tiptap/extension-italic`).

However, per-document override is mechanically possible: `renderMarkdown` is
an extension config field, `renderNestedMarkdownContent` is exported from
`@tiptap/core`, and the manager resolves handlers per node name in
**registration order** (`handlers[0]` wins), so patched extensions listed
before `StarterKit` take precedence. (Trap for anyone reproducing this:
`flattenExtensions([StarterKit])` includes `starterKit` itself, and the
manager re-expands it — replacing a child inside the flattened array does
nothing; you must *prepend* the patched extension.) A probe manager built this
way, with conventions inferred from each document's source, round-trips all
four canonical inputs byte-exactly:

```
asterisk bullets:      variantRoundtrip=EXACT
underscore emphasis:   variantRoundtrip=EXACT
paren ordered:         variantRoundtrip=EXACT
tab nested list:       variantRoundtrip=EXACT   (this one needs only the public indentation option)
```

But over the real mismatch bucket:

```
byte-exact with inferred variant serializer: 75 / 2890   (docs/**: 0)
additionally byte-exact modulo blank lines:  206
```

**2.6%.** The hypothesis is killed as a primary fix — the causes it addresses
are the statistically irrelevant ones. Blank lines it "almost certainly
cannot" fix, confirmed. Indentation it mostly cannot fix either (real files
mix list-continuation widths that a single per-document indent setting cannot
express). The *technique* — registration-order extension patching against the
pinned version — survives and is exactly what the fidelity fixes in the
recommendation use.

## Q3 — Is a semantic-equivalence gate sound? (verdict: NO — empirically unsound)

Measured: `parse(serialize(parse(x)))` deep-equals `parse(x)` for
**2513 / 2890 (87%)** of mismatch files. A semantic gate would therefore admit
almost the whole bucket. That is precisely the problem, because equality is
computed *after* the lossy first parse — parse-time loss is invisible to it.
Concrete admissions, all from the real pipeline:

| input | serializer output | semantic gate admits? |
|---|---|---|
| `### Question\n\nNo.\n` | `### Question\n\nN\no.\n` — **corrupts "No." into two lines** | **YES** |
| ``both Dockerfiles `COPY\n.build/` and symlink`` | joins the wrapped lines — reflows prose | **YES** |
| `Tech Debt & Architecture` | `Tech Debt &amp; Architecture` | **YES** |
| `See https://example.com for details.` | `See [https://example.com](https://example.com) for details.` | **YES** |
| `a\n\n&nbsp;\n\nb\n` (the known poison) | `a\n\n\n\nb\n` | **YES** |
| `[![badge](img)](link)` | `![badge](img)` — **outer link destroyed** | no (loss visible on reparse) |

The `No.` → `N\no.` case (found in the wild in
`packages/opencode/specs/effect/facades.md` copies) is disqualifying on its
own: a semantic gate would open that file in rich mode and the first keystroke
would commit the corruption to disk in a diff the user never made. It also
breaks CAS hygiene: the first human edit becomes a whole-file reformat, so a
concurrent agent's If-Match retry rebases its small edit onto a file where
*every* line moved — the exact failure the contract's "first-mutation
serialization must not rewrite unrelated regions" clause exists to prevent.
And the gate is not even convergent: `a\n\n&nbsp;\n\nb` → `a\n\n\n\nb` →
(next open/save) → `a\n\nb`. Bytes keep changing across sessions with zero
user edits. The adversarial fixtures would not save us — they pin *rejection*
of these inputs; a semantic gate is a decision to stop rejecting them.

## Q4 — What do comparable products do?

Three parallel research sweeps (source-anchored editors; web/import-export
tools; AST-based editors and frameworks), citations in-line:

- **Byte-safe products are byte-safe because they never reserialize.**
  Obsidian Live Preview is CodeMirror 6 decorations over the raw text — the
  buffer IS the file (docs.obsidian.md/Plugins/Editor/Editor+extensions).
  HackMD/CodiMD is a source editor and closed WYSIWYG as **wontfix**
  (github.com/hackmdio/codimd/issues/375). StackEdit edits raw text
  ("cledit"). VS Code/Zed have no markdown WYSIWYG at all; normalization only
  enters via an explicitly installed formatter (Prettier), on save, never on
  open.
- **Every parse-to-model product normalizes, silently, and users hate it.**
  Typora's tracker is a decade of "stop rewriting my markdown" (deleted blank
  lines #73, list renumbering #1188, blank lines injected across lists #5228)
  and its remediation was to progressively *disable* normalization. MarkText:
  "the default style ... is applied" on save, files modified without edits,
  "not planned to change" (marktext #2189, #2148). Milkdown (remark-based)
  injects escapes (`[` → `\[`, milkdown #1278). Notion discards original
  bytes at import. A directly-on-point incident: DesktopCommanderMCP
  "silently rewrites .md files via Tiptap-based markdown round-trip" —
  corrupted frontmatter, escaped brackets, stripped blank lines
  (DesktopCommanderMCP #440).
- **No parse-to-AST editor achieves byte-exact round-trip. None.** jgm
  (CommonMark): AST→md→AST round-trip "certainly not" for most ASTs
  (talk.commonmark.org/t/3959). remark's own docs: "complete roundtripping is
  impossible" (mdast-util-to-markdown README). Trivia-preserving parsing
  exists only outside the JS editor world (Markdig roundtrip mode, .NET).
- **Nobody has shipped normalize-on-consent.** The closest analogs are
  Dendron's user-invoked Doctor command and VS Code's "consent = you installed
  the formatter." Claxedo's strict-gate-plus-consent design would be, as far
  as this research found, honest in a way no shipping parse-to-model editor
  currently is — and the industry's failure mode (silent rewriting) is
  exactly what the current detector already refuses.

## Q5 — Blank lines: separable, partially fixable, not fully preservable

New finding, sharper than "the AST has no representation": **it has one, but
it is quantized and the serializer poisons it.** `MarkdownManager.parse()`
always converts blank-line runs into implicit empty `paragraph` nodes
(`parseTokens(tokens, true)` → `createImplicitEmptyParagraphsFromSpace`,
count = `⌊separators⌋ − 1` interior). Measured parity table (`a<newlines>b`):

```
newlines=1 rich   serialized "a\nb"        exact
newlines=2 rich   serialized "a\n\nb"      exact
newlines=3 SOURCE serialized "a\n\nb"      one newline lost
newlines=4 rich   serialized "a\n\n\n\nb"  exact  ← empty paragraph round-trips!
newlines=5 SOURCE serialized "a\n\n\n\nb"  one newline lost
newlines=6 SOURCE serialized "a\n\n\n\n&nbsp;\n\nb"  ← the &nbsp; POISON, reproduced
```

So: k interior empty paragraphs ↔ exactly 2k+2 newlines. Runs of 2 and 4
newlines already round-trip byte-exactly *today*; odd runs are off-by-one
unrepresentable; **runs producing two adjacent empty paragraphs make the
serializer emit a literal `&nbsp;`** — this is the mechanical origin of
established finding 4's poison (Enter-Enter in rich mode → save → reopen →
source-locked). Leading/trailing runs round-trip via the envelope's
trailing-LF policy. Arbitrary-run preservation would require a raw-preserving
node, but the manager consumes `space` tokens *before* extension handlers run
(hard-coded in `parseTokens`), so that means subclassing/forking the pinned
manager — not worth it. Conclusion: blank-line loss for odd runs is
unavoidable in this stack; treat it as part of the consent normalization, and
independently consider pinning a fix for the `&nbsp;` injection (it is a
serializer artifact, and it is what *creates* poisoned files from rich-mode
editing today).

## Recommendation

Ranked, with contract implications:

1. **Fidelity fixes to the pinned serializer (do first — no contract change,
   no consent, largest win).** Using the registration-order `extend()`
   technique validated in Q2, patch, in the single extension list the
   Documents editor mounts:
   - text escaping: stop entity-encoding `&`, `<`, `>` in plain text where
     the encoding is not required for reparse correctness (1,170 files, 40%
     of the bucket);
   - link rendering: serialize a link whose text equals its href as the bare
     URL (52 files, 2%).
   Each fix makes `serialize(parse(x)) === x` for files whose only mismatch
   was that rewrite, so they flip to rich **under the unchanged byte-exact
   gate**. The detector, CAS, and no-write-on-open are untouched — this is
   strictly a better serializer under the same authority. Ceiling: ~42% of
   mismatches; realistically lower where causes co-occur — the corpus probe
   should be re-run after the patch to get the real number. Fixture work:
   new supported-corpus fixtures pinning `&`, `->`, bare-URL round-trips;
   the production-parity test already sweeps `docs/**` and will catch
   regressions. Risk to check in the prototype: original bytes that contain
   literal entities (`AT&amp;T`) must still serialize as `&amp;` — those
   files simply stay source, which is correct.

2. **Consent normalization for the rest ("Format this document for rich
   editing?").** One-time, explicit, from source mode. Mechanics that keep
   the contract honest:
   - normalized bytes = `serialize(parse(x))` from the *fixed* serializer;
   - admit only if the normalized bytes re-detect as `rich` (guarantees
     stability from then on — rules out the non-convergent cases in Q3);
   - **show a diff preview** in the consent dialog. This is non-negotiable
     given Q3: normalization with this serializer can corrupt (`No.` →
     `N\no.`, dropped badge links, joined wrapped lines). The user must see
     what changes before agreeing; both byte strings are already in hand.
   - the write goes through the normal CAS save path as a user-initiated
     edit — no write-on-open, agents see one honest edit.
   This also un-poisons existing `&nbsp;`-locked files (consent → normalize →
   blank runs collapse) without any forbidden repair-on-open.

3. **Do not build the semantic-equivalence gate** (Q3: admits real
   corruption, breaks first-edit diff hygiene, not convergent). **Do not
   ship permissive mode** (same evidence, minus even the one-time consent).
   **Do not pursue per-document convention inference** as a product feature
   (Q2: 2.6%); keep the technique only as the implementation vehicle for the
   fidelity fixes.

4. **Blank lines:** accept quantization; document in `contract.md` that
   2-newline and 4-newline separations round-trip and others normalize under
   consent. Evaluate a pinned-serializer patch for the `&nbsp;` injection
   (two adjacent empty paragraphs) since it manufactures poisoned files from
   ordinary rich-mode editing; if patched, add a fixture pinning
   Enter-Enter-save-reopen staying rich.

### What changes where (if the owner approves)

- `detector.ts`: nothing. The gate's semantics stay byte-exact.
- Serializer extension list (editor + detector share it per contract):
  patched text/link `renderMarkdown` overrides + tests pinning
  handler-precedence order (registration order is observed behavior of the
  pinned version, not documented API — pin it with a test).
- `contract.md`: add the fidelity-fix spellings to the rich subset ("`&`
  serializes unencoded", "self-link URLs serialize bare"), document blank-line
  quantization, update the fidelity report numbers after re-measuring.
- Fixtures: new supported-corpus entries (`&`, `->`, bare URLs, 4-newline
  separation); adversarial corpus unchanged — nothing that is rejected today
  becomes silently accepted; consent-path admissions are user-approved writes,
  not gate changes.
- New consent UI in `source-mode.tsx` / `document-editor.tsx` with the diff
  preview; vitest regression: "consent normalization only ever writes bytes
  that re-detect as rich", "declining consent changes nothing".

Open question for the owner: consent-with-diff is the recommended contract;
the alternative of consent-without-diff is cheaper but, given the serializer
demonstrably corrupts some inputs (`No.`), it would put Claxedo's name on
silent damage the user technically "agreed" to. Recommend diff.
