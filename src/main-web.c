/**
 * \file main-web.c
 * \brief Browser (Emscripten/WASM) front end for Tactical Angband
 *
 * All drawing is done by JavaScript on one <canvas> per term (see
 * web/tactical.js).  Blocking input uses Asyncify: when the game waits for
 * a key we sleep in emscripten_sleep(), which yields to the browser.
 *
 * Terms: 0 map, 1 messages, 2 inventory, 3 monster list, 4 item list,
 * 5 recall (the 4.2 default subwindow flags, ui-init.c).  The map uses the
 * Shockbolt tiles, two text columns per tile (tile_width 2).
 *
 * Sound: EVENT_SOUND (raised by the game for its MSG_* message types) is
 * passed to the page by name; the page maps it through
 * lib/customize/sound.prf to the Dubtrain samples in lib/sounds.
 */

#include "angband.h"
#include "main.h"

#ifdef USE_WEB

#include <emscripten.h>
#include "game-event.h"
#include "grafmode.h"
#include "message.h"
#include "game-world.h"
#include "player.h"
#include "player-calcs.h"
#include "ui-display.h"
#include "ui-input.h"
#include "ui-prefs.h"

#define WEB_TERMS 7		/* term 6: equipment (RVIP 5b) */
#define WEB_TILESET 5		/* Shockbolt Dark, lib/tiles/list.txt */

static term web_term[WEB_TERMS];

/* Pending "save now" request from the page (tab hidden / autosave timer) */
static int web_want_save = 0;

/* Last time we yielded to the browser */
static double web_last_yield = 0;


/* ---- JavaScript side (implemented in web/tactical.js) ---- */

EM_JS(void, js_text, (int t, int x, int y, int n, int a, const wchar_t *s), {
	Module.ta.text(t, x, y, n, a, s);
});

EM_JS(void, js_wipe, (int t, int x, int y, int n), {
	Module.ta.wipe(t, x, y, n);
});

EM_JS(void, js_clear, (int t), {
	Module.ta.clear(t);
});

EM_JS(void, js_curs, (int t, int x, int y, int w, int h), {
	Module.ta.curs(t, x, y, w, h);
});

EM_JS(void, js_pict, (int t, int x, int y, int n, const int *ap,
		const wchar_t *cp, const int *tap, const wchar_t *tcp), {
	Module.ta.pict(t, x, y, n, ap, cp, tap, tcp);
});

EM_JS(void, js_tileset, (int cw, int ch, int odr, int odm), {
	Module.ta.tileset(cw, ch, odr, odm);
});

EM_JS(void, js_sound, (const char *name), {
	Module.ta.sound(UTF8ToString(name));
});

EM_JS(void, js_depth, (int depth), {
	Module.ta.depth(depth);
});

EM_JS(void, js_color, (int i, int r, int g, int b), {
	Module.ta.color(i, r, g, b);
});

EM_JS(int, js_term_cols, (int t), {
	return Module.ta.termCols(t);
});

EM_JS(int, js_term_rows, (int t), {
	return Module.ta.termRows(t);
});

/* Layout changes after a browser resize */
EM_JS(int, js_layout_pending, (int t), {
	return Module.ta.layoutPending(t);
});

EM_JS(int, js_pending_cols, (int t), {
	return Module.ta.pendingCols(t);
});

EM_JS(int, js_pending_rows, (int t), {
	return Module.ta.pendingRows(t);
});

EM_JS(void, js_apply_layout, (int t, int cols, int rows), {
	Module.ta.applyLayout(t, cols, rows);
});

/* Next queued input: -1 none, 0x100000 mouse (see js_mouse_*), else key */
EM_JS(int, js_next_event, (int at_cmd), {
	return Module.ta.nextEvent(at_cmd);
});

EM_JS(int, js_event_mods, (void), { return Module.ta.mods; });
EM_JS(int, js_mouse_x, (void), { return Module.ta.mouseX; });
EM_JS(int, js_mouse_y, (void), { return Module.ta.mouseY; });
EM_JS(int, js_mouse_b, (void), { return Module.ta.mouseB; });

