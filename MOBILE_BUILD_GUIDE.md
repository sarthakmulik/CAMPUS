# CAMPUS — Mobile Build Guide (Web + Android + iOS)

One React codebase, three ships. The native apps are **Capacitor 8** shells that
load the **bundled local production build** (`webDir: dist`) — never a remote
URL. Supabase (auth, Postgres/RLS, realtime, storage, edge functions) is the only
remote dependency and is shared with the web app unchanged.

- App ID / bundle ID: `com.campus.app` · App name: `CAMPUS`
- Web: Vite 6 + React 18 + TypeScript 5.7 → `dist/`
- Native: `@capacitor/core` 8.6, plugins: app, status-bar, splash-screen, share,
  keyboard, push-notifications (see `package.json` for exact versions)
- Platform glue lives in `src/platform/` (`platform.ts`, `lifecycle.ts`,
  `nativeNavigation.ts`, `nativePush.ts`, `share.ts`). On web every native path
  is a no-op or a web fallback; the web app is unaffected.

---

## 1. Prerequisites

| Tool | Version used | Notes |
| --- | --- | --- |
| Node.js | 22 LTS | repo scripts are ESM (`"type": "module"`) |
| JDK | Microsoft OpenJDK 21 | Gradle 8.14.3 wrapper is committed |
| Android SDK | platforms 35/36, build-tools 36.0.0 | `minSdk 24`, `target/compileSdk 36` (`android/variables.gradle`) |
| Android Studio | any recent | only needed to open the project / run an AVD |
| macOS + Xcode | 16+ | **required for any iOS compile** — cannot be done on Windows |

`android/local.properties` must point at your SDK (gitignored). Use **forward
slashes** — Java properties files eat single backslashes:

```properties
sdk.dir=C:/Users/you/AppData/Local/Android/Sdk
```

## 2. Everyday workflow

```bash
npm run dev        # web dev server (browser)
npm run build      # tsc -b && vite build → dist/
npm run cap:sync   # build + copy dist into android/ and ios/ + update plugins
npm run android    # build + sync + open Android Studio
npm run ios        # build + sync + open Xcode (macOS only)
```

**Always `npm run build` before `cap sync`.** The native projects embed whatever
is in `dist/` at sync time; `cap sync` alone does not rebuild web assets.

The Firebase push flags (section 6) are baked at `vite build` time — after
adding/removing Firebase config files you must rebuild **and** re-sync.

## 3. Android

### Debug APK

```bash
cd android
./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Release signing (one-time setup)

Secrets are **never committed**. `android/.gitignore` excludes `*.jks`,
`*.keystore`, `keystore.properties`, and `google-services.json`.

1. Create an upload keystore (keep it for the app's lifetime — Play App Signing
   uses it as the upload key):

   ```bash
   keytool -genkeypair -v -keystore android/app/campus-upload.jks \
     -alias campus -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Create `android/keystore.properties` (gitignored):

   ```properties
   storeFile=campus-upload.jks
   storePassword=YOUR_STORE_PASSWORD
   keyAlias=campus
   keyPassword=YOUR_STORE_PASSWORD
   ```

   **PKCS12 requires `keyPassword` == `storePassword`.** A mismatch fails the
   build with "Given final block not properly padded".

3. `android/app/build.gradle` reads that file only if it exists; without it,
   `assembleRelease` produces an **unsigned** APK. With it, release builds are
   signed automatically.

> **Back up the keystore and its passwords offline.** If you lose the upload
> key you cannot update the app on Play (short of a Play Console key reset).
> The keystore in this repo's working tree is a local development upload key.

### Release APK + AAB

```bash
cd android
./gradlew assembleRelease bundleRelease
# → app/build/outputs/apk/release/app-release.apk   (sideload / testing)
# → app/build/outputs/bundle/release/app-release.aab (Play Console upload)
```

Verify the signature before claiming a build is signed:

```bash
$ANDROID_SDK/build-tools/36.0.0/apksigner verify --print-certs \
  app/build/outputs/apk/release/app-release.apk
jarsigner -verify app/build/outputs/bundle/release/app-release.aab
```

### Manifest notes

- `android:allowBackup="false"` — the WebView localStorage holds the Supabase
  refresh token; it must not leave the device via Google backup.
- Permissions: `INTERNET`, `RECORD_AUDIO` (voice notes, runtime-prompted),
  `CAMERA` (take-photo flows), `POST_NOTIFICATIONS` (Android 13+, prompted only
  from Notification settings → Enable). Gallery picking uses the system photo
  picker and needs **no** storage permission. Camera/mic hardware are
  `required=false` so the app installs on devices without them.
