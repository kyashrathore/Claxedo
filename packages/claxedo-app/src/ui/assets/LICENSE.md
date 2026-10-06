# Artwork

## tod-jag-mandir-dither.webp

A 1-bit 8 × 8 Bayer dither (960 × 661, #aaaaaa dots on a transparent ground, lossless WebP) of **"Palace of Jugmundur in Oodipoor Lake"**: Jag Mandir on Lake Pichola, Udaipur, engraved by Edward Francis Finden after Patrick Waugh for James Tod's *Annals and Antiquities of Rajast'han*, 1829, held by the British Library.

- Source file: https://commons.wikimedia.org/wiki/File:Palace_of_Jugmundur_in_Oodipoor_Lake.jpg
  (the British Library's online gallery image,
  http://www.bl.uk/onlinegallery/onlineex/apac/other/largeimage68613.html)
- Licence: public domain, as its Wikimedia Commons record states.
- Made with the marketing site's plate treatment (`packages/claxedo-web/src/assets/home/LICENSE.md`) from the 976 × 675 Commons file: the top 3 rows of scan edge cropped, greyscale, autocontrast (1 % cut), resized to 960 wide, an unsharp mask (radius 18, 170 %), a tone curve (black 25, white 250, gamma 1.25), then the Bayer threshold.

## plate-thinning-dots.png

A 256 × 256 tile of 2 × 2 px opaque dots on a transparent ground, each dot kept with probability 0.3 by a seeded mulberry32 generator (seed 30). Made for this app; no source image.
