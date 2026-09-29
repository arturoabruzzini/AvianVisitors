import os
import sys

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "avian", "scripts"))
import cutout  # noqa: E402


def test_the_uncut_render_is_kept_before_it_is_overwritten(tmp_path):
    render = tmp_path / "gull.png"
    Image.new("RGB", (8, 8), (236, 218, 185)).save(render)
    keep = tmp_path / "originals"

    cutout.preserve_original(render, keep)

    kept = Image.open(keep / "gull.png")
    assert kept.mode == "RGB" and kept.getpixel((0, 0)) == (236, 218, 185)


def test_an_existing_original_is_never_replaced(tmp_path):
    keep = tmp_path / "originals"
    keep.mkdir()
    Image.new("RGB", (8, 8), (1, 2, 3)).save(keep / "gull.png")
    render = tmp_path / "gull.png"
    Image.new("RGB", (8, 8), (236, 218, 185)).save(render)

    cutout.preserve_original(render, keep)

    assert Image.open(keep / "gull.png").getpixel((0, 0)) == (1, 2, 3)
