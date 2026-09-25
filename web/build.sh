#!/bin/sh
# Build Tactical Angband for the browser (Emscripten + Asyncify).
# Output goes to web/dist; deploy with web/deploy.sh.  Run with sh, not zsh.
set -e
cd "$(dirname "$0")/.."
OUT=web/dist
rm -rf "$OUT" web/stage && mkdir -p "$OUT" web/stage/lib/tiles/shockbolt

# Game data (lib/user is the IndexedDB mount, created by the page)
for d in gamedata customize help screens; do cp -R lib/$d web/stage/lib/; done
cp lib/tiles/list.txt web/stage/lib/tiles/
cp lib/tiles/shockbolt/*.prf web/stage/lib/tiles/shockbolt/
find web/stage -name Makefile -delete

SRCS=$(tr -d '\r' < src/Makefile.src | sed -n '/^ANGFILES/,/^$/p;/^ZFILES/,/^$/p' \
	| grep -o '[A-Za-z0-9_/.-]*\.o' | grep -v '^borg/' | sed 's/\.o$/.c/;s|^|src/|' | sort -u)

emcc -O2 -std=gnu99 -DUSE_WEB -DHAVE_MKSTEMP -Isrc -w \
	$SRCS src/main.c src/main-web.c \
	-o "$OUT/tactical-core.js" \
	-sASYNCIFY -sASYNCIFY_STACK_SIZE=131072 -sSTACK_SIZE=2097152 \
	-sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=128MB \
	-sEXPORTED_FUNCTIONS=_main,_web_request_save \
	-sEXPORTED_RUNTIME_METHODS=FS,IDBFS,HEAP32,addRunDependency,removeRunDependency \
	-sFORCE_FILESYSTEM -lidbfs.js -sENVIRONMENT=web \
	--preload-file web/stage/lib@/tactical-angband/lib

cp web/index.html "$HOME/Games/rvip-tools/web/rvip-wm.js" web/tactical.js "$OUT/"
# Shockbolt tiles, lossless WebP (the PNG is 18 MB); drawn nearest-neighbour
[ web/tiles.webp -nt lib/tiles/shockbolt/64x64.png ] || \
	cwebp -quiet -lossless -z 9 -exact lib/tiles/shockbolt/64x64.png -o web/tiles.webp
cp web/tiles.webp "$OUT/"
# Sound effects (Dubtrain, mapped by sound.prf) and town music, fetched on demand
mkdir -p "$OUT/sounds" "$OUT/music"
cp lib/sounds/*.mp3 "$OUT/sounds/" && cp lib/customize/sound.prf "$OUT/sounds/"
cp web/music/new_town.ogg "$OUT/music/"
# Game guide for the Help button, from ~/Desktop/Games/Roguelikes/Docs
python3 web/make-help.py > "$OUT/help.html"
rm -rf web/stage
ls -la "$OUT"
