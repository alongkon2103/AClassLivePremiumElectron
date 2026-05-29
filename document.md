# Refactoring Documentation — A Class Store Pro
**Date:** Wednesday, May 20, 2026

## Overview
This document logs the production-grade refactoring of the Stream Overlay module to improve maintainability, fix synchronization bugs, and establish professional software engineering patterns.

## 1. Structural Changes
- **Public Assets:** Moved `/src/public/` to the project root `/public/`.
  - *Reason:* Vite serves static assets from the root `public/` folder. This fixes the 404/Black screen issues in `iframe` previews and OBS.
- **Component Decomposition:** Segregated the monolithic `StreamOverlay.tsx` into modular components under `src/components/overlay/`.

## 2. Technical Improvements
- **Context API:** Implemented `OverlayContext` to centralize state management and persistence logic.
- **Dual-Sync Communication:**
  - Overlays now listen to `window.postMessage` for instant local preview.
  - Overlays continue to listen to `storage` events for cross-window sync (OBS).
- **Transparency Fix:** Explicitly set `background: transparent !important` in all overlay templates.

## 3. Component Map
- `OverlayContext.tsx`: State & Persistence.
- `LivePreview.tsx`: Robust `iframe` wrapper with `postMessage` bridge.
- `WinCountControls.tsx`: Counter & Appearance forms.
- `SpinControls.tsx`: Spin pool & Template settings.
- `SourceLinks.tsx`: OBS URL management.
- `AdminContext.tsx`: Mock cloud data (Users, HWID, Announcements, Presets).
- `AdminLayout.tsx`: Specialized shell for admin pages.
- `UserTable.tsx`: Subscription and HWID management.
- `AnnouncementEditor.tsx`: Global broadcast system.
- `PresetManager.tsx`: Community cloud preset management.

## 4. Verification Status
- [x] File structure relocation (DONE)
- [x] Context API Implementation (DONE)
- [x] UI Component Extraction (DONE)
- [x] Overlay HTML Refactor (DONE)
- [x] Real-time Sync Validation (DONE)
- [x] Admin Dashboard Mockup (DONE)
