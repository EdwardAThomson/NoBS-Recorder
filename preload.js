const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
    listSources: (type) => ipcRenderer.invoke("list-sources", { type }),
    chooseSavePath: () => ipcRenderer.invoke("choose-save-path"),
    chooseFolder: (defaultPath) => ipcRenderer.invoke("choose-folder", { defaultPath }),
    resolveOutputFolder: () => ipcRenderer.invoke("resolve-output-folder"),
    confirmSilentRecording: (detail) => ipcRenderer.invoke("confirm-silent-recording", { detail }),
    setRecordingState: (recording) => ipcRenderer.send("recording-state", recording),
    onStopAndSave: (cb) => ipcRenderer.on("stop-and-save", () => cb()),
    readyToClose: () => ipcRenderer.send("ready-to-close"),
    chooseImage: () => ipcRenderer.invoke("choose-image"),
    writeFile: (args) => ipcRenderer.invoke("write-file", args),
    getSettings: () => ipcRenderer.invoke("get-settings"),
    saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
    getHomePath: () => ipcRenderer.invoke("get-home-path"),

    // Live streaming. Media goes out with send() rather than invoke(): at a few
    // hundred messages a second, awaiting a round trip per frame would put the
    // socket's latency into the encode loop.
    streamConnect: (args) => ipcRenderer.invoke("stream-connect", args),
    streamMetadata: (info) => ipcRenderer.send("stream-metadata", info),
    streamSend: (kind, timestampMs, buffer) => ipcRenderer.send("stream-send", kind, timestampMs, buffer),
    streamStop: () => ipcRenderer.invoke("stream-stop"),
    onStreamEvent: (cb) => ipcRenderer.on("stream-event", (_evt, payload) => cb(payload))
});
