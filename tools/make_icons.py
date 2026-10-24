# -*- coding: utf-8 -*-
"""Generate icon-192.png and icon-512.png for the Listo logo (stdlib only).

Rounded green square + two faded list lines + white checkmark — same
artwork as www/icon.svg. Antialiasing via 4x supersampling.

Usage: python3 tools/make_icons.py
"""
import math
import os
import struct
import zlib

BG = (27, 94, 32)           # #1b5e20
WHITE = (255, 255, 255)
LINE = tuple(round(BG[i] + (WHITE[i] - BG[i]) * 0.38) for i in range(3))

RADIUS_RATIO = 110 / 512
SS = 4  # supersampling factor (antialiasing)

# Geometry (SVG 512 space, y pointing down)
LINES = [((130, 150), (285, 150), 15),   # (x1,y1),(x2,y2), half-width
         ((130, 235), (245, 235), 15)]
CHECK = [(130, 330), (215, 415), (395, 190)]
CHECK_W = 29


def seg_dist(px, py, x1, y1, x2, y2):
    """Distance point-segment."""
    dx, dy = x2 - x1, y2 - y1
    l2 = dx * dx + dy * dy
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / l2)) if l2 else 0.0
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def rounded(px, py, size):
    """True if the point is inside the rounded square."""
    r = size * RADIUS_RATIO
    cx = min(max(px, r), size - r)
    cy = min(max(py, r), size - r)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r or (
        r <= px <= size - r or r <= py <= size - r)


def pixel(px, py, s):
    """RGBA color of a sub-pixel, or None if transparent."""
    if not rounded(px, py, 512):
        return None
    for i in range(len(CHECK) - 1):
        (x1, y1), (x2, y2) = CHECK[i], CHECK[i + 1]
        if seg_dist(px, py, x1, y1, x2, y2) <= CHECK_W:
            return WHITE
    for (x1, y1), (x2, y2), w in LINES:
        if seg_dist(px, py, x1, y1, x2, y2) <= w:
            return LINE
    return BG


def mix(colors):
    n = len(colors)
    if n == 0:
        return (0, 0, 0, 0)
    return tuple(round(sum(c[i] for c in colors) / n) for i in range(3)) + (
        round(255 * n / (SS * SS)),)


def make_icon(size, path):
    s = 512 / (size * SS)
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            subs = []
            for sy in range(SS):
                for sx in range(SS):
                    px = (x * SS + sx + 0.5) * s
                    py = (y * SS + sy + 0.5) * s
                    c = pixel(px, py, s)
                    if c is not None:
                        subs.append(c)
            row += bytes(mix(subs))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + \
            struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print("wrote %s (%dx%d)" % (path, size, size))


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..",
                       "custom_components", "listo", "www", "img")
    make_icon(192, os.path.join(out, "icon-192.png"))
    make_icon(512, os.path.join(out, "icon-512.png"))
