"""Rasterize captured xterm cells at 2x; never synthesize application content.

stdin: {"columns", "rows", "cells"} writes one PNG to argv[1];
       {"columns", "rows", "frames": [cells, ...]} writes argv[1]/frame-0000.png, ... (one per frame).
"""
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
palette = [
    (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0),
    (0, 0, 238), (205, 0, 205), (0, 205, 205), (229, 229, 229),
    (127, 127, 127), (255, 0, 0), (0, 255, 0), (255, 255, 0),
    (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
]
BLOCKS = {"█": (0, 2), "▀": (0, 1), "▄": (1, 2)}  # covered halves of the cell, top to bottom
# Left eighth blocks (the duration bar): how many eighths of the cell's width, from the left.
EIGHTHS = {"▏": 1, "▎": 2, "▍": 3, "▌": 4, "▋": 5, "▊": 6, "▉": 7}
# Box drawing: which arms leave the cell's center (up, down, left, right), and the stroke weight.
# Terminals draw these edge to edge; the font's glyphs stop short, which breaks the turn spine and
# table borders into dashes between rows.
LIGHT, HEAVY = 1, 2
BOX = {
    "│": ("ud", LIGHT), "┃": ("ud", HEAVY), "─": ("lr", LIGHT), "━": ("lr", HEAVY),
    "├": ("udr", LIGHT), "┤": ("udl", LIGHT), "┬": ("dlr", LIGHT), "┴": ("ulr", LIGHT), "┼": ("udlr", LIGHT),
    "╭": ("dr", LIGHT), "┌": ("dr", LIGHT), "╮": ("dl", LIGHT), "┐": ("dl", LIGHT),
    "╰": ("ur", LIGHT), "└": ("ur", LIGHT), "╯": ("ul", LIGHT), "┘": ("ul", LIGHT),
}
# Braille dots (U+2800 block, used by the spinner): bit -> (column, row) in the 2x4 grid.
BRAILLE = [(0x01, 0, 0), (0x02, 0, 1), (0x04, 0, 2), (0x40, 0, 3), (0x08, 1, 0), (0x10, 1, 1), (0x20, 1, 2), (0x80, 1, 3)]
levels = (0, 95, 135, 175, 215, 255)
palette += [(r, g, b) for r in levels for g in levels for b in levels]
palette += [(8 + n * 10,) * 3 for n in range(24)]


def color(mode, value, default):
    if mode == 0x3000000:
        return ((value >> 16) & 255, (value >> 8) & 255, value & 255)
    if mode in (0x1000000, 0x2000000):
        return palette[value]
    return default


def draw_box(draw, text, x, y, fg):
    arms, weight = BOX[text]
    cx, cy = x + cw // 2, y + ch // 2
    lo, hi = -weight, weight - 1
    if "u" in arms:
        draw.rectangle((cx + lo, y, cx + hi, cy + hi), fill=fg)
    if "d" in arms:
        draw.rectangle((cx + lo, cy + lo, cx + hi, y + ch - 1), fill=fg)
    if "l" in arms:
        draw.rectangle((x, cy + lo, cx + hi, cy + hi), fill=fg)
    if "r" in arms:
        draw.rectangle((cx + lo, cy + lo, x + cw - 1, cy + hi), fill=fg)


def draw_braille(draw, text, x, y, fg):
    bits = ord(text) - 0x2800
    for mask, column, row in BRAILLE:
        if bits & mask:
            dx, dy = x + 4 + column * 7, y + 11 + row * 6
            draw.rectangle((dx, dy, dx + 2, dy + 2), fill=fg)


def render(cells):
    image = Image.new("RGB", (data["columns"] * cw + pad * 2, data["rows"] * ch + pad * 2), background)
    draw = ImageDraw.Draw(image)
    for row, line in enumerate(cells):
        for col, cell in enumerate(line):
            fg = color(cell["fgMode"], cell["fg"], foreground)
            bg = color(cell["bgMode"], cell["bg"], background)
            if cell["inverse"]:
                fg, bg = bg, fg
            x, y = pad + col * cw, pad + row * ch
            draw.rectangle((x, y, x + cw - 1, y + ch - 1), fill=bg)
            text = cell["text"]
            if not text or cell["width"] == 0 or cell["invisible"]:
                continue
            if cell["dim"]:
                fg = tuple((f + b) // 2 for f, b in zip(fg, bg))
            # Terminals draw block elements themselves, filling the cell; the font's glyphs leave gaps
            # between rows, which would cut the startup logo into strips.
            if text in BLOCKS:
                top, bottom = BLOCKS[text]
                draw.rectangle((x, y + ch * top // 2, x + cw - 1, y + ch * bottom // 2 - 1), fill=fg)
                continue
            if text in EIGHTHS:
                draw.rectangle((x, y, x + cw * EIGHTHS[text] // 8 - 1, y + ch - 1), fill=fg)
                continue
            if text in BOX:
                draw_box(draw, text, x, y, fg)
                continue
            if len(text) == 1 and 0x2800 <= ord(text) <= 0x28FF:
                draw_braille(draw, text, x, y, fg)
                continue
            draw.text((x, y + 5), text, font=fonts[cell["bold"], cell["italic"]], fill=fg)
            if cell["underline"]:
                draw.line((x, y + 35, x + cw * cell["width"], y + 35), fill=fg)
            if cell["strike"]:
                draw.line((x, y + 22, x + cw * cell["width"], y + 22), fill=fg)
    return image


if "frames" in data:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for index, cells in enumerate(data["frames"]):
        render(cells).save(out / f"frame-{index:04d}.png")
else:
    render(data["cells"]).save(sys.argv[1], optimize=True)
