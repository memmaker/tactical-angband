# Tactical Angband — RVIP handover

Tactical Angband (tomm's Angband 4.2 variant: 50 short levels, one blow ×
might, few teleports) imported per `~/Games/rvip-tools/RVIP.md` (case A) and published
on the web per `~/Games/rogue2wasm.md`.

- Play (Mac): Desktop shortcut `~/Desktop/Games/Roguelikes/Tactical Angband`
  (Finder alias to `Tactical-Angband.app`), or `./play.sh`.
- Play (web): https://ruzzoli.de/roguelikes/tactical-angband/
- Docs page: `~/Desktop/Games/Roguelikes/Docs/tactical-angband.html`

## Source and changes

- Base: **Tactical Angband 0.9beta2** (tag `0.9beta2`, built on Angband
  4.2.6), commit `06a3ea6aad49f4101f9dc219dbfba0529504b176`, the first
  commit of this history (pristine upstream, `upstream` remote =
  https://github.com/tomm/tactical-angband).
- Original source: https://github.com/tomm/tactical-angband/tree/06a3ea6aad49f4101f9dc219dbfba0529504b176
- Our changes: https://github.com/memmaker/tactical-angband/compare/06a3ea6aa...master
  (an older, unrelated fork `memmaker/tactical-angbandX` from 2024 exists and
  was left alone).

## What was done (RVIP steps)

1. **Build:** kept the Cocoa app (`cd src && make -f Makefile.osx
   ARCHS=arm64`). Reason: 4.2's `main-x11.c` has no tile support, while the
   Cocoa frontend has tiles, per-window fonts and the 4.2 sound module; the
   web build doesn't need X11 either. Own bundle id
   `org.rephial.tactical-angband` (it shared vanilla Angband's defaults
   before). One ASan run was done with a curses build of the same sources
   driven through a pty (birth, command menu, inventory actions, stairs,
   explore, options, save): no reports; the ASan objects lived in the
   scratchpad and were deleted.
2. **Auto-explore `p`** (`do_cmd_explore`, `player-path.c`): upstream walked
   to the nearest unknown grid and stopped; now it continues until a monster
   is in view, a new message appears (`messages_added` counter in
   `message.c`) or a key is pressed. Locked doors: stops, skips them next
   time. Walks into an adjacent closed door to open it. `autoexplore_commands`
   defaults to on.
3. **`<` / `>`** always work: take the stairs or walk to the nearest known
   ones and take them on arrival (`path_arrived()` in `player-path.c`; the
   upstream code never reached its "path finished" branch).
3b. **Enter menu** (`ui-context.c`): existing 4.2 menu; the "Hidden" group's
   player commands were moved into Action / Information / Utility (explore
   included), the rest is "Wizard and debug"; boxes are sized to content.
3c. **Inventory** (`inven_browse()` in `ui-knowledge.c`, `browse_key()` in
   `ui-object.c`, `context_menu_object_act()` in `ui-context.c`): letter =
   main action, Shift+letter drop, Ctrl+letter inspect, Enter/Space/click =
   action menu, keypad 8/2/4/6/5/+/-/*/0; reopens after an action unless a
   monster is in view (hook at the top of `textui_process_command()`).
   Keypad 5 chooses in every item prompt.
4. **Tiles:** Shockbolt Dark (64×64) at 32 px by default
   (`GraphicsID`=5, `TileFraction`=500), drawn with
   `kCGInterpolationNone` (nearest-neighbour). All monsters are mapped;
   flavoured items use the flavour tiles.
5. **Layout:** `play.sh` writes the first-run window frames for 1440×900
   (map left, Inventory / monsters / items right, Messages + Recall bottom)
   into the app defaults, then opens the app. The main window was checked
   with a window-only capture; the subwindows only appear once a game is
   loaded, which needs menu input — not verified visually on the Mac.
6. **Docs:** entry updated in `build-docs.py` / `guides.py` (Tips, "On this
   computer", new keys), rebuilt.
6b. **Sound:** the game's own `EVENT_SOUND` (MSG_* types) → Dubtrain samples
   via `lib/customize/sound.prf` (4.2 ships the Dubtrain pack as mp3); added
   `BR_WIND` and `SCRAMBLE`. Web: Sound/Music buttons, off by default, town
   music (`web/music/new_town.ogg`) at depth 0.
7. **Web:** `src/main-web.c` (4.2 z-term hooks, wchar/int arrays read from
   `HEAP32`, 4.2 key codes + modifiers, dblh overdraw for tall Shockbolt
   tiles), `web/tactical.js`, `web/index.html`, `web/build.sh`,
   `web/deploy.sh`, `web/make-help.py`. Saves in IndexedDB under
   `/tactical-angband/lib/{save,user,scores,panic}`.

## Testing notes

- Curses test harness (not committed): build all sources with `-DUSE_GCU`
  into a scratch dir and drive it with a pty + small VT100 model; pass
  `-duser=… -dsave=… -dscores=… -dpanic=… -darchive=…` *before* `-u<name>`
  so no file touches the game folder or `~/Documents/Tactical Angband`.
- Web checked locally in the browser pane: birth, tiles, 5 subwindows,
  Enter menu, inventory + keypad (synthetic `Numpad*` events), explore,
  stairs, options menu incl. subwindow setup, Ctrl-S, reload restores the
  character and the sound setting, sound files fetched, resize, Ctrl-X →
  high scores.
- Prompt line (RVIP step 5 / W4, 2026-09-26): the live message row is shown in a
  box over the map by `RvipWM.prompt` (rvip-wm.js). A key hides it only while
  the game waits for a command, so a question stays up until answered.
  Here: `js_next_event(inkey_flag && character_generated)` in `src/main-web.c`;
  the page tracks term 0 row 0 (`row0` in `text`/`wipe`/`clear`) and sends it on
  `fresh(0)`.
