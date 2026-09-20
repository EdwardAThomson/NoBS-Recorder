const chooseWindowBtn = document.getElementById("chooseWindowBtn");
const chooseScreenBtn = document.getElementById("chooseScreenBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

const fpsSelect = document.getElementById("fpsSelect");
const webcamToggle = document.getElementById("webcamToggle");
const cameraSelect = document.getElementById("cameraSelect");
const cornerSelect = document.getElementById("cornerSelect");
const sizeRange = document.getElementById("sizeRange");
const sizeLabel = document.getElementById("sizeLabel");
const micSelect = document.getElementById("micSelect");
const micVolume = document.getElementById("micVolume");
const volLabel = document.getElementById("volLabel");
const sysAudioToggle = document.getElementById("sysAudioToggle");
const sysAudioHint = document.getElementById("sysAudioHint");

const recordingStatus = document.getElementById("recordingStatus");
const recTimer = document.getElementById("recTimer");

const setFolderBtn = document.getElementById("setFolderBtn");
const folderPathLabel = document.getElementById("folderPathLabel");
const resetFolderBtn = document.getElementById("resetFolderBtn");

const selectedLabel = document.getElementById("selectedLabel");
const canvas = document.getElementById("mixCanvas");
const logEl = document.getElementById("log");
const ctx = canvas.getContext("2d");

// modal UI
const modalBackdrop = document.getElementById("modalBackdrop");
const modalTitle = document.getElementById("modalTitle");
const refreshBtn = document.getElementById("refreshBtn");
const closeModalBtn = document.getElementById("closeModalBtn");
const filterInput = document.getElementById("filterInput");
const sourceGrid = document.getElementById("sourceGrid");

let pickerType = "window"; // "window" | "screen"
let allSources = [];
let selectedSource = null; // {id, name}

let displayStream = null;
let sysAudioStream = null;
let camStream = null;
let micStream = null;

let displayVideo = null;
let camVideo = null;

let animationHandle = null;
let recorder = null;
let recordedChunks = [];
let timerInterval = null;
let startTime = 0;
let outputFolder = null;
let usingDefaultFolder = true;

let audioCtx = null;
let gainNode = null;
let micLimiter = null;
let micShaper = null;
let micDest = null;
let homeDir = "";

function formatPath(p) {
    if (!p) return "";
    if (homeDir && p.startsWith(homeDir)) {
        return "~" + p.slice(homeDir.length);
    }
    return p;
}

// System audio is only offered when the platform actually handed us a loopback track.
function updateSysAudioUi() {
    const available = !!sysAudioStream;
    sysAudioToggle.disabled = !available;
    if (!displayStream) {
        sysAudioHint.textContent = "(pick a source)";
    } else {
        sysAudioHint.textContent = available ? "" : "(not supported here)";
    }
}

// A soft-knee ceiling: transparent below -3dBFS, and mathematically unable to
// exceed 1.0 no matter how hard the input is driven. The compressor alone still
// let peaks through above 0dBFS, so this sits after it as the real backstop.
function makeCeilingCurve() {
    const n = 8192;
    const curve = new Float32Array(n);
    const knee = 0.7;
    for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        const a = Math.abs(x);
        const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
        curve[i] = (x < 0 ? -1 : 1) * y;
    }
    return curve;
}

function setMicGain(db) {
    if (!gainNode) return;
    gainNode.gain.value = Math.pow(10, db / 20);
    routeMicChain();
}

// Only engage the limiter when the user is actually boosting. At or below 0dB
// the mic passes straight through, so nothing changes for anyone happy today.
function routeMicChain() {
    if (!gainNode || !micDest) return;
    try { gainNode.disconnect(); } catch (e) { /* not connected yet */ }
    if (Number(micVolume.value) > 0 && micLimiter) gainNode.connect(micLimiter);
    else gainNode.connect(micDest);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }, 100);
    log(`Saved via download: ${filename}`);
}

function applyOutputFolder(folder, isDefault) {
    outputFolder = folder;
    usingDefaultFolder = isDefault;
    folderPathLabel.textContent = formatPath(folder) + (isDefault ? " (default)" : "");
    folderPathLabel.title = folder;
    resetFolderBtn.disabled = isDefault;
}

function log(msg) {
    logEl.textContent = `${new Date().toLocaleTimeString()}  ${msg}\n` + logEl.textContent;
}

function stopStream(stream) {
    if (!stream) return;
    for (const t of stream.getTracks()) t.stop();
}

