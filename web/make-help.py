#!/usr/bin/env python3
"""Writes the in-page game guide (dist/help.html) for the web build.

The game content comes from the desktop key guides in
~/Desktop/Games/Roguelikes/Docs (build-docs.py + guides.py), so both guides
stay in sync; only the saving and "playing in the browser" parts are
written here, because they differ on the web."""
import html, importlib.util, os, sys

DOCS = os.path.expanduser('~/Desktop/Games/Roguelikes/Docs')
PAGE = 'tactical-angband.html'
BASE = '06a3ea6aad49f4101f9dc219dbfba0529504b176'

sys.path.insert(0, DOCS)
spec = importlib.util.spec_from_file_location('build_docs', os.path.join(DOCS, 'build-docs.py'))
docs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(docs)
from guides import GUIDES   # noqa: E402

game = next(g for g in docs.GAMES if g['file'] == PAGE)
guide = dict(GUIDES[PAGE])
info = dict(game['info'])
kbd = docs.kbd
esc = html.escape

SAVING = '''<ul>
<li><strong>Saving is automatic.</strong> The game is stored in this browser (IndexedDB) every two minutes while it waits for your next command, whenever you switch to another tab or window, and on every level change. Reloading the page continues from there.</li>
<li><kbd>Ctrl+S</kbd> saves right away. <kbd>Ctrl+X</kbd> saves and ends the session; reload the page (or press <em>Play again</em>) to continue.</li>
<li>When your character dies, the next start rolls a new one.</li>
<li>Each browser keeps <strong>one character</strong>. <em>New character</em> deletes it and starts over.</li>
<li><em>Export save</em> downloads the savefile; <em>Import save</em> loads one. Use them for a backup or to move a character to another browser or computer (the Mac app reads the same file: put it in <code>~/Documents/Tactical Angband/save</code>).</li>
<li>Options, window layout, zoom and the sound/music switches are stored in the same browser storage.</li>
<li>Private/incognito windows and "clear site data" delete the stored game. Export first if it matters.</li>
</ul>'''

WEB = '''<ul>
<li><strong>Windows:</strong> the tiled map (Shockbolt tiles); Inventory, Visible monsters and Visible items on the right; Messages and Recall along the bottom. Menus, stores and help pop up over the map.</li>
<li><strong>Resize windows</strong> by dragging the gaps between them. <em>Reset windows</em> puts everything back.</li>
<li><strong>Zoom:</strong> <em>Zoom −</em> / <em>Zoom +</em> change the size of the map tiles. Hover over a text window's title to show its <em>A−</em> / <em>A+</em> buttons; click a title to rename the window.</li>
<li><strong>Sound</strong> and <strong>Music</strong> are off until you switch them on in the top bar. The sound effects are the game's own sound events, played with the Dubtrain Angband Sound Pack; music plays in town.</li>
<li><strong>Keys:</strong> the arrow keys or the numeric keypad move you; Shift+arrow runs. <em>Center map</em> and <em>auto_more</em> are on by default here (change them under <kbd>=</kbd>).</li>
<li><strong>Mouse:</strong> click a square to walk there, click yourself or a monster for a menu.</li>
<li>Browsers keep a few shortcuts for themselves (<kbd>Ctrl+W</kbd>, <kbd>Ctrl+T</kbd>, <kbd>Ctrl+N</kbd>, and <kbd>Cmd</kbd> shortcuts on a Mac), so those never reach the game. <kbd>Ctrl+S</kbd> and <kbd>Ctrl+X</kbd> do.</li>
<li>If the game ever crashes, a message appears at the top; reload the page to continue from the last save.</li>
</ul>'''

KEY_HINTS = [
    ('?', 'In-game help: the list of all commands'),
    ('p', 'Auto-explore until something turns up'),
    ('Enter', 'Menu of all commands'),
    ('i', 'Inventory with a cursor: letter = use, Shift+letter = drop, Enter = all actions'),
    ('<', 'Go up (walks to the nearest known staircase)'),
    ('>', 'Go down (walks to the nearest known staircase)'),
    ('^S', 'Save'),
]


def dl(items):
    return '<dl>' + ''.join(f'<dt>{kbd(k)}</dt><dd>{esc(d)}</dd>' for k, d in items) + '</dl>'


def section(anchor, title, body):
    return f'<h2 id="h-{anchor}">{esc(title)}</h2>{body}'


parts = []
toc = [('about', 'About the game'), ('keys', 'Keyboard controls'), ('saving', 'Saving your game'),
       ('tips', 'Tips'), ('guide', "New player's guide"), ('web', 'Playing in the browser'),
       ('version', 'About this version')]
parts.append('<p>' + esc(game['tagline']) + '</p><ul class="toc">' +
             ''.join(f'<li><a href="#h-{a}">{esc(t)}</a></li>' for a, t in toc) + '</ul>')

parts.append(section('about', 'About the game',
                     guide.pop('What makes Tactical Angband special') +
                     '<h3>What is different from Angband</h3>' + info['What is different from Angband']))

ess = ''.join(f'<div class="box"><h3>{esc(cat)}</h3>{dl(items)}</div>' for cat, items in game['essentials'])
all_keys = game['all']() if callable(game['all']) else game['all']
full = ''.join(f'<div>{kbd(k)}<span>{esc(d)}</span></div>' for k, d in all_keys)
parts.append(section('keys', 'Keyboard controls',
                     '<div class="box key"><h3>The keys to remember</h3>' + dl(KEY_HINTS) + '</div>'
                     '<h3>Essential keys</h3><div class="grid">' + ess + '</div>'
                     '<h3>Auto-explore, stairs and the item lists</h3>' + info['Auto-explore'] +
                     '<details><summary>Complete key list (' + str(len(all_keys)) + ' commands)</summary>'
                     '<div class="all">' + full + '</div></details>'))

parts.append(section('saving', 'Saving your game', SAVING))
parts.append(section('tips', 'Tips', info['Tips']))
parts.append(section('guide', "New player's guide",
                     ''.join(f'<h3>{esc(t)}</h3>{b}' for t, b in guide.items())))
parts.append(section('web', 'Playing in the browser', WEB))

# rogue2wasm.md: Source and changes
parts.append(section('version', 'About this version',
             '<ul><li>Based on <strong>Tactical Angband 0.9beta2</strong> (itself based on Angband 4.2.6), '
             f'commit <code>{BASE[:9]}</code>.</li>'
             f'<li>Original source: <a href="https://github.com/tomm/tactical-angband/tree/{BASE}" target="_blank" rel="noopener">tomm/tactical-angband at {BASE[:9]}</a></li>'
             '<li>Our changes (auto-explore, stair walking, command menu, inventory item actions, tiles, sound, web build): '
             f'<a href="https://github.com/memmaker/tactical-angband/compare/{BASE[:9]}...master" target="_blank" rel="noopener">memmaker/tactical-angband</a></li></ul>'))
print('\n'.join(parts))
