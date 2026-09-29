# Generating illustrations

The collage art is generated, not hand-drawn. The repo ships 498 kachō-e
illustrations (249 species, a perched and a flight pose each). To restyle
them or build a set for your own region, the pipeline is four scripts in
this directory.

## Pipeline

1. `pregen.py` renders each bird with Gemini 2.5 Flash Image, on a flat cream ground.
2. `cutout.py` removes the ground with BiRefNet and crops to the bird. It keeps
   the uncut render in `assets/originals/` (git-ignored) first.
3. `fill_holes.py` puts back white plumage the cutout removed (see below).
4. `build_masks.py` rebuilds the collage silhouette masks inlined in `apt.js`.
5. `verify.py` (optional) runs an adversarial species-ID + anatomy check.

```bash
pip install -r requirements.txt
export GEMINI_API_KEY='your-key'

# 1. generate (cream ground) for your region's species
python3 pregen.py --labels ~/BirdNET-Pi/model/labels.txt --ebird-region GB

# 2. cut the ground off and crop
python3 cutout.py

# 3. refill white plumage listed in hole-fills.json
python3 fill_holes.py

# 4. rebuild the collage masks, then bump SKETCH_VERSION + IMG_VERSION in apt.js
python3 build_masks.py
```

`--labels` takes any `Sci|Com` per-line file (BirdNET-Pi's `labels.txt` works
directly). `--ebird-region` filters to species actually seen in your region
(needs `EBIRD_API_KEY`). Re-render one bird with
`--species "Calypte anna|Anna's Hummingbird" --force`.

## Why a cream ground

The image model can't cut a clean transparent background on its own: it
leaves holes and fringes, worst on pale birds. Rendering on a flat,
consistent cream ground gives a known color that BiRefNet removes cleanly,
and the steady ground also holds the painting style together across the
whole set. `cutout.py` is the step that makes the backgrounds transparent.

## Holes in white plumage

The prints leave white plumage as bare paper inside an ink outline, the same
cream as the ground, so BiRefNet cuts a gull's breast out with the background.
On the light page it goes unnoticed; on a dark ground (the watch tile, the
phone widget) the bird has holes. Colour can't tell such a hole from real
negative space (the gap between a wader's legs is bare paper too), so which
holes to fill is decided by eye and recorded in `hole-fills.json` as seed
points in cutout pixels:

```bash
python3 fill_holes.py --review larus-canus cygnus-olor --out review.png  # numbered candidates
python3 fill_holes.py --preview --out after.png                          # before/after, saves nothing
python3 fill_holes.py                                                    # apply (idempotent)
```

A seed is `[x, y]`; `[x, y, r]` bridges an outline break wider than the default
(about 16px); `[x, y, r, [x0, y0, x1, y1]]` also clips the fill to a box, for a
belly hole that runs on into the gap between the legs. Filled pixels come from
`assets/originals/<slug>.png` where it exists, flat paper otherwise.

## The prompt

`prompt.template.md` is the kachō-e prompt, sent verbatim per request with
`{sci_name}`, `{com_name}`, and `{pose}` substituted. Edit it to change the
style. `pregen.py` attaches up to three reference images per request:

- **Anatomy** (IMAGE 1): a Wikipedia photo of the target species, auto-fetched
  and cached in `assets/references/`. Anchors identity and markings. Drop your
  own `references/<slug>.jpg` to override.
- **Anti-reference** (IMAGE 2, optional): a photo of a look-alike the model
  drifts toward, captioned with what NOT to copy. Wired for blue corvids (vs
  Blue Jay) and swallows (vs Barn Swallow); add more in the `ANTI_REFS` table
  and place photos at `references/_anti_<key>.jpg`.
- **Style** (IMAGE 3, optional): a real Edo-period kachō-e print whose painting
  technique is borrowed. The genus-to-print mapping is in `pregen.py`'s
  `STYLE_REFS`. The prints are not bundled (they are someone else's art); put
  your own in `assets/references/styles/`. The Koson and Yoshida prints used
  originally are easy to find on the public web by the filenames in `STYLE_REFS`.

All three degrade gracefully: a missing reference is simply not attached.

## Hard species

`species-notes.json` holds one-line diagnostic addenda for species the model
gets wrong. Each note names the field marks that matter and the look-alikes to
avoid, and is appended to the prompt for that species. Add entries as you find
drift; they carry forward to every future regeneration of that bird.

## Verifying

`verify.py` sends each illustration back through Gemini Vision without telling
it the target species, then checks the guess, the wing/leg/tail counts, and
whether a stray perch crept in. It catches drift a quick eyeball misses.

```bash
python3 verify.py --labels labels.txt              # whole library -> verify-results.csv
python3 verify.py --labels labels.txt calypte-anna
```

## What actually goes wrong

- **Sticks.** Perched raptors often come back gripping a twig the prompt
  forbade. Generate 2-3 and keep the clean one.
- **Species drift.** The model collapses an uncommon species toward a common
  look-alike (a swift becomes a swallow). Fixes, in order: a sharper
  `species-notes.json` note with anti-feature language; an anti-reference; a
  different style print; a one-off `--species` regen.
- **Matched pair.** The perched and flight poses must read as the same
  individual. Review them side by side before locking.
