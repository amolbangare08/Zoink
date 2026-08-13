# ZOINK! — Implementation Plan

**Adobe Premiere Pro extension.** Paste a YouTube / Instagram / TikTok link, optionally set in/out points, and the clip is downloaded, conformed to edit-safe H.264 MP4, imported, and dropped on the timeline at the playhead — in one click.

Target host: Premiere Pro 2025 (v25.x) on Windows 11. Verified on this machine: `Adobe Premiere Pro 2025` installed, `yt-dlp.exe` and `ffmpeg.exe` already on PATH, and `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\` in use by other panels.

---

## 1. Platform decision: CEP, not UXP

| | CEP 12 (CSXS 12) | UXP for Premiere |
| --- | --- | --- |
| Spawn external binaries (`yt-dlp`, `ffmpeg`) | Yes — Node.js runtime in panel | No `child_process` |
| Premiere DOM coverage | Full ExtendScript DOM | Partial / evolving |
| Version reach | Premiere 2018 → 2025+ | Recent builds only |

ZOINK's core is "run two external binaries and then talk to the Premiere DOM". Only CEP can do both. **Decision: CEP 12 panel with `--enable-nodejs`, ExtendScript (`.jsx`) for all host/DOM work.**

Consequence: the panel runs two separate JavaScript worlds.

- **Panel context** (Chromium + Node): UI, settings, process spawning, progress parsing.
- **Host context** (ExtendScript, ES3): import, bin creation, track placement.

They communicate only through `CSInterface.evalScript(codeString, callback)`. This boundary drives most of the design below.

---

## 2. File layout

```
ZOINK/
├── CSXS/
│   └── manifest.xml            # extension id, host list, CEF flags
├── client/                     # panel context
│   ├── index.html
│   ├── style.css               # the design in the mockup
│   ├── app.js                  # UI state machine + step orchestration
│   ├── pipeline/
│   │   ├── probe.js            # yt-dlp -J metadata fetch
│   │   ├── download.js         # yt-dlp download + progress parsing
│   │   ├── conform.js          # ffprobe inspect + ffmpeg transcode
│   │   ├── tools.js            # binary resolution (bin/ → PATH), version check
│   │   └── proc.js             # spawn wrapper, cancellation, process-tree kill
│   ├── host-bridge.js          # evalScript wrapper w/ safe arg encoding
│   ├── settings.js             # load/save JSON settings
│   ├── log.js                  # console pane writer
│   └── vendor/CSInterface.js
├── host/
│   ├── zoink.jsx               # entry: ZOINK.place(payloadJson)
│   ├── placement.jsx           # playhead / append / insert / bin-only
│   └── json2.jsx               # JSON polyfill — ExtendScript has no JSON
├── bin/                        # optional bundled tools (gitignored)
│   ├── yt-dlp.exe
│   ├── ffmpeg.exe
│   └── ffprobe.exe
├── assets/
│   └── zoink-logo.svg
├── scripts/
│   ├── install-dev.ps1         # symlink to user CEP dir + debug-mode registry
│   └── package-zxp.ps1         # ZXPSignCmd packaging
└── .debug                      # remote-debug ports for dev
```

No npm runtime dependencies. Everything uses Node built-ins (`child_process`, `fs`, `path`, `os`).

---

## 3. `CSXS/manifest.xml` essentials

- Extension id: `com.zoink.premierepro.panel`
- Bundle version: `1.0.1` (matches the footer chip in the design)
- `<Host Name="PPRO" Version="[22.0,99.9]"/>` — Premiere 2022 and up
- `<RequiredRuntime Name="CSXS" Version="9.0"/>`
- `<ScriptPath>./host/zoink.jsx</ScriptPath>` — auto-loaded into the host context on panel open
- `<MainPath>./client/index.html</MainPath>`
- `<Type>Panel</Type>`, geometry: default 420×900, min 360×640, max 900×2000 (the design is a tall narrow panel)
- CEF command line params:
  - `--enable-nodejs` — required to spawn binaries
  - `--mixed-context` — one V8 context, so Node stays available after navigation
  - `--allow-file-access-from-files`

---

## 4. The pipeline

Three user-visible steps, matching the `01 FETCH / 02 ENCODE / 03 TIMELINE` chips.

### Step 0 — Validate & probe (before FETCH lights up)

1. URL regex per platform (`youtube.com/watch`, `youtu.be`, `youtube.com/shorts`, `instagram.com/(p|reel|tv)`, `tiktok.com/@*/video`, `vm.tiktok.com`). Unknown hosts are still allowed — yt-dlp supports 1000+ sites — but flagged as "unverified" in the log.
2. `yt-dlp -J --no-warnings --no-playlist <url>` → JSON metadata: `title`, `duration`, `fps`, `formats[]`, `vcodec`, `acodec`.
3. Panel shows resolved title + duration in the log pane, and validates in/out against `duration`.

This probe is cheap and turns the most common failures (private video, login wall, dead link) into a clear message *before* anything is downloaded.

### Step 1 — FETCH (`yt-dlp`)

Command shape:

```
yt-dlp
  --no-playlist
  -f "bv*[height<=H]+ba/b[height<=H]"       # H from MAX QUALITY dropdown
  --merge-output-format mp4
  --download-sections "*IN-OUT"              # only when in/out set
  --force-keyframes-at-cuts                  # frame-accurate section cut
  --ffmpeg-location <resolved ffmpeg dir>
  --newline
  --progress-template "YKP|%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s"
  -o "<workdir>/%(title).80s [%(id)s].%(ext)s"
  --print after_move:filepath                # authoritative output path
  <url>
