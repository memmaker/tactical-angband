#!/bin/sh
# Upload web/dist to https://ruzzoli.de/roguelikes/tactical-angband/
set -e
cd "$(dirname "$0")"
ssh ruzzoli.de 'sudo mkdir -p /var/www/ruzzoli.de/roguelikes/tactical-angband && sudo chown -R felix:www-data /var/www/ruzzoli.de/roguelikes/tactical-angband'
rsync -rtz --delete dist/ ruzzoli.de:/var/www/ruzzoli.de/roguelikes/tactical-angband/
