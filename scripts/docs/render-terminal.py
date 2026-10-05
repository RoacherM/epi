"""Rasterize captured xterm cells at 2x; never synthesize application content."""
import json
import os
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

data = json.load(sys.stdin)
font_dir = Path(os.environ.get("EPI_SCREENSHOT_FONT_DIR", "/usr/share/fonts/truetype/dejavu"))
fonts = {
    (False, False): "DejaVuSansMono.ttf",
    (True, False): "DejaVuSansMono-Bold.ttf",
    (False, True): "DejaVuSansMono-Oblique.ttf",
    (True, True): "DejaVuSansMono-BoldOblique.ttf",
}
fonts = {key: ImageFont.truetype(str(font_dir / name), 28) for key, name in fonts.items()}
cw, ch, pad = 17, 42, 28
background, foreground = (24, 24, 24), (225, 225, 225)
image = Image.new("RGB", (data["columns"] * cw + pad * 2, data["rows"] * ch + pad * 2), background)
draw = ImageDraw.Draw(image)
palette = [
    (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0),
    (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
    (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0),
    (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
]
BLOCKS = {"█": (0, 2), "▀": (0, 1), "▄": (1, 2)}  # covered halves of the cell, top to bottom
levels = (0, 95, 135, 175, 215, 255)
palette += [(r, g, b) for r in levels for g in levels for b in levels]
palette += [(8 + n * 10,) * 3 for n in range(24)]


def color(mode, value, default):
    if mode == 0x3000000:
        return ((value >> 16) & 255, (value >> 8) & 255, value & 255)
    if mode in (0x1000000, 0x2000000):
        return palette[value]
    return default


for row, cells in enumerate(data["cells"]):
    for col, cell in enumerate(cells):
        fg = color(cell["fgMode"], cell["fg"], foreground)
        bg = color(cell["bgMode"], cell["bg"], background)
        if cell["inverse"]:
            fg, bg = bg, fg
        x, y = pad + col * cw, pad + row * ch
        draw.rectangle((x, y, x + cw - 1, y + ch - 1), fill=bg)
        if not cell["text"] or cell["width"] == 0 or cell["invisible"]:
            continue
        if cell["dim"]:
            fg = tuple((f + b) // 2 for f, b in zip(fg, bg))
        # Terminals draw block elements themselves, filling the cell; the font's glyphs leave gaps
        # between rows, which would cut the startup logo into strips.
        if cell["text"] in BLOCKS:
            top, bottom = BLOCKS[cell["text"]]
            draw.rectangle((x, y + ch * top // 2, x + cw - 1, y + ch * bottom // 2 - 1), fill=fg)
            continue
        draw.text((x, y + 5), cell["text"], font=fonts[cell["bold"], cell["italic"]], fill=fg)
        if cell["underline"]:
            draw.line((x, y + 35, x + cw * cell["width"], y + 35), fill=fg)
        if cell["strike"]:
            draw.line((x, y + 22, x + cw * cell["width"], y + 22), fill=fg)

image.save(sys.argv[1], optimize=True)
