"""Rebake the checked-in maps; not part of the app build. Requires Pillow with WebP.
Usage: python3 scripts/build-solar-maps.py /path/to/a/download-cache
Sources, credits and known coverage gaps: public/solar-map-credits.html.
"""
import hashlib
import io
import json
import struct
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageChops, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SOURCES = json.loads((ROOT / "scripts/solar-map-sources.json").read_text())
DETAIL_OVERRIDES = json.loads((ROOT / "scripts/solar-tile-source-overrides.json").read_text())
OUTPUT = ROOT / "src/assets/solar"


def load_image(key, cache, source=None, *, cache_name=None):
    source = source or SOURCES[key]
    ext = Path(source["url"]).suffix
    path = cache / ((cache_name or key) + ext)
    if not path.exists():
        with urllib.request.urlopen(source["url"], timeout=60) as response:
            path.write_bytes(response.read())
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != source["sha256"]:
        raise ValueError(f"Source changed for {key}; inspect it before updating the pin.")
    if ext == ".glb":
        # NASA VTAD cylindrical sphere: use the base color, never its geometry or normals.
        json_len = struct.unpack_from("<I", data, 12)[0]
        gltf = json.loads(data[20:20 + json_len])
        texture = gltf["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
        image = gltf["images"][gltf["textures"][texture]["source"]]
        view = gltf["bufferViews"][image["bufferView"]]
        start = 28 + json_len + view.get("byteOffset", 0)
        data = data[start:start + view["byteLength"]]
    image = Image.open(io.BytesIO(data)).convert("RGB")
    if key == "titan":
        # PIA19658 plate: remove frame, all ticks, and caption. Left edge is
        # 360°W (= 0°E); shift to the globe's -180°..180° east-positive convention.
        image = image.crop((196, 218, 4240, 2240))
        image = ImageChops.offset(image, image.width // 2, 0)
        image = ImageOps.colorize(image.convert("L"), "#4b3422", "#edcf93")
    if image.width != 2 * image.height:
        raise ValueError(f"{key} is not a 2:1 map: {image.size}")
    return image


def encode(image, target, quality, limit):
    for q in range(quality, 17, -4):
        image.save(target, "WEBP", quality=q, method=6)
        if target.stat().st_size <= limit:
            return
    raise ValueError(f"{target.name} exceeds {limit} bytes")


def bake_focus_maps(surface, body):
    for width, quality, limit in ((512, 78, 24 * 1024), (1024, 82, 100 * 1024)):
        detail = surface.resize((width, width // 2), Image.Resampling.LANCZOS)
        encode(detail, OUTPUT / f"surface-{body}-{width}.webp", quality, limit)


def build(cache):
    cache.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    keys = list(SOURCES)
    # 640 × 320 in total (23 surface views plus two cloud-top views). Each slot has longitude-wrapped and latitude-
    # clamped gutters so bilinear filtering never samples a neighbouring world.
    atlas = Image.new("RGB", (640, ((len(keys) + 4) // 5) * 64))
    slots = {}
    for slot, body in enumerate(keys):
        slots[body] = slot
        surface = load_image(body, cache)
        thumb = surface.resize((120, 60), Image.Resampling.LANCZOS)
        tile = Image.new("RGB", (128, 64))
        tile.paste(thumb, (4, 2))
        tile.paste(thumb.crop((116, 0, 120, 60)), (0, 2))
        tile.paste(thumb.crop((0, 0, 4, 60)), (124, 2))
        tile.paste(tile.crop((0, 2, 128, 3)).resize((128, 2)), (0, 0))
        tile.paste(tile.crop((0, 61, 128, 62)).resize((128, 2)), (0, 62))
        atlas.paste(tile, ((slot % 5) * 128, (slot // 5) * 64))
        if body != "earth" and "-" not in body:  # Earth uses zoomable topo; haze is overview-only
            if body == "moon":
                surface = load_image(body, cache, DETAIL_OVERRIDES[body], cache_name=body + "-detail")
            bake_focus_maps(surface, body)
    encode(atlas, OUTPUT / "solar-overview.webp", 84, 40 * 1024)
    (OUTPUT / "slots.json").write_text(json.dumps(slots, indent=2) + "\n")


if __name__ == "__main__":
    build(Path(sys.argv[1]).expanduser())
