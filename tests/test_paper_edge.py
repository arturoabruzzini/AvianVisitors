"""The cream paper edge drawn round every bird on dark grounds.

The edge is an SVG filter in index.html (dilate, then blur), applied by
styles.css in the dark theme and in the transparent watch/phone render. Its
reach is fixed in screen px, so it must fit the gap the collage leaves between
birds (apt.js COLLAGE_PAD grid cells of GRID_STRIDE px) and the margin a round
render leaves inside its circle (ROUND_FILL of an 800px render).
"""
import os
import re

FRONTEND = os.path.join(os.path.dirname(__file__), "..", "avian", "frontend")
PAPER = "#ecdab9"  # (236, 218, 185): the ground the illustrations were drawn on
ROUND_PX = 800     # render-round.sh --window-size


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as f:
        return f.read()


def edge_filter():
    html = read(FRONTEND, "index.html")
    m = re.search(r'<filter id="paper-edge".*?</filter>', html, re.S)
    assert m, "index.html defines no #paper-edge filter"
    return m.group(0)


def js_number(name):
    m = re.search(r"var %s = ([0-9.]+);" % name, read(FRONTEND, "apt.js"))
    return float(m.group(1))


def reach():
    """px from the bird's outline to where the edge fades below 5% alpha."""
    f = edge_filter()
    radius = float(re.search(r'<feMorphology[^>]*radius="([0-9.]+)"', f).group(1))
    sigma = float(re.search(r'<feGaussianBlur[^>]*stdDeviation="([0-9.]+)"', f).group(1))
    return radius + 1.645 * sigma


def test_the_edge_is_the_paper_the_birds_were_drawn_on():
    assert re.search(r'flood-color="%s"' % PAPER, edge_filter(), re.I)


def test_neighbouring_edges_never_meet():
    gap = js_number("COLLAGE_PAD") * js_number("GRID_STRIDE")
    assert 2 * reach() <= gap


def test_the_edge_stays_inside_a_round_render():
    margin = (1 - js_number("ROUND_FILL")) * ROUND_PX / 2
    assert reach() <= margin


def test_the_dark_theme_and_the_transparent_render_draw_the_edge():
    css = read(FRONTEND, "styles.css")
    for selector in (r':root\[data-theme="dark"\] \.gtile img',
                     r'html\.kiosk\.bg-none \.gtile img'):
        rule = re.search(selector + r"[^{]*\{([^}]*)\}", css)
        assert rule and "url(#paper-edge)" in rule.group(1), selector
