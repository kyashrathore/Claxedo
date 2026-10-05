# Style guide

Written from the live site source (`src/styles/site.css`, `app-theme.css`, `HomeHero.astro`, `TajPlate.astro`, `PlatePanel.astro`, the crops) and the app's own screens.

## Palette

| Token | Value | Use in the film |
|---|---|---|
| `--bg` paper | `#fcfcfc` | Every frame's ground. No dark scenes, no gradient grounds. |
| `--ink` | `#0f0f0f` | Headlines, pixel C, the primary pill. |
| `--ink-body` | `#3a3a3a` | Tile labels. |
| `--ink-soft` | `#6b6b6b` | Sublines, quiet links. |
| `--line` | `#e8e8e8` | Hairlines, card rings. |
| dither dots | `#aaaaaa` | Daniell plates only. |
| app strong / base / weak / weaker | `#1a1c1f` `#4f4f4f` `#696a6c` `#8c8d8f` | Product UI text. |
| app border / selected | `#ededed` / `#ececec` | Rows, hairlines, the hover pill. |
| success | `#168447` | ✓ in terminals, "Ready", "Live at". The only colour that means something. |
| term-path | `#147c83` | Prompt path in terminals. |
| macOS lights | `#ff5f57` `#febc2e` `#28c840` | Desktop window chrome, as the site's replica draws it. |

Colour is spent on meaning only. No accent glows, no tinted panels, no gradient fills (the one gradient-shaped thing is the app's own text shimmer on "Waking checkout", and the mask fades the site already uses on its plates).

## Type

- Display: `-apple-system, "SF Pro Display"` at weight 400, tracking −0.032em, line-height 1.04. The site sets h1 at 400 / −0.025em; at film sizes (84–128 px) tighter tracking reads the same.
- Text: `"SF Pro Text"` 400; sublines 30 px / 1.35 / −0.012em in ink-soft.
- Mono: Claxedo Mono for film-level numerals; SF Mono (`ui-monospace`) inside the app's terminals, as the app does.
- Scale (16:9): headline 84–88, hero type 128, subline 30, tile label 26, product UI 14–15 at 1.3–1.5× camera.
- Scale (9:16): headline 92–104, subline 34; product UI at 1.3× or larger, so nothing on screen is under ~17 px.

## Composition

- Headlines sit on a **left editorial grid** (x = 144 in 16:9, x = 72 in 9:16), top-aligned, ragged right. The product owns the right two-thirds. The eye goes headline → the one changing UI element → back.
- One changing thing at a time. When the picker opens, the headline holds still; when the headline changes, the UI holds still.
- **Carried component:** the composer (context row, input, harness button, send). It is the harness picker's anchor, the thing that wakes the workspace, the dock of the cloud session, the phone's input, and the hero loop. It changes size, content and position; it never changes design.
- The Daniell plates are the texture: the Taj under "Wherever it should run" and in the closing poster, Jama Masjid behind the deploy terminal, revealed dot by dot exactly as the site's hero does.
- Safe areas: 144 px horizontal / 90 px vertical in 16:9; 72 / 160 in 9:16 (clear of feed chrome).

## Pacing

Site: hero rises over 0.8 s with a 0.12 s stagger; the Taj settles in 1.2 s. The film uses a 96 BPM grid (beat 0.625 s, bar 2.5 s). A meaningful change lands every 1.25–2.5 s; a headline holds at least 2.5 s fully legible; shots change on bar lines.

## Motion vocabulary (per object class)

| Class | Motion | Curve |
|---|---|---|
| Micro UI (pill, check, chip, switch, send) | Snaps; 0.2–0.25 s glides; a press dips to 0.94 and returns with ≤3% overshoot | `cubic-bezier(.65,0,.35,1)`; spring only on the press return |
| Popovers, dialogs | Open in 0.4 s from 0.97 scale + 6 px, close faster (0.22 s) | site rise `cubic-bezier(.2,.7,.2,1)` / ease-in |
| Panels and windows | Settle from 70–260 px over 0.9–1.1 s, no overshoot | `cubic-bezier(.16,1,.3,1)` |
| Camera | Slow push-ins of 3–18% over 2–4 s; never whips | in-out |
| Headlines | Strong entrance: words rise 0.38 em out of a 12 px blur, 60 ms stagger; then hold still | site rise |
| Typing | Seeded human jitter, ~14 chars/s, spaces and punctuation linger | n/a |
| Streaming replies | Whole words at ~14 words/s | n/a |
| Texture | Plates reveal by dither noise settling, as `TajPlate.astro` | `1 − (1 − p)³` |
| Brand | The pixel C assembles square by square, left to right | out + spring per square |

After every move: the viewer should know where to look. If two things move at once, one of them is wrong.

## Banned defaults

- A centered headline on a gradient.
- Everything fading in the same way at the same speed.
- A logo-only ending.
- Glowing or coloured accent borders, quote stripes, tinted warning boxes (`packages/claxedo-app/src/ui/AGENTS.md`, "Visual restraint").
- Generic particles, bokeh, lens flares, light leaks, dark "tech" grounds.
- Screenshots of the app; every UI moment is rebuilt as DOM.
- Invented numbers, customers or benchmarks.
- Wall-clock animation: every frame is a pure function of `t`.
