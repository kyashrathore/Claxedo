export function defineIconLibrary<const IconName extends string, const GlyphName extends string>(input: {
  name: string
  glyphs: readonly GlyphName[]
  aliases?: Partial<Record<IconName, GlyphName>>
}) {
  const glyphs = new Set<string>(input.glyphs)
  const isGlyph = (value: string): value is GlyphName => glyphs.has(value)

  return {
    name: input.name,
    resolve(icon: IconName) {
      const glyph = input.aliases?.[icon] ?? icon
      if (isGlyph(glyph)) return glyph

      throw new Error(
        `[icons:${input.name}] No glyph for "${icon}". The identity mapping "${icon}" was not found; add an explicit alias.`,
      )
    },
  }
}