```

Key points:

- **In/out clipping is the headline feature.** `--download-sections` makes yt-dlp request only the byte ranges covering that time window, so a 40-second grab from a 3-hour VOD downloads ~40 seconds of data. That is the "no wasted disk" promise.
- `--force-keyframes-at-cuts` re-encodes the boundary GOPs so the cut lands on the requested frame instead of the nearest keyframe. Slower, but an editor asking for `1:20:00–1:20:40` expects exactly that. Make it a settings toggle (`Frame-accurate cuts`, default on).
- Time parsing accepts `SS`, `MM:SS`, `HH:MM:SS`, and `HH:MM:SS.mmm`; normalize to seconds internally, re-emit as `HH:MM:SS.mmm`.
- Instagram and some TikTok URLs need auth. Settings expose `--cookies-from-browser <chrome|edge|firefox|brave>`; on a 403/login error, the panel surfaces "This post needs a signed-in session — enable Use browser cookies in Settings."
- Progress: parse the `YKP|` lines, map to 0–60% of the bar. Non-`YKP` stderr goes to the log pane verbatim.
- The `after_move:filepath` print gives the exact final filename — never guess it by globbing the folder.

### Step 2 — ENCODE (`ffprobe` + `ffmpeg`)

The point of this step is not "convert to MP4" — yt-dlp usually already merged to MP4. It is **VFR → CFR**. TikTok and Instagram exports are variable-frame-rate; dropped straight into Premiere they cause progressive audio/video drift. This is the single biggest quality-of-life win over just dragging a downloaded file in.

1. `ffprobe -v quiet -print_format json -show_streams <file>` → codec, pix_fmt, `r_frame_rate` vs `avg_frame_rate`, profile.
2. **Fast path (skip transcode)** when all of: `vcodec=h264`, `pix_fmt=yuv420p`, `acodec=aac`, container `mp4`, and `r_frame_rate == avg_frame_rate` (CFR). Log "already edit-safe — skipping encode" and jump to 90%.
3. Otherwise transcode:

```
ffmpeg -y -i <in>
  -c:v libx264 -preset veryfast -crf 18 -profile:v high -pix_fmt yuv420p
  -r <target_fps> -fps_mode cfr
  -c:a aac -b:a 192k -ar 48000
  -movflags +faststart
  <out>.mp4
