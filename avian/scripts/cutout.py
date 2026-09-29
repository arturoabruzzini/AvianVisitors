#!/usr/bin/env python3
"""AvianVisitors - cut the cream ground off the generated illustrations.

Step 2 of the illustration pipeline (after pregen.py, before build_masks.py).

pregen.py renders each bird on a flat cream ground because the image model
can't cut a clean transparent background on its own (it leaves holes and
fringes). A flat known ground, by contrast, removes cleanly. This runs each
illustration through the BiRefNet matting model (via rembg), then crops to
the bird's bounding box with a small even margin, and saves an RGBA cutout
back in place.

Idempotent: an illustration that already has a transparent background is
skipped unless you pass --force.

Requires rembg + onnxruntime (see requirements.txt). The first run downloads
the BiRefNet model (~1 GB) to ~/.u2net/.

Usage:
    python3 cutout.py                      # process every illustration
    python3 cutout.py calypte-anna         # one slug (both poses)
    python3 cutout.py calypte-anna-2 --force
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path


def preserve_original(render: Path, originals: Path) -> None:
    """Copy the uncut render to originals/ before it is cut in place.

    The cream-ground render is the only record of the white plumage the
    matting model removes, and fill_holes.py needs it to put that back.
    An original already kept is never replaced: after the first cut, the
    file in illustrations/ is a cutout, not a render.
    """
    import shutil
    originals.mkdir(parents=True, exist_ok=True)
    kept = originals / render.name
    if not kept.exists():
        shutil.copy2(render, kept)


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("slugs", nargs="*",
                    help="Slugs to process (e.g. calypte-anna). Default: all.")
    ap.add_argument("--dir", type=Path, default=here / "assets" / "illustrations",
                    help="Illustration directory (default: avian/assets/illustrations/)")
    ap.add_argument("--originals", type=Path, default=here / "assets" / "originals",
                    help="Where the uncut renders are kept (default: "
                         "avian/assets/originals/, git-ignored)")
    ap.add_argument("--model", default="birefnet-general",
                    help="rembg model name (default: birefnet-general)")
    ap.add_argument("--margin", type=float, default=0.02,
                    help="Even margin around the bird, as a fraction of its "
                         "long side (default: 0.02)")
    ap.add_argument("--force", action="store_true",
                    help="Re-cut illustrations that already have transparency")
    ap.add_argument("--providers", default="cpu",
                    help="ONNX execution providers: 'cpu' (default), 'coreml' "
                         "(Apple GPU/ANE with CPU fallback — note: ORT's CoreML "
                         "EP stalls on BiRefNet's dynamic-shape ops, so CPU is "
                         "the reliable choice), or a comma-separated ORT list")
    args = ap.parse_args()

    try:
        from PIL import Image
        from rembg import new_session, remove
    except ImportError:
        print("error: needs Pillow + rembg (pip install -r requirements.txt)",
              file=sys.stderr)
        return 2

    if args.slugs:
        paths = [args.dir / f"{s}.png" for s in args.slugs]
        missing = [p for p in paths if not p.exists()]
        if missing:
            print("error: not found: " + ", ".join(p.name for p in missing), file=sys.stderr)
            return 2
    else:
        paths = sorted(args.dir.glob("*.png"))
    if not paths:
        print("error: no illustrations found", file=sys.stderr)
        return 1

    provider_aliases = {
        "coreml": ["CoreMLExecutionProvider", "CPUExecutionProvider"],
        "cpu": ["CPUExecutionProvider"],
    }
    providers = provider_aliases.get(args.providers.lower(),
                                     [p.strip() for p in args.providers.split(",")])
    try:
        session = new_session(args.model, providers=providers)
    except Exception as e:
        print(f"warn: providers {providers} failed ({e}); falling back to CPU",
              file=sys.stderr)
        session = new_session(args.model, providers=["CPUExecutionProvider"])
    print(f"rembg session: {args.model} via {providers}")
    done = skipped = 0
    for p in paths:
        im = Image.open(p)
        if not args.force and im.mode == "RGBA" and im.getchannel("A").getextrema()[0] == 0:
            skipped += 1
            continue
        if not (im.mode == "RGBA" and im.getchannel("A").getextrema()[0] == 0):
            preserve_original(p, args.originals)  # an uncut render, not a --force re-cut
        cut = remove(im.convert("RGB"), session=session)  # RGBA, ground -> transparent
        bbox = cut.getchannel("A").getbbox()
        if bbox:
            pad = round(args.margin * max(bbox[2] - bbox[0], bbox[3] - bbox[1]))
            x0, y0 = max(0, bbox[0] - pad), max(0, bbox[1] - pad)
            x1, y1 = min(cut.width, bbox[2] + pad), min(cut.height, bbox[3] + pad)
            cut = cut.crop((x0, y0, x1, y1))
        cut.save(p)
        done += 1
        print(f"  [cut]  {p.name}  -> {cut.width}x{cut.height}")

    print(f"\ncut {done} · skipped {skipped} (already transparent)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
