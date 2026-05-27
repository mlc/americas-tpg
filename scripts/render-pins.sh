#!/usr/bin/env bash
# Regenerate assets/pins/*.png — the color-baked Google-Maps-style pin images
# that `yarn build-kml` bundles into rounds.kmz. One PNG per simplestyle marker
# (symbol + color); the color is baked into the image because Google My Maps
# ignores KML <IconStyle><color> on import.
#
# Filenames match src/kml.ts's styleIdFor(): s_<symbol>_<rrggbb>.png.
# Requires rsvg-convert (librsvg). Re-run after changing the SIMPLESTYLE palette.
set -euo pipefail
cd "$(dirname "$0")/.."
out=assets/pins
mkdir -p "$out"

SIZE=64
# Teardrop pin body; tip at bottom-center (~32,61). FILL is substituted per call.
BODY='<path d="M32 3 C 19.8 3 10 12.8 10 25 C 10 36 24 50 30.6 60.6 C 31.3 61.7 32.7 61.7 33.4 60.6 C 40 50 54 36 54 25 C 54 12.8 44.2 3 32 3 Z" fill="FILL" stroke="#0000001f" stroke-width="1"/>'
# White knocked-out symbols, centred in the pin head (~32,24).
CIRCLE='<circle cx="32" cy="24" r="8.5" fill="#ffffff" stroke="#00000026" stroke-width="0.8"/>'
STAR='<polygon points="32,13 34.70,20.28 42.46,20.60 36.37,25.42 38.47,32.90 32,28.60 25.53,32.90 27.63,25.42 21.54,20.60 29.30,20.28" fill="#ffffff" stroke="#00000026" stroke-width="0.8"/>'

render() { # $1=style-id  $2=fill (#rrggbb)  $3=symbol svg
  local svg="<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"${SIZE}\" height=\"${SIZE}\" viewBox=\"0 0 64 64\">${BODY/FILL/$2}$3</svg>"
  printf '%s' "$svg" | rsvg-convert -w "$SIZE" -h "$SIZE" -o "$out/$1.png"
  echo "wrote $out/$1.png"
}

render s_star_000000   "#000000" "$STAR"
render s_circle_d4af37 "#d4af37" "$CIRCLE"
render s_circle_c0c0c0 "#c0c0c0" "$CIRCLE"
render s_circle_cd7f32 "#cd7f32" "$CIRCLE"
render s_circle_ff0000 "#ff0000" "$CIRCLE"
render s_circle_444444 "#444444" "$CIRCLE"
