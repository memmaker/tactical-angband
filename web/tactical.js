/*
 * Tactical Angband in the browser: terminal rendering, input and save
 * persistence.  The game (tactical-core.js / .wasm) calls into Module.ta
 * (see src/main-web.c).  Angband 4.2 key codes: ui-event.h.
 */
(function () {
	'use strict';

	var TILE = 64, TILE_H = 64;    /* source tile size (set by the game) */
	var OD_ROW = 0, OD_MAX = 0;    /* rows of double-height tiles */
	var ROOT = '/tactical-angband';
	/* lib/user holds the savefile (lib/user/save), scores and pref files */
	var PERSIST = [ROOT + '/lib/user'];
	var SAVE_DIR = ROOT + '/lib/user/save/';

	/* Term order = the 4.2 default subwindow flags (ui-init.c) */
	var TERMS = [
		{ id: 'main', title: '' },
		{ id: 'msg', title: 'Messages' },
		{ id: 'inv', title: 'Inventory' },
		{ id: 'mon', title: 'Visible monsters' },
		{ id: 'itm', title: 'Visible items' },
		{ id: 'rec', title: 'Recall' }
	];

	var palette = [];
	var terms = [];
	var events = [];
	var tiles = new Image();
	var tilesReady = false;
	var running = false;
	var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

	function $(id) { return document.getElementById(id); }

	function status(msg, isError) {
		var s = $('status');
		s.textContent = msg;
		s.className = isError ? 'error' : '';
		s.hidden = !msg;
	}

	/* ---------- tiling window layout ---------- */

	/*
	 * The windows tile the area below the top bar like a tiling window
	 * manager: a fixed tree of splits, stored as fractions so it adapts to
	 * the browser size.  Windows never overlap and always cover the area:
	 *
	 *   +------------------+-------+   side   : x of main | side column
	 *   |                  |  inv  |   inv    : y of inv | mon (of top height)
	 *   |       main       +-------+   mon    : y of mon | itm (of top height)
	 *   |                  |  mon  |   bottom : y of top | bottom row
	 *   |                  +-------+   msg    : x of msg | rec
	 *   |                  |  itm  |
	 *   +-------------+----+-------+
	 *   |     msg     |    rec     |
	 *   +-------------+------------+
	 *
	 * The gutters between windows are drag handles.  Split positions, zoom
	 * levels and window titles are kept in LAYOUT_FILE, in the IndexedDB
	 * backed game filesystem next to the savefile.
	 */
	var FONT = '"DejaVu Sans Mono", Menlo, Consolas, "Liberation Mono", monospace';
	var GUT = 6, TITLE_H = 20, BORDER = 2;
	var MIN_W = 90, MIN_H = 64, MAIN_MIN_W = 240, MAIN_MIN_H = 160;
	var TILE_STEPS = [16, 20, 24, 28, 32, 36, 40, 44, 48, 56, 64];
	var FONT_MIN = 8, FONT_MAX = 28;
	var LAYOUT_FILE = ROOT + '/lib/user/web-layout.json';
	var SPLITS = ['side', 'bottom', 'inv', 'mon', 'msg'];

	var L = null;             /* persisted layout state */
	var rects = {};           /* current window rectangles, by id */

	function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

	function measure(fontPx) {
		var c = document.createElement('canvas').getContext('2d');
		c.font = fontPx + 'px ' + FONT;
		return c.measureText('M').width;
	}

	function areaSize() {
		var g = $('game');
		return { w: g.clientWidth, h: g.clientHeight };
	}

	function defaultLayout() {
		var A = areaSize(), W = A.w, H = A.h;
		/* Not laid out yet (hidden or zero-sized): assume a typical screen */
		if (W < 400 || H < 300) { W = 1280; H = 720; }
		var sideW = clamp(W * 0.24, 260, 440), botH = clamp(H * 0.19, 120, 220);
		var font = W >= 1600 ? 14 : 12;
		var fit = Math.min((W - sideW - GUT - BORDER) / 40, (H - botH - GUT - BORDER) / 24);
		var tile = TILE_STEPS[0];
		TILE_STEPS.forEach(function (t) { if (t <= fit) tile = t; });
		var f = {};
		TERMS.forEach(function (d, i) { if (i) f[d.id] = font; });
		/* auto*: still following the window size (not customised yet) */
		return { v: 1, tile: tile, font: f, titles: {}, autoSplit: true, autoTile: true,
			split: { side: (W - sideW) / W, bottom: (H - botH) / H, inv: 0.46, mon: 0.73, msg: 0.6 } };
	}

	function loadLayout() {
		var d = defaultLayout();
		try {
			var s = JSON.parse(Module.FS.readFile(LAYOUT_FILE, { encoding: 'utf8' }));
			if (s && s.v === 1) {
				SPLITS.forEach(function (k) {
					if (typeof s.split[k] === 'number' && s.split[k] > 0 && s.split[k] < 1) d.split[k] = s.split[k];
				});
				if (TILE_STEPS.indexOf(s.tile) >= 0) d.tile = s.tile;
				d.autoSplit = s.autoSplit === true;
				d.autoTile = s.autoTile === true;
				if (d.autoSplit || d.autoTile) followWindow(d);
				Object.keys(d.font).forEach(function (k) {
					if (s.font && s.font[k] >= FONT_MIN && s.font[k] <= FONT_MAX) d.font[k] = s.font[k];
				});
				if (s.audio) d.audio = { sound: s.audio.sound === true, music: s.audio.music === true };
				if (s.titles) Object.keys(s.titles).forEach(function (k) {
					if (typeof s.titles[k] === 'string' && d.font[k]) d.titles[k] = s.titles[k].slice(0, 60);
				});
			}
		} catch (err) { /* no layout saved yet */ }
		L = d;
		if (L.audio) { audio.sound = !!L.audio.sound; audio.music = !!L.audio.music; renderAudio(); }
	}

	var saveTimer = 0;
	function saveLayout() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(function () {
			try {
				Module.FS.writeFile(LAYOUT_FILE, JSON.stringify(L));
				syncFiles();
			} catch (err) { console.warn('layout not saved', err); }
		}, 400);
	}

	/*
	 * Until the player drags a gutter / zooms, the splits / tile size are
	 * recomputed for the current window size.  Otherwise a page that first
	 * loads in a tiny window (background tab, pane still opening) would
	 * keep that layout's proportions forever.
	 */
	function followWindow(l) {
		if (!l.autoSplit && !l.autoTile) return;
		var d = defaultLayout();
		if (l.autoSplit) l.split = d.split;
		if (l.autoTile) l.tile = d.tile;
	}

	/* Split fractions -> pixel rectangles [x, y, w, h]; clamps the splits */
	function computeRects() {
		var A = areaSize(), W = A.w, H = A.h, h = GUT / 2, s = L.split;
		var xs = clamp(Math.round(W * s.side), MAIN_MIN_W + h, W - MIN_W - h);
		var yb = clamp(Math.round(H * s.bottom), Math.max(MAIN_MIN_H, 3 * MIN_H + 2 * GUT) + h, H - MIN_H - h);
		var y1 = clamp(Math.round(yb * s.inv), MIN_H + h, yb - 2 * MIN_H - GUT - h - GUT);
		var y2 = clamp(Math.round(yb * s.mon), y1 + MIN_H + GUT, yb - MIN_H - h);
		var xm = clamp(Math.round(W * s.msg), MIN_W + h, W - MIN_W - h);
		var sw = W - xs - h;
		return {
			main: [0, 0, xs - h, yb - h],
			inv: [xs + h, 0, sw, y1 - h],
			mon: [xs + h, y1 + h, sw, y2 - y1 - GUT],
			itm: [xs + h, y2 + h, sw, yb - h - (y2 + h)],
			msg: [0, yb + h, xm - h, H - yb - h],
			rec: [xm + h, yb + h, W - xm - h, H - yb - h],
			split: {
				side: [xs - h, 0, GUT, yb - h],
				bottom: [0, yb - h, W, GUT],
				inv: [xs + h, y1 - h, sw, GUT],
				mon: [xs + h, y2 - h, sw, GUT],
				msg: [xm - h, yb + h, GUT, H - yb - h]
			}
		};
	}

	function place(el, r) {
		el.style.left = r[0] + 'px';
		el.style.top = r[1] + 'px';
		el.style.width = Math.max(0, r[2]) + 'px';
		el.style.height = Math.max(0, r[3]) + 'px';
	}

	/* Position windows and gutters; scale canvases that don't fit (yet) */
	function applyDom() {
		rects = computeRects();
		TERMS.forEach(function (d, i) {
			place($('t-' + d.id), rects[d.id]);
			if (terms[i]) fitCanvas(i);
		});
		SPLITS.forEach(function (k) { place($('split-' + k), rects.split[k]); });
	}

	/* Canvas area of a window (inside its border and title bar) */
	function inner(i) {
		var r = rects[TERMS[i].id];
		return { w: Math.max(1, r[2] - BORDER), h: Math.max(1, r[3] - BORDER - (i ? TITLE_H : 0)) };
	}

	/* Cell size, font and cols/rows for a window at the current zoom */
	function termShape(i) {
		var box = inner(i), cw, ch, font, cols, rows;
		if (!i) {
			ch = L.tile; cw = L.tile / 2;
			font = Math.floor(Math.min(ch * 0.8, cw / 0.62));
			cols = clamp(Math.floor(box.w / cw), 80, 255);
			rows = clamp(Math.floor(box.h / ch), 24, 255);
		} else {
			font = L.font[TERMS[i].id];
			cw = Math.ceil(measure(font)); ch = Math.round(font * 1.3);
			cols = clamp(Math.floor(box.w / cw), 1, 255);
			rows = clamp(Math.floor(box.h / ch), 1, 255);
		}
		return { cols: cols, rows: rows, cw: cw, ch: ch, font: font };
	}

	/*
	 * A canvas bigger than its window (main window below 80x24, or a size
	 * the game hasn't applied yet) is scaled down to fit, never clipped.
	 */
	function fitCanvas(i) {
		var T = terms[i], box = inner(i);
		var w = T.cols * T.cw, h = T.rows * T.ch;
		var sc = Math.min(1, box.w / w, box.h / h);
		T.cv.style.width = (w * sc) + 'px';
		T.cv.style.height = (h * sc) + 'px';
	}

	/* (Re)size one term's canvas; resizing the canvas also blanks it */
	function configureTerm(i, l, cols, rows) {
		var cv = $('t-' + TERMS[i].id).querySelector('canvas');
		cv.width = cols * l.cw * dpr;
		cv.height = rows * l.ch * dpr;
		var ctx = cv.getContext('2d', { alpha: false });
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.imageSmoothingEnabled = false;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'center';
		ctx.font = l.font + 'px ' + FONT;
		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, cols * l.cw, rows * l.ch);
		terms[i] = { cv: cv, ctx: ctx, cols: cols, rows: rows,
			cw: l.cw, ch: l.ch, font: l.font, dpr: dpr };
		fitCanvas(i);
	}

	function buildTerms() {
		loadLayout();
		renderTitles();
		applyDom();
		TERMS.forEach(function (d, i) {
			var l = termShape(i);
			configureTerm(i, l, l.cols, l.rows);
		});
	}

	/*
	 * New window sizes or zoom: compute each term's new shape; the game
	 * applies it (ta.applyLayout) the next time it looks for input.
	 */
	var pending = null;

	function sameShape(T, l) {
		return T.cols === l.cols && T.rows === l.rows && T.cw === l.cw &&
			T.ch === l.ch && T.font === l.font;
	}

	function scheduleLayout() {
		if (!terms.length) return;
		dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
		applyDom();
		pending = TERMS.map(function (d, i) {
			var l = termShape(i);
			/* Unchanged terms need no work (unless the pixel ratio changed) */
			return (sameShape(terms[i], l) && terms[i].dpr === dpr) ? null : l;
		});
	}

	/* Throttled version for live dragging */
	var schedTimer = 0, schedLast = 0;
	function scheduleSoon() {
		var now = Date.now();
		clearTimeout(schedTimer);
		if (now - schedLast > 80) { schedLast = now; scheduleLayout(); }
		else schedTimer = setTimeout(function () { schedLast = Date.now(); scheduleLayout(); }, 80);
	}

	/* Dragging a gutter moves that edge; neighbours follow */
	function startDrag(k, e) {
		if (e.button !== 0) return;
		e.preventDefault();
		var el = $('split-' + k);
		el.setPointerCapture(e.pointerId);
		L.autoSplit = false;
		el.classList.add('drag');
		function move(ev) {
			var g = $('game').getBoundingClientRect(), A = areaSize();
			var x = ev.clientX - g.left, y = ev.clientY - g.top;
			var top = rects.split.bottom[1] + GUT / 2;          /* height of the top area */
			if (k === 'side') L.split.side = x / A.w;
			else if (k === 'msg') L.split.msg = x / A.w;
			else if (k === 'bottom') L.split.bottom = y / A.h;
			else L.split[k] = y / top;
			applyDom();
			/* Store what the clamps allowed */
			var r = rects.split;
			if (k === 'side') L.split.side = (r.side[0] + GUT / 2) / A.w;
			if (k === 'msg') L.split.msg = (r.msg[0] + GUT / 2) / A.w;
			if (k === 'bottom') L.split.bottom = (r.bottom[1] + GUT / 2) / A.h;
			if (k === 'inv' || k === 'mon') L.split[k] = (r[k][1] + GUT / 2) / top;
			scheduleSoon();
		}
		function up() {
			el.classList.remove('drag');
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
			el.removeEventListener('pointercancel', up);
			scheduleLayout();
			saveLayout();
		}
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
		el.addEventListener('pointercancel', up);
	}

	/* Zoom: main window tile size, sub window font size */
	function zoomMain(dir) {
		var i = TILE_STEPS.indexOf(L.tile);
		var n = clamp(i + dir, 0, TILE_STEPS.length - 1);
		if (n === i) return;
		L.tile = TILE_STEPS[n];
		L.autoTile = false;
		scheduleLayout();
		saveLayout();
		status('Map tiles: ' + L.tile + ' px');
		clearTimeout(zoomMsgTimer);
		zoomMsgTimer = setTimeout(function () { status(''); }, 1200);
	}
	var zoomMsgTimer = 0;

	function zoomSub(id, dir) {
		var f = clamp(L.font[id] + dir, FONT_MIN, FONT_MAX);
		if (f === L.font[id]) return;
		L.font[id] = f;
		scheduleLayout();
		saveLayout();
	}

	function resetLayout() {
		L = Object.assign(defaultLayout(), { audio: L.audio });
		renderTitles();
		scheduleLayout();
		saveLayout();
	}

	/* Sub window titles: click to rename */
	function titleOf(id) {
		var d = TERMS.filter(function (t) { return t.id === id; })[0];
		return L.titles[id] || d.title;
	}

	function renderTitles() {
		TERMS.forEach(function (d, i) {
			if (!i) return;
			$('t-' + d.id).querySelector('.name').textContent = titleOf(d.id);
		});
	}

	function editTitle(id) {
		var name = $('t-' + id).querySelector('.name');
		if (name.querySelector('input')) return;
		var input = document.createElement('input');
		input.value = titleOf(id);
		input.maxLength = 60;
		input.setAttribute('aria-label', 'Window title');
		name.textContent = '';
		name.appendChild(input);
		input.focus();
		input.select();
		var done = false;
		function finish(keep) {
			if (done) return;
			done = true;
			var v = input.value.trim();
			if (keep) {
				var d = TERMS.filter(function (t) { return t.id === id; })[0];
				if (!v || v === d.title) delete L.titles[id];
				else L.titles[id] = v;
				saveLayout();
			}
			renderTitles();
		}
		input.addEventListener('keydown', function (e) {
			e.stopPropagation();
			if (e.key === 'Enter') { e.preventDefault(); finish(true); }
			else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
		});
		input.addEventListener('blur', function () { finish(true); });
	}

	/* ---------- drawing (called from C) ---------- */

	function color(a) {
		return palette[a] || palette[a & 0x0F] || '#fff';
	}

	function glyph(b) {
		if (b < 32 || b === 127) return ' ';
		return String.fromCodePoint(b);
	}

	/* 4.2 attr: colour + 256 * background set (BG_BLACK / BG_SAME / BG_DARK) */
	function cellBg(a) {
		var bg = (a / 256) | 0;
		return bg === 1 ? color(a % 32) : bg === 2 ? color(28) : '#000';
	}

	/*
	 * Sound effects and town music, both off by default.  The game raises
	 * its own sound events (MSG_* names); lib/customize/sound.prf maps them
	 * to the Dubtrain samples in lib/sounds.
	 */
	var audio = { sound: false, music: false, cfg: {}, cache: {}, depth: -1,
		song: new Audio('music/new_town.ogg') };
	audio.song.loop = true;
	fetch('sounds/sound.prf').then(function (r) { return r.text(); }).then(function (t) {
		t.split('\n').forEach(function (l) {
			var m = /^(\w+):(.+)$/.exec(l.trim());
			if (m && m[2].trim()) audio.cfg[m[1]] = m[2].trim().split(/\s+/);
		});
	});

	function updateMusic() {
		if (audio.music && audio.depth === 0) audio.song.play().catch(function () { });
		else audio.song.pause();
	}

	function toggleAudio(kind) {
		audio[kind] = !audio[kind];
		L.audio = { sound: audio.sound, music: audio.music };
		saveLayout();
		renderAudio();
		updateMusic();
	}

	function renderAudio() {
		$('btn-sound').textContent = 'Sound: ' + (audio.sound ? 'on' : 'off');
		$('btn-music').textContent = 'Music: ' + (audio.music ? 'on' : 'off');
	}

	var ta = {
		sound: function (name) {
			var files = audio.sound && audio.cfg[name];
			if (!files) return;
			var f = files[Math.floor(Math.random() * files.length)];
			if (!audio.cache[f]) audio.cache[f] = new Audio('sounds/' + f + '.mp3');
			var a = audio.cache[f].cloneNode();
			a.volume = 0.6;
			a.play().catch(function () { });
		},

		depth: function (d) {
			if (d === audio.depth) return;
			audio.depth = d;
			updateMusic();
		},

		mouseX: 0, mouseY: 0, mouseB: 0, mods: 0,

		tileset: function (cw, ch, odr, odm) {
			TILE = cw; TILE_H = ch; OD_ROW = odr; OD_MAX = odm;
		},

		termCols: function (t) { return terms[t].cols; },
		termRows: function (t) { return terms[t].rows; },

		layoutPending: function (t) { return (pending && pending[t]) ? 1 : 0; },
		pendingCols: function (t) { return pending[t].cols; },
		pendingRows: function (t) { return pending[t].rows; },
		applyLayout: function (t, cols, rows) {
			var l = pending[t];
			pending[t] = null;
			configureTerm(t, l, cols, rows);
		},

		color: function (i, r, g, b) {
			palette[i] = 'rgb(' + r + ',' + g + ',' + b + ')';
		},

		clear: function (t) {
			var T = terms[t];
			T.ctx.fillStyle = '#000';
			T.ctx.fillRect(0, 0, T.cols * T.cw, T.rows * T.ch);
		},

		wipe: function (t, x, y, n) {
			var T = terms[t];
			T.ctx.fillStyle = '#000';
			T.ctx.fillRect(x * T.cw, y * T.ch, n * T.cw, T.ch);
		},

		text: function (t, x, y, n, a, s) {
			var T = terms[t], c = T.ctx, H = Module.HEAP32, p = s >> 2;
			c.fillStyle = cellBg(a);
			c.fillRect(x * T.cw, y * T.ch, n * T.cw, T.ch);
			c.fillStyle = color(a % 32);
			var cy = y * T.ch + T.ch / 2 + 1;
			for (var i = 0; i < n; i++) {
				var ch = H[p + i];
				if (ch > 32) c.fillText(glyph(ch), (x + i) * T.cw + T.cw / 2, cy);
			}
		},

		pict: function (t, x, y, n, ap, cp, tap, tcp) {
			var T = terms[t], c = T.ctx, H = Module.HEAP32;
			var w = T.cw * 2, h = T.ch;
			var sw = tiles.naturalWidth, sh = tiles.naturalHeight;
			ap >>= 2; cp >>= 2; tap >>= 2; tcp >>= 2;
			for (var i = 0; i < n; i++) {
				var a = H[ap + i], k = H[cp + i];
				var ta = H[tap + i], tk = H[tcp + i];
				var px = (x + i) * T.cw, py = y * T.ch;

				/* Rest of a big tile (Term_big_queue_char) */
				if (a === 255 && k === -1) continue;

				/* Not a tile: plain text in a graphics call */
				if (!(a & 0x80) || !(k & 0x80) || !tilesReady) {
					c.fillStyle = cellBg(a);
					c.fillRect(px, py, T.cw, h);
					if (k > 32) {
						c.fillStyle = color((a & 0x7F) % 32);
						c.fillText(glyph(k), px + T.cw / 2, py + h / 2 + 1);
					}
					continue;
				}

				var fr = a & 0x7F, fx = (k & 0x7F) * TILE, fy = fr * TILE_H;
				var bx = (tk & 0x7F) * TILE, by = (ta & 0x7F) * TILE_H;
				if (fx + TILE > sw || fy + TILE_H > sh) fx = fy = 0;
				if (bx + TILE > sw || by + TILE_H > sh) bx = by = 0;

				c.fillStyle = '#000';
				c.fillRect(px, py, w, h);
				if ((ta & 0x80) && (tk & 0x80) && (bx !== fx || by !== fy))
					c.drawImage(tiles, bx, by, TILE, TILE_H, px, py, w, h);
				/* Tall sprites also cover the cell above (grafmode overdraw) */
				if (OD_ROW && fr >= OD_ROW && fr <= OD_MAX && y > 0 && fy >= TILE_H)
					c.drawImage(tiles, fx, fy - TILE_H, TILE, TILE_H * 2, px, py - h, w, h * 2);
				else
					c.drawImage(tiles, fx, fy, TILE, TILE_H, px, py, w, h);
			}
		},

		curs: function (t, x, y, w, hh) {
			var T = terms[t], c = T.ctx;
			c.strokeStyle = '#ff0';
			c.lineWidth = 1;
			c.strokeRect(x * T.cw + 0.5, y * T.ch + 0.5, w * T.cw - 1, hh * T.ch - 1);
		},

		fresh: function () { },

		bell: function () { },

		nextEvent: function () {
			if (!events.length) return -1;
			var e = events.shift();
			if (e.mouse) {
				ta.mouseX = e.x; ta.mouseY = e.y; ta.mouseB = e.b;
				return 0x100000;
			}
			ta.mods = e.m || 0;
			return e.k;
		},

		plog: function (msg) {
			console.warn('[tactical-angband]', msg);
			status(msg, true);
		},

		sync: function () { syncFiles(); },

		quit: function (msg) {
			running = false;
			syncFiles();
			$('overlay-msg').textContent = msg ? msg : 'Your game has been saved.';
			$('overlay').hidden = false;
		}
	};

	/* ---------- input ---------- */

	/* Angband 4.2 key codes and modifiers (src/ui-event.h) */
	var MOD_CTRL = 1, MOD_SHIFT = 2, MOD_ALT = 4, MOD_KEYPAD = 0x10;
	var ESCAPE = 0xE000, KC_ENTER = 0x9C, KC_TAB = 0x9D, KC_DELETE = 0x9E, KC_BACKSPACE = 0x9F;
	var SPECIAL = {
		ArrowDown: 0x80, ArrowLeft: 0x81, ArrowRight: 0x82, ArrowUp: 0x83,
		F1: 0x84, F2: 0x85, F3: 0x86, F4: 0x87, F5: 0x88, F6: 0x89, F7: 0x8A,
		F8: 0x8B, F9: 0x8C, F10: 0x8D, F11: 0x8E, F12: 0x8F,
		Home: 0x94, PageUp: 0x95, End: 0x96, PageDown: 0x97, Insert: 0x98,
		Pause: 0x99, Clear: 0x9B, Escape: ESCAPE, Enter: KC_ENTER, Tab: KC_TAB,
		Delete: KC_DELETE, Backspace: KC_BACKSPACE
	};
	var KEYPAD = { NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*',
		NumpadDivide: '/', NumpadDecimal: '.', NumpadEqual: '=' };

	function pushKey(k, m) { events.push({ k: k, m: m || 0 }); }

	function mods(e) {
		return (e.ctrlKey ? MOD_CTRL : 0) | (e.shiftKey ? MOD_SHIFT : 0) | (e.altKey ? MOD_ALT : 0);
	}

	function onKey(e) {
		/* The help overlay has the keyboard while it is open */
		if (!$('help').hidden) {
			if (e.key === 'Escape') { $('help').hidden = true; e.preventDefault(); }
			return;
		}
		/* Typing a window title */
		if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
		if (!running || e.isComposing) return;
		if (e.metaKey) return;               /* leave Cmd shortcuts to the browser */
		var k = e.key, code = e.code || '';

		if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' ||
			k === 'CapsLock' || k === 'NumLock' || k === 'Dead') return;

		/* Numeric keypad (digits are directions; + - * . 5 act in item lists) */
		var m = /^Numpad(\d)$/.exec(code);
		if (m) pushKey(48 + +m[1], MOD_KEYPAD | (mods(e) & ~MOD_SHIFT));
		else if (code === 'NumpadEnter') pushKey(KC_ENTER, MOD_KEYPAD);
		else if (KEYPAD[code]) pushKey(KEYPAD[code].charCodeAt(0), MOD_KEYPAD);
		else if (SPECIAL[k] !== undefined) {
			var sm = mods(e);
			/* Plain Enter / Escape / Tab / Backspace carry no Shift */
			if (k === 'Enter' || k === 'Escape' || k === 'Tab' || k === 'Backspace') sm &= ~MOD_SHIFT;
			pushKey(SPECIAL[k], sm);
		}
		else if ([...k].length === 1) {
			var c = k.codePointAt(0);
			if (e.ctrlKey && !e.altKey) {
				/* Control-letter and friends: KTRL(x), no modifier */
				var u = k.toUpperCase().charCodeAt(0);
				if (u >= 64 && u <= 95) pushKey(u & 0x1F, 0);
				else pushKey(c, MOD_CTRL);
			}
			else pushKey(c, e.altKey ? MOD_ALT : 0);
		}
		else return;

		e.preventDefault();
	}

	function onMouse(e) {
		if (!running) return;
		var T = terms[0], r = T.cv.getBoundingClientRect();
		var sx = r.width / (T.cols * T.cw), sy = r.height / (T.rows * T.ch);
		var x = Math.floor((e.clientX - r.left) / sx / T.cw);
		var y = Math.floor((e.clientY - r.top) / sy / T.ch);
		if (x < 0 || y < 0 || x >= T.cols || y >= T.rows) return;
		/* 4.2: 1 left, 2 right, 3 middle; modifiers in the high bits */
		var b = e.button === 2 ? 2 : e.button === 1 ? 3 : 1;
		events.push({ mouse: true, x: x, y: y, b: b | (mods(e) << 4) });
		e.preventDefault();
	}

	/* ---------- persistence (IndexedDB via IDBFS) ---------- */

	var syncing = false, syncAgain = false;

	function mountPersistent() {
		var FS = Module.FS;
		PERSIST.forEach(function (d) {
			FS.mkdirTree(d);
			FS.mount(Module.IDBFS, {}, d);
		});
		Module.addRunDependency('idbfs');
		FS.syncfs(true, function (err) {
			if (err) {
				console.error(err);
				status('Could not read saved games from IndexedDB (' + err + '). ' +
					'Saving may not work in this browser mode.', true);
			}
			Module.removeRunDependency('idbfs');
		});
	}

	/* Write the save directories to IndexedDB; cb(err) when done */
	function syncFiles(cb) {
		if (!Module.FS) { if (cb) cb(); return; }
		if (syncing) {
			syncAgain = true;
			if (cb) pendingCbs.push(cb);
			return;
		}
		syncing = true;
		var cbs = pendingCbs.concat(cb ? [cb] : []);
		pendingCbs = [];
		Module.FS.syncfs(false, function (err) {
			syncing = false;
			if (err) {
				console.error(err);
				status('Saving to browser storage (IndexedDB) failed: ' + err +
					'. Use "Export save" to keep a copy.', true);
			}
			cbs.forEach(function (f) { f(err); });
			if (syncAgain) { syncAgain = false; syncFiles(); }
		});
	}
	var pendingCbs = [];

	function listFiles() {
		var FS = Module.FS, out = [];
		PERSIST.forEach(function (d) {
			var names;
			try { names = FS.readdir(d); } catch (err) { return; }
			names.forEach(function (name) {
				if (name === '.' || name === '..') return;
				var p = d + '/' + name;
				if (FS.isFile(FS.stat(p).mode)) out.push(p);
			});
		});
		return out;
	}

	function removeSaves() {
		listFiles().forEach(function (p) {
			if (p.indexOf(SAVE_DIR) === 0) Module.FS.unlink(p);
		});
	}

	function saveFilePath() {
		var files = listFiles().filter(function (p) {
			return p.indexOf(SAVE_DIR) === 0 && !/\.(new|old)$/.test(p);
		});
		return files[0];
	}

	function exportSave() {
		if (running) Module._web_request_save();
		setTimeout(function () {
			var p = saveFilePath();
			if (!p) { status('There is no saved game yet.', true); return; }
			var blob = new Blob([Module.FS.readFile(p)], { type: 'application/octet-stream' });
			var a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = 'tactical-angband-' + p.split('/').pop() + '.sav';
			document.body.appendChild(a);
			a.click();
			setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
		}, running ? 1500 : 0);
	}

	function importSave(file) {
		var r = new FileReader();
		r.onload = function () {
			if (!confirm('Replace the current saved game with "' + file.name + '"?')) return;
			running = false;
			removeSaves();
			Module.FS.mkdirTree(SAVE_DIR);
				Module.FS.writeFile(SAVE_DIR + SAVE_NAME, new Uint8Array(r.result));
			syncFiles(function (err) { if (!err) location.reload(); });
		};
		r.readAsArrayBuffer(file);
	}

	function newGame() {
		if (!confirm('Delete the saved character in this browser and start a new one?')) return;
		running = false;
		removeSaves();
		syncFiles(function (err) { if (!err) location.reload(); });
	}

	/* Help: the game guide (help.html, generated at build time) */
	var helpLoaded = false;
	function toggleHelp() {
		var h = $('help');
		h.hidden = !h.hidden;
		if (!h.hidden && !helpLoaded) {
			helpLoaded = true;
			fetch('help.html').then(function (r) {
				if (!r.ok) throw new Error(r.status);
				return r.text();
			}).then(function (t) {
				$('help-body').innerHTML = t;
			}).catch(function (err) {
				helpLoaded = false;
				$('help-body').textContent = 'Could not load the guide (' + err + '). Press ? in the game for its own help.';
			});
		}
		if (!h.hidden) $('help-body').focus();
	}

	/* -uPLAYER: lib/user/save/PLAYER (no uid prefix without SETGID) */
	var SAVE_NAME = 'PLAYER';

	/* ---------- startup ---------- */

	window.Module = {
		ta: ta,
		arguments: ['-u' + SAVE_NAME],
		noInitialRun: false,
		preRun: [function () {
			if (!tilesDone) {
				Module.addRunDependency('tiles');
				tilesWait = true;
			}
			/* Own paths: IndexedDB names come from the mount points, shared per origin */
			Module.FS.mkdirTree(ROOT); Module.FS.chdir(ROOT);
			mountPersistent();
		}],
		/* Terms must exist before main() runs (it asks for their sizes) */
		onRuntimeInitialized: function () {
			running = true;
			status('');
			$('game').hidden = false;
			buildTerms();
		},
		print: function (s) { console.log(s); },
		printErr: function (s) { console.warn(s); },
		setStatus: function (s) {
			if (s && !running) status(s.replace(/\(\d+\/\d+\)/, '').trim() || 'Loading…');
		},
		onAbort: function (what) {
			running = false;
			status('The game crashed: ' + what + '. Reload the page to continue from your last save.', true);
		}
	};

	/* Tile sheet; main() waits for it */
	var tilesDone = false, tilesWait = false;
	function tilesFinished(ok) {
		tilesReady = ok;
		tilesDone = true;
		if (!ok) status('Could not load the tile set; using text.', true);
		if (tilesWait) Module.removeRunDependency('tiles');
	}
	tiles.onload = function () { tilesFinished(true); };
	tiles.onerror = function () { tilesFinished(false); };
	tiles.src = 'tiles.webp';

	document.addEventListener('keydown', onKey);
	document.addEventListener('DOMContentLoaded', function () {
		var mainCv = document.querySelector('#t-main canvas');
		mainCv.addEventListener('mousedown', onMouse);
		mainCv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
		$('btn-export').onclick = exportSave;
		$('btn-import').onclick = function () { $('import-file').click(); };
		$('import-file').onchange = function () { if (this.files[0]) importSave(this.files[0]); this.value = ''; };
		$('btn-new').onclick = newGame;
		$('btn-help').onclick = toggleHelp;
		$('help-close').onclick = toggleHelp;
		$('btn-zoom-in').onclick = function () { zoomMain(1); };
		$('btn-zoom-out').onclick = function () { zoomMain(-1); };
		$('btn-layout').onclick = resetLayout;
		$('btn-sound').onclick = function () { toggleAudio('sound'); };
		$('btn-music').onclick = function () { toggleAudio('music'); };
		renderAudio();

		/* Buttons never take the keyboard focus away from the game */
		document.querySelectorAll('button').forEach(function (b) {
			b.addEventListener('mousedown', function (e) { e.preventDefault(); });
		});

		SPLITS.forEach(function (k) {
			$('split-' + k).addEventListener('pointerdown', function (e) { startDrag(k, e); });
		});
		TERMS.forEach(function (d, i) {
			if (!i) return;
			var w = $('t-' + d.id);
			w.querySelector('.name').addEventListener('click', function () { editTitle(d.id); });
			w.querySelector('.zin').addEventListener('click', function () { zoomSub(d.id, 1); });
			w.querySelector('.zout').addEventListener('click', function () { zoomSub(d.id, -1); });
		});
		$('btn-restart').onclick = function () { location.reload(); };
	});

	/*
	 * A trap inside the game (e.g. a bad function pointer) can surface as an
	 * unhandled promise rejection after an Asyncify resume, bypassing onAbort.
	 */
	function crashed(err) {
		if (!running) return;
		running = false;
		var msg = (err && (err.message || err.reason && err.reason.message)) || String(err);
		console.error('[tactical-angband] crash:', err);
		status('The game crashed (' + msg + '). Reload the page to continue from your last save.', true);
	}
	window.addEventListener('unhandledrejection', function (e) { crashed(e.reason); });
	window.addEventListener('error', function (e) {
		if (e.error instanceof WebAssembly.RuntimeError || /tactical-core/.test(e.filename || ''))
			crashed(e.error || e.message);
	});

	/* Resize and reposition the windows when the browser window changes */
	var resizeTimer = 0;
	window.addEventListener('resize', function () {
		if (!terms.length) return;
		followWindow(L);
		applyDom();
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(scheduleLayout, 150);
	});

	/* Autosave when the tab is hidden; keep IndexedDB current */
	document.addEventListener('visibilitychange', function () {
		if (document.hidden && running && Module._web_request_save) Module._web_request_save();
		if (document.hidden) syncFiles();
	});
	window.addEventListener('pagehide', function () { syncFiles(); });
	window.addEventListener('beforeunload', function (e) {
		if (!running) return;
		syncFiles();
		e.preventDefault();
		e.returnValue = '';
	});
	setInterval(function () { if (running) syncFiles(); }, 15000);

	/* Autosave every two minutes (the game only saves when idle at the command prompt) */
	setInterval(function () {
		if (running && Module._web_request_save) Module._web_request_save();
	}, 120000);
})();
