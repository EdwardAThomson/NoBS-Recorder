
# NoBS Recorder (OBS-lite Recorder Spec - Linux/X11, Electron desktopCapturer, Window Picker)

Here’s a solid “best spec” for an Electron `desktopCapturer` + in-app window list picker on **Kubuntu/X11**, optimized for *repeatability* and *minimal OBS-like complexity*.


## 1) Purpose

A small desktop app that reliably records:

*   **One selected window** (typically a browser showing slides / ChatGPT thread / JS app)
*   Optional **webcam picture-in-picture**
*   **Microphone audio** recording
*   Saves locally as **WebM**

Primary goal: eliminate OBS device/routing variability by keeping the feature surface tiny and deterministic.

---

## 2) Target platforms

* **Primary:** Kubuntu / Linux on **X11**
* **Secondary (optional):** Windows (future; spec keeps code modular so you can add it later)

---

## 3) Core user stories

### US1: Pick a window and preview it

* User clicks **“Choose window”**
* App shows an in-app list of capturable sources: **Windows** and **Screens**
* User selects a **window**
* App shows a live preview immediately

### US2: Record the selected window

* User clicks **Start**
* App records the composited output (window + optional webcam overlay)
* User clicks **Stop**
* App saves `recording-YYYY-MM-DD_HH-mm-ss.webm` to chosen directory (or save dialog, your choice)

### US3: Enable webcam overlay (optional)

* User toggles webcam on/off
* User can select camera device
* User can set overlay corner + overlay size

---

## 4) UX / Screens

Single-window app with three panels:

### A) Source panel

* Button: **Choose window**
* List view (modal or side panel):

  * Tabs: **Windows** | **Screens**
  * Each entry shows: thumbnail + title (and app name if available)
  * “Refresh list” button (rebuild sources)
* Selected source summary: `Selected: <window title>`

### B) Controls panel

* **FPS**: 15 / 30 / 60 (default 30)
* **Resolution**:

  * `Native` (default) — use source size
  * Optional future: “Scale to 1080p”
* **Webcam overlay**:

  * toggle
  * camera dropdown
  * corner dropdown (TR/TL/BR/BL)
  * size slider (10–40%)
* **Audio**:
  * Microphone dropdown (list input devices)
  * Meter (optional for MVP, but good for confidence)

### C) Preview + Debug panel

* Live preview canvas
* Debug log area:

  * selected source id, fps, recorder mimeType
  * start/stop timestamps
  * any errors

---

## 5) Capture pipeline (technical design)

### 5.1 Enumerate sources (main process)

Use Electron:

* `desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })`

Return to renderer via IPC:

* `{ id, name, thumbnailDataURL, displayId?, appIconDataURL? }`

### 5.2 Acquire selected window stream (renderer)

Once user chooses a source `sourceId`, acquire stream with:

* `navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: fps } }, audio: false })`

This is the reliable X11 path: no portal picker, no permissions churn (beyond normal OS).

### 5.3 Webcam + Audio streams (renderer)

* Webcam: `navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: ... } }, audio: false })`
* Mic: `navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: ... } }, video: false })`

### 5.4 Compositing

* Create hidden `<video>` elements for display + webcam
* Draw to a single `<canvas>` each animation frame:

  * base layer: window capture
  * overlay: webcam (rounded corners, corner selectable, cover-fit)

### 5.5 Recording

### 5.5 Recording

* Combine tracks: `new MediaStream([...canvasStream.getVideoTracks(), ...micStream.getAudioTracks()])`
* `combinedStream` → `MediaRecorder`
* Try mimeTypes in order:

  * `video/webm;codecs=vp9`
  * `video/webm;codecs=vp8`
  * `video/webm`

Chunking:

* `recorder.start(1000)` (1s chunks)

Save:

* collect chunks → Blob → ArrayBuffer
* send to main process for writing (IPC) so you avoid renderer filesystem permissions complexity

---

## 6) Determinism / reliability rules (important)

The app must be explicit and boring:

* Never follow “default mic” / “default camera” automatically once set
* If the window disappears / stream ends:

  * stop recording automatically
  * show a clear error (“Source closed”)
* Explicitly set:

  * FPS
  * prefer “Native resolution”
* If user selects a different source while recording:

  * disallow and prompt “Stop recording first”

---

## 7) File handling

### MVP saving behavior

* On Stop:

  * open save dialog (default filename timestamped)
  * write `.webm`

### Nice upgrade (optional)

* Settings: default save directory
* Auto-save with no dialog + “Reveal in folder” button

---

## 8) Packaging & distribution (Linux)

* Use `electron-builder` or `electron-forge`
* Targets:

  * AppImage (nice for Linux users)
  * deb (optional)

---

## 9) Non-functional requirements

* Startup to usable UI in < 2 seconds on a normal laptop
* No background services
* Minimal dependencies
* Crash-safe recording: if app crashes mid-record, you may lose the current file (acceptable for MVP). If you want safer: write chunks incrementally to disk (future).

---

## 10) Known limitations (explicitly documented in README)

* **X11 only** for the “in-app window list picker” capture path
* Output is **WebM**
* No **system audio** (speaker output) in MVP, only **microphone**
* Some apps using GPU overlays / protected content may capture as black (rare on Linux; more common with DRM video)

---

## 11) Milestones

### M0 — skeleton UI

* main window loads
* source list modal works (fake data)

### M1 — real window picker

* `desktopCapturer` list + selection

### M2 — preview

* render selected window to preview canvas

### M3 — record

* MediaRecorder start/stop + save `.webm`

### M4 — webcam overlay

* toggle + selection + PiP

### M5 — polish

* error handling, logs, settings persistence

---

## 12) Testing checklist (practical)

* Pick Chrome window → preview works
* Record 2 minutes → saved file plays in VLC
* Resize/move window during recording → still records
* Close captured window → app stops recording and warns
* Toggle webcam on/off while NOT recording → works
* Attempt to change source during recording → blocked

