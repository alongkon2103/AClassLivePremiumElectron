# A Class Store Pro — Project Flow & Documentation

## 1. Project Overview
A Class Store Pro is a specialized streaming tool designed to bridge TikTok Live interactions (Gifts, Likes, Comments, Follows, Shares) with system events, games like Minecraft, and on-stream overlays. It enables streamers to set up dynamic "Event → Action" mappings, manage on-stream win counters and spin wheels, and execute RCON commands automatically.

**Tech Stack:**
- Frontend: React 18, Vite, Tailwind CSS
- Routing: React Router v6
- Desktop Environment: Electron 28+
- Icons: Lucide React
- Fonts: Sora (Sans-serif), IBM Plex Mono (Monospace)

**Architecture Diagram:**
```
[ Electron Client ] <=== (Phase 3) ===> [ Node.js/Express Backend API ] <---> [ PostgreSQL ]
       |                                          ^
  (IPC Bridge)                                    |
       v                                   (TikTok Live API)
[ Browser Window ]
```

**Current Phase:** Phase 1 (UI Mockup & Prototype Integration)

---

## 2. Folder Structure

```
tiklive-pro/
├── electron/                 # Electron main process files
│   ├── main.js               # Window initialization, IPC handlers
│   └── preload.js            # Context bridge for renderer process
├── src/                      # React frontend application
│   ├── components/           # Reusable UI components
│   │   ├── AppLayout.tsx     # Main wrapper with Sidebar and Titlebar
│   │   ├── Sidebar.tsx       # Main navigation menu
│   │   └── Titlebar.tsx      # Custom frameless window controls
│   ├── pages/                # React pages (one per route)
│   │   ├── AdminStats.tsx    # F-602: สถิติและประกาศ (Admin)
│   │   ├── AdminUsers.tsx    # F-601: จัดการผู้ใช้ (Admin)
│   │   ├── Dashboard.tsx     # F-101: แผงควบคุมหลัก & Live Feed
│   │   ├── Login.tsx         # F-001: หน้าเข้าสู่ระบบ
│   │   ├── Mapping.tsx       # F-201: ตั้งค่า Event -> Action แบบอิสระ
│   │   ├── Minecraft.tsx     # F-401: การเชื่อมต่อ Minecraft RCON และ Console
│   │   ├── Overlay.tsx       # (Legacy) หน้าต่าง overlay เก่า
│   │   ├── OverlaySettings.tsx # (Legacy) การตั้งค่า overlay เก่า
│   │   ├── OverlayView.tsx   # F-502: หน้าต่างโปร่งใสสำหรับ OBS Browser Source
│   │   ├── Preset.tsx        # F-301: เลือก Preset เกมและแมพ
│   │   └── StreamOverlay.tsx # F-501: ตั้งค่า Overlay และตัวอย่างสด
│   ├── styles/
│   │   └── globals.css       # Tailwind entry and CSS variables
│   ├── types/
│   │   └── electron.d.ts     # TypeScript definitions for Window.electron
│   ├── App.tsx               # Application Router setup
│   └── main.tsx              # React entry point
├── package.json              # NPM dependencies & scripts
├── tailwind.config.ts        # Tailwind configuration & color themes
├── tsconfig.json             # TypeScript configuration
└── vite.config.ts            # Vite bundler configuration
```

---

## 3. Pages & Routes

### `/login` (หน้า Login)
- **Function ID:** F-001
- **Status:** UI Only
- **Details:** User and password fields. Submitting always redirects to `/dashboard`.
- **State:** `username`, `password`, `error`.

### `/dashboard` (หน้าหลัก)
- **Function ID:** F-101
- **Status:** UI Only (Mock Data)
- **Details:** 2x2 grid layout displaying Live Feed for Gifts, Comments, Likes, and Follows. Contains TikTok connect input and real-time status.
- **State:** `username`, `connected`, `giftLogs`, `commentLogs`, `likeLogs`, `followLogs`.
- **IPC:** `tiktok:connect` (stub).

### `/mapping` (Mapping Rules)
- **Function ID:** F-201
- **Status:** Partial (UI + LocalStorage)
- **Details:** Inline editable table for creating custom rules mapping TikTok events to specific actions (sounds, keys, RCON).
- **State:** `rules`, `editingId`, `editForm`, `isAdding`, `testTriggered`.
- **Storage:** Persists to `aclass_mapping_rules`.

### `/preset` (Preset Configurations)
- **Function ID:** F-301
- **Status:** UI Only
- **Details:** 3-level cascading selector (Game → Map → Preset). Read-only preview table of the loaded preset.
- **State:** `selectedGame`, `selectedMap`, `selectedPreset`.