```

   - `target_fps` = sequence frame rate when a sequence is open (queried from the host), else the source's `avg_frame_rate` rounded to a standard rate (23.976/24/25/29.97/30/50/59.94/60).
   - Optional hardware path: detect `h264_nvenc` via `ffmpeg -hide_banner -encoders`, and when the setting `Hardware encode` is on, swap in `-c:v h264_nvenc -preset p5 -cq 20`. Roughly 3–6× faster on an NVIDIA machine; keep libx264 as the fallback.
   - Progress: parse `-progress pipe:1` `out_time_us=` against known duration → 60–90% of the bar.
4. Keep-or-delete the pre-conform source per settings (`Keep original download`, default off).

### Step 3 — TIMELINE (ExtendScript)

Panel calls `ZOINK.place(payload)` where payload carries `{ filePath, title, insertMode, binName, sourceUrl, inPoint, outPoint }`.

Host script does:

1. Guard: `app.project` exists, else return an error object.
2. Bin: find or create `app.project.rootItem` child bin named `ZOINK!` (`createBin`), so grabbed footage never litters the project root.
3. Import: `app.project.importFiles([filePath], true /*suppressUI*/, bin, false)`. Locate the new `projectItem` by comparing `getMediaPath()` — do not assume it lands last.
4. Stamp metadata: write the source URL and in/out into the item's Description / Comment field via `projectItem.setProjectMetadata` so an editor can trace where a clip came from three weeks later.
5. Placement, by `insertMode`:
   - **`playhead-overwrite`** (default, matches "Append to end of sequence"'s sibling option): `seq.getPlayerPosition()` → `videoTrack.overwriteClip(item, time)`.
   - **`playhead-insert`**: `videoTrack.insertClip(item, time)` — ripples everything right.
   - **`append`**: scan the target track's `clips`, take `max(clip.end.seconds)`, overwrite there. Empty track → 0.
   - **`bin-only`**: stop after import.
6. Target track selection: first targeted video track (`track.isTargeted()`), else V1. Same logic for audio.
7. No open sequence: if `insertMode` is a timeline mode and `app.project.activeSequence` is null, fall back to `createNewSequenceFromClips` so the grab still lands somewhere useful, and report which fallback fired.
8. Return `JSON.stringify({ ok, message, sequenceName, trackIndex, atSeconds })`.

---

## 5. Panel ⇄ host bridge

ExtendScript is ES3 and `evalScript` takes a single string. Two rules keep this from breaking on the first video title containing an apostrophe:

```js
// panel side
function callHost(fn, payload) {
  const arg = encodeURIComponent(JSON.stringify(payload));
  return new Promise(res =>
    cs.evalScript(`ZOINK.${fn}("${arg}")`, r => res(safeParse(r)))
  );
}
```

```js
// host side
ZOINK.place = function (encoded) {
  var payload = JSON.parse(decodeURIComponent(encoded)); // json2.jsx provides JSON
  ...
};
```

- Always `encodeURIComponent` — it eliminates quote, newline, and backslash escaping problems from Windows paths and video titles.
- Always return a JSON string; `evalScript` returns `"EvalScript error."` on an uncaught host exception, so wrap every host entry point in `try/catch` and return a structured error instead.
- Host code must stay ES3: no `let`/`const`, no arrow functions, no `Array.prototype.find`.

---

## 6. Tool resolution & first-run

`tools.js` resolves each binary in order:

1. `<extension>/bin/<name>.exe` (bundled)
2. Path saved in settings
3. System `PATH` (`where yt-dlp` / `which yt-dlp`)

On panel load, run `yt-dlp --version` and `ffmpeg -version`. Results drive the header status pill: `ready` (green, as in the design), `tools missing` (amber), `error` (red). The log pane on first load prints exactly what the mockup shows — extension root and whether tools came from `bin/` or PATH.

Missing tools → an inline banner with a **How to install** link and the two winget commands, not a silent failure.

yt-dlp rots fast when extractors change. Add a **Check for yt-dlp update** button in Settings that runs `yt-dlp -U` (only valid for the standalone exe; for a pip install, show the pip command instead). Also detect a build older than ~60 days and hint at it after an extractor error.

---

## 7. Settings (gear icon)

Stored at `%APPDATA%\ZOINK\settings.json`:

| Setting | Default |
| --- | --- |
| Download folder | `<project folder>/ZOINK Downloads`, falling back to `~/Videos/ZOINK` |
| Max quality | Up to 1080p |
| Insert mode | Append to end of sequence |
| Frame-accurate cuts | on |
| Hardware encode (NVENC) | off |
| Keep original download | off |
| Use browser cookies | off + browser picker |
| Proxy | empty |
| yt-dlp / ffmpeg path overrides | empty (auto) |

Defaulting the download folder next to the Premiere project keeps grabbed media with the edit, which is what a project-relative workflow expects. Fall back to the user folder when the project is unsaved.

---

## 8. UI state machine

Single `state` object driving the whole panel:

```
idle → probing → fetching → encoding → placing → done
                    ↓          ↓         ↓
                  error ←──────┴─────────┘
                  cancelled
