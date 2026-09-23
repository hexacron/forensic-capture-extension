#!/usr/bin/env python3
"""
Icon generator for Exhibit: a red evidence tag with a punched hole, reinforcement
ring, string and written lines.

Each size is drawn on its own design grid (small sizes drop the string and use fewer,
pixel-aligned lines) and rendered 16x supersampled, then downscaled, so edges are crisp.

Requires: pip3 install Pillow
Run:      python3 generate_icons.py
"""

import math
import os

try:
    from PIL import Image, ImageDraw
except ImportError:
    raise SystemExit("Pillow is not installed: pip3 install Pillow")

SUPERSAMPLE = 16

TAG = (206, 32, 48, 255)          # evidence red
TAG_EDGE = (140, 18, 32, 255)     # darker rim, keeps the silhouette on light toolbars
RING = (255, 232, 234, 255)       # hole reinforcement
LINES = (255, 255, 255, 255)
STRING = (201, 166, 107, 255)     # manila string, visible on light and dark toolbars

# Per-size designs, in that size's own pixel units.
# body: left, top, right, bottom; chamfer: size of the cut top corners.
DESIGNS = {
    16: dict(body=(2, 2, 14, 15), chamfer=3, radius=1, edge=1,
             hole=(8, 5, 1.1), ring=None, string=None,
             lines=[(5, 8, 11, 10), (5, 11, 9, 13)]),
    32: dict(body=(5, 5, 27, 30), chamfer=6, radius=2, edge=1,
             hole=(16, 10.5, 2.2), ring=3.9, string=None,
             lines=[(9, 16, 23, 18), (9, 20, 23, 22), (9, 24, 18, 26)]),
    48: dict(body=(8, 9, 40, 46), chamfer=9, radius=3, edge=1.8,
             hole=(24, 16.5, 3), ring=5.4,
             string=[(24, 16.5), (22, 8), (27, 3), (35, 1.5)], string_width=1.6,
             lines=[(13.5, 25, 34.5, 27.6), (13.5, 31, 34.5, 33.6), (13.5, 37, 27, 39.6)]),
    128: dict(body=(22, 26, 106, 122), chamfer=23, radius=7, edge=4,
              hole=(64, 45, 7.5), ring=13.5,
              string=[(64, 45), (58, 22), (70, 8), (92, 4)], string_width=4,
              lines=[(37, 68, 91, 75), (37, 84, 91, 91), (37, 100, 72, 107)]),
}


def rounded_polygon(points, radius, steps=24):
    """Polygon with every corner rounded by `radius` (points in drawing order)."""
    out = []
    n = len(points)
    for i in range(n):
        p0, p1, p2 = points[i - 1], points[i], points[(i + 1) % n]
        v1 = (p0[0] - p1[0], p0[1] - p1[1])
        v2 = (p2[0] - p1[0], p2[1] - p1[1])
        l1, l2 = math.hypot(*v1), math.hypot(*v2)
        u1, u2 = (v1[0] / l1, v1[1] / l1), (v2[0] / l2, v2[1] / l2)
        angle = math.acos(max(-1.0, min(1.0, u1[0] * u2[0] + u1[1] * u2[1])))
        dist = min(radius / math.tan(angle / 2), l1 / 2, l2 / 2)
        a = (p1[0] + u1[0] * dist, p1[1] + u1[1] * dist)
        b = (p1[0] + u2[0] * dist, p1[1] + u2[1] * dist)
        # quadratic Bezier from a to b with control point at the corner
        for s in range(steps + 1):
            t = s / steps
            out.append((
                (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * b[0],
                (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * b[1],
            ))
    return out


def tag_outline(body, chamfer, inset=0.0):
    left, top, right, bottom = body
    left, top, right, bottom = left + inset, top + inset, right - inset, bottom - inset
    c = max(0.0, chamfer - inset * 0.41)
    return [(left, top + c), (left + c, top), (right - c, top), (right, top + c),
            (right, bottom), (left, bottom)]


def bezier(points, steps=64):
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = points
    return [(
        (1 - t) ** 3 * x0 + 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3 * x3,
        (1 - t) ** 3 * y0 + 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3 * y3,
    ) for t in (i / steps for i in range(steps + 1))]


def render(size, d):
    k = SUPERSAMPLE
    img = Image.new('RGBA', (size * k, size * k), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Pillow floors polygon vertices and fills both boundary pixels. Map polygons onto
    # [0.5, size*k - 0.5] and end boxes one pixel early, so an edge at a whole design
    # pixel covers exactly the pixels inside it and never bleeds into the neighbour.
    f = (size * k - 1) / size
    sc = lambda pts: [(x * f + 0.5, y * f + 0.5) for x, y in pts]
    box = lambda x0, y0, x1, y1: [x0 * k, y0 * k, x1 * k - 1, y1 * k - 1]

    # tag: dark rim, then the red face inset by the rim width
    draw.polygon(sc(rounded_polygon(tag_outline(d['body'], d['chamfer']), d['radius'])), fill=TAG_EDGE)
    face = tag_outline(d['body'], d['chamfer'], inset=d['edge'])
    draw.polygon(sc(rounded_polygon(face, max(0.5, d['radius'] - d['edge'] * 0.6))), fill=TAG)

    # written lines
    for x0, y0, x1, y1 in d['lines']:
        r = (y1 - y0) / 2
        draw.rounded_rectangle(box(x0, y0, x1, y1), radius=r * k, fill=LINES)

    # reinforcement ring and punched hole (transparent)
    hx, hy, hr = d['hole']
    if d['ring']:
        rr = d['ring']
        draw.ellipse(box(hx - rr, hy - rr, hx + rr, hy + rr), fill=RING)
    draw.ellipse(box(hx - hr, hy - hr, hx + hr, hy + hr), fill=(0, 0, 0, 0))

    # string through the hole, running off the top edge
    if d['string']:
        draw.line(sc(bezier(d['string'])), fill=STRING, width=round(d['string_width'] * k), joint='curve')
        # the string passes behind the ring: redraw the hole's lower half over it
        draw.chord(box(hx - hr, hy - hr, hx + hr, hy + hr), 20, 160, fill=(0, 0, 0, 0))

    return img.resize((size, size), Image.BOX)  # exact area average: aligned edges stay sharp


def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size, design in DESIGNS.items():
        path = os.path.join(out_dir, f'icon{size}.png')
        render(size, design).save(path, 'PNG', optimize=True)
        print(f'Created {path} ({size}x{size})')


if __name__ == '__main__':
    main()