function makeVideoEl(stream) {
    const v = document.createElement("video");
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    return v;
}

function setCanvasSizeFromTrack() {
    const track = displayStream?.getVideoTracks()?.[0];
    const settings = track?.getSettings?.() || {};
    const w = settings.width || 1280;
    const h = settings.height || 720;
    canvas.width = w;
    canvas.height = h;
    log(`Canvas: ${w}x${h}`);
}

function getOverlayRect() {
    const pct = Number(sizeRange.value) / 100;
    const pad = Math.round(Math.min(canvas.width, canvas.height) * 0.02);

    const ow = Math.round(canvas.width * pct);
    const oh = Math.round(ow * (9 / 16));

    let x = pad, y = pad;
    const corner = cornerSelect.value;
    if (corner.includes("r")) x = canvas.width - ow - pad;
    if (corner.includes("b")) y = canvas.height - oh - pad;

    return { x, y, w: ow, h: oh, r: Math.round(pad * 0.6) };
}

function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawLoop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (displayVideo?.readyState >= 2) {
        ctx.drawImage(displayVideo, 0, 0, canvas.width, canvas.height);
    }

    if (webcamToggle.checked && camVideo?.readyState >= 2) {
        const { x, y, w, h, r } = getOverlayRect();

        // drop shadow
        ctx.save();
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 6;
        ctx.shadowColor = "rgba(0,0,0,0.35)";
        roundRect(x, y, w, h, r);
        ctx.fillStyle = "rgba(0,0,0,0.15)";
        ctx.fill();
        ctx.restore();

        // rounded clip
        ctx.save();
        roundRect(x, y, w, h, r);
        ctx.clip();

        // cover-fit webcam into overlay
        const vw = camVideo.videoWidth || 1280;
        const vh = camVideo.videoHeight || 720;
        const dstAspect = w / h;
        const srcAspect = vw / vh;

        let sx = 0, sy = 0, sw = vw, sh = vh;
        if (srcAspect > dstAspect) {
            sw = Math.round(vh * dstAspect);
            sx = Math.round((vw - sw) / 2);
        } else {
            sh = Math.round(vw / dstAspect);
            sy = Math.round((vh - sh) / 2);
        }

        ctx.drawImage(camVideo, sx, sy, sw, sh, x, y, w, h);
        ctx.restore();
    }

    animationHandle = requestAnimationFrame(drawLoop);
}

async function listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === "videoinput");

    // keep current selection if possible
    const current = cameraSelect.value;
    cameraSelect.innerHTML = "";

    for (const cam of cams) {
        const opt = document.createElement("option");
        opt.value = cam.deviceId;
        opt.textContent = cam.label || `Camera ${cameraSelect.length + 1}`;
        cameraSelect.appendChild(opt);
    }
    if (current && cams.some(c => c.deviceId === current)) cameraSelect.value = current;
}

async function startWebcam() {
    await listCameras();
    const deviceId = cameraSelect.value;

    camStream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
        audio: false
    });

    camVideo = makeVideoEl(camStream);
    await camVideo.play();
    log("Webcam started.");
}

async function listMicrophones() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === "audioinput");

    // keep current selection if possible
    const current = micSelect.value;
    micSelect.innerHTML = '<option value="">(None)</option>';

    for (const mic of mics) {
        const opt = document.createElement("option");
        opt.value = mic.deviceId;
        opt.textContent = mic.label || `Microphone ${micSelect.length}`;
        micSelect.appendChild(opt);
    }
    if (current) micSelect.value = current;
}

async function acquireDesktopStream(sourceId) {
    const fps = Number(fpsSelect.value);

    // Important: chromeMediaSource + chromeMediaSourceId is the desktopCapturer path
    const video = {
        mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
            maxFrameRate: fps
        }
    };

    // Loopback audio exists on Windows but not on Linux, and asking for it where it
    // is unsupported rejects the whole request - so retry without it.
    try {
        displayStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: "desktop"
                }
            },
            video
        });
    } catch (e) {
        log(`Desktop audio unavailable (${e.name}); capturing video only.`);
        displayStream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    }

    // Extract audio track if present (system audio)
    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length > 0) {
        log("System audio track found.");
        // We keep it in a separate stream/variable so we can mix it later
        sysAudioStream = new MediaStream(audioTracks);
    } else {
        log("No system audio track.");
        sysAudioStream = null;
    }
    updateSysAudioUi();

    displayVideo = makeVideoEl(displayStream);
    await displayVideo.play();

    // if the source goes away, the track can end
    const track = displayStream.getVideoTracks()[0];
    track.onended = () => {
        log("Source ended (window closed or capture stopped).");
        if (recorder && recorder.state !== "inactive") stopRecording();
        stopStream(displayStream);
        stopStream(sysAudioStream);
        displayStream = null;
        sysAudioStream = null;
        displayVideo = null;
        updateSysAudioUi();
        startBtn.disabled = true;
        selectedLabel.textContent = "Selected: (none)";
        selectedSource = null;
    };

    setCanvasSizeFromTrack();
    if (!animationHandle) drawLoop();

    startBtn.disabled = false;
    log("Desktop stream ready.");
}

