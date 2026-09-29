#!/usr/bin/env python3
"""AvianVisitors - put back the white plumage the matting model cut out.

Step 2b of the illustration pipeline (after cutout.py, before build_masks.py).

The kachō-e prints leave white plumage as bare paper inside an ink outline,
the same cream as the ground, so BiRefNet removes a gull's breast along with
the background. On the light page nobody notices; on a dark ground (the watch
tile, the phone widget) the bird shows holes.

Colour cannot tell such a hole from real negative space -- the gap between a
wader's legs is the same bare paper -- so which holes to fill is a human call,
recorded in hole-fills.json as seed points (cutout pixel coordinates):

    {"larus-argentatus": [[180, 330]], ...}

A seed fills the see-through region around it: an enclosed hole, or one that
leaks to the outside through a break in the outline (the break is bridged by
a morphological closing). Filled pixels become opaque with the original
render's pixels from avian/assets/originals/<slug>.png, or with flat paper
when no original survives. Re-running is a no-op.

Usage:
    python3 fill_holes.py                          # apply hole-fills.json
    python3 fill_holes.py --review larus-canus ... --out sheet.png
    python3 fill_holes.py --preview --out after.png   # filled birds, not saved
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "assets"

SEE = 200      # alpha below this shows the ground through the bird
CLOSE_R = 8    # widest outline break (px) bridged when finding a leaky hole
MIN_AREA = 30  # smaller regions are antialiasing specks, not holes
MIN_FRAC = 0.004  # of the bird's area: smaller holes vanish at tile size
PAPER = (236, 218, 185)  # median ground colour of the original renders


def _disk(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return x * x + y * y <= r * r


def _regions(alpha, close_r=CLOSE_R):
    """Labelled see-through regions the bird's outline encloses, counting an
    outline break up to about 2 * close_r wide as closed."""
    see = alpha < SEE
    pad = close_r + 2
    opaque = np.pad(~see, pad)
    disk = _disk(close_r)
    closed = ndimage.binary_closing(opaque, structure=disk)
    inside = ndimage.binary_fill_holes(closed)
    # Closing cannot bridge a wide break in a *thin* outline: the dilated
    # line ends meet only in a narrow lens that the erosion reopens. So also
    # seal the outline by dilation alone and grow the sealed interior back out
    # by the same radius, which brings it up to the chord across the break.
    fat = ndimage.binary_dilation(opaque, structure=disk)
    sealed = ndimage.binary_fill_holes(fat) & ~fat
    inside |= ndimage.binary_dilation(sealed, structure=disk)
    inside = inside[pad:-pad, pad:-pad]
    return ndimage.label(see & inside)


def candidates(rgba, min_frac=MIN_FRAC):
    """[(seed (x, y), area)] for every region worth a reviewer's look: at
    least MIN_AREA px and min_frac of the bird's area. Smaller gaps are the
    slivers between feather tips and toes, and invisible at tile size."""
    lab, n = _regions(rgba[..., 3])
    body = int(ndimage.binary_fill_holes(rgba[..., 3] >= SEE).sum())
    out = []
    for i in range(1, n + 1):
        m = lab == i
        area = int(m.sum())
        if area < max(MIN_AREA, min_frac * body):
            continue
        # The seed is the region's deepest point, so it stays inside the
        # region however the outline wiggles.
        dist = ndimage.distance_transform_edt(np.pad(m, 1))[1:-1, 1:-1]
        y, x = np.unravel_index(np.argmax(dist), m.shape)
        out.append(((int(x), int(y)), area))
    return out


def fill(rgba, seeds, original, offset):
    """Copy of rgba with the regions under `seeds` made opaque.

    A seed is (x, y), optionally followed by r, to bridge an outline break
    wider than the default closing does, and then a box [x0, y0, x1, y1] the
    fill is clipped to, for a hole that runs on into real negative space
    (a belly into the gap between the legs). `original` is the uncut render
    (HxWx3) or None; `offset` is where the cutout's top-left sits in it.
    """
    out = rgba.copy()
    region = np.zeros(rgba.shape[:2], bool)
    labels = {}
    for seed in seeds:
        x, y = seed[0], seed[1]
        r = seed[2] if len(seed) > 2 else CLOSE_R
        if r not in labels:
            labels[r] = _regions(rgba[..., 3], r)[0]
        lab = labels[r]
        if not lab[y, x]:
            continue
        m = lab == lab[y, x]
        if len(seed) > 3:
            x0, y0, x1, y1 = seed[3]
            box = np.zeros_like(m)
            box[y0:y1, x0:x1] = True
            m &= box
        region |= m
    if not region.any():
        return out
    # Take in the soft rim the matting left around the hole too.
    region |= ndimage.binary_dilation(region, iterations=2) & (rgba[..., 3] < 255)
    if original is not None:
        ox, oy = offset
        h, w = rgba.shape[:2]
        out[region, :3] = original[oy:oy + h, ox:ox + w][region]
    else:
        out[region, :3] = PAPER
    out[region, 3] = 255
    return out


def locate(cut, orig):
    """(x, y) where the cutout's opaque pixels match the original, else None.

    cutout.py crops rembg's output, which leaves opaque pixels untouched, so
    the cutout is an exact sub-image of its original wherever it is opaque.
    """
    ys, xs = np.nonzero(cut[..., 3] == 255)
    if len(ys) < 64:
        return None
    ch, cw = cut.shape[:2]
    oh, ow = orig.shape[:2]
    pick = np.random.default_rng(0).choice(len(ys), 64, replace=False)
    py, px = ys[pick], xs[pick]
    want = cut[py, px, :3].astype(np.int16)
    o = orig.astype(np.int16)
    cy, cx = np.nonzero(np.abs(o - want[0]).max(axis=2) <= 2)
    for y, x in zip(cy - py[0], cx - px[0]):
        if 0 <= y <= oh - ch and 0 <= x <= ow - cw:
            if np.abs(o[py + y, px + x] - want).max() <= 2:
                return int(x), int(y)
    return None


def _load(slug, ill_dir, orig_dir):
    cut = np.asarray(Image.open(ill_dir / f"{slug}.png").convert("RGBA"))
    orig_path = orig_dir / f"{slug}.png"
    if orig_path.exists():
        orig = np.asarray(Image.open(orig_path).convert("RGB"))
        off = locate(cut, orig)
        if off is not None:
            return cut, orig, off
        print(f"  warn: {slug}: original does not match the cutout; using paper",
              file=sys.stderr)
    return cut, None, (0, 0)


def apply(fills_path, ill_dir, orig_dir):
    """Fill every seeded hole in place; returns the slugs that changed."""
    changed = []
    for slug, seeds in sorted(json.loads(Path(fills_path).read_text()).items()):
        cut, orig, off = _load(slug, ill_dir, orig_dir)
        out = fill(cut, [tuple(s) for s in seeds], orig, off)
        if (out != cut).any():
            Image.fromarray(out).save(ill_dir / f"{slug}.png")
            changed.append(slug)
    return changed


def _on_dark(rgba, tint=None):
    img = Image.alpha_composite(Image.new("RGBA", (rgba.shape[1], rgba.shape[0]),
                                          (18, 18, 20, 255)), Image.fromarray(rgba))
    if tint is not None:
        arr = np.asarray(img).copy()
        arr[tint] = (arr[tint] * 0.3 + np.array([255, 0, 200, 255]) * 0.7).astype(np.uint8)
        img = Image.fromarray(arr)
    return img


def sheet(panels, out, cell=320, cols=4):
    """panels: [(label, PIL image, [(x, y, text)] in image coordinates)]."""
    rows = (len(panels) + cols - 1) // cols
    s = Image.new("RGB", (cols * cell, rows * (cell + 16)), (18, 18, 20))
    d = ImageDraw.Draw(s)
    for k, (label, img, marks) in enumerate(panels):
        k_scale = min((cell - 8) / img.width, (cell - 8) / img.height)
        th = img.resize((max(1, round(img.width * k_scale)), max(1, round(img.height * k_scale))))
        x0, y0 = (k % cols) * cell + 4, (k // cols) * (cell + 16) + 4
        s.paste(th.convert("RGB"), (x0, y0))
        for mx, my, text in marks:
            px, py = x0 + mx * k_scale, y0 + my * k_scale
            d.rectangle((px - 7, py - 7, px + 7, py + 7), fill=(255, 255, 255))
            d.text((px - 3, py - 6), text, fill=(0, 0, 0))
        d.text((x0 + 2, y0 + cell - 6), label, fill=(220, 220, 220))
    s.save(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fills", type=Path, default=HERE / "hole-fills.json")
    ap.add_argument("--dir", type=Path, default=ASSETS / "illustrations")
    ap.add_argument("--originals", type=Path, default=ASSETS / "originals")
    ap.add_argument("--review", nargs="*", metavar="SLUG",
                    help="Draw numbered candidate holes (magenta) for these slugs")
    ap.add_argument("--preview", action="store_true",
                    help="Draw the seeded birds before/after filling; save nothing")
    ap.add_argument("--out", type=Path, default=Path("fill-holes-sheet.png"))
    args = ap.parse_args()

    if args.review is not None:
        panels = []
        for slug in args.review:
            cut = np.asarray(Image.open(args.dir / f"{slug}.png").convert("RGBA"))
            cands = candidates(cut)
            lab, _ = _regions(cut[..., 3])
            tint = np.isin(lab, [lab[y, x] for (x, y), _ in cands])
            marks = [(x, y, str(i)) for i, ((x, y), _) in enumerate(cands)]
            panels.append((slug, _on_dark(cut, tint), marks))
            print(slug, json.dumps([list(s) for s, _ in cands]))
        sheet(panels, args.out)
        print(f"wrote {args.out}")
        return 0

    if args.preview:
        panels = []
        for slug, seeds in sorted(json.loads(args.fills.read_text()).items()):
            cut, orig, off = _load(slug, args.dir, args.originals)
            out = fill(cut, [tuple(s) for s in seeds], orig, off)
            src = "original" if orig is not None else "paper"
            panels.append((f"{slug} (before)", _on_dark(cut), []))
            panels.append((f"{slug} (after, {src})", _on_dark(out), []))
        sheet(panels, args.out)
        print(f"wrote {args.out}")
        return 0

    changed = apply(args.fills, args.dir, args.originals)
    for slug in changed:
        print(f"  [filled] {slug}")
    print(f"filled {len(changed)}; now run build_masks.py and bump IMG_VERSION")
    return 0


if __name__ == "__main__":
    sys.exit(main())