EM_JS(void, js_quit, (const char *msg), {
	Module.ta.quit(msg ? UTF8ToString(msg) : "");
});

EM_JS(void, js_plog, (const char *msg), {
	Module.ta.plog(UTF8ToString(msg));
});

EM_JS(void, js_sync, (void), {
	Module.ta.sync();
});


/* Persist the user directory (saves, prefs) after every save */
void web_sync_files(void)
{
	js_sync();
}


/* Called from JS when the page is hidden, and every two minutes */
EMSCRIPTEN_KEEPALIVE void web_request_save(void)
{
	web_want_save = 1;
}


/**
 * Resize the terms to the layout the page computed.  Subwindows change at
 * once; the map changes its size only at the command prompt, where the
 * resize event leads to a full redraw (menus and prompts elsewhere don't
 * expect one).  Returns true if an event was queued.
 */
static bool web_apply_layout(void)
{
	int i;
	term *old = Term;
	bool at_prompt = (inkey_flag && character_generated);
	bool subs = false, queued = false;

	for (i = 0; i < WEB_TERMS; i++) {
		term *t = &web_term[i];
		int cols, rows;

		if (!js_layout_pending(i)) continue;

		cols = MAX(1, js_pending_cols(i));
		rows = MAX(1, js_pending_rows(i));

		if (!i) {
			cols = MAX(cols, 80);
			rows = MAX(rows, 24);
			if (((cols != t->wid) || (rows != t->hgt)) && !at_prompt)
				continue;
		}

		/* New canvas size and cell size (the canvas starts blank) */
		js_apply_layout(i, cols, rows);

		Term_activate(t);

		/* Queues EVT_RESIZE on this term if the size changed */
		if ((Term_resize(cols, rows) == 0) && !i) queued = true;

		/* Subwindow queues are never read */
		if (i) {
			t->key_head = t->key_tail = 0;
			subs = true;
		}

		/* Repaint the contents at the new cell size */
		Term_redraw();
	}

	Term_activate(old);

	if (subs && character_generated) {
		/* Refill the subwindows for their new size */
		player->upkeep->redraw |= (PR_INVEN | PR_EQUIP | PR_MESSAGE |
			PR_MONSTER | PR_OBJECT | PR_MONLIST | PR_ITEMLIST);

		/* At the command prompt, redraw everything right away */
		if (at_prompt && !queued) {
			ui_event evt = EVENT_EMPTY;

			evt.type = EVT_RESIZE;
			Term_activate(&web_term[0]);
			Term_event_push(&evt);
			Term_activate(old);
			queued = true;
		}
	}

	return queued;
}


/* Move queued browser input into the main term's key queue */
static int web_pump(void)
{
	int k, got = 0;
	term *old = Term;

	if (web_apply_layout()) got = 1;

	Term_activate(&web_term[0]);

	while ((k = js_next_event(inkey_flag && character_generated)) >= 0) {
		if (k == 0x100000) {
			Term_mousepress(js_mouse_x(), js_mouse_y(),
				(char) js_mouse_b());
		} else {
			Term_keypress((keycode_t) k, (uint8_t) js_event_mods());
		}
		got = 1;
	}

	/* Safe autosave: only while waiting for a command */
	if (web_want_save && inkey_flag && character_generated
			&& !player->is_dead && !got
			&& (Term->key_head == Term->key_tail)) {
		web_want_save = 0;
		Term_keypress(KTRL('S'), 0);
		got = 1;
	}

	Term_activate(old);
	return got;
}

static void web_yield(int ms)
{
	emscripten_sleep(ms);
	web_last_yield = emscripten_get_now();
}

static errr web_check_events(int wait)
{
	if (web_pump()) return 0;

	if (!wait) {
		/* Let the browser paint now and then during long actions */
		if (emscripten_get_now() - web_last_yield > 50) web_yield(0);
		return web_pump() ? 0 : 1;
	}

	while (1) {
		web_yield(10);
		if (web_pump()) return 0;
	}
}

static void web_react(void)
{
	int i;

	for (i = 0; i < MAX_COLORS; i++) {
		js_color(i, angband_color_table[i][1], angband_color_table[i][2],
			angband_color_table[i][3]);
	}
}

