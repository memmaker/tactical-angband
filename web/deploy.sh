#!/bin/sh
# Upload web/dist to https://ruzzoli.de/roguelikes/tactical-angband/
set -e
cd "$(dirname "$0")"
git fetch -q && [ -z "$(git status --porcelain)" ] && [ "$(git rev-parse @)" = "$(git rev-parse @{u})" ] || { echo "commit + push first" >&2; exit 1; }
ssh ruzzoli.de 'sudo mkdir -p /var/www/ruzzoli.de/roguelikes/tactical-angband && sudo chown -R felix:www-data /var/www/ruzzoli.de/roguelikes/tactical-angband'
rsync -rtz --delete dist/ ruzzoli.de:/var/www/ruzzoli.de/roguelikes/tactical-angband/
