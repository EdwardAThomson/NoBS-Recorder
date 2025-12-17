const { app, BrowserWindow, ipcMain, dialog, desktopCapturer } = require("electron");
const fs = require("fs");
const path = require("path");

function createWindow() {
    const win = new BrowserWindow({
        width: 1180,
        height: 800,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, "preload.js")
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

ipcMain.handle("choose-folder", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ["openDirectory"]
    });
    return canceled ? null : filePaths[0];
});

// Settings Persistence
const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");

ipcMain.handle("get-settings", async () => {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = fs.readFileSync(SETTINGS_FILE, "utf-8");
            return JSON.parse(data);
        }
    } catch (e) {
        console.error("Error reading settings:", e);
    }
    return {};
});

ipcMain.handle("save-settings", async (_evt, settings) => {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
        return true;
    } catch (e) {
        console.error("Error saving settings:", e);
        return false;
    }
});

ipcMain.handle("get-home-path", () => app.getPath("home"));

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

ipcMain.handle("write-file", async (_evt, { filePath, arrayBuffer }) => {
    console.log(`IPC: write-file called for ${filePath}, size: ${arrayBuffer.byteLength}`);
    try {
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync(filePath, buffer);
        console.log("IPC: write-file success");
        return true;
    } catch (e) {
        console.error("IPC: write-file error:", e);
        throw e;
    }
});
