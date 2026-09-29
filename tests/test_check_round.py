import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "avian", "render"))
import check_round  # noqa: E402


def blank(size=100):
    return Image.new("RGBA", (size, size), (0, 0, 0, 0))


def test_blank_render_draws_nothing():
    assert check_round.measure(blank()) == (0, 0)


def test_disc_inside_circle_passes():
    img = blank()
    ImageDraw.Draw(img).ellipse((10, 10, 89, 89), fill=(255, 255, 255, 255))
    drawn, outside = check_round.measure(img)
    assert drawn > 0 and outside == 0


def test_corner_pixel_is_outside():
    img = blank()
    img.putpixel((0, 0), (255, 255, 255, 1))
    assert check_round.measure(img) == (1, 1)


def test_main_fails_on_blank_and_on_corner(tmp_path):
    empty = tmp_path / "empty.png"
    blank().save(empty)
    assert check_round.main([str(empty)]) == 1
    good = tmp_path / "good.png"
    img = blank()
    ImageDraw.Draw(img).ellipse((30, 30, 69, 69), fill=(0, 0, 0, 255))
    img.save(good)
    assert check_round.main([str(good)]) == 0
