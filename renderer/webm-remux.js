/*
 * Rewrites a WebM blob produced by MediaRecorder so that it is structurally valid.
 *
 * MediaRecorder is a live muxer: it writes Segment and every Cluster with an
 * "unknown size" marker, because it cannot know the length in advance. Players
 * that scan for cluster IDs (ffmpeg, GStreamer) cope with this; Windows Media
 * Foundation does not, and stops at the end of the first cluster.
 *
 * So we walk the clusters, work out where each one really ends, and re-emit
 * everything with definite sizes. We also write the Duration into Segment>Info,
 * which MediaRecorder leaves out entirely.
 */
(function (root, factory) {
    if (typeof module !== "undefined" && module.exports) module.exports = factory();
    else root.webmRemux = factory();
})(typeof self !== "undefined" ? self : this, function () {

    var ID_SEGMENT = 0x18538067;
    var ID_INFO = 0x1549A966;
    var ID_CLUSTER = 0x1F43B675;
    var ID_TIMECODE_SCALE = 0x2AD7B1;
    var ID_DURATION = 0x4489;

    // Everything allowed directly inside a Cluster. An ID outside this set means
    // the cluster has ended - that is how an unknown-sized element terminates.
    var CLUSTER_CHILDREN = [0xE7, 0xA7, 0xAB, 0xA3, 0xA0, 0xAF, 0xBF, 0xEC, 0x5854];

    function readId(buf, pos) {
        var b = buf[pos];
        if (b === undefined) return null;
        var len = b >= 0x80 ? 1 : b >= 0x40 ? 2 : b >= 0x20 ? 3 : b >= 0x10 ? 4 : 0;
        if (!len || pos + len > buf.length) return null;
        var v = 0;
        for (var i = 0; i < len; i++) v = v * 256 + buf[pos + i];
        return { value: v, length: len };
    }

    function readSize(buf, pos) {
        var b = buf[pos];
        if (b === undefined) return null;
        var len = 1, mask = 0x80;
        while (len <= 8 && b < mask) { mask = mask >> 1; len++; }
        if (len > 8 || pos + len > buf.length) return null;
        var v = b & (mask - 1);
        var unknown = (v === mask - 1);
        for (var i = 1; i < len; i++) {
            var c = buf[pos + i];
            v = v * 256 + c;
            if (c !== 0xFF) unknown = false;
        }
        return { value: v, length: len, unknown: unknown };
    }

    function sizeLength(v) {
        var bytes = 1, limit = 128;
        while (v >= limit - 1 && bytes < 8) { bytes++; limit *= 128; }
        return bytes;
    }

    function writeSize(out, pos, v) {
        var bytes = sizeLength(v);
        var value = v + Math.pow(2, 7 * bytes);
        for (var i = bytes - 1; i >= 0; i--) {
            var c = value % 256;
            out[pos + i] = c;
            value = (value - c) / 256;
        }
        return bytes;
    }

    function isClusterChild(id) {
        for (var i = 0; i < CLUSTER_CHILDREN.length; i++) {
            if (CLUSTER_CHILDREN[i] === id) return true;
        }
        return false;
    }

    // An unknown-sized cluster ends at the first ID that cannot be its child.
    function findClusterEnd(buf, dataStart) {
        var pos = dataStart;
        while (pos < buf.length) {
            var id = readId(buf, pos);
            if (!id || !isClusterChild(id.value)) return pos;
            var sz = readSize(buf, pos + id.length);
            if (!sz || sz.unknown) return pos;
            var next = pos + id.length + sz.length + sz.value;
            if (next <= pos || next > buf.length) return buf.length;
            pos = next;
        }
        return buf.length;
    }

    function encodeDouble(value) {
        var out = new Uint8Array(8);
        new DataView(out.buffer).setFloat64(0, value, false);
        return out;
    }

    function concat(parts) {
        var total = 0, i;
        for (i = 0; i < parts.length; i++) total += parts[i].length;
        var out = new Uint8Array(total), off = 0;
        for (i = 0; i < parts.length; i++) {
            out.set(parts[i], off);
            off += parts[i].length;
        }
        return out;
    }

    function element(idBytes, content) {
        var header = new Uint8Array(idBytes.length + sizeLength(content.length));
        header.set(idBytes, 0);
        writeSize(header, idBytes.length, content.length);
        return [header, content];
    }

    // Rebuild Segment>Info with a Duration element, replacing any existing one.
    function rebuildInfo(content, durationMs) {
        var scale = 1000000;
        var pos = 0, kept = [], replaced = false;
        while (pos < content.length) {
            var id = readId(content, pos);
            if (!id) break;
            var sz = readSize(content, pos + id.length);
            if (!sz) break;
            var dataStart = pos + id.length + sz.length;
            var end = Math.min(dataStart + sz.value, content.length);
            if (id.value === ID_TIMECODE_SCALE) {
                var s = 0;
                for (var i = dataStart; i < end; i++) s = s * 256 + content[i];
                if (s > 0) scale = s;
            }
            if (id.value === ID_DURATION) replaced = true;
            else kept.push(content.slice(pos, end));
            if (end <= pos) break;
            pos = end;
        }

        // Duration is expressed in TimecodeScale units, not milliseconds.
        var payload = encodeDouble(durationMs * 1000000 / scale);
        var header = new Uint8Array(2 + sizeLength(payload.length));
        header[0] = 0x44;
        header[1] = 0x89;
        writeSize(header, 2, payload.length);
        kept.push(header);
        kept.push(payload);
        return { bytes: concat(kept), replaced: replaced };
    }

    function remuxBytes(buf, durationMs) {
        var stats = { clusters: 0, unknownSized: 0, durationReplaced: false };
        var pos = 0, head = [], segmentIdBytes = null, segmentStart = -1;

        // Copy everything before the Segment (the EBML header) verbatim.
        while (pos < buf.length) {
            var id = readId(buf, pos);
            if (!id) break;
            var sz = readSize(buf, pos + id.length);
            if (!sz) break;
            var dataStart = pos + id.length + sz.length;
            if (id.value === ID_SEGMENT) {
                segmentIdBytes = buf.slice(pos, pos + id.length);
                segmentStart = dataStart;
                break;
            }
            var end = sz.unknown ? buf.length : Math.min(dataStart + sz.value, buf.length);
            head.push(buf.slice(pos, end));
            if (end <= pos) break;
            pos = end;
        }
        if (segmentStart < 0) return null;

        var children = [];
        pos = segmentStart;
        while (pos < buf.length) {
            var cid = readId(buf, pos);
            if (!cid) break;
            var csz = readSize(buf, pos + cid.length);
            if (!csz) break;
            var cStart = pos + cid.length + csz.length;
            var idBytes = buf.slice(pos, pos + cid.length);
            var cEnd;

            if (cid.value === ID_CLUSTER) {
                // Always derive the end by parsing, never from the declared size.
                // An unknown size has to be resolved anyway, and a definite size
                // may be wrong: fix-webm-duration used to stamp the first cluster
                // with a size covering the whole file, burying every later cluster
                // inside it. Parsing splits those back apart.
                cEnd = findClusterEnd(buf, cStart);
                stats.clusters++;
                if (csz.unknown) stats.unknownSized++;
                children.push(element(idBytes, buf.slice(cStart, cEnd)));
            } else if (cid.value === ID_INFO) {
                cEnd = csz.unknown ? buf.length : Math.min(cStart + csz.value, buf.length);
                var info = rebuildInfo(buf.slice(cStart, cEnd), durationMs);
                stats.durationReplaced = info.replaced;
                children.push(element(idBytes, info.bytes));
            } else {
                cEnd = csz.unknown ? buf.length : Math.min(cStart + csz.value, buf.length);
                children.push([buf.slice(pos, cEnd)]);
            }

            if (cEnd <= pos) break;
            pos = cEnd;
        }

        var flat = [];
        for (var i = 0; i < children.length; i++) {
            for (var j = 0; j < children[i].length; j++) flat.push(children[i][j]);
        }
        var segment = element(segmentIdBytes, concat(flat));
        return { bytes: concat(head.concat(segment)), stats: stats };
    }

    function remuxBlob(blob, durationMs) {
        return blob.arrayBuffer().then(function (ab) {
            var result = remuxBytes(new Uint8Array(ab), durationMs);
            if (!result) return { blob: blob, stats: null };
            return {
                blob: new Blob([result.bytes], { type: blob.type || "video/webm" }),
                stats: result.stats
            };
        });
    }

    return { remuxBytes: remuxBytes, remuxBlob: remuxBlob };
});