- `campus://` intent filter on `MainActivity` (`singleTask`).

## 4. iOS

**Prepared on Windows; never compiled here.** The project is complete and
configured, but an IPA can only be built on a Mac with Xcode. Do not treat the
iOS app as device-verified until the Mac steps below are done.

What is already in `ios/`:

- `App.xcodeproj` with bundle ID `com.campus.app`, deployment target **iOS 15.0**,
  version 1.0 (1). Capacitor 8 uses **Swift Package Manager** (`CapApp-SPM`),
  not CocoaPods — there is no Podfile and `pod install` is not needed.
- `App/App.entitlements` with `aps-environment = development`, wired into both
  Debug and Release via `CODE_SIGN_ENTITLEMENTS`.
- `Info.plist`: `campus://` URL scheme, camera/microphone/photo-library usage
  descriptions, scene manifest pointing at `SceneDelegate` (which already
  proxies `openURLContexts` / `userActivity` to Capacitor).
- App icon + splash generated from the existing brand (section 7).

### Mac steps (first build)

```bash
npm install
npm run build && npx cap sync ios
npx cap open ios        # or open ios/App/App.xcodeproj directly
```

In Xcode:

1. Let SPM resolve packages (File → Packages → Resolve Package Versions).
2. Select the **App** target → Signing & Capabilities → choose your Team
   (a paid Apple Developer account is needed for push and device builds).
3. Confirm the bundle ID `com.campus.app` (or your own — it must match the
   Firebase iOS app if you enable push).
4. Run on a simulator (no signing needed) or a registered device.
5. For TestFlight/App Store: Product → Archive → Distribute. Xcode flips
   `aps-environment` to `production` for distribution builds automatically.

Push on iOS uses plain APNs (no Firebase): it needs the APNs .p8 key set as
Supabase secrets and a provisioning profile with push (section 6). Without
them, do not claim push works — registration may succeed on-device but the
server cannot deliver until the secrets are set.

## 5. Deep links (`campus://`)

`src/platform/nativeNavigation.ts` maps incoming `campus://` URLs to the same
hash routes the web app uses (`#p/<id>`, `#c/<slug>`, `#e/<slug>`, `#m/<slug>`,
`#u/<handle>`, `#chat/<id>`…). Android delivers them via the intent filter;
iOS via the URL scheme / `SceneDelegate`.

**Authorization is never taken from the link.** Every route resolves its
content through Supabase under the signed-in user's RLS — exactly like typing
the hash on web. A link to a post the user cannot see shows the honest
"not available" notice, never the content.

Test on Android:

```bash
adb shell am start -a android.intent.action.VIEW -d "campus://post/<id>" com.campus.app
```

## 6. Push notifications — activation runbook

Code is complete on all three platforms; **delivery is not live until the
steps in `supabase/PUSH-DEPLOYMENT.md` §6 are done.** Token kinds differ by
platform: Android registers an **FCM** token; iOS registers a **raw APNs**
token (the Capacitor 8 iOS plugin uses plain APNs — no Firebase). Summary:

1. Apply `supabase/migrations/0054_device_tokens.sql` in the Supabase SQL
   editor (whole file, once). It adds `device_tokens` (own-row RLS) +
   `save_device_token` / `remove_device_token` RPCs and teaches the enqueue
   trigger to skip web-push delivery when the recipient has native tokens.
2. **Android:** Firebase console → add an Android app `com.campus.app` →
   download `google-services.json` → place in `android/app/`. Generate a
   service-account private key and `supabase secrets set
   FCM_SERVICE_ACCOUNT='<full JSON>'`.
3. **iOS:** Apple Developer → Keys → create an APNs auth key (.p8). Then
   `supabase secrets set APNS_AUTH_KEY='<.p8 contents>' APNS_KEY_ID=<key id>
   APNS_TEAM_ID=<team id>` (optional `APNS_TOPIC`, default `com.campus.app`).
   No Firebase app is needed for iOS. The push entitlement is already wired.
4. `supabase functions deploy push-deliver`. **No push secret, service-account
   key or .p8 key ever ships inside the app bundle.**
5. `npm run build && npx cap sync` then rebuild the native app.
6. Enable push in the app: Notification settings → Push notifications → Enable.
7. **Verify on a real device** (background the app, send a message from another
   account, tap the notification). Emulators are not proof of delivery.

### The build-time Firebase guard (Android, important)

