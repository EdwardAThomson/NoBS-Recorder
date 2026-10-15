/*
 * Background blur / replacement for the webcam feed.
 *
 * MediaPipe's selfie segmenter gives a per-pixel person mask. We draw the
 * background first (a blurred copy of the frame, or a still image), then stamp
 * the sharp person over it using the mask as an alpha channel.
 *
 * The model and WASM runtime are loaded from disk, so nothing leaves the
 * machine. Everything here degrades to "no effect" rather than failing: if the
 * segmenter cannot start, draw() returns false and the caller draws normally.
 */
(function (root) {
    "use strict";

    // Segmentation runs on a downscaled copy. The model works at 256x256
    // internally, so full-resolution input costs time and buys nothing.
    var SEG_WIDTH = 480;

    var segmenter = null;
    var starting = null;
    var failed = false;

    var work = null, workCtx = null;        // downscaled frame fed to the model
    var mask = null, maskCtx = null;        // mask as an alpha channel
    var person = null, personCtx = null;    // frame cut to the mask
    var maskImage = null;                   // reusable ImageData

    var backgroundImage = null;
    var lastTimestamp = -1;

    function canvasOf(w, h) {
        var c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        return c;
    }

    function ensure(name, w, h) {
        var pair = { work: [work, workCtx], mask: [mask, maskCtx], person: [person, personCtx] }[name];
        var c = pair[0];
        if (!c) {
            c = canvasOf(w, h);
            var cx = c.getContext("2d", { willReadFrequently: name === "mask" });
            if (name === "work") { work = c; workCtx = cx; }
            if (name === "mask") { mask = c; maskCtx = cx; }
            if (name === "person") { person = c; personCtx = cx; }
            return cx;
        }
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        return pair[1];
    }

    // Same cover-fit rule the rest of the app uses: crop the overflowing axis.
    function coverRect(vw, vh, w, h) {
        var dstAspect = w / h, srcAspect = vw / vh;
        var sx = 0, sy = 0, sw = vw, sh = vh;
        if (srcAspect > dstAspect) {
            sw = Math.round(vh * dstAspect);
            sx = Math.round((vw - sw) / 2);
        } else {
            sh = Math.round(vw / dstAspect);
            sy = Math.round((vh - sh) / 2);
        }
        return { sx: sx, sy: sy, sw: sw, sh: sh };
    }

    var api = {
        mode: "none",           // "none" | "blur" | "image"
        blurPx: 14,
        lastError: "",

        isActive: function () {
            return api.mode !== "none";
        },

        // Loading the runtime takes a moment and the first inference compiles
        // GPU shaders, so this is kicked off when a mode is first selected.
        start: function () {
            if (segmenter || failed) return starting || Promise.resolve(!!segmenter);
            if (starting) return starting;

            starting = (async function () {
                try {
                    if (typeof Vision === "undefined") throw new Error("vision bundle not loaded");
                    var fileset = await Vision.FilesetResolver.forVisionTasks("./vendor/mediapipe/wasm");
                    var opts = {
                        baseOptions: { modelAssetPath: "./models/selfie_segmenter.tflite", delegate: "GPU" },
                        runningMode: "VIDEO",
                        outputCategoryMask: true,
                        outputConfidenceMasks: false
                    };
                    try {
                        segmenter = await Vision.ImageSegmenter.createFromOptions(fileset, opts);
                    } catch (gpuError) {
                        opts.baseOptions.delegate = "CPU";
                        segmenter = await Vision.ImageSegmenter.createFromOptions(fileset, opts);
                    }
                    return true;
                } catch (e) {
                    failed = true;
                    api.lastError = String((e && e.message) || e);
                    return false;
                } finally {
                    starting = null;
                }
            })();
            return starting;
        },

        setBackgroundImage: function (src) {
            return new Promise(function (resolve) {
                if (!src) { backgroundImage = null; return resolve(true); }
                var img = new Image();
                img.onload = function () { backgroundImage = img; resolve(true); };
                img.onerror = function () { backgroundImage = null; resolve(false); };
                img.src = src;
            });
        },

        hasBackgroundImage: function () {
            return !!backgroundImage;
        },

        // Returns false when it could not draw, so the caller falls back to a
        // plain cover-fit draw and the picture never simply vanishes.
        draw: function (ctx, video, x, y, w, h) {
            if (api.mode === "none" || !segmenter || w < 2 || h < 2) return false;
            if (!video || video.readyState < 2) return false;
            if (api.mode === "image" && !backgroundImage) return false;

            var vw = video.videoWidth || 1280;
            var vh = video.videoHeight || 720;
            if (!vw || !vh) return false;

            try {
                var segH = Math.max(2, Math.round(SEG_WIDTH * (h / w)));
                var wcx = ensure("work", SEG_WIDTH, segH);
                var crop = coverRect(vw, vh, SEG_WIDTH, segH);
                wcx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, SEG_WIDTH, segH);

                // Timestamps must increase or the model rejects the frame.
                var ts = performance.now();
                if (ts <= lastTimestamp) ts = lastTimestamp + 1;
                lastTimestamp = ts;

                var result = segmenter.segmentForVideo(work, ts);
                if (!result || !result.categoryMask) { if (result && result.close) result.close(); return false; }

                var mw = result.categoryMask.width;
                var mh = result.categoryMask.height;
                var data = result.categoryMask.getAsUint8Array();

                var mcx = ensure("mask", mw, mh);
                if (!maskImage || maskImage.width !== mw || maskImage.height !== mh) {
                    maskImage = mcx.createImageData(mw, mh);
                }
                var px = maskImage.data;
                for (var i = 0, j = 0; i < data.length; i++, j += 4) {
                    // Category 0 is background for the selfie segmenter.
                    var on = data[i] !== 0 ? 255 : 0;
                    px[j] = 255; px[j + 1] = 255; px[j + 2] = 255; px[j + 3] = on;
                }
                mcx.putImageData(maskImage, 0, 0);
                result.close();

                // The frame, cut to the person.
                var pcx = ensure("person", w, h);
                pcx.save();
                pcx.clearRect(0, 0, w, h);
                pcx.globalCompositeOperation = "source-over";
                var full = coverRect(vw, vh, w, h);
                pcx.drawImage(video, full.sx, full.sy, full.sw, full.sh, 0, 0, w, h);
                pcx.globalCompositeOperation = "destination-in";
                pcx.drawImage(mask, 0, 0, w, h);
                pcx.restore();

                // Background, then the person on top.
                ctx.save();
                if (api.mode === "image") {
                    var bg = coverRect(backgroundImage.naturalWidth, backgroundImage.naturalHeight, w, h);
                    ctx.drawImage(backgroundImage, bg.sx, bg.sy, bg.sw, bg.sh, x, y, w, h);
                } else {
                    var radius = Math.max(4, Math.round(api.blurPx * (w / 1280)));
                    ctx.filter = "blur(" + radius + "px)";
                    ctx.drawImage(video, full.sx, full.sy, full.sw, full.sh, x, y, w, h);
                    ctx.filter = "none";
                }
                ctx.drawImage(person, x, y);
                ctx.restore();
                return true;
            } catch (e) {
                api.lastError = String((e && e.message) || e);
                return false;
            }
        }
    };

    root.bgEffect = api;
})(typeof self !== "undefined" ? self : this);