### `/minecraft` (Minecraft Integration)
- **Function ID:** F-401
- **Status:** UI Only
- **Details:** RCON connection toggle, credential fields, interactive command console with mock responses, and quick action buttons.
- **State:** `rconEnabled`, `showPassword`, `connectionStatus`, `command`, `logs`.

### `/stream-overlay` (Stream Overlay Settings)
- **Function ID:** F-501
- **Status:** Partial (UI + LocalStorage Sync)
- **Details:** Dual-tab (Overlay & Spin) layout to configure the Win Counter and Spin Wheel. Includes live preview synced with settings.
- **State:** `settings` (large object with all overlay states), `activeTab`, `expandedSections`, `showSaved`, `rebinding`, `customAdjust`, `overlayOpen`.
- **Storage:** Persists to `aclass_overlay_settings`.
- **IPC:** `overlay:toggle`.

### `/overlay-view` (OBS Browser Source)
- **Function ID:** F-502
- **Status:** Partial (UI + LocalStorage Sync)
- **Details:** Standalone transparent route without AppLayout. Renders only the win counter based on `localStorage` state. Auto-updates on `storage` event.
- **State:** `settings`, `animType`, `lastCount`.

### `/admin/users` (จัดการผู้ใช้)
- **Function ID:** F-601
- **Status:** UI Only
- **Details:** Web-style layout showing registered users, HWID bindings, and expiry dates.

### `/admin/stats` (ประกาศ / สถิติ)
- **Function ID:** F-602
- **Status:** UI Only
- **Details:** Global announcements editor and recent login activity logs.

---

## 4. Component Inventory

| Component Name | Props | Description | Used By |
|----------------|-------|-------------|---------|
| `AppLayout` | None | Main wrapper including Titlebar, Sidebar, and an Outlet for nested routes. | `App.tsx` |
| `Titlebar` | `title?: string`, `showControls?: boolean` | Frameless window drag area and custom minimize/maximize/close buttons. | `AppLayout`, `Login` |
| `Sidebar` | None | Main navigation menu. Highlights active route. | `AppLayout` |

---

## 5. Design System

**CSS Variables (`globals.css`):**
- `--bg`: `#0a0a0f` (Background)
- `--surface`: `#111118` (Cards/Panels)
- `--surface2`: `#18181f` (Inputs/Hover states)
- `--border`: `#1e1e28` (Primary Borders)
- `--border2`: `#2a2a38` (Secondary Borders)
- `--text`: `#e8e8f0` (Primary Text)
- `--text2`: `#8888a0` (Secondary Text)
- `--text3`: `#44445a` (Tertiary/Muted Text)
- `--purple`: `#7c5cfc` (Primary Brand Accent)
- `--purple2`: `#9b7fff` (Hover Brand Accent)
- `--green`: `#22c55e` (Success/Positive)
- `--red`: `#ef4444` (Error/Negative)
- `--amber`: `#f59e0b` (Warning/Neutral)
- `--pink`: `#f472b6` (Accent 2)

**Typography:**
- `font-sans`: 'Sora', sans-serif (UI standard)
- `font-mono`: 'IBM Plex Mono', monospace (Logs, Stats, Coding elements)

---

## 6. IPC Channels (Electron)

| Channel name | Direction | What it does | Status |
|--------------|-----------|--------------|--------|
| `window:minimize` | Renderer → Main | Minimizes the main Electron window | Implemented |
| `window:maximize` | Renderer → Main | Toggles maximize state | Implemented |
| `window:close` | Renderer → Main | Closes the application | Implemented |
| `overlay:toggle` | Renderer → Main | Shows or hides the secondary `overlayWindow` | Implemented |
| `tiktok:connect` | Renderer → Main | Requests TikTok connection (logs to console) | Stub |
| `keyboard:press` | Renderer → Main | Requests global keypress simulation (logs to console) | Stub |
| `heartbeat:check` | Renderer → Main | Checks API connection status | Stub |

---

## 7. Feature Status Table

| Function ID | Name | Page | Status | Notes |
|-------------|------|------|--------|-------|
| F-001 | Login & Session | `/login` | UI Only | ยังไม่เชื่อม API กับ Backend |
| F-002 | Single Device Monitor | - | Not Started | ตรวจสอบการล็อคอินซ้อน (Phase 3) |
| F-101 | Dashboard Live Feed | `/dashboard` | UI Only | แสดง Mock Data อัตโนมัติ |
| F-102 | TikTok Connection | `/dashboard` | Partial | มี UI และ IPC Stub แล้ว |
| F-201 | Mapping Rules | `/mapping` | Partial | UI รองรับ Inline Edit และ LocalStorage |
| F-301 | Preset Selection | `/preset` | Partial | 3-Level Table Selector โชว์ Mock Data และ Preview |
| F-401 | Minecraft RCON | `/minecraft` | UI Only | UI จำลองการส่งคำสั่ง |
| F-501 | Stream Overlay | `/stream-overlay` | Partial | ตั้งค่าพร้อม Sync ผ่าน LocalStorage |
| F-502 | OBS Overlay View | `/overlay-view` | Partial | รองรับ `storage` event อัปเดตทันที |
| F-601 | Admin Users | `/admin/users` | UI Only | จำลองรายชื่อผู้ใช้ |
| F-602 | Admin Stats | `/admin/stats` | UI Only | จำลองสถิติและการประกาศ |
| F-603 | Global Hotkeys | - | Not Started | ยังไม่มี Listener จริงใน Electron Main |

