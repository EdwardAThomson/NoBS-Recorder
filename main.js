const { app, BrowserWindow, ipcMain, dialog, desktopCapturer } = require("electron");
const fs = require("fs");
const path = require("path");

// Chromium's setuid sandbox commonly fails on Linux desktops; Windows/macOS keep it on.
if (process.platform === "linux") app.commandLine.appendSwitch("no-sandbox");

function createWindow() {
    const win = new BrowserWindow({
        width: 1180,
        height: 800,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, "preload.js"),
            backgroundThrottling: false
        }
    });

    win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("list-sources", async (_evt, { type }) => {
    // type: "window" | "screen"
    const types = type === "screen" ? ["screen"] : ["window"];

    const sources = await desktopCapturer.getSources({
        types,
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true
    });

    return sources
        .filter(s => s.name !== "NoBS Recorder") // Prevent self-capture loop
        .map((s) => ({
            id: s.id,
            name: s.name,
            thumbnailDataUrl: s.thumbnail.toDataURL(),
            appIconDataUrl: s.appIcon ? s.appIcon.toDataURL() : null
        }));
});

function isDirectory(p) {
    try {
        return !!p && fs.statSync(p).isDirectory();
    } catch (e) {
        return false;
    }
}

// Recordings land in the platform's Videos folder unless the user picks
// somewhere else. app.getPath resolves this per-OS: the XDG videos dir on
// Linux, the Videos known folder on Windows. Some minimal Linux setups have
// no XDG dirs configured at all, hence the fallback.
function defaultOutputFolder() {
    try {
        return app.getPath("videos");
    } catch (e) {
        return app.getPath("home");
    }
}

ipcMain.handle("choose-folder", async (_evt, { defaultPath } = {}) => {
    const options = { properties: ["openDirectory", "createDirectory"] };
    if (isDirectory(defaultPath)) options.defaultPath = defaultPath;
    const { canceled, filePaths } = await dialog.showOpenDialog(options);
    return canceled ? null : filePaths[0];
});

// Settings Persistence
const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");

function readSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
        }
    } catch (e) {
        console.error("Error reading settings:", e);
    }
    return {};
}

ipcMain.handle("get-settings", async () => readSettings());

ipcMain.handle("save-settings", async (_evt, patch) => {
    try {
        // Merge, so saving one setting does not wipe the others.
        const merged = { ...readSettings(), ...patch };
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
        return true;
    } catch (e) {
        console.error("Error saving settings:", e);
        return false;
    }
});

ipcMain.handle("get-home-path", () => app.getPath("home"));

ipcMain.handle("confirm-silent-recording", async (_evt, { detail }) => {
    const { response } = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Cancel", "Record anyway"],
        defaultId: 0,
        cancelId: 0,
        title: "No audio source",
        message: "This recording will have no sound.",
        detail: detail
    });
    return response === 1;
});

ipcMain.handle("resolve-output-folder", () => {
    const saved = readSettings().outputFolder;

    // A settings file that travelled between machines carries a path that does
    // not exist here. Never try to create it: a Linux "/home/me/Videos" would
    // be created as "C:\home\me\Videos" on Windows. Fall back instead.
    if (isDirectory(saved)) return { folder: saved, isDefault: false, rejected: null };

    const fallback = defaultOutputFolder();
    try {
        fs.mkdirSync(fallback, { recursive: true });
    } catch (e) {
        console.error("Could not create default output folder:", e);
    }
    return { folder: fallback, isDefault: true, rejected: saved || null };
});

ipcMain.handle("choose-save-path", async () => {
    console.log("IPC: choose-save-path called");
    try {
        const { canceled, filePath } = await dialog.showSaveDialog({
            title: "Save recording",
            defaultPath: `nobs-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`,
            filters: [{ name: "WebM Video", extensions: ["webm"] }]
        });
        console.log(`IPC: dialog result - canceled: ${canceled}, filePath: ${filePath}`);
        return canceled ? null : filePath;
    } catch (e) {
        console.error("IPC: choose-save-path error:", e);
        throw e;
    }
});

ipcMain.handle("write-file", async (_evt, { filePath, folder, filename, arrayBuffer }) => {
    // The renderer has no path module, so it may pass folder + filename and let us join.
    const target = filePath || path.join(folder, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    console.log(`IPC: write-file called for ${target}, size: ${arrayBuffer.byteLength}`);
    try {
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync(target, buffer);
        console.log("IPC: write-file success");
        return target;
    } catch (e) {
        console.error("IPC: write-file error:", e);
        throw e;
    }
});
