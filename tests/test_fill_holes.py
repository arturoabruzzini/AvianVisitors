import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "avian", "scripts"))
import fill_holes  # noqa: E402

INK = (20, 20, 20, 255)
PLUMAGE = (240, 230, 200)  # what the original shows inside the outline


def ring(gap=False, size=100):
    """A cutout: an ink ring whose paper interior the matting removed."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse((20, 20, 79, 79), outline=INK, width=3)
    a = np.asarray(img).copy()
    if gap:  # a break in the outline, so the hole leaks to the outside
        a[47:53, 76:80] = 0
    return a


def original(size=100):
    img = Image.new("RGB", (size, size), (233, 215, 180))
    ImageDraw.Draw(img).ellipse((20, 20, 79, 79), fill=PLUMAGE, outline=INK[:3], width=3)
    return np.asarray(img)


def test_enclosed_hole_is_filled_from_the_original():
    out = fill_holes.fill(ring(), [(50, 50)], original(), (0, 0))
    assert out[50, 50, 3] == 255
    assert tuple(out[50, 50, :3]) == PLUMAGE
    assert out[5, 5, 3] == 0  # the real background stays transparent


def test_hole_leaking_through_an_outline_break_is_filled():
    out = fill_holes.fill(ring(gap=True), [(50, 50)], original(), (0, 0))
    assert out[50, 50, 3] == 255
    assert out[50, 78, 3] == 255  # the break itself is closed
    assert out[50, 90, 3] == 0    # but nothing outside it


def test_a_seed_can_bridge_a_wider_outline_break():
    a = ring()
    a[40:60, 76:80] = 0  # a 20px break: too wide for the default closing
    assert fill_holes.fill(a, [(50, 50)], original(), (0, 0))[50, 50, 3] == 0
    out = fill_holes.fill(a, [(50, 50, 14)], original(), (0, 0))
    assert out[50, 50, 3] == 255
    assert out[50, 95, 3] == 0


def test_a_seed_can_clip_its_fill_to_a_box():
    # e.g. a belly hole that runs on into the gap between the legs
    out = fill_holes.fill(ring(), [(50, 50, 8, [0, 0, 100, 60])], original(), (0, 0))
    assert out[50, 50, 3] == 255
    assert out[70, 50, 3] == 0


def test_only_seeded_holes_are_filled():
    a = ring()
    a2 = np.concatenate([a, a], axis=1)  # two birds' worth of holes
    orig = np.concatenate([original(), original()], axis=1)
    out = fill_holes.fill(a2, [(50, 50)], orig, (0, 0))
    assert out[50, 50, 3] == 255
    assert out[50, 150, 3] == 0  # e.g. the gap between two legs


def test_without_an_original_the_hole_gets_paper():
    out = fill_holes.fill(ring(), [(50, 50)], None, (0, 0))
    assert out[50, 50, 3] == 255
    assert tuple(out[50, 50, :3]) == fill_holes.PAPER


def test_original_offset_is_honoured():
    big = np.zeros((140, 130, 3), np.uint8)
    big[30:130, 10:110] = original()
    out = fill_holes.fill(ring(), [(50, 50)], big, (10, 30))
    assert tuple(out[50, 50, :3]) == PLUMAGE


def test_locate_finds_the_crop_offset():
    big = np.full((140, 130, 3), 233, np.uint8)
    rng = np.random.default_rng(1)
    big[30:130, 10:110] = rng.integers(0, 255, (100, 100, 3))
    cut = np.dstack([big[30:130, 10:110], np.full((100, 100), 255, np.uint8)])
    assert fill_holes.locate(cut, big) == (10, 30)


def test_candidates_cover_enclosed_and_leaky_holes_but_not_the_background():
    for a in (ring(), ring(gap=True)):
        seeds = [seed for seed, _ in fill_holes.candidates(a)]
        assert len(seeds) == 1
        x, y = seeds[0]
        assert (x - 50) ** 2 + (y - 50) ** 2 < 28 ** 2


def test_specks_too_small_to_see_are_not_candidates():
    # A big solid bird with a 7x7 gap: 49px, far under 0.4% of its area.
    a = np.zeros((200, 200, 4), np.uint8)
    a[10:190, 10:190] = INK
    a[97:104, 97:104] = 0
    assert fill_holes.candidates(a) == []
    assert len(fill_holes.candidates(a, min_frac=0)) == 1


def test_apply_writes_in_place_and_is_idempotent(tmp_path):
    ill, orig_dir = tmp_path / "ill", tmp_path / "orig"
    ill.mkdir(), orig_dir.mkdir()
    Image.fromarray(ring(gap=True)).save(ill / "gull.png")
    Image.fromarray(original()).save(orig_dir / "gull.png")
    fills = tmp_path / "hole-fills.json"
    fills.write_text(json.dumps({"gull": [[50, 50]]}))

    assert fill_holes.apply(fills, ill, orig_dir) == ["gull"]
    first = np.asarray(Image.open(ill / "gull.png"))
    assert first[50, 50, 3] == 255
    assert fill_holes.apply(fills, ill, orig_dir) == []  # nothing left to fill
    assert (np.asarray(Image.open(ill / "gull.png")) == first).all()
