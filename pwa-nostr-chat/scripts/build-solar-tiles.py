"""Bake immutable, north-up WebP tile pyramids for the focused globe.

Usage: python3 scripts/build-solar-tiles.py CACHE [BODY ...]
Pillow with WebP is required. No network or Python needed by Vite or CI.
"""
import argparse
import hashlib
import json
import runpy
from pathlib import Path
from io import BytesIO
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
BASE = runpy.run_path(str(ROOT / "scripts/build-solar-maps.py"))
SOURCES = BASE["SOURCES"]
OVERRIDES = BASE["DETAIL_OVERRIDES"]
OUTPUT = ROOT / "public/solar-tiles"
MANIFEST = ROOT / "src/assets/solar-tile-levels.json"
TILE, GUTTER = 256, 2


def tile_image(image, x, y):
    width, height = image.size
    left, top = x * TILE, y * TILE
    out = Image.new("RGB", (TILE + 2 * GUTTER,) * 2)
    # West/east wraps at the antimeridian. Only pole-edge rows clamp.
    for turn in (-1, 0, 1):
        x0, x1 = left - GUTTER + turn * width, left + TILE + GUTTER + turn * width
        y0, y1 = max(0, top - GUTTER), min(height, top + TILE + GUTTER)
        x_src0, x_src1 = max(0, x0), min(width, x1)
        if x_src1 > x_src0:
            out.paste(image.crop((x_src0, y0, x_src1, y1)), (x_src0 - x0, y0 - top + GUTTER))
    if top == 0:
        out.paste(out.crop((0, GUTTER, out.width, GUTTER + 1)).resize((out.width, GUTTER)), (0, 0))
    if top + TILE == height:
        out.paste(out.crop((0, TILE + GUTTER - 1, out.width, TILE + GUTTER)).resize((out.width, GUTTER)), (0, TILE + GUTTER))
    return out


def webp(image):
    for q in range(81, 20, -5):
        out = BytesIO()
        image.save(out, "WEBP", quality=q, method=4)
        data = out.getvalue()
        if len(data) <= 32 * 1024:
            return data
    raise ValueError("Tile exceeds 32 KiB")


def bake(body, cache):
    over = OVERRIDES.get(body)
    image = BASE["load_image"](body, cache, over, cache_name=body + "-detail" if over else None)
    max_width = min(image.width, 8192 if body == "moon" else 4096)
    # A non-power-of-two source uses the next grid size to retain all
    # available samples, not to claim detail beyond the native resolution.
    max_level = (max_width - 1).bit_length() - (2 * TILE).bit_length() + 1
    if max_level < 1:
        return None
    tiles = []
    digest = hashlib.sha256()
    for level in range(1, max_level + 1):
        rows = 1 << level
        scale = image.resize((rows * 2 * TILE, rows * TILE), Image.Resampling.LANCZOS)
        for y in range(rows):
            for x in range(2 * rows):
                key = Path(str(level)) / str(x) / f"{y}.webp"
                data = webp(tile_image(scale, x, y))
                digest.update(data)
                tiles.append((key, data))
    revision = digest.hexdigest()[:16]
    for key, data in tiles:
        p = OUTPUT / body / revision / key
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    if body == "moon" and over:
        # Keep adjacent LODs in the same radiometry and registration. The
        # distant overview remains the original independently registered map.
        BASE["bake_focus_maps"](image, body)
    print(f"{body}: {image.width} px source → {512 << max_level} px tiled, {len(tiles)} files, {sum(len(data) for _, data in tiles):,} bytes", flush=True)
    return {"level": max_level, "revision": revision, "sourceWidth": max_width}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path)
    parser.add_argument("bodies", nargs="*")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    bodies = [body for body in SOURCES if body != "earth" and "-" not in body]
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    for body in (args.bodies or bodies):
        if body not in bodies:
            parser.error(f"Not a tileable surface: {body}")
        result = bake(body, args.cache)
        if result is not None:
            manifest[body] = result
    MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