/* The game's own sound events (MSG_* types) go to the page by name */
static void web_sound(game_event_type type, game_event_data *data,
		void *user)
{
	int t = data->message.type;

	(void) type;
	(void) user;
	if (t > 0 && t < MSG_MAX) js_sound(message_sound_name(t));
}

static int web_idx(void)
{
	return (int) (Term - web_term);
}

static errr Term_xtra_web(int n, int v)
{
	switch (n) {
		case TERM_XTRA_NOISE: return 0;
		case TERM_XTRA_FRESH:
			/*
			 * The page's Sound button is the only switch (off by
			 * default): keep the option on so events reach it.
			 */
			if (character_generated && player)
				player->opts.opt[OPT_use_sound] = true;

			/* The page plays the town music at depth 0 */
			js_depth((character_dungeon && player) ? player->depth : -1);
			return 0;
		case TERM_XTRA_BORED: return web_check_events(0);
		case TERM_XTRA_EVENT: return web_check_events(v);
		case TERM_XTRA_FLUSH:
			while (js_next_event(0) >= 0) ;
			return 0;
		case TERM_XTRA_CLEAR: js_clear(web_idx()); return 0;
		case TERM_XTRA_DELAY:
			if (v > 0) web_yield(v);
			return 0;
		case TERM_XTRA_REACT: web_react(); return 0;
	}

	return 1;
}

static errr Term_curs_web(int x, int y)
{
	js_curs(web_idx(), x, y, 1, 1);
	return 0;
}

static errr Term_bigcurs_web(int x, int y)
{
	js_curs(web_idx(), x, y, tile_width, tile_height);
	return 0;
}

static errr Term_wipe_web(int x, int y, int n)
{
	js_wipe(web_idx(), x, y, n);
	return 0;
}

static errr Term_text_web(int x, int y, int n, int a, const wchar_t *s)
{
	js_text(web_idx(), x, y, n, a, s);
	return 0;
}

static errr Term_pict_web(int x, int y, int n, const int *ap,
		const wchar_t *cp, const int *tap, const wchar_t *tcp)
{
	js_pict(web_idx(), x, y, n, ap, cp, tap, tcp);
	return 0;
}


static void hook_plog(const char *str)
{
	if (str) js_plog(str);
}

static void hook_quit(const char *str)
{
	js_sync();
	js_quit(str);
}


const char help_web[] = "Browser front end";

errr init_web(int argc, char **argv)
{
	int i;

	(void) argc;
	(void) argv;

	/* Shockbolt tiles, one tile = 2 x 1 text cells of the map term */
	if (init_graphics_modes()) {
		graphics_mode *gm = get_graphics_mode(WEB_TILESET);

		if (gm) {
			current_graphics_mode = gm;
			use_graphics = gm->grafID;
			tile_width = 2;
			tile_height = 1;
			js_tileset(gm->cell_width, gm->cell_height,
				gm->overdrawRow, gm->overdrawMax);
		}
	}

	event_add_handler(EVENT_SOUND, web_sound, NULL);

	web_react();

	for (i = 0; i < WEB_TERMS; i++) {
		term *t = &web_term[i];
		int cols = js_term_cols(i), rows = js_term_rows(i);

		if (!i) {
			cols = MAX(cols, 80);
			rows = MAX(rows, 24);
		}

		term_init(t, cols, rows, (i == 0) ? 1024 : 16);

		t->soft_cursor = true;
		t->complex_input = true;

		t->xtra_hook = Term_xtra_web;
		t->curs_hook = Term_curs_web;
		t->bigcurs_hook = Term_bigcurs_web;
		t->wipe_hook = Term_wipe_web;
		t->text_hook = Term_text_web;
		t->pict_hook = Term_pict_web;
		t->higher_pict = true;
		if (!i && current_graphics_mode
				&& current_graphics_mode->overdrawRow)
			t->dblh_hook = is_dh_tile;

		Term_activate(t);
		angband_term[i] = t;
	}

	Term_activate(&web_term[0]);

	web_last_yield = emscripten_get_now();

	quit_aux = hook_quit;
	plog_aux = hook_plog;

	return 0;
}

#endif /* USE_WEB */
