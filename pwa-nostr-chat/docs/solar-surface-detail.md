# Solar surface detail

Earth keeps its Esri basemap. The 22 other mapped planets and moons keep the
existing globe texture as a fallback, then stream 256×256 color tiles as the
focused view gets closer. The Sun is a separate procedural rendering. Tile
resolution reflects the best supported source, not a promise of street-map
detail or new observations on poorly imaged terrain.

- The Moon uses the NASA LROC/WAC mosaic at 8,192×4,096. The overview and new
  detail use the same north-up, east-positive registration (longitude 0 at
  the horizontal midpoint). No body orientation or geohash coordinates change.
- The other source images provide 1,264 to 4,096 pixels across. The tile
  manifest records the source width used; a non-power-of-two image is
  resampled to the next tile grid so it keeps its available detail.
- The mobile atlas holds eight tiles (about 2 MiB of RGBA pixel data) and
  fetches at most two at once. Desktop holds 16 tiles and fetches up to four.
  These limits cover the new atlas, not the entire renderer or JS heap.
  Data Saver skips all close-up texture and tile fetches. No tiles are
  precached, and failed or offline requests leave the fallback visible.
- Tiles include two-pixel gutters. Longitudes wrap at the antimeridian;
  latitudes clamp at the poles. Near a pole or in a wide view the planner
  can choose a coarser level to keep the visible area within budget.

## Updating imagery

See [imagery credits](../public/solar-map-credits.html). Source URLs and SHA-256
pins are in [the base manifest](../scripts/solar-map-sources.json) and [tile
overrides](../scripts/solar-tile-source-overrides.json). To rebake, install
Pillow with WebP support and run:

```sh
python3 scripts/build-solar-tiles.py /path/to/source-cache [body ...]
npm run test:solar-tiles
npm run test:solar-maps
npm run test:lunar-orientation
```

The tile baker does not delete old tiles. If the content hash changes, remove
the old generated revision for that body before committing. Tile routes are
same-origin and versioned by content; the service worker stores up to 96
visited tiles, independently of the app precache.
