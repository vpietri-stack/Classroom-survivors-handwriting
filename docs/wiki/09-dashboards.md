# Teacher & Admin Dashboards

> **Last verified:** 2026-09-27 · **Part of:** [Classroom-survivors Repo Wiki](README.md)

**Owner files:** `teacher_dashboard.html` (488 ln), `teacher_dashboard.js` (818 ln), `teacher_dashboard.css` (1151 ln), `admin_dashboard.js` (958 ln), `geo_export.js` (368 ln), `test_archive_merge_dashboard.js`

One HTML app shell (`teacher_dashboard.html`), two role views. `teacher_dashboard.js` is the base (list/filters/detail tabs); `admin_dashboard.js` (loaded AFTER it — header comment "ADMIN DASHBOARD - Additional functionality for admin role") layers on admin/BM powers: add student, settings editing, targets with manual offset, BM management. There is no separate admin HTML page — `initAdminUI()` re-skins the same shell.

## Files & load order

`teacher_dashboard.html:474-486` loads, in order:

1. `config.js`, `frontend_auth.js` (API base, `apiFetch`, app key)
2. **Inline stub:** `<script>var TEACHING_CONTENT = {}; var AVAILABLE_CONTENT = {};</script>` — the content packs are loaded to serve the **test iframe** (`#testIframe` loads `index.html?testMode=true&…`); the stub exists so pack files parse, and `sr_engine.js`/`teaching_content.js` are deliberately NOT loaded (the dashboard never does SR math itself; it renders `srState` read-only)
3. All 7 content packs (`content_pu1/2/3.js`, `content_think0/1/2.js`, `content_test.js`)
4. `teacher_dashboard.js` (declares `let isBM = false` at top level, ~12) then `geo_export.js` (Student Locations panel + location exports; needs `allStudents` from the base script) then `admin_dashboard.js` (declares `let isAdmin = false`, ~6) — **do not redeclare either**; both are top-level `let` shared across the two files

`apiFetch` (defined in `frontend_auth.js`) attaches `X-App-Key` + `X-Auth-Token` automatically — dashboards never hand-roll auth headers.

## Auth & role model

```mermaid
flowchart TD
    L["Teacher/BM logs in on index.html (main app)"] --> R["finishLogin(): role BM/admin → redirect teacher_dashboard.html (frontend_auth.js ~1432)"]
    R --> C["checkTeacherAuth (teacher_dashboard.js ~20)"]
    C -->|"no saved teacher/BM profile"| IDX["window.location = index.html"]
    C -->|"GET /login (refresh) with session token"| V{"data.role is BM/admin?"}
    V -->|no| IDX2["hard-stop (spoof guard)"]
    V -->|yes| OK["isBM = role==='BM'; initAdminUI(); loadAllStudents()"]
    V -->|"network/token error"| DEG["degrade to cached role (legacy REQUIRE_AUTH-off mode keeps working)"]
```

- `checkTeacherAuth()` (teacher_dashboard.js ~20) re-verifies the role **server-side** via `GET /login` (token refresh) to prevent localStorage spoofing; on failure it *degrades* to the cached role so the legacy no-token dashboard still works while `REQUIRE_AUTH` is off — under enforcement the privileged data calls themselves reject.
- Roles: `admin` (full: admin columns, BM management) / `BM` (add students, edit settings/targets, no admin-only columns) / plain `teacher` (view only). `initAdminUI()` (admin_dashboard.js ~8) toggles `.admin-only` / `.admin-col` / `.bm-or-admin-col` / `.bm-or-admin-only` CSS classes and sets the title ("Admin Dashboard" / "BM Dashboard").

## Student list (teacher_dashboard.js ~60-200)

`loadAllStudents()` → `GET /getStudents?includeSecure=true` (the flag is sent for BM/admin; server re-attaches plaintext passwords only for privileged callers) → filters out non-student docs (`role !== 'BM' && role !== 'admin'`) → `populateTeacherFilter()` / `populateClassTimeFilter()` (class times re-derive from the selected teacher) → `applyFilters()` (teacher + classTime + name search) → sortable table. Detail view opens per student via `loadStudentArchives` + `switchTab`.

## Student detail tabs (teacher_dashboard.js `switchTab` ~534)

| Tab | Content |
|---|---|
| **Sessions** | `renderSessions()` — `type:'session'` events, date-filtered, with detail panel; labels via `sessionTypeLabel` (`study`/`gomoku`/`uno`/`vampireSurvivors`) |
| **Exercises** | `renderExercises()` — `type:'exercise'` events; `exerciseTypeLabel` maps `wordScramble`/`spelling`/`handwriting`/`sentenceScramble`/`sentenceMatch` + `speech_*` types |
| **Test** | `startTestMode()` (~786) — loads `index.html?testMode=true&…` into `#testIframe` to try the student's exact content assignment |
| **Settings** | `populateSettingsTab()` + `saveStudentSettings()` (admin_dashboard.js ~150/~175); the Student Locations panel sits at the bottom (see below) |
| **Targets** | `renderTargetsTab()` + `adjustTargetOffset` (admin_dashboard.js ~222/~344) |
| **SR** | `renderSRTab()` — read-only SR state explorer; per-item popup shows interval/due/last result (admin_dashboard.js ~700-724) |