```

- Step chips: `idle` (dim border) → `active` (purple border + glow, matching the accent in the design) → `done` (green tick) → `error` (red).
- The thin rail under the chips is one continuous 0–100% bar: FETCH 0–60, ENCODE 60–90, TIMELINE 90–100. Indeterminate shimmer while probing.
- The primary button is a single control that becomes **CANCEL** while running. Cancel kills the process tree (`taskkill /PID <pid> /T /F` on Windows; `SIGTERM` then `SIGKILL` on macOS) and removes partial `.part` files.
- `OPEN FOLDER` uses `shell.showItemInFolder`-equivalent: `explorer /select,"<path>"` on Windows, `open -R` on macOS. Enabled once a file exists, even after a failed encode.
- Log pane is append-only, auto-scrolls unless the user has scrolled up, capped at 500 lines, with a right-click **Copy all** for bug reports.
- Everything from the mockup carries over verbatim: monospace type, `01/02/03` numbering, the `ZOINK! v1.0.1` chip, and the legal notice in the footer.

---

## 9. Error handling

Map raw stderr into one plain sentence plus a suggested action:

| Signal in stderr | Message shown |
| --- | --- |
| `Private video`, `Sign in to confirm` | "Needs a signed-in session — enable browser cookies in Settings." |
| `HTTP Error 403` | "Access denied. Try cookies, or update yt-dlp." |
| `Unsupported URL` | "This link isn't supported." |
| `Video unavailable` / geo | "Unavailable in your region or removed." |
| `ffmpeg not found` | "ffmpeg missing — install it or drop it in bin/." |
| Extractor / `unable to extract` | "Extractor out of date — run Check for yt-dlp update." |
| Host returns `EvalScript error.` | "Premiere rejected the import — check the log." |

Failure never loses work: if ENCODE fails, the raw download stays and `OPEN FOLDER` is enabled. If TIMELINE fails, the file is still imported into the `ZOINK!` bin whenever import succeeded.

---

## 10. Build phases

| Phase | Deliverable | Done when |
| --- | --- | --- |
| **0 — Scaffold** | manifest, empty panel, dev install script, debug-mode registry keys | Panel opens under Window ▸ Extensions ▸ ZOINK! and a ping round-trips to ExtendScript |
| **1 — UI shell** | Full static markup + CSS matching the mockup, state machine with fake progress | Every visual state (idle/active/done/error) can be triggered by hand |
| **2 — Tools + probe** | `tools.js`, `probe.js`, status pill, log pane | Pasting a YouTube URL prints resolved title and duration |
| **3 — Fetch** | `download.js`, progress parsing, cancel | Full video lands in the download folder with a live progress bar |
| **4 — In/out clipping** | Time parsing, validation, `--download-sections` | 40s slice of a 3-hour VOD downloads in seconds, not minutes |
| **5 — Conform** | `conform.js`, fast-path skip, CFR transcode | A VFR TikTok comes out CFR H.264, and an already-clean YouTube MP4 skips the step |
| **6 — Timeline** | `zoink.jsx`, all four insert modes, `ZOINK!` bin | Clip appears at the playhead in an open sequence, and all fallbacks behave |
| **7 — Settings** | Settings view, persistence, cookies, NVENC, path overrides | Settings survive a Premiere restart |
| **8 — Hardening** | Error mapping, cancel cleanup, long titles, unicode, spaces in paths, no-project / no-sequence cases | Manual test matrix passes |
| **9 — Packaging** | `ZXPSignCmd` signing, self-signed cert, install docs, macOS parity pass | Double-click install via a ZXP installer works on a clean machine |

Phases 2–6 are the real product; 0–1 are a day, 7–9 are polish and distribution.

---

## 11. Install & distribution

**Development** (this machine): unsigned extensions require debug mode.

```
reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f
```

Then symlink the repo into the *user* extensions folder — no admin rights needed, and edits are live on panel reload:

```
mklink /D "%APPDATA%\Adobe\CEP\extensions\com.zoink.premierepro.panel" "C:\path\to\ZOINK"
```

A `.debug` file exposes a CEF remote-debugging port so the panel is inspectable from Chrome at `localhost:8088`.

**Release:** sign with `ZXPSignCmd -sign` using a self-signed cert (or a real code-signing cert for Adobe Exchange), ship the `.zxp`, and point users at the ZXP Installer or Adobe's UPIA. Bundling `yt-dlp.exe` and `ffmpeg.exe` in `bin/` (~90 MB) makes it zero-config — worth it, with a "lite" build that relies on PATH as the alternative.

---

## 12. Risks and open questions

1. **yt-dlp extractor rot** — the largest ongoing maintenance cost. Mitigated by the in-panel update button and an age hint; unavoidable in principle.
2. **`--force-keyframes-at-cuts` cost** — makes an otherwise stream-copy section download re-encode its boundaries, so a 40s grab takes noticeably longer than a raw copy. Exposed as a toggle so speed-over-precision is a user choice.
3. **`--download-sections` support varies by site.** It works well on YouTube DASH; on some Instagram/TikTok single-file URLs yt-dlp downloads the whole (short) file and trims after. Detect this and log "trimmed after download" so the behavior is never a mystery.
4. **Premiere DOM quirks** — `overwriteClip` time arguments are version-sensitive (seconds-as-string vs `Time` object). Pin the behavior in phase 6 against 2025 and guard with a try/catch that retries the other form.
5. **Terms of service.** The footer notice from the design stays: fetch only what you own or are licensed to use; no DRM circumvention is implemented or planned. That is a real constraint on scope, not just a disclaimer.
6. **macOS parity** — mostly path and process-kill differences, plus a Gatekeeper-quarantine issue on bundled binaries. Cheap to add in phase 9 if the panel is kept free of Windows-only assumptions from phase 0.

---

## 13. Manual test matrix (phase 8)

- YouTube long VOD, in/out mid-video, 1080p cap
- YouTube Short (vertical, 60fps)
- Instagram Reel (VFR — must come out CFR)
- TikTok with a signed-in-only account (cookies path)
- URL with unicode/emoji title, and a project path with spaces
- Cancel mid-fetch and mid-encode; verify no orphan processes and no `.part` leftovers
- No project open / project open with no sequence / sequence with all tracks locked
- Insert at playhead mid-timeline (overwrite vs insert ripple)
- Tools absent from PATH and `bin/`
- Same URL grabbed twice — filename collision handling
