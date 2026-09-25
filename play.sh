#!/bin/sh
# Start Tactical Angband (Cocoa app). On the first run, lay the windows out
# for a 1440x900 screen: map on the left, inventory / monsters / items on
# the right, messages and recall along the bottom (RVIP step 5).
# The layout lives in the app's own defaults (org.rephial.tactical-angband);
# delete them with `defaults delete org.rephial.tactical-angband` to reset.
D=org.rephial.tactical-angband
APP="$(cd "$(dirname "$0")" && pwd)/Tactical-Angband.app"
if ! defaults read $D "NSWindow Frame AngbandTerm-0" >/dev/null 2>&1; then
	S="0 0 1440 903 "
	defaults write $D "NSWindow Frame AngbandTerm-0" "0 190 1100 713 $S"
	defaults write $D "NSWindow Frame AngbandTerm-1" "0 0 660 186 $S"
	defaults write $D "NSWindow Frame AngbandTerm-2" "1104 500 336 403 $S"
	defaults write $D "NSWindow Frame AngbandTerm-3" "1104 250 336 246 $S"
	defaults write $D "NSWindow Frame AngbandTerm-4" "1104 0 336 246 $S"
	defaults write $D "NSWindow Frame AngbandTerm-5" "664 0 436 186 $S"
	defaults write $D Terminals -array \
		'{Columns=140;Rows=42;Visible=1;}' \
		'{Columns=108;Rows=13;Visible=1;}' \
		'{Columns=55;Rows=31;Visible=1;}' \
		'{Columns=55;Rows=18;Visible=1;}' \
		'{Columns=55;Rows=18;Visible=1;}' \
		'{Columns=71;Rows=13;Visible=1;}' \
		'{Columns=80;Rows=24;Visible=0;}' \
		'{Columns=80;Rows=24;Visible=0;}'
fi
exec open "$APP"