## Archive merge (the reason `getStudentArchive` exists)

`saveAnalytics` trims the live doc to ~500 recent events (auto-archive ≥700). The dashboard restores full history:

- `mergeAnalytics(live, archives)` (teacher_dashboard.js ~494, **exported pure** for `test_archive_merge_dashboard.js`): concatenates archive `events` arrays onto live, de-duping by `eventId` (fallback `timestamp`) — archives may overlap the live tail.
- `loadStudentArchives(studentId)` (~508): `GET /getStudentArchive?studentId=…` → merges into `student._fullAnalytics`; shows an archive-count badge. **Fail-safe by design:** any fetch error silently keeps the live-only view; the detail view never blocks on archives.
- `getAnalyticsInRange(student, from, to)` (~203) prefers `_fullAnalytics`, falls back to `student.analytics` — all downstream counting (sessions, durations, targets) automatically sees merged history.

## Settings tab & the password-view boundary

- `populateSettingsTab()` (admin_dashboard.js ~150): fills fullName, teacher (dropdown + custom), classTime, book/unit/page cascading selects, **`settingsLogin` (read-only + copy button via `copyLogin()` ~43)** and **`settingsPassword`** with the stored plaintext (eye-toggle `togglePwVis`).
- `saveStudentSettings()` (~175) POSTs `updateStudent` with the whitelisted field set. **Load-bearing rule:** only include `password` when the box is non-empty (`if (newPw) fields.password = newPw`, ~196-197) — an empty box means "leave unchanged". The historical empty-save bug wiped real passwords; do not "simplify" this away. The password plaintext view is the sanctioned recovery path (no email reset exists) — one-at-a-time only, never bulk-export (see [Backend API](10-backend-api.md)).

## Student Locations panel & geo_export.js (2026-09-25, geo v2 2026-09-26)

The Settings tab's bottom `.admin-panel` ("Student Locations", `teacher_dashboard.html:232-246`) holds a coverage line (`#geoCoverage`, "N/M students have location data"), the student table mount (`#geoList`), the Baidu-AK input (`#geoBaiduAk`), and the two export buttons. All behavior lives in `geo_export.js`; `teacher_dashboard.js` only re-renders on `switchTab('settings')` by calling `renderGeoCoverage()` + `renderGeoList()` (~563-566).

- `renderGeoList()` (geo v2): one row per student with a **usable** geo fix (`_hasUsableFix` — finite lat AND lng; malformed docs are excluded everywhere) — name, winning ~1 km cell, `days`, `Samples (all)` (total samples across all cells, not just the winner), captured date, and a **清除位置** button → `POST /clearGeo` (with confirm; drops local `geo`/`geoSamples` and re-renders). A `同址` badge marks students whose winning cell equals another student's (`_cellShareMap`) — sibling/trip twins. Empty-state text when nobody has data yet.
- **Escaping rule (load-bearing):** the student roster table (`teacher_dashboard.js` `renderStudents`) and the bulk-action chips (`admin_dashboard.js`) paste student-writable `avatar` and roster-imported names into `innerHTML` — every such sink must go through `geo_export.js`'s `_esc()` (HTML) or `_escJsArg()` (values embedded in `onclick="fn('…')"` — quotes escaped at the JS layer *first*, because the attribute is HTML-decoded before JS parsing). Belt: `updateAvatar.js`'s `sanitizeAvatar` rejects HTML-significant or >32-char values server-side. `test_geo_export.js` + `test_dashboard_security.js` pin both. Never add raw student-data interpolations here.
- **Map tab (2026-09-28, `geo_map.js` + vendored Leaflet 1.9.4 at `lib/leaflet/`):** `switchTab('map')` → `renderGeoMap()` builds a Leaflet map on **key-less Gaode GCJ-02 raster tiles** (`webrd0{1-4}.is.autonavi.com/appmaptile…`; Gaode's routing/JS APIs need a real-name-verified key — unobtainable, see [Gotchas](15-gotchas-and-history.md)). Students with a usable fix render as orange circle-markers (GCJ-converted via `geo_export.wgs84ToGcj02` so dots sit on roads; tooltip = name + `(Nd)`, popup adds days/captured). Candidate campuses: 添加候选校区 click-to-drop, persisted in teacher-browser `localStorage.csGeoCampusPins` (GCJ coords), 清空校区 resets. Side panel: per-campus straight-line ranking (avg/median km, ≤3/≤5 km counts — haversine in GCJ space, locally equivalent to true distance) and per-student rows with **驾车** links = `uri.amap.com/navigation` deep links (key-less, opens Gaode's real driving directions). Pure builders (`buildStudentPoints`, `haversineKm`, `rankCampuses`, `gaodeDriveUrl`, pin load/save) are VM-tested by `test_geo_map.js`; fit-to-bounds is deferred one tick because the tab container has zero size on first render (zoom-0 bug class).
- Exports: `exportLocationsCsv()` → `buildLocationCsv` (v2 columns `studentId,name,hasLocation,capturedAt,days,samples,wgs84_lat,wgs84_lng,bd09_lat,bd09_lng,sharesCellWith`); `exportBaiduMapHtml()` → self-contained Baidu GL map page (marker label `name (Nd)` = `geo.days`, and the ` (Nd)` suffix renders **only when days > 1** — a single-fix student shows as a bare name; campus pins + driving-time panel remain dormant pending an AK). The AK lives in `localStorage.csBaiduAk`, teacher browser only — never sent to the server.