function modalOpen(type) {
    pickerType = type;
    modalTitle.textContent = type === "screen" ? "Choose screen" : "Choose window";
    filterInput.value = "";
    modalBackdrop.classList.remove("hidden");
    refreshSources();
    filterInput.focus();
}

function modalClose() {
    modalBackdrop.classList.add("hidden");
}

function renderSources() {
    const q = filterInput.value.trim().toLowerCase();
    const filtered = allSources.filter(s => s.name.toLowerCase().includes(q));

    sourceGrid.innerHTML = "";
    for (const s of filtered) {
        const card = document.createElement("div");
        card.className = "card";
        card.title = s.name;

        const img = document.createElement("img");
        img.className = "thumb";
        img.src = s.thumbnailDataUrl;

        const name = document.createElement("div");
        name.className = "name";
        name.textContent = s.name;

        const meta = document.createElement("div");
        meta.className = "meta";

        if (s.appIconDataUrl) {
            const icon = document.createElement("img");
            icon.className = "icon";
            icon.src = s.appIconDataUrl;
            meta.appendChild(icon);
        }

        const idSpan = document.createElement("span");
        idSpan.textContent = s.id;
        meta.appendChild(idSpan);

        card.appendChild(img);
        card.appendChild(name);
        card.appendChild(meta);

        card.addEventListener("dblclick", async () => {
            try {
                selectedSource = { id: s.id, name: s.name };
                selectedLabel.textContent = `Selected: ${s.name}`;
                modalClose();

                // tear down old display stream if any
                stopStream(displayStream);
                stopStream(sysAudioStream);
                displayStream = null;
                sysAudioStream = null;
                displayVideo = null;

                await acquireDesktopStream(s.id);
            } catch (e) {
                log(`Acquire error: ${String(e)}`);
            }
        });

        sourceGrid.appendChild(card);
    }

    log(`Sources: ${filtered.length}/${allSources.length} shown.`);
}

async function refreshSources() {
    try {
        log(`Listing ${pickerType} sources…`);
        allSources = await window.api.listSources(pickerType);
        renderSources();
    } catch (e) {
        log(`List sources error: ${String(e)}`);
    }
}

