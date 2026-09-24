#!/usr/bin/env python3
"""Generates JevBlock's icons from one geometry: an isometric cube in thick lines on Jev pink.

    python3 tools/make_icons.py

Writes the Icon Composer layers (App/AppIcon.icon/Assets/*.svg), the web extension's PNG icons
(WebExtension/icon-*.png, toolbar-*.png) and a flat preview (tools/icon-preview.png).
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
PINK = (0xC5, 0x62, 0xB2)
PINK_LIGHT = (0xD6, 0x80, 0xC6)

C = (512.0, 530.0)  # optical centre sits a little low: the top face reads heavier
R = 272.0  # circumradius of the cube's centre-line hexagon
W = 64.0  # line width


def hexagon(radius, centre=C):
    cx, cy = centre
    return [(cx + radius * math.cos(math.radians(a)), cy + radius * math.sin(math.radians(a)))
            for a in (-90, -30, 30, 90, 150, 210)]


VERTS = hexagon(R)  # top, upper right, lower right, bottom, lower left, upper left
OUTER = hexagon(R + (W / 2) / math.cos(math.radians(30)))
INNER = hexagon(R - (W / 2) / math.cos(math.radians(30)))
JOINT = hexagon((W / 2) / math.cos(math.radians(30)))


def bar(a, b, half=W / 2):
    (x1, y1), (x2, y2) = a, b
    length = math.hypot(x2 - x1, y2 - y1)
    nx, ny = -(y2 - y1) / length * half, (x2 - x1) / length * half
    return [(x1 + nx, y1 + ny), (x2 + nx, y2 + ny), (x2 - nx, y2 - ny), (x1 - nx, y1 - ny)]


# The inner "Y": centre to upper left, upper right and bottom.
BARS = [bar(C, VERTS[5]), bar(C, VERTS[1]), bar(C, VERTS[3])]
TOP_FACE = [VERTS[0], VERTS[1], C, VERTS[5]]


def path(points):
    return "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in points) + " Z"


def svg(body):
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n'
            f"{body}\n</svg>\n")


def write_svgs():
    assets = ROOT / "App/AppIcon.icon/Assets"
    assets.mkdir(parents=True, exist_ok=True)
    lines = [f'  <path fill="#FFFFFF" fill-rule="evenodd" d="{path(OUTER)} {path(INNER)}"/>']
    lines += [f'  <path fill="#FFFFFF" d="{path(p)}"/>' for p in BARS + [JOINT]]
    (assets / "cube.svg").write_text(svg("\n".join(lines)))
    (assets / "face.svg").write_text(svg(f'  <path fill="#FFFFFF" d="{path(TOP_FACE)}"/>'))


def render(size, rounded=True, face_alpha=110):
    """Flat raster of the same icon, for the extension and the preview (no glass effects)."""
    s = size * 4
    k = s / 1024
    scale = lambda pts: [(x * k, y * k) for x, y in pts]
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bg = Image.new("RGBA", (s, s))
    top, bottom = PINK_LIGHT, PINK
    draw_bg = ImageDraw.Draw(bg)
    for y in range(s):
        t = min(1, y / (s * 0.7))
        draw_bg.line([(0, y), (s, y)], fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
    mask = Image.new("L", (s, s), 0)
    if rounded:
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=round(s * 0.225), fill=255)
    else:
        mask.paste(255, (0, 0, s, s))
    img.paste(bg, (0, 0), mask)
    face = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(face).polygon(scale(TOP_FACE), fill=(255, 255, 255, face_alpha))
    img = Image.alpha_composite(img, face)
    d = ImageDraw.Draw(img)
    ring = Image.new("L", (s, s), 0)
    rd = ImageDraw.Draw(ring)
    rd.polygon(scale(OUTER), fill=255)
    rd.polygon(scale(INNER), fill=0)
    for p in BARS + [JOINT]:
        rd.polygon(scale(p), fill=255)
    img.paste((255, 255, 255, 255), (0, 0), ring)
    return img.resize((size, size), Image.LANCZOS)


def main():
    write_svgs()
    ext = ROOT / "WebExtension"
    for n in (48, 64, 96, 128, 256, 512):
        render(n).save(ext / f"icon-{n}.png")
    for n in (16, 19, 32, 38, 48, 72):
        render(n).save(ext / f"toolbar-{n}.png")
    render(1024, rounded=True).save(ROOT / "tools/icon-preview.png")


if __name__ == "__main__":
    main()
