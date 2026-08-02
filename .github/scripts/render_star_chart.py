#!/usr/bin/env python3
"""Render metrics/stars.csv into metrics/stars.svg.

Depends only on Python's stdlib so the CI runner needs no extra packages.
Produces a small, dependency-free SVG line chart of GitHub stars over time.
"""
import csv
import os
import sys

W, H = 760, 320
PAD_L, PAD_R, PAD_T, PAD_B = 60, 24, 20, 48
X0, X1 = PAD_L, W - PAD_R
Y0, Y1 = PAD_T, H - PAD_B


def main() -> int:
    csv_path = "metrics/stars.csv"
    if not os.path.exists(csv_path):
        print(f"Missing {csv_path}", file=sys.stderr)
        return 1

    rows = []
    with open(csv_path) as fh:
        for line in csv.DictReader(fh):
            try:
                rows.append((line["date"], int(line["stars"])))
            except (KeyError, ValueError):
                continue

    if not rows:
        print("No usable rows", file=sys.stderr)
        return 1

    dates = [r[0] for r in rows]
    stars = [r[1] for r in rows]
    lo, hi = 0, max(stars) or 1
    if hi == lo:
        hi = lo + 1
    last = (dates[-1], stars[-1])

    def sx(i: int) -> int:
        return X0 + int(round(i * (X1 - X0) / max(len(dates) - 1, 1)))

    def sy(n: int) -> int:
        return Y1 - int(round((n - lo) * (Y1 - Y0) / (hi - lo)))

    blue = "#6366f1"
    grid = "#e2e8f0"
    label = "#64748b"

    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
        'viewBox="0 0 %d %d" role="img" '
        'aria-label="Inkvoice GitHub stars over time">' % (W, H, W, H),
        f'<style>.tick{{fill:{label};font:11px sans-serif}}.grid{{stroke:{grid};'
        f'stroke-width:1}}</style>',
    ]

    # horizontal gridlines + y-axis labels
    ticks = 5
    for i in range(ticks + 1):
        n = int(lo + (hi - lo) * i / ticks)
        y = sy(n)
        parts.append(f'<line x1="{X0}" y1="{y}" x2="{X1}" y2="{y}" class="grid"/>')
        parts.append(
            f'<text x="{X0 - 8}" y="{y + 4}" class="tick" text-anchor="end">{n}</text>')

    # x-axis date labels: first, middle, last
    for i in (0, len(dates) // 2, len(dates) - 1):
        parts.append(
            f'<text x="{sx(i)}" y="{Y1 + 20}" class="tick" text-anchor="middle">'
            f'{dates[i]}</text>')

    # baseline
    parts.append(f'<line x1="{X0}" y1="{Y1}" x2="{X1}" y2="{Y1}" stroke="{grid}"/>')

    # data
    if len(rows) > 1:
        pts = " ".join(f"{sx(i)},{sy(n)}" for i, (_, n) in enumerate(rows))
        parts.append(
            f'<polygon points="{X0},{Y1} {pts} {X1},{Y1}" fill="{blue}" '
            'fill-opacity="0.12"/>')
        parts.append(f'<polyline points="{pts}" fill="none" stroke="{blue}" '
                     'stroke-width="2"/>')
    parts.append(f'<circle cx="{sx(len(dates) - 1)}" '
                 f'cy="{sy(stars[-1])}" r="3" fill="{blue}"/>')
    parts.append(f'<text x="{X1}" y="{Y1 - 10}" class="tick" text-anchor="end">'
                 f'⭐ {stars[-1]}</text>')

    parts.append('</svg>')

    with open("metrics/stars.svg", "w") as fh:
        fh.write("\n".join(parts))
    print("Wrote metrics/stars.svg")
    return 0


if __name__ == "__main__":
    sys.exit(main())