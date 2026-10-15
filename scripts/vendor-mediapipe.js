/*
 * Copies MediaPipe's WASM runtime out of node_modules and into renderer/vendor,
 * where the renderer can load it over file:// like any other local asset.
 *
 * The runtime is ~13MB, so it is kept out of git and reproduced from the
 * dependency instead. The model beside it (renderer/models) IS committed,
 * because npm does not ship one.
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "node_modules", "@mediapipe", "tasks-vision");
const DEST = path.join(__dirname, "..", "renderer", "vendor", "mediapipe");

const FILES = [
    ["vision_bundle.js", "vision_bundle.js"],
    [path.join("wasm", "vision_wasm_internal.js"), path.join("wasm", "vision_wasm_internal.js")],
    [path.join("wasm", "vision_wasm_internal.wasm"), path.join("wasm", "vision_wasm_internal.wasm")]
];

function sameSize(a, b) {
    try {
        return fs.statSync(a).size === fs.statSync(b).size;
    } catch (e) {
        return false;
    }
}

if (!fs.existsSync(SRC)) {
    console.log("[vendor-mediapipe] @mediapipe/tasks-vision not installed; skipping.");
    process.exit(0);
}

let copied = 0;
for (const [from, to] of FILES) {
    const src = path.join(SRC, from);
    const dest = path.join(DEST, to);
    if (!fs.existsSync(src)) {
        console.error("[vendor-mediapipe] missing " + src);
        process.exit(1);
    }
    if (sameSize(src, dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied++;
}

console.log(copied
    ? "[vendor-mediapipe] copied " + copied + " file(s) into renderer/vendor/mediapipe"
    : "[vendor-mediapipe] already up to date");
