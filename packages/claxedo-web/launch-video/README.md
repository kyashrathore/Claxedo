# Claxedo launch film

The launch film, its 9:16 cut and the site-hero loop, built as code. Every frame is a
pure function of the film time `t`; the score is synthesised from the same timeline.
The site never imports this folder; this folder reads the site's fonts, plates, brand
marks, harness marks and icons through `scripts/serve.js`.

Read first: `brief.md` (what the film must say and the approved copy), `style-guide.md`
(tokens, type, motion rules, banned defaults), `shotlist.md` (beat grid, UI state chain,
shots). Review evidence per gate is in `reviews/`.

## Render

```sh
cd packages/claxedo-web/launch-video
bun install                         # playwright 1.61.1; uses the cached Chromium
bun run preview                     # http://localhost:4677/?cut=film&play  (?t=12.5 holds a frame)
bun run sheet -- --cut film         # contact sheet, one frame per 2 s → out/sheet-film.png
bun run sheet -- --cut film --from 24 --to 25.4 --step 0.1 --label handoff
bun run score -- --cut film         # out/film.wav
bun run render -- --cut film        # out/claxedo-film.mp4 + poster; also social, loop
```

`render` captures PNG frames from two Chromium pages in parallel, encodes each half
with x264 (High, yuv420p, CRF 16, 60 fps), joins them without re-encoding, muxes the
AAC score and writes `+faststart`. On an M-series Mac the 62.5 s film renders in about
a minute. Set `FFMPEG` to use an ffmpeg other than `/opt/homebrew/bin/ffmpeg`; it needs
libx264. `out/` is ignored by git.

## Layout

- `src/cuts.js`: the three cuts (`film`, `social`, `loop`) as scenes on one clock, on the 96 BPM bar grid.
- `src/scenes/`: one file per shot; each takes its start time and an orientation and renders from `t`.
- `src/ui/`: the app rebuilt as DOM from its own strings (composer, pickers, rail, window, phone).
- `src/lib/`: timing and easing, the dithered plate and pixel-mark renderers, kinetic type, the grid.
- `src/story.js`: the demo session the film follows.
- `src/score.js`: the score and cue sounds, synthesised in JS so two renders are bit-identical.
