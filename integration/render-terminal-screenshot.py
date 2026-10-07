#!/usr/bin/env python3
"""Render tmux's ANSI pane capture as a portable SVG terminal screenshot."""

import ctypes
import ctypes.util
import html
import re
import sys
import unicodedata
from pathlib import Path

SGR = re.compile(r"\x1b\[([0-9;:]*)m")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
DEFAULT_FG = "#d8dee9"
DEFAULT_BG = "#10151c"
PALETTE = [
    "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
]


def color_256(index):
    if index < 16:
        return PALETTE[index]
    if index < 232:
        index -= 16
        levels = [0, 95, 135, 175, 215, 255]
        return "#%02x%02x%02x" % (levels[index // 36], levels[(index // 6) % 6], levels[index % 6])
    gray = 8 + (index - 232) * 10
    return "#%02x%02x%02x" % (gray, gray, gray)


def apply_sgr(style, raw):
    values = [int(part or "0") for part in raw.replace(":", ";").split(";")]
    i = 0
    while i < len(values):
        code = values[i]
        i += 1
        if code == 0:
            style.update(fg=DEFAULT_FG, bg=None, bold=False, underline=False)
        elif code == 1:
            style["bold"] = True
        elif code in (22,):
            style["bold"] = False
        elif code == 4:
            style["underline"] = True
        elif code == 24:
            style["underline"] = False
        elif code == 39:
            style["fg"] = DEFAULT_FG
        elif code == 49:
            style["bg"] = None
        elif 30 <= code <= 37:
            style["fg"] = PALETTE[code - 30]
        elif 90 <= code <= 97:
            style["fg"] = PALETTE[code - 90 + 8]
        elif 40 <= code <= 47:
            style["bg"] = PALETTE[code - 40]
        elif 100 <= code <= 107:
            style["bg"] = PALETTE[code - 100 + 8]
        elif code in (38, 48) and i < len(values):
            target = "fg" if code == 38 else "bg"
            mode = values[i]
            i += 1
            if mode == 5 and i < len(values):
                style[target] = color_256(max(0, min(255, values[i])))
                i += 1
            elif mode == 2 and i + 2 < len(values):
                r, g, b = values[i:i + 3]
                style[target] = "#%02x%02x%02x" % tuple(max(0, min(255, x)) for x in (r, g, b))
                i += 3


def line_runs(line, initial_style):
    style = dict(initial_style)
    runs = []
    position = 0
    for match in SGR.finditer(line):
        if match.start() > position:
            runs.append((line[position:match.start()], dict(style)))
        apply_sgr(style, match.group(1))
        position = match.end()
    if position < len(line):
        text = ANSI.sub("", line[position:])
        if text:
            runs.append((text, dict(style)))
    return runs, style


def cell_width(text):
    width = 0
    for char in text:
        category = unicodedata.category(char)
        if category.startswith("M") or char in ("\u200d", "\ufe0f"):
            continue
        width += 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
    return width


def rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[index:index + 2], 16) / 255 for index in (0, 2, 4))


