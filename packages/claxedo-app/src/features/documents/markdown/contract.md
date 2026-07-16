# Rich Markdown contract

The Documents rich editor accepts a UTF-8 Markdown file only when the exact
editor configuration can parse and serialize it without changing bytes. The
detector is a read-only gate: `rich` means the Tiptap document and its envelope
can reproduce the input; `source` keeps the original text and explains why the
gate declined it; `rejected` identifies content that is not an editable text
document.

`serializeMarkdownDocument` is also a typed boundary. It returns
`{ status: "serialized", markdown }` on success. An exception from the external
serializer returns the same stable `source` shape with `parser_failed` and the
original envelope bytes, so an invalid or pathological Tiptap tree cannot throw
through the Documents controller.

The implementation is pinned to `@tiptap/markdown@3.23.4` and uses the same
Tiptap node families as the Documents editor: StarterKit, images, GFM tables,
and task lists. Mermaid is represented by the standard code-block node with
`language: "mermaid"`, so fenced Mermaid blocks use the existing custom node
view while remaining ordinary fenced Markdown on disk.

## Rich subset

The fixture-pinned subset is:

- ATX headings, paragraphs, blockquotes, thematic breaks, and LF line endings;
- `**` bold, `*` italic, `~~` strike, inline code, inline links, and images;
- `-` bullet lists, `1.` ordered lists, and two-space nested list indentation;
- two-space hard breaks;
- backtick fenced code blocks with an optional language, including `mermaid`;
- `- [ ]` and `- [x]` task lists;
- pipe tables in the exact layout emitted by the pinned serializer.

Byte equality remains the final authority even for syntax in this list. A
non-canonical spelling opens in source mode.

Reference links, setext headings, HTML, footnotes, inline or block math, Liquid
templates, MDX modules, every complete brace expression, and two-way or diff3
merge-conflict markers are explicitly outside the rich subset. Brace
expressions include identifiers, numbers, comments, spreads, strings, and
arrays. The preflight scanner ignores all of these spellings inside fenced and
inline code. Autolinks, backslash hard breaks, alternate list markers,
underscore emphasis, and non-canonical tables are lossless Markdown but
normalize under the pinned serializer, so they also open in source mode.

## Byte envelope and normalization

The byte envelope consists of an optional UTF-8 BOM, optional frontmatter, the
Markdown body, and the body's trailing-LF policy.

- The BOM is removed before parsing and restored verbatim when serializing.
- Frontmatter starts with `---` on the first post-BOM line and closes with a
  line containing exactly `---` or `...`. It is retained as one opaque prefix,
  including its original LF/CRLF endings and one separator line after the
  closing delimiter. Values are never parsed, reordered, normalized, or
  requoted. A `...` closing delimiter and a closing delimiter at EOF are
  supported. An unterminated opening delimiter is body content, not
  frontmatter.
- CRLF in the body selects source mode. CRLF confined to opaque frontmatter is
  preserved and does not disqualify an otherwise byte-stable body.
- Unicode content is not normalized. NFC and NFD remain distinct byte strings.
- The number of trailing LF bytes is carried from the opened body to rich-mode
  saves. A missing trailing newline stays missing. Empty and whitespace-only
  documents round-trip exactly; deleting a non-empty document serializes to a
  zero-length body.

There is no syntax-wide normalization allowance in the admission comparison.
List markers, emphasis delimiters, indentation, table padding, and hard-break
spelling must already match the pinned serializer. This keeps first-mutation
serialization from rewriting unrelated regions. Files that would require any
such normalization remain source documents, where a one-paragraph edit changes
only the edited text.

## Size and text limits

- Invalid UTF-8 and strings containing NUL are rejected as
  `document_not_text` before parsing.
- Files through and including 512 KiB may enter rich mode.
- Files above 512 KiB and through and including 2 MiB open in source mode without invoking
  the rich parser.
- Files above 2 MiB are rejected as `document_too_large`.

NUL detection takes precedence over the hard size limit for both strings and
byte inputs. List items indented by more than 128 columns (tabs count as two)
short-circuit to `complexity_limit_exceeded`. Any exception from the pinned
parser or initial round-trip serializer, including a recursion `RangeError`,
becomes the stable `parser_failed` source-mode result. These external failures
never escape the detector.

On the 2026-07-16 local probe, median detector times across seven runs were
31.31 ms at 100 KiB, 63.54 ms at 500 KiB, 0.14 ms at 2 MiB (source
short-circuit), and 0.06 ms above 2 MiB (typed rejection). The focused test
allows a conservative one-second combined ceiling for the parsing probes.

## Fidelity report

The repository corpus currently contains 52 Markdown files under `docs/**`.
All 52 are protected by the byte-stability sweep. The measured rich-admission
rate is 0/52 (0.0%): 27 differ from the pinned serializer and 25 contain an
explicitly unsupported construct. This is a fidelity limitation, not a data
loss path; all 52 open in source mode and no file is serialized on open.

The adversarial corpus has zero known false negatives for reference links,
setext headings, HTML blocks, footnotes, math, Liquid, MDX, numeric/comment/
spread/string/array brace expressions, and two-way or diff3 merge markers. The
supported corpus proves byte-exact CommonMark, GFM tables/tasks, opaque code,
and Mermaid fences. The canonical repository fixture's first rich edit mutates
its Tiptap JSON and proves that the real serializer changes exactly the target
paragraph. The representative `docs/README.md` churn check separately confirms
that its source-mode one-paragraph edit changes one line and leaves the rest of
the file untouched.
