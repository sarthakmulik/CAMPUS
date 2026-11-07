import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.campus.app',
  appName: 'CAMPUS',
  webDir: 'dist',
  // The native apps load the bundled local production build (webDir), never
  // the live website — Supabase is the only remote dependency.
  android: {
    // Android 15+ enforces edge-to-edge; the WebView draws under the status
    // bar and the app's existing env(safe-area-inset-*) CSS owns the insets.
    backgroundColor: '#f6f7fb',
  },
  ios: {
    backgroundColor: '#f6f7fb',
    // matches the web app's black-translucent PWA status bar: content runs
    // under the status bar and env(safe-area-inset-top) pads the header
    contentInset: 'always',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#f6f7fb',
      showSpinner: false,
    },
    StatusBar: {
      // overlay = WebView keeps the full viewport; the shell's existing
      // safe-area padding (50px header + env inset) handles the cutout
      overlaysWebView: true,
      style: 'DEFAULT',
    },
    Keyboard: {
      // iOS WKWebView ignores interactive-widget=resizes-content; resizing
      // the native WebView reproduces the Android/web keyboard behaviour
      resize: 'native',
    },
  },
}

export default config