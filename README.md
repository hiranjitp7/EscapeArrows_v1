# Escape Arrows!

A mobile-friendly Phaser arrow path puzzle game with touch input, levels, stars, combos, and head-first path-slicing animations.

## Level mechanics

- Levels 1–2 teach the classic arrow puzzle.
- From level 3, each board adds a relay (⚡) that must be cleared to unlock a gate (🔒).
- From level 11, boards add a second relay/gate order and two **TURN** charges. Tap **TURN**, then tap an unlocked arrow to re-aim it along an available clear exit; turning does not cost a star.
- Every fifth level is a lighter recovery board with a shape reveal. The 20 collectible artworks use a spaced, non-linear unlock curve from level 5 to the final Prism Gem at level 250 (early milestones: 5, 10, 15, 25, 35, 50, 65, 85, 105). The gallery shows unlocked art, locked previews, unlock levels, and collection progress. Neon palettes rotate every four levels.
- From level 15, one arrow needs two taps to arm and launch.
- Levels 3, 11, 15, 18, and 21 teach relay, re-aim, two-tap, portal, and switch mechanics. Levels 22–31 add ten authored gate-and-relay challenge boards; campaign levels beyond those remain procedural, and daily boards remain date-seeded.
- Difficulty continues to scale without enlarging the board: layouts become more tightly packed after level 25, two-tap arrows and relay/switch dependencies increase at levels 51 and 101, and another switch-linked gate pair appears at level 151.
- Level recaps show a featured reward illustration, collection progress, moves, hints, elapsed time, personal bests, and optional **FLAWLESS**, **NO HINTS**, and **LOW MOVES** medals. Replay completed levels from the level selector to earn missing medals.
- **DAILY** opens a deterministic shared board for the current date. Campaign progress, collected artwork, daily completion, login streaks, bonus hints, and undo charges are saved locally on the device.
- Login rewards grant bonus hints and one undo; a seven-day streak grants extra hints, and a three-day streak permanently unlocks a small neon badge. One undo restores the previous move and consumes a charge.
- Clears and combos have synthesized sound, supported-device haptics, particles, and a level-clear celebration. Sound can be turned off in settings. Mistakes still cost stars; there are no ads or forced timers in a puzzle.
- First-time tutorials introduce the relay at level 3, re-aiming at 11, two-tap arrows at 15, portals at 18, and switches at 21. The level picker summarizes earned flawless, no-hints, and low-moves medals across cleared campaign levels. Tap the level label to choose any unlocked level; the gear opens sound, restart, and the private art collection.
- Campaign progress, sound preference, hints, undo charges, and daily streak data are saved through Capacitor Preferences on Android and localStorage on the web. The app starts portrait-only with a custom neon arrow icon and splash mark.

Moving blockers, a timed bonus mode, actual rewarded ads, analytics, and cloud-synced/shared collection are not implemented. The daily board is seeded by UTC date locally; there is not yet an online leaderboard or server validation. Test touch targets and haptics on a physical Android phone before release.

## Run locally

From this folder:

```powershell
npm start
```

Open `http://localhost:8080` in a browser or on a phone connected to the same network.

## Validate the game script

```powershell
npm run check
```

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
