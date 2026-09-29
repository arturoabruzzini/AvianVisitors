#!/usr/bin/env python3
"""Checks a round collage render: it draws something, and nothing outside its circle.

The watch tile and phone widget put this PNG over a round ground, so a pixel
outside the inscribed circle would show as a stray mark on the wallpaper or be
clipped by the watch bezel, and a fully transparent render means Chromium
screenshotted the page before the birds loaded.

    check_round.py birds-round.png [more.png ...]   # exit 0 = all good
"""
import sys

from PIL import Image


def measure(img):
    """(pixels with alpha > 0, of those how many lie outside the inscribed circle)."""
    img = img.convert("RGBA")
    w, h = img.size
    cx, cy, r2 = w / 2, h / 2, (min(w, h) / 2) ** 2
    alpha = img.getchannel("A").load()
    drawn = outside = 0
    for y in range(h):
        dy2 = (y + 0.5 - cy) ** 2
        for x in range(w):
            if alpha[x, y]:
                drawn += 1
                if (x + 0.5 - cx) ** 2 + dy2 > r2:
                    outside += 1
    return drawn, outside


def main(paths):
    ok = True
    for path in paths:
        drawn, outside = measure(Image.open(path))
        good = drawn > 0 and outside == 0
        ok = ok and good
        print(f"{'ok  ' if good else 'FAIL'} {path}: {drawn} drawn, {outside} outside the circle")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
