const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
    listSources: (type) => ipcRenderer.invoke("list-sources", { type }),
    chooseSavePath: () => ipcRenderer.invoke("choose-save-path"),
    chooseFolder: () => ipcRenderer.invoke("choose-folder"),
    writeFile: (args) => ipcRenderer.invoke("write-file", args),
    getSettings: () => ipcRenderer.invoke("get-settings"),
    saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
    getHomePath: () => ipcRenderer.invoke("get-home-path")
});