## Targets & the manual offset

- Creating targets: `setTargets` API (admin_dashboard.js ~295, ~519) — date range + session count per student.
- `renderTargetsTab()` (~222) shows per-target progress: `completed = countSessionsInRange(student, start, end) + (t.manualOffset || 0)`, with an amber "(+N manual)" note when offset > 0.
- `adjustTargetOffset(idx)` (~344): prompts for the **TOTAL** completed sessions, computes `manualOffset = newTotal - recorded`, persists via `updateStudent` `fields.targets`, reverts on failure. Guards: cannot set total below recorded (server events always count); prompt shows recorded vs offset vs total.
- `countSessionsInRange` (~259) applies the **2-minute rule**: game-mode losses under 120s survival time don't count toward targets (`isUncountedShortLoss`, shared from frontend_auth.js — anti-cheat from 2026-07-27, not retroactive). Same rule client-side ([Auth & Versioning](04-auth-versioning.md)) and in VS/UNO game-over ([Game Modes](06-game-modes.md)).
- `manualOffset` exists because teachers record out-of-band practice (WeChat-reported sessions) — see [Data Model](11-data-model.md) for the field's home in the student doc.

## BM management (admin only, admin_dashboard.js ~726-916)

`openManageBmsModal()` → three tabs backed by `manageBms` API:
- **List** (`loadBmsList` ~755): `GET /manageBms?action=list` → table of BM accounts.
- **Add** (`POST action:'add'` ~820): id/login/password/fullName — server stores BM passwords as scrypt hashes (unlike students — BMs never need teacher recovery).
- **Logs** (`loadBmActivityLogs` ~907): `GET /manageBms?action=logs` → the `bmActivity` audit trail written by `addStudent`/`updateStudent` (who changed what).

## API surface used by the dashboards

| Endpoint | Used for |
|---|---|
| `GET /login` | Role re-verification (token refresh) in `checkTeacherAuth` |
| `GET /getStudents?includeSecure=true` | Student list (privileged) |
| `GET /getStudentArchive?studentId=` | Archive merge |
| `POST /updateStudent` | Settings save, target delete/offset (fields.targets) |
| `POST /setTargets` | Bulk target creation |
| `POST /addStudent` | Add-student modal |
| `GET/POST /manageBms` | BM list/add/delete + activity logs |
| `POST /clearGeo` | Student Locations panel 清除位置 button (geo v2) |
| `POST /changePassword` | (student-facing; not used by dashboards) |

## Dashboard testing

- `test_archive_merge_dashboard.js` (in `npm test`): unit-tests the exported pure `mergeAnalytics` + `getAnalyticsInRange` by stubbing a minimal `document` before requiring `teacher_dashboard.js` (its DOMContentLoaded listener never fires in Node).
- `test_geo_export.js` (in `npm test`): covers `geo_export.js` — WGS→GCJ→BD conversion, the v2 CSV columns + `sharesCellWith` grouping, map-HTML data embedding, and the `_esc`/`_escJsArg` guards on `renderGeoList`'s innerHTML sinks.
- **The rest of the dashboards have NO automated coverage** (neither `teacher_dashboard.js` beyond the two helpers nor `admin_dashboard.js` are unit-tested) — the jsdom suite loads `index.html`, not `teacher_dashboard.html`. Verify `admin_dashboard.js` edits with a `vm.runInContext` harness (mind the `let isBM`/`let isAdmin` double-declaration and the `AVAILABLE_CONTENT` stub) — method in the `classroom-survivors-dev` skill's `references/dashboard_testing.md`.

## Update discipline

Any agent that changes code covered by this page must update this page in the same commit. The wiki is the single source of truth; skills/memory hold only behavior rules and point here.
