import { existsSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Firebase config presence is baked into the bundle: the Android push plugin
// hard-crashes (uncatchable IllegalStateException) when register() is called
// without google-services.json, so nativePush must never call register() on
// an unconfigured Android build. iOS uses plain APNs and needs no such guard.
// Rebuild web assets after adding/removing the config.
const pushAndroid = existsSync(new URL('./android/app/google-services.json', import.meta.url))

export default defineConfig({
  plugins: [react()],
  define: {
    __CAMPUS_PUSH_ANDROID__: JSON.stringify(pushAndroid),
  },
})