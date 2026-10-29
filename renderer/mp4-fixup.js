/*
 * Repairs the media duration in an MP4 produced by MediaRecorder.
 *
 * Chromium's MP4 muxer writes each track's mdhd duration as a count of
 * milliseconds, even though mdhd carries its own timescale - 30000 for 30fps
 * video. A 15 second clip therefore declares a media duration of 15007/30000,
 * half a second. mvhd and tkhd are correct, but a player that trusts the track
 * reads the clip as a thirtieth of its real length: Windows Media Player shows
 * no duration, races through the picture and will not seek.
 *
 * The real duration is already in the file - the sum of the sample durations in
 * the fragments - so we add those up per track and write the total over the
 * wrong number. It is a fixed-width field, so nothing moves: every byte offset
 * in the file, the mfra seek index included, stays valid.
 *
 * Anything unexpected means leave it alone. A file we cannot make sense of is
 * returned untouched rather than half-rewritten.
 */
(function (root, factory) {
    if (typeof module !== "undefined" && module.exports) module.exports = factory();
    else root.mp4Fixup = factory();
})(typeof self !== "undefined" ? self : this, function () {

    // Boxes whose payload is further boxes rather than fields.
    var CONTAINERS = ["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf", "mfra", "edts", "dinf"];

    function isContainer(type) {
        for (var i = 0; i < CONTAINERS.length; i++) if (CONTAINERS[i] === type) return true;
        return false;
    }

    function readU32(buf, pos) {
        return (buf[pos] * 16777216) + (buf[pos + 1] * 65536) + (buf[pos + 2] * 256) + buf[pos + 3];
    }

    // Durations never approach 2^53, so plain arithmetic is safe for the 64-bit
    // forms and we avoid needing BigInt.
    function readU64(buf, pos) {
        return readU32(buf, pos) * 4294967296 + readU32(buf, pos + 4);
    }

    function writeU32(buf, pos, value) {
        buf[pos] = Math.floor(value / 16777216) & 0xFF;
        buf[pos + 1] = Math.floor(value / 65536) & 0xFF;
        buf[pos + 2] = Math.floor(value / 256) & 0xFF;
        buf[pos + 3] = value & 0xFF;
    }

    function writeU64(buf, pos, value) {
        var high = Math.floor(value / 4294967296);
        writeU32(buf, pos, high);
        writeU32(buf, pos + 4, value - high * 4294967296);
    }

    function type4(buf, pos) {
        return String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
    }

    // Flat list of every box, each tagged with the chain of types above it, so a
    // box can be identified by where it sits rather than by its name alone.
    function boxes(buf) {
        var out = [];
        function walk(start, end, path) {
            var pos = start;
            while (pos + 8 <= end) {
                var size = readU32(buf, pos);
                var type = type4(buf, pos + 4);
                var head = 8;
                if (size === 1) {
                    if (pos + 16 > end) return;
                    size = readU64(buf, pos + 8);
                    head = 16;
                } else if (size === 0) {
                    size = end - pos;
                }
                if (size < head || pos + size > end) return;
                out.push({ type: type, start: pos, dataStart: pos + head, dataEnd: pos + size, path: path });
                if (isContainer(type)) walk(pos + head, pos + size, path.concat([type]));
                pos += size;
            }
        }
        walk(0, buf.length, []);
        return out;
    }

    function parentIs(box, type) {
        return box.path.length > 0 && box.path[box.path.length - 1] === type;
    }

    function within(box, outer) {
        return box.start > outer.start && box.dataEnd <= outer.dataEnd;
    }

    // Sum of every sample duration a track's fragments declare, which is that
    // track's media duration expressed in its own timescale.
    function sampleTotals(buf, all) {
        var totals = {};
        for (var i = 0; i < all.length; i++) {
            var traf = all[i];
            if (traf.type !== "traf") continue;

            var trackId = null;
            var truns = [];
            for (var j = 0; j < all.length; j++) {
                var child = all[j];
                if (!within(child, traf) || !parentIs(child, "traf")) continue;
                if (child.type === "tfhd") trackId = readU32(buf, child.dataStart + 4);
                else if (child.type === "trun") truns.push(child);
            }
            if (trackId === null) continue;

            for (var t = 0; t < truns.length; t++) {
                var trun = truns[t];
                var flags = readU32(buf, trun.dataStart) & 0xFFFFFF;
                if (!(flags & 0x100)) continue;          // no per-sample durations to add up
                var pos = trun.dataStart + 4;
                var count = readU32(buf, pos);
                pos += 4;
                if (flags & 0x1) pos += 4;               // data_offset
                if (flags & 0x4) pos += 4;               // first_sample_flags
                var stride = 4 +
                    ((flags & 0x200) ? 4 : 0) +
                    ((flags & 0x400) ? 4 : 0) +
                    ((flags & 0x800) ? 4 : 0);
                if (pos + count * stride > trun.dataEnd) continue;   // truncated, do not guess
                var sum = 0;
                for (var s = 0; s < count; s++) {
                    sum += readU32(buf, pos);
                    pos += stride;
                }
                totals[trackId] = (totals[trackId] || 0) + sum;
            }
        }
        return totals;
    }

    // Patches the buffer in place. Returns what changed, or null if this is not
    // an MP4 we recognise.
    function fixBytes(buf) {
        var all = boxes(buf);
        if (!all.length || all[0].type !== "ftyp") return null;

        var totals = sampleTotals(buf, all);
        var stats = { tracks: 0, patched: 0, details: [] };

        for (var i = 0; i < all.length; i++) {
            var trak = all[i];
            if (trak.type !== "trak") continue;
            stats.tracks++;

            var tkhd = null;
            var mdhd = null;
            for (var j = 0; j < all.length; j++) {
                var box = all[j];
                if (!within(box, trak)) continue;
                if (box.type === "tkhd" && parentIs(box, "trak")) tkhd = box;
                if (box.type === "mdhd" && parentIs(box, "mdia")) mdhd = box;
            }
            if (!tkhd || !mdhd) continue;

            var tkVersion = buf[tkhd.dataStart];
            var trackId = readU32(buf, tkhd.dataStart + 4 + (tkVersion === 1 ? 16 : 8));

            var mdVersion = buf[mdhd.dataStart];
            var tsPos = mdhd.dataStart + 4 + (mdVersion === 1 ? 16 : 8);
            var timescale = readU32(buf, tsPos);
            var durPos = tsPos + 4;
            var current = mdVersion === 1 ? readU64(buf, durPos) : readU32(buf, durPos);

            var correct = totals[trackId];
            if (!correct || !timescale) continue;
            // A duration already within about a frame of the sample total is
            // right enough; only an outright wrong one gets touched.
            if (Math.abs(correct - current) * 1000 < timescale) continue;

            if (mdVersion === 1) {
                writeU64(buf, durPos, correct);
            } else if (correct <= 4294967295) {
                writeU32(buf, durPos, correct);
            } else {
                continue;   // will not fit the field this file uses
            }

            stats.patched++;
            stats.details.push({
                track: trackId,
                timescale: timescale,
                was: current,
                now: correct,
                seconds: correct / timescale
            });
        }
        return stats;
    }

    function fixBlob(blob) {
        return blob.arrayBuffer().then(function (ab) {
            var buf = new Uint8Array(ab);
            var stats = fixBytes(buf);
            if (!stats || !stats.patched) return { blob: blob, stats: stats };
            return { blob: new Blob([buf], { type: blob.type || "video/mp4" }), stats: stats };
        });
    }

    return { fixBytes: fixBytes, fixBlob: fixBlob };
});
