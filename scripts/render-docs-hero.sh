#!/usr/bin/env bash
# Preserve the original screenshot pixels; only perspective and shadow are added.
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source_image="$repo_root/planner/guide-assets/06-preview.jpg"
output_image="$repo_root/docs/images/home-studio-hero.jpg"
command -v magick >/dev/null 2>&1 || { printf '%s\n' 'ImageMagick 7 is required.' >&2; exit 1; }
[[ "$(magick identify -format '%wx%h' "$source_image")" == '1280x720' ]] || { printf '%s\n' 'Screenshot dimensions changed; review the perspective before rendering.' >&2; exit 1; }
render_dir="$(mktemp -d "${TMPDIR:-/tmp}/docs-hero.XXXXXX")"
trap 'rm -rf -- "$render_dir"' EXIT
magick "$source_image" -alpha on -virtual-pixel transparent -filter Robidoux \
  -define distort:viewport=1540x1100+0+0 -distort Perspective '0,0 160,294 1279,0 1320,224 1279,719 1370,851 0,719 220,966' \
  -strip "$render_dir/panel.png"
magick "$render_dir/panel.png" -fill '#152033' -colorize 100 \
  -channel A -evaluate multiply 0.22 +channel -blur 0x18 -strip "$render_dir/shadow.png"
magick -size 1540x1100 xc:'#f0f1f3' \
  "$render_dir/shadow.png" -geometry +0+22 -compose Over -composite \
  "$render_dir/panel.png" -geometry +0+0 -compose Over -composite \
  -strip -sampling-factor 4:4:4 -quality 94 "$render_dir/hero.jpg"
mv -- "$render_dir/hero.jpg" "$output_image"
printf 'Rendered %s\n' "$output_image"
