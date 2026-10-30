# Credits

Third-party material shipped inside JakeTunes V3, with its source and
license.

## The jewel case photograph

The CD jewel case on the album page and in the Home Cover Flow
(`src/renderer/assets/jewel-case/`) is cut from one photograph of a real
case:

- **"CD Jewel Case (Front).jpg"** by **DiscoA340**, Wikimedia Commons —
  https://commons.wikimedia.org/wiki/File:CD_Jewel_Case_(Front).jpg
- License: **CC0 1.0 Universal** (public domain dedication) — no
  attribution required; given anyway.
- Original: 4641 × 3692 px, Canon EOS R10, a closed empty case, front
  view, on white paper.

What was done to it (`tools/jewel-case/rectify.py` and
`tools/jewel-case/build-assets.py`): perspective-corrected to a 142:125
rectangle, then cut into four layers — the frame (the plastic with the
booklet window cut to transparent), the lid's optics (reflections, scratches,
the ribs' lighting, the walls' shadow on the booklet; an alpha layer), a
synthesised contact shadow (the paper in the photo carries none), and the
black tray for the Home case's open state. Proportions measured on the
rectified photo live in `src/common/jewel-case-photo.ts`.
