# Icon libraries

Feature code uses semantic names from `catalog.ts` through `ClaxedoIcon` and
`ClaxedoIconButton`. It never imports a library-specific glyph or asset ID.

`catalog.ts` is the complete list of generic interface icons used by the app.
Brand and file-type artwork remains in `ProviderIcon`, `AppIcon`, and
`FileIcon`.

Each library adapter has:

- the glyph names available in that library;
- aliases for semantic names that do not exist under the same name;
- optional presentation metadata such as rotation.

Resolution is identity-first. For example, `plus` resolves to `plus` when the
target library contains that glyph. If it does not, the adapter must define an
explicit alias. An unresolved name throws with the missing semantic name and
the adapter name.

To add or switch a library:

1. Add its adapter beside `codex.ts` and `opencode.ts`.
2. List the library's real glyph names.
3. Add aliases only where identity resolution is not possible.
4. Add the adapter's renderer in `claxedo-icon.tsx`.
5. Change `ACTIVE_ICON_LIBRARY` in `config.ts`.
6. Run `registry.test.ts`; it verifies that every catalog entry resolves.

Codex's extracted assets use numbered IDs, so `codex.ts` contains the complete
semantic-to-ID map. `manifest.ts` is the agent-facing index: each semantic name
has only its glyph, a readable description, and an optional active-state icon.
Exact glyphs that are not in the numbered sprite—open folder, outline/filled
pin, menus, and provider marks—live in the small local Codex sprite owned by
`claxedo-icon.tsx`.
