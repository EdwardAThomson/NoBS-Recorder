# Roadmap — NoBS Recorder

_Status: active · updated 2026-05-30_

A minimal Electron screen recorder for Linux/X11 — capture a window or screen with
optional webcam overlay and mic/system audio, saved as WebM, without OBS
complexity. See `docs/spec_and_plan.md`. (Pairs with the `nobs-stitcher` clip editor.)

## Shipped

- [x] Window & screen picker (X11 desktopCapturer, thumbnails, app icons, name filter)
- [x] Live preview canvas (composite of source + overlays)
- [x] Webcam picture-in-picture (device, corner position, size, rounded corners + shadow)
- [x] Microphone support (device select, gain slider −30dB to +20dB)
- [x] System audio capture + microphone mixing
- [x] FPS selection (15 / 30 / 60)
- [x] WebM output with corrected duration headers
- [x] Auto-save to chosen folder (falls back to download dialog)
- [x] Recording controls (start/stop, blinking indicator, elapsed timer)
- [x] Settings persistence (last-used output folder)
- [x] Self-hiding from the window list (no mirror loop)
- [x] Background throttling disabled for steady capture

## Next

- [ ] Resolution scaling (1080p option; currently native only)
- [ ] Audio input meter for confidence
- [ ] AppImage / .deb packaging

## Backlog

- [ ] Windows / macOS support
- [ ] Wayland support (experimental)
- [ ] Incremental chunk writing to disk (crash safety)
- [ ] Startup-time optimization (<2s target)
