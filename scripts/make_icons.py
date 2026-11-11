#!/usr/bin/env python3
"""Render the app icons (no external assets, no design files needed)."""

from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
S = 1024
BG_TOP = (26, 32, 48)
BG_BOT = (9, 11, 16)
LINE = (167, 139, 250)
GLOW = (34, 211, 238)


def rounded_mask(size: int, radius: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


def gradient(size: int) -> Image.Image:
    g = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        g.putpixel((0, y), tuple(int(a + (b - a) * t ** 0.85) for a, b in zip(BG_TOP, BG_BOT)))
    return g.resize((size, size))


def draw_art(img: Image.Image, inset: float) -> None:
    """9x9 sudoku glyph: thin cell rules, heavy block rules, a few filled cells."""
    d = ImageDraw.Draw(img, "RGBA")
    pad = S * inset
    x0 = y0 = pad
    side = S - 2 * pad
    x1, y1 = x0 + side, y0 + side
    outer = int(S * 0.030)
    thin = max(2, int(S * 0.0055))
    block = max(3, int(S * 0.0135))
    cell = side / 9

    # filled cells first (behind the rules)
    accent_cells = {(0, 0): GLOW, (2, 2): LINE, (4, 4): GLOW, (6, 6): LINE, (8, 8): GLOW}
    for (cx, cy), colour in accent_cells.items():
        pad_in = cell * 0.16
        d.rounded_rectangle(
            (x0 + cx * cell + pad_in, y0 + cy * cell + pad_in,
             x0 + (cx + 1) * cell - pad_in, y0 + (cy + 1) * cell - pad_in),
            radius=int(cell * 0.22), fill=colour + (205,),
        )

    # rules
    for i in range(1, 9):
        heavy = i % 3 == 0
        w = block if heavy else thin
        a = 225 if heavy else 105
        p = i * cell
        d.line([(x0 + p, y0), (x0 + p, y1)], fill=LINE + (a,), width=w)
        d.line([(x0, y0 + p), (x1, y0 + p)], fill=LINE + (a,), width=w)

    d.rounded_rectangle((x0, y0, x1, y1), radius=int(S * 0.055), outline=LINE + (240,), width=outer)


def make(size: int, inset: float, radius_frac: float, opaque_bg: bool, path: Path) -> None:
    base = gradient(S)
    draw_art(base, inset)

    if opaque_bg:
        out = base.convert("RGBA")
    else:
        out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        out.paste(base, (0, 0), rounded_mask(S, int(S * radius_frac)))

    # soft violet glow behind the glyph
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((S * 0.2, S * 0.18, S * 0.8, S * 0.82), fill=LINE + (46,))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.10))
    if not opaque_bg:
        alpha = Image.composite(glow.getchannel("A"), Image.new("L", (S, S), 0), rounded_mask(S, int(S * radius_frac)))
        glow.putalpha(alpha)

    out = Image.alpha_composite(out, glow)
    out.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True)
    print(path.relative_to(OUT.parent), size)


OUT.mkdir(exist_ok=True)
make(192, 0.20, 0.22, False, OUT / "icon-192.png")
make(512, 0.20, 0.22, False, OUT / "icon-512.png")
make(1024, 0.20, 0.22, False, OUT / "icon-1024.png")
make(180, 0.20, 0.22, True, OUT / "apple-touch-icon.png")
# maskable: full-bleed art kept inside the 80% safe circle
make(512, 0.28, 0.0, True, OUT / "maskable-512.png")
make(32, 0.16, 0.18, False, OUT / "favicon-32.png")
