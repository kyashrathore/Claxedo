/** The editorial grid: headlines hang from the left margin; product owns the rest. Safe areas from style-guide.md. */
export const grid = (L) =>
  L.portrait
    ? { left: 72, right: L.W - 72, top: 190, bottom: L.H - 160, headline: 104, subline: 34 }
    : { left: 144, right: L.W - 144, top: 116, bottom: L.H - 90, headline: 88, subline: 30 }
