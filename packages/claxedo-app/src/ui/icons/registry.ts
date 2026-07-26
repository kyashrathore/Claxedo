export function defineIconLibrary<const IconName extends string, const GlyphName extends string>(input: {
  name: string
  glyphs: readonly GlyphName[]
  aliases?: Partial<Record<IconName, GlyphName>>
}) {
  const glyphs = new Set<string>(input.glyphs)

  return {
    name: input.name,
    resolve(icon: IconName) {
      const glyph = input.aliases?.[icon] ?? icon
      if (glyphs.has(glyph)) return glyph as GlyphName

      throw new Error(
        `[icons:${input.name}] No glyph for "${icon}". The identity mapping "${icon}" was not found; add an explicit alias.`,
      )
    },
  }
}