def render_png(lines, output_path, width, height, cell, line_height, padding):
    library = ctypes.util.find_library("cairo")
    if not library:
        return False
    cairo = ctypes.CDLL(library)
    cairo.cairo_image_surface_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
    cairo.cairo_image_surface_create.restype = ctypes.c_void_p
    cairo.cairo_create.argtypes = [ctypes.c_void_p]
    cairo.cairo_create.restype = ctypes.c_void_p
    cairo.cairo_select_font_face.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
    cairo.cairo_set_font_size.argtypes = [ctypes.c_void_p, ctypes.c_double]
    cairo.cairo_set_source_rgb.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_double, ctypes.c_double]
    cairo.cairo_paint.argtypes = [ctypes.c_void_p]
    cairo.cairo_rectangle.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_double, ctypes.c_double, ctypes.c_double]
    cairo.cairo_fill.argtypes = [ctypes.c_void_p]
    cairo.cairo_move_to.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_double]
    cairo.cairo_show_text.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    cairo.cairo_surface_write_to_png.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    cairo.cairo_surface_write_to_png.restype = ctypes.c_int
    cairo.cairo_destroy.argtypes = [ctypes.c_void_p]
    cairo.cairo_surface_destroy.argtypes = [ctypes.c_void_p]

    surface = cairo.cairo_image_surface_create(0, width, height)  # CAIRO_FORMAT_ARGB32
    context = cairo.cairo_create(surface)
    try:
        cairo.cairo_set_source_rgb(context, *rgb(DEFAULT_BG))
        cairo.cairo_paint(context)
        cairo.cairo_select_font_face(context, b"DejaVu Sans Mono", 0, 0)
        cairo.cairo_set_font_size(context, 14)
        style = {"fg": DEFAULT_FG, "bg": None, "bold": False, "underline": False}
        for row_index, line in enumerate(lines):
            runs, style = line_runs(line, style)
            x = padding
            baseline = padding + (row_index + 1) * line_height - 4
            for text, run_style in runs:
                text = text.replace("\t", "    ")
                columns = cell_width(text)
                if run_style["bg"]:
                    cairo.cairo_set_source_rgb(context, *rgb(run_style["bg"]))
                    cairo.cairo_rectangle(context, x, padding + row_index * line_height, columns * cell, line_height)
                    cairo.cairo_fill(context)
                cairo.cairo_set_source_rgb(context, *rgb(run_style["fg"]))
                cairo.cairo_move_to(context, x, baseline)
                cairo.cairo_show_text(context, text.encode("utf-8", "replace"))
                x += columns * cell
        result = cairo.cairo_surface_write_to_png(surface, str(output_path).encode())
        if result != 0:
            raise RuntimeError(f"cairo could not write PNG (status {result})")
        return True
    finally:
        cairo.cairo_destroy(context)
        cairo.cairo_surface_destroy(surface)


def render_svg(lines, output_path, columns, cell, line_height, padding):
    width = max(640, columns * cell + padding * 2)
    height = max(160, len(lines) * line_height + padding * 2)
    style = {"fg": DEFAULT_FG, "bg": None, "bold": False, "underline": False}
    output = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="Pi TUI integration screenshot">',
        f'<rect width="100%" height="100%" fill="{DEFAULT_BG}"/>',
        '<g font-family="DejaVu Sans Mono, monospace" font-size="14">',
    ]
    for row_index, line in enumerate(lines):
        runs, style = line_runs(line, style)
        x = padding
        baseline = padding + (row_index + 1) * line_height - 4
        for text, run_style in runs:
            text = text.replace("\t", "    ")
            columns_used = cell_width(text)
            if run_style["bg"]:
                output.append(f'<rect x="{x}" y="{padding + row_index * line_height}" width="{columns_used * cell}" height="{line_height}" fill="{run_style["bg"]}"/>')
            weight = "bold" if run_style["bold"] else "normal"
            decoration = " underline" if run_style["underline"] else ""
            output.append(f'<text x="{x}" y="{baseline}" fill="{run_style["fg"]}" font-weight="{weight}" text-decoration="{decoration.strip()}">{html.escape(text)}</text>')
            x += columns_used * cell
    output.extend(["</g>", "</svg>"])
    output_path.write_text("\n".join(output) + "\n", encoding="utf-8")
    return width, height


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: render-terminal-screenshot.py <tmux-capture.ansi> <screenshot.svg>")
    source = Path(sys.argv[1])
    svg_path = Path(sys.argv[2])
    raw = source.read_text(encoding="utf-8", errors="replace").replace("\r", "")
    lines = raw.splitlines()
    columns = max((cell_width(ANSI.sub("", SGR.sub("", line))) for line in lines), default=80)
    cell = 9
    line_height = 20
    padding = 14
    width, height = render_svg(lines, svg_path, columns, cell, line_height, padding)
    png_path = svg_path.with_suffix(".png")
    if render_png(lines, png_path, width, height, cell, line_height, padding):
        print(f"SVG and PNG screenshots saved: {svg_path}, {png_path}")
    else:
        print(f"SVG screenshot saved: {svg_path} (libcairo unavailable; PNG omitted)")


if __name__ == "__main__":
    main()
