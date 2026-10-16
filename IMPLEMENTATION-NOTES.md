# CAMPUS approved visual redesign

This update applies the approved warm-ivory / indigo / violet / coral visual direction to the existing Vite + React + TypeScript CAMPUS starter.

## Updated
- Desktop search header and notification/profile actions.
- Campus banner with a lightweight CSS illustration (no external image dependency).
- College identity card in the desktop sidebar.
- Warm ivory surfaces, gradient active navigation, rounded post cards, pastel badges, and gradient advertising panel.
- Responsive layout adjustments for mobile screens while retaining the existing bottom navigation and create sheet.
- Original approved mockup retained at `public/design/campus-approved-design-reference.png`.

## Run
```bash
npm install
npm run dev
```

## Backend note
Existing Supabase configuration and SQL schema are preserved. Current seeded feed interactions are still demo/local state where the starter previously used local state. This visual update does not claim to make every module production-connected; see README for Supabase setup.
