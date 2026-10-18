# Escape Arrows!

A mobile-friendly Phaser arrow path puzzle game with touch input, levels, stars, combos, and head-first path-slicing animations.

## Level mechanics

- Levels 1–2 teach the classic arrow puzzle.
- From level 3, each board adds a relay (⚡) that must be cleared to unlock a gate (🔒).
- From level 11, boards add a second relay/gate order and two **TURN** charges. Level 11 requires turning its highlighted arrow downward to break a relay deadlock: tap **TURN**, then tap the highlighted arrow. Each gate is opened by its matching relay; if two locked gates block one another, tap a gate to highlight the relay that opens it. Turning does not cost a star.
- Every fifth level is a lighter recovery board with a shape reveal. The 20 collectible artworks use a spaced, non-linear unlock curve from level 5 to the final Prism Gem at level 250 (early milestones: 5, 10, 15, 25, 35, 50, 65, 85, 105). The gallery shows unlocked art, locked previews, unlock levels, and collection progress. Neon palettes rotate every four levels.
- From level 15, one arrow shows two dots inside a ring and needs two taps to arm and launch.
- Portals are two-way and define the outgoing direction: entering A leaves B along the portal's direction, and entering B leaves A in the opposite direction. Each ring has a vector exit tick. Collision checks follow the same head-first, tail-following route as the animation, rather than translating the whole body beside the exit. Blocked exits name and highlight the blocking arrow/cell and destination mouth.
- A blocked attempt costs a star. Only immediately re-tapping the same arrow in the same direction on an unchanged board repeats the explanation without another penalty. Switching arrows always costs a star; any successful clear, arm, turn, undo, revive, restart, or modal/screen transition resets the exemption. Attempts are keyed by runtime arrow identity, direction, and a board-change counter. Three penalized mistakes still end the attempt; messages, reward, undo, and revive charge limits are unchanged.
- Levels 3, 11, 15, 18, and 21 teach relay, re-aim, two-tap, portal, and switch mechanics. Levels 22–31 add ten authored gate-and-relay challenge boards with cross-axis blockers and longer routes; level 30 has a unique forced solution. Campaign levels beyond those remain procedural, and daily boards remain date-seeded.
- Difficulty continues to scale without enlarging the board: layouts become more tightly packed after level 25, two-tap arrows and relay/switch dependencies increase at levels 51 and 101, and another switch-linked gate pair appears at level 151.
- Procedural campaign boards from level 32 use a level-seeded generator and bounded quality analysis. Direction options use a seeded Fisher-Yates shuffle to keep generated boards deterministic. Normal candidates need at least 32% cell occupancy, at least ten arrows (or enough for that level's relay and double-tap mechanics), and a solver-confirmed route. Opening moves are capped at 3–8 based on board size; average branching must be at most 4.5 (at most 3.75 when the 50,000-solution count is capped), and searches stop after 6,000 states. The generator retries up to twelve candidates, adding at most eight blocker arrows per candidate; if quality attempts are exhausted, a deterministic fallback guarantees solvability and mechanic capacity.
- Level recaps show a featured reward illustration, collection progress, moves, hints, elapsed time, personal bests, and optional **FLAWLESS**, **NO HINTS**, and **LOW MOVES** medals. Replay completed levels from the level selector to earn missing medals.
- **DAILY** opens a deterministic shared board for the current date. Campaign progress, collected artwork, daily completion, login streaks, bonus hints, and undo charges are saved locally on the device.
- Login rewards grant bonus hints and one undo; a seven-day streak grants extra hints, and a three-day streak permanently unlocks a small neon badge. Undo restores the last successful move, spending the free level undo first and then one global charge per use.
- Campaign and daily out-of-stars screens share separate Undo and Revive buttons, counts, and availability-aware explanations. Revive restores one star in place without rewinding a move or consuming an undo; it requires a successful move and is limited to one use per level/daily key. Undo, restart, and older snapshots cannot refill the spent free undo or revive. The old separate daily ad-retry modal is replaced by this same bounded recovery flow.
- Clears and combos have synthesized sound, supported-device haptics, particles, and a level-clear celebration. Sound can be turned off in settings. Mistakes still cost stars; there are no ads or forced timers in a puzzle.
- First-time tutorials introduce the relay at level 3, re-aiming at 11, two-tap arrows at 15, portals at 18, and switches at 21. The level picker summarizes earned flawless, no-hints, and low-moves medals across cleared campaign levels. Tap the level label to choose any unlocked level; the gear opens sound, restart, and the private art collection.
- Level Select derives each tile's completed/current/locked appearance and medal dots from saved campaign results on every open/redraw. Recent-clear and current-level pulses affect only a separate glow layer, never the card or medals. Scrolled pool slots reset their visuals and cancel old tweens before reuse; daily results stay separate from campaign tile records.
- Gameplay and Daily Challenge share one responsive header layout: 44px restart/settings/close hit targets, a 14px icon-to-resource-row gap, and a divider clear of both rows. Small interface labels use a 12px minimum and wrap rather than shrinking below it. Dialog close controls use the same centered vector-X icon and shared 14px visual inset; modal titles reserve side space for it.
- Campaign progress, sound preference, hints, undo charges, and daily streak data are saved through Capacitor Preferences on Android and localStorage on the web. Writes retry both stores, and the game warns once per session if neither can save. The app starts portrait-only with a custom neon arrow icon and splash mark.

Moving blockers, a timed bonus mode, actual rewarded ads, analytics, and cloud-synced/shared collection are not implemented. The daily board is seeded by UTC date locally; there is not yet an online leaderboard or server validation. Test touch targets and haptics on a physical Android phone before release.

## Run locally

From this folder:

```powershell
npm start
```

Open `http://localhost:8080` in a browser or on a phone connected to the same network.

## Validate the game

```powershell
npm test
npm run check
npm run build
```

`scripts/level-select.test.js` covers saved progress through levels 1–10 and beyond 250, every medal combination, recent-clear removal, texture caching, and recycled tile resets after animations settle.

Level Select browser smoke: clear several consecutive levels and open/close the picker after each; reload to check saved progress; replay an older level and complete a daily challenge. Previously earned campaign dots must remain visible and completed cards fully opaque. With higher saved progress, scroll between the first rows, level 32, level 100, and the current level, then toggle medal filters to exercise pooled redraws. Repeat at a narrow viewport with a larger default font. Check the same flow on an Android device before release.

## Android packaging

The Android wrapper uses Capacitor. The web build bundles Phaser locally, so the game does not need a network connection to download its game engine at launch.

1. Install Android Studio and the Android SDK platform/build tools required by the generated project.
2. Before publishing, choose a unique permanent application ID and update `appId` in `capacitor.config.json`. The current `com.arrowpathpuzzle.game` value is a placeholder; changing it after the first Play Store release is not supported.
3. Generate the native Android project once:

	```powershell
	npx cap add android
	```

4. After web-game changes, build and sync them into Android:

	```powershell
	npm run android:sync
	```

5. Open the project in Android Studio, test it on a device, then use **Build > Generate Signed Bundle / APK > Android App Bundle** to create the `.aab` for Google Play.

The app bundle runs offline and the Android manifest does not request Internet access. A privacy-policy draft is in `PRIVACY_POLICY.md`; replace its contact placeholder and publish it at a public URL before submitting. The Play Console also requires a developer account, store listing, app icon/screenshots, content rating, Data safety form, and a signed release. Review the current Play Console requirements before submission.