---

## 8. Data Flow

1. **Overlay Sync Flow:** 
   - User changes a setting in `/stream-overlay`.
   - The state updates and calls `localStorage.setItem('aclass_overlay_settings', ...)` and `window.dispatchEvent(new Event('storage'))`.
   - The `/overlay-view` page (loaded in OBS or the separate Electron window) listens for the `storage` event.
   - It reads the new settings from `localStorage` and triggers React renders and CSS animation classes (`bounce`, `flash`) accordingly.
2. **Mapping Rules Flow:**
   - User adds/edits a rule in `/mapping`.
   - Changes are saved directly to `localStorage.setItem('aclass_mapping_rules', ...)`.
   - When the component mounts, it prioritizes reading from `localStorage`. If empty, it falls back to `MOCK_RULES`.
3. **Preset Selection Flow:**
   - User selects Game → Map → Preset Row.
   - The `/preset` page updates the `currentPreset` state.
   - A read-only preview table dynamically renders the rules summary for the selected preset.

---

## 9. localStorage Keys

| Key | Type | Used by | Description |
|-----|------|---------|-------------|
| `aclass_overlay_settings` | JSON String (Object) | `/stream-overlay`, `/overlay-view` | เก็บสถานะทั้งหมดของ Stream Overlay (Wins, Typography, Background, Hotkeys) |
| `aclass_mapping_rules` | JSON String (Array) | `/mapping` | เก็บรายการเงื่อนไข Event -> Action ทั้งหมด |

---

## 10. Phase Roadmap

### ─── Phase 1 (Current) — UI Mockup ───
- ✅ Project Initialization (React, Vite, Electron, Tailwind)
- ✅ Custom Titlebar & Base Layout
- ✅ Dashboard 2x2 Grid Live Feed
- ✅ Minecraft RCON Page & Console
- ✅ Custom Mapping Rules (Inline Edit + Capture Modal)
- ✅ Preset Cascading Table Selector
- ✅ Stream Overlay Configuration Page (Advanced UI)
- ✅ Standalone OBS Overlay View with real-time sync

### ─── Phase 2 — Backend API ───
- Node.js + Express API server setup
- PostgreSQL database integration
- **Endpoints needed:** `/api/auth/login`, `/api/users/hwid`, `/api/stats`
- **Tables needed:** `users` (id, username, password, expiry, hwid, status)

### ─── Phase 3 — Connect Electron to API ───
- Auth flow implementation in `/login`
- Hardware ID (HWID) binding implementation
- Heartbeat implementation (`heartbeat:check`)
- Session management & single-device restrictions

### ─── Phase 4 — Feature Implementation ───
- TikTok Live Connector (using unofficial TikTok Live libraries)
- Keyboard macro integration (`robotjs` or `nut.js`)
- Actual Audio player execution via Electron Main
- Real Minecraft RCON client implementation in Electron Main
- Global hotkey listeners (`globalShortcut` in Electron)

---

## 11. Known Issues & TODOs

- **Mock Data Dependency:** The Dashboard and Preset pages currently use synthetic data.
- **Overlay Window Preload:** The `createOverlayWindow` in `electron/main.js` currently opens `/overlay-view`.
- **IPC Handlers are Stubs:** Events like `tiktok:connect` and `keyboard:press` only `console.log` in the main process right now.
- **RCON Implementation:** The `/minecraft` page visually simulates RCON interaction.
- **Keyboard Capture:** The mapping page uses a modal to capture keys, but logic to send these to the system (robotjs) is pending Phase 4.
- **Gift Picker:** The mapping page uses a mock gift picker.

---

## 12. How to Run

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Development Mode (Concurrent React & Electron):**
   ```bash
   npm run electron:dev
   ```
   *Note: This starts the Vite dev server and waits for port 5173 before launching Electron.*

3. **Production Build:**
   ```bash
   npm run build
   ```

4. **Common Fixes:**
   - If Vite server fails to start, ensure port 5173 is available.
   - If Tailwind styles aren't applying, ensure your component classes match the variables in `globals.css` and `tailwind.config.ts`.