async function startRecording() {
    if (!displayStream) return;

    // We no longer strictly require a microphone, as system audio might be sufficient.
    // However, if neither is present, it will be a silent video.

    const useSysAudio = !!sysAudioStream && sysAudioToggle.checked;

    // Nothing selected means a silent video, which is easy to do by accident
    // and only discovered after the fact.
    if (!micSelect.value && !useSysAudio) {
        const detail = sysAudioStream
            ? 'No microphone is selected, and System audio is switched off.'
            : 'No microphone is selected, and this platform provides no system audio.';
        const proceed = await window.api.confirmSilentRecording(detail);
        if (!proceed) {
            log('Start cancelled: the recording would have had no sound.');
            return;
        }
        log('Recording with no audio source, as confirmed.');
    }

    const fps = Number(fpsSelect.value);

    // ensure draw loop running
    if (!animationHandle) drawLoop();

    let audioTrack = null;

    // Process/Mix Audio (System Audio + Mic)
    if (micSelect.value || useSysAudio) {
        if (!audioCtx) audioCtx = new AudioContext();
        const dest = audioCtx.createMediaStreamDestination();

        // 1. Mic path
        if (micSelect.value) {
            try {
                micStream = await navigator.mediaDevices.getUserMedia({
                    audio: { deviceId: { exact: micSelect.value }, echoCancellation: false, noiseSuppression: false },
                    video: false
                });
                log("Microphone started.");

                const micSource = audioCtx.createMediaStreamSource(micStream);
                micDest = dest;
                gainNode = audioCtx.createGain();

                // Quiet Windows inputs need far more than the old +20dB ceiling,
                // but raw gain that high clips hard on peaks.
                micLimiter = audioCtx.createDynamicsCompressor();
                micLimiter.threshold.value = -6;
                micLimiter.knee.value = 0;
                micLimiter.ratio.value = 20;
                micLimiter.attack.value = 0.003;
                micLimiter.release.value = 0.25;

                micShaper = audioCtx.createWaveShaper();
                micShaper.curve = makeCeilingCurve();
                micShaper.oversample = "4x";

                micLimiter.connect(micShaper);
                micShaper.connect(dest);

                micSource.connect(gainNode);
                setMicGain(Number(micVolume.value));

            } catch (e) {
                log(`Mic error: ${String(e)}`);
            }
        }

        // 2. System Audio path
        if (useSysAudio) {
            try {
                const sysSource = audioCtx.createMediaStreamSource(sysAudioStream);
                // Connect directly to dest
                sysSource.connect(dest);
                log("System audio mixed.");
            } catch (e) {
                log(`Sys audio mix error: ${String(e)}`);
            }
        }

        if (dest.stream.getAudioTracks().length > 0) {
            audioTrack = dest.stream.getAudioTracks()[0];
        }
    }

    const canvasStream = canvas.captureStream(fps);

    // Mix tracks: Canvas Video + Processed Audio (if any)
    const combinedTracks = [
        ...canvasStream.getVideoTracks(),
        ...(audioTrack ? [audioTrack] : [])
    ];
    const combinedStream = new MediaStream(combinedTracks);

    recordedChunks = [];

    const mimeCandidates = [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm"
    ];
    const mimeType = mimeCandidates.find(t => MediaRecorder.isTypeSupported(t)) || "";

    recorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: 3_000_000
    });

    recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    recorder.onstop = async () => {
        try {
            const duration = Date.now() - startTime;
            let blob = new Blob(recordedChunks, { type: recorder.mimeType || "video/webm" });

            try {
                if (window.webmRemux) {
                    log("Finalising container...");
                    const fixed = await window.webmRemux.remuxBlob(blob, duration);
                    blob = fixed.blob;
                    if (fixed.stats) {
                        log(`Container: ${fixed.stats.clusters} clusters, ${(duration / 1000).toFixed(1)}s.`);
                    }
                }
            } catch (e) {
                log(`Container fix error: ${e}`);
            }

            const filename = `nobs-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
            try {
                // The renderer has no path module, so main joins folder + filename
                // with the right separator for the platform.
                const arrayBuffer = await blob.arrayBuffer();
                const savedPath = await window.api.writeFile({ folder: outputFolder, filename, arrayBuffer });
                log(`Saved: ${savedPath}`);
            } catch (e) {
                // Never lose a recording because the folder went away.
                log(`Could not write to ${outputFolder} (${e}); downloading instead.`);
                downloadBlob(blob, filename);
            }
        } catch (err) {
            log(`Save failed: ${String(err)}`);
        }
    };

    recorder.start(1000);

    startBtn.disabled = true;
    stopBtn.disabled = false;
    chooseWindowBtn.disabled = true;
    chooseScreenBtn.disabled = true;

    log(`Recording started (${mimeType || "default"} @ ${fps}fps).`);

    // Start Visual Timer
    recordingStatus.classList.remove("hidden");
    startTime = Date.now();
    recTimer.textContent = "00:00";
    timerInterval = setInterval(() => {
        const diff = Date.now() - startTime;
        const totalSecs = Math.floor(diff / 1000);
        const m = Math.floor(totalSecs / 60).toString().padStart(2, "0");
        const s = (totalSecs % 60).toString().padStart(2, "0");
        recTimer.textContent = `${m}:${s}`;
    }, 1000);
}

function stopRecording() {
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();

    clearInterval(timerInterval);
    recordingStatus.classList.add("hidden");

    stopBtn.disabled = true;
    startBtn.disabled = false;
    chooseWindowBtn.disabled = false;
    chooseScreenBtn.disabled = false;

    log("Recording stopped.");

    // stop mic immediately to release device
    stopStream(micStream);
    micStream = null;

    // Clean up AudioContext
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
        gainNode = null;
        micLimiter = null;
        micShaper = null;
        micDest = null;
    }
}

// --- UI wiring ---
chooseWindowBtn.addEventListener("click", () => modalOpen("window"));
chooseScreenBtn.addEventListener("click", () => modalOpen("screen"));
closeModalBtn.addEventListener("click", modalClose);
refreshBtn.addEventListener("click", refreshSources);
filterInput.addEventListener("input", renderSources);

startBtn.addEventListener("click", async () => {
    try {
        if (webcamToggle.checked && !camStream) await startWebcam();
        await startRecording();
    } catch (e) {
        log(`Start error: ${String(e)}`);
    }
});

stopBtn.addEventListener("click", () => {
    try {
        stopRecording();
    } catch (e) {
        log(`Stop error: ${String(e)}`);
    }
});

webcamToggle.addEventListener("change", async () => {
    const enabled = webcamToggle.checked;
    cameraSelect.disabled = !enabled;
    cornerSelect.disabled = !enabled;
    sizeRange.disabled = !enabled;

    if (!enabled) {
        stopStream(camStream);
        camStream = null;
        camVideo = null;
        log("Webcam disabled.");
        return;
    }

    try {
        await startWebcam();
    } catch (e) {
        log(`Webcam error: ${String(e)}`);
        webcamToggle.checked = false;
    }
});

cameraSelect.addEventListener("change", async () => {
    if (!webcamToggle.checked) return;
    stopStream(camStream);
    camStream = null;
    camVideo = null;
    await startWebcam();
});

micVolume.addEventListener("input", () => {
    const db = Number(micVolume.value);
    const label = db > 0 ? `+${db}dB` : `${db}dB`;
    volLabel.textContent = label;

    setMicGain(db);
});

sizeRange.addEventListener("input", () => {
    sizeLabel.textContent = `${sizeRange.value}%`;
});

setFolderBtn.addEventListener("click", async () => {
    try {
        const folder = await window.api.chooseFolder(outputFolder);
        if (folder) {
            applyOutputFolder(folder, false);
            log(`Output folder set: ${folder}`);
            await window.api.saveSettings({ outputFolder: folder });
        }
    } catch (e) {
        log(`Folder selection error: ${String(e)}`);
    }
});

resetFolderBtn.addEventListener("click", async () => {
    try {
        // Clearing the setting makes main fall back to the platform default.
        await window.api.saveSettings({ outputFolder: null });
        const resolved = await window.api.resolveOutputFolder();
        applyOutputFolder(resolved.folder, resolved.isDefault);
        log(`Output folder reset to default: ${resolved.folder}`);
    } catch (e) {
        log(`Folder reset error: ${String(e)}`);
    }
});

// cleanup
window.addEventListener("beforeunload", () => {
    try {
        if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch { }
    stopStream(displayStream);
    stopStream(sysAudioStream);
    stopStream(camStream);
    if (animationHandle) cancelAnimationFrame(animationHandle);
});

// The lists are built once at startup, so without this a headset plugged in
// mid-session never shows up.
navigator.mediaDevices.addEventListener("devicechange", async () => {
    try {
        await listCameras();
        await listMicrophones();
        log("Device list refreshed.");
    } catch (e) {
        log(`Device refresh error: ${String(e)}`);
    }
});

sysAudioToggle.addEventListener("change", async () => {
    await window.api.saveSettings({ systemAudio: sysAudioToggle.checked });
    log(`System audio ${sysAudioToggle.checked ? "enabled" : "disabled"}.`);
});

// helpful: request device labels by doing a quick enumerate after permissions
(async () => {
    try {
        await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch {
        // user may deny; it's fine
    }
    try {
        // Load Home Dir
        homeDir = await window.api.getHomePath();

        // Load Settings
        const settings = await window.api.getSettings();
        if (settings && typeof settings.systemAudio === "boolean") {
            sysAudioToggle.checked = settings.systemAudio;
        }
        const resolved = await window.api.resolveOutputFolder();
        applyOutputFolder(resolved.folder, resolved.isDefault);
        if (resolved.rejected) {
            log(`Saved folder is not available on this machine: ${resolved.rejected}`);
        }
        log(`Output folder: ${resolved.folder}${resolved.isDefault ? " (default)" : ""}`);

        await listCameras();
        await listMicrophones();
        if (webcamToggle.checked) {
            // enable controls since we removed 'disabled' in HTML but the handler manages state
            cameraSelect.disabled = false;
            cornerSelect.disabled = false;
            sizeRange.disabled = false;
            await startWebcam();
        }
    } catch { }
})();