The Android push plugin **crashes the process** (`IllegalStateException:
Default FirebaseApp is not initialized`) if `register()` is called without
`google-services.json` — the exception is uncatchable from JS. To keep
unconfigured builds honest and crash-free, `vite.config.ts` bakes
`__CAMPUS_PUSH_ANDROID__` from the presence of `android/app/google-services.json`;
`nativePush.ts` refuses to call `register()`/`unregister()` when it is false and
the UI reports *"Push is not configured on this app build yet."* iOS needs no
such guard (plain APNs, no crash path).

Consequence: **after adding or removing `google-services.json`, rebuild web
assets and re-sync** (`npm run cap:sync`) or the flag is stale.

Token hygiene: tokens are bound to the signed-in user server-side; logout
removes this device's row before the session ends; the settings sheet lists and
removes devices; foreground pushes are intentionally not displayed (the in-app
realtime bell already covers them).

## 7. Icons & splash

Source art: `assets/icon.png` (1024², brand mark on `#6D57F3`) and
`assets/splash.png` (2732², mark centered on `#f6f7fb`) — derived from the
existing `public/campus-icon-512.png`, no new identity.

```bash
npm run assets   # capacitor-assets generate --android --ios (colors: #f6f7fb)
```

The script intentionally targets **only** Android + iOS: `capacitor-assets`
rewrites `public/manifest.webmanifest` to unserved `../icons/*.webp` paths when
allowed to touch PWA — the web manifest is the original, referencing
`/campus-icon*.png`. If you ever regenerate PWA assets, restore the manifest.

## 8. Web → native install prompt

Mobile-browser visitors are invited to install the native app by a quiet,
dismissible card (`src/components/AppDownloadBanner.tsx`, logic in
`src/lib/appDownload.ts`).

**Android is active by default.** There is no Play Store listing yet, so the
card links to the signed release APK published on GitHub Releases:

```
https://github.com/sarthakmulik/CAMPUS/releases/latest/download/CAMPUS.apk
```

The `releases/latest/download/<asset>` permalink always resolves to the newest
release, so it stays correct as new versions are uploaded. To publish a new
build: `gh release create vX.Y.Z path/to/app-release.apk#CAMPUS.apk` (the asset
must be named `CAMPUS.apk`). Override the default with `VITE_ANDROID_APP_URL`
once a Play Store link exists. **iOS has no default** and stays silent until an
App Store link is set:

```bash
# .env (web deployment) — optional overrides
VITE_ANDROID_APP_URL=https://play.google.com/store/apps/details?id=com.campus.app
VITE_IOS_APP_URL=https://apps.apple.com/app/id<YOUR_APP_STORE_ID>
```

Safety/UX rules baked in:

- **Desktop browsers (Windows/macOS/Linux) are never prompted.** Detection is
  by user agent + touch points, not viewport width; iPadOS's Mac-spoofed UA is
  still recognised as iOS.
- **No dead links:** only https URLs render. iOS (no default) stays silent until
  `VITE_IOS_APP_URL` is set; a non-https value on either platform is ignored.
- Never shown inside the native app itself.
- Dismissible (✕, or Escape); a dismiss is remembered for 30 days. The link
  opens in a new tab with `rel="noopener noreferrer"`.

## 9. What was actually verified (and what wasn't)

Verified on an **Android emulator** (Pixel 9 Pro AVD, Android 15/36), not a
physical device:

- Boot, sign-in, session persistence across force-stop.
- `campus://` deep links: reel → Discover, post → Home, missing post → honest
  notice; RLS respected (college-only content stays gated).
- Hardware Back: closes overlays/pages first; root double-press exits.
- Background/resume: feed + bell re-read, reels pause/resume, chat catch-up.
- Offline banner + recovery.
- Push: runtime permission dialog, and the unconfigured-build path shows the
  honest "not configured" notice **without crashing** (a real crash was found
  and fixed here — see section 6).
- Release APK signature (`apksigner`), AAB (`jarsigner`), debug install.
- Web regression: `tsc`, `vite build`, 22/22 pulse tests, visitor boot with zero
  console errors.

**Not verified / pending:**

- Physical-device testing (Android + iOS) — required before any production
  claim, especially push delivery, camera, and voice notes.
- iOS compilation of any kind (needs a Mac).
- Live push delivery end-to-end (needs section 6 steps 1–3 + real device).
- Migration 0054 is written but **not yet applied** to the hosted database.
- Play Console / App Store submission, listing assets, and policy review.

An APK that compiles is not a production-ready app. Treat this guide's
verification list as the floor, not the ceiling.