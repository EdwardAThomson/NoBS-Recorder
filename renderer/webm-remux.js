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
 *
 * Finally we build a Cues element: the index that maps a timestamp to the byte
 * offset of the cluster holding it. MediaRecorder cannot write one, because it
 * does not know a cluster's offset until after it has emitted the one before.
 * Without it a player can only decode forward from the start, so Media
 * Foundation plays a recording but refuses to seek inside it.
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
    var ID_TIMECODE = 0xE7;
    var ID_TRACKS = 0x1654AE6B;
    var ID_TRACK_ENTRY = 0xAE;
    var ID_TRACK_NUMBER = 0xD7;
    var ID_TRACK_TYPE = 0x83;
    var ID_SEEK_HEAD = 0x114D9B74;
    var ID_CUES = 0x1C53BB6B;
    var ID_CUE_POINT = 0xBB;
    var ID_CUE_TIME = 0xB3;
    var ID_CUE_TRACK_POSITIONS = 0xB7;
    var ID_CUE_TRACK = 0xF7;
    var ID_CUE_CLUSTER_POSITION = 0xF1;

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

    // Cue times and offsets are written at a fixed width so that the length of
    // the Cues element does not depend on the values inside it. That length has
    // to be settled before the cluster offsets can be measured, and those
    // offsets are precisely what goes in. Eight bytes is the EBML ceiling for an
    // unsigned integer, so no offset can outgrow the room reserved for it.
    var CUE_WIDTH = 8;

    function readUint(buf, start, end) {
        var v = 0;
        for (var i = start; i < end; i++) v = v * 256 + buf[i];
        return v;
    }

    // An EBML ID carries its own length marker, so the bytes of the constant are
    // already the bytes that go on the wire.
    function encodeId(id) {
        var bytes = [];
        while (id > 0) { bytes.unshift(id % 256); id = Math.floor(id / 256); }
        return new Uint8Array(bytes);
    }

    function uintFixed(value, width) {
        var out = new Uint8Array(width);
        for (var i = width - 1; i >= 0; i--) {
            out[i] = value % 256;
            value = Math.floor(value / 256);
        }
        return out;
    }

    function el(id, content) {
        return concat(element(encodeId(id), content));
    }

    function lengthOf(parts) {
        var total = 0;
        for (var i = 0; i < parts.length; i++) total += parts[i].length;
        return total;
    }

    // A cluster's Timecode is already in TimecodeScale units, which is what
    // CueTime is measured in, so it carries across untouched.
    function clusterTimecode(buf, dataStart, dataEnd) {
        var pos = dataStart;
        while (pos < dataEnd) {
            var id = readId(buf, pos);
            if (!id) return null;
            var sz = readSize(buf, pos + id.length);
            if (!sz || sz.unknown) return null;
            var start = pos + id.length + sz.length;
            var end = Math.min(start + sz.value, dataEnd);
            if (id.value === ID_TIMECODE) return readUint(buf, start, end);
            if (end <= pos) return null;
            pos = end;
        }
        return null;
    }

    // Every cue names a track. Prefer the video track, so that scrubbing lands
    // on pictures, but index an audio-only recording rather than leaving it bare.
    function findCueTrack(content) {
        var pos = 0, first = 0, video = 0;
        while (pos < content.length) {
            var id = readId(content, pos);
            if (!id) break;
            var sz = readSize(content, pos + id.length);
            if (!sz) break;
            var dataStart = pos + id.length + sz.length;
            var end = Math.min(dataStart + sz.value, content.length);
            if (id.value === ID_TRACK_ENTRY) {
                var number = 0, type = 0, p = dataStart;
                while (p < end) {
                    var eid = readId(content, p);
                    if (!eid) break;
                    var esz = readSize(content, p + eid.length);
                    if (!esz) break;
                    var eStart = p + eid.length + esz.length;
                    var eEnd = Math.min(eStart + esz.value, end);
                    if (eid.value === ID_TRACK_NUMBER) number = readUint(content, eStart, eEnd);
                    if (eid.value === ID_TRACK_TYPE) type = readUint(content, eStart, eEnd);
                    if (eEnd <= p) break;
                    p = eEnd;
                }
                if (number) {
                    if (!first) first = number;
                    if (type === 1 && !video) video = number;
                }
            }
            if (end <= pos) break;
            pos = end;
        }
        return video || first || 1;
    }

    function buildCues(entries, track) {
        var points = [];
        for (var i = 0; i < entries.length; i++) {
            var positions = concat([
                el(ID_CUE_TRACK, uintFixed(track, CUE_WIDTH)),
                el(ID_CUE_CLUSTER_POSITION, uintFixed(entries[i].position, CUE_WIDTH))
            ]);
            points.push(el(ID_CUE_POINT, concat([
                el(ID_CUE_TIME, uintFixed(entries[i].time, CUE_WIDTH)),
                el(ID_CUE_TRACK_POSITIONS, positions)
            ])));
        }
        return el(ID_CUES, concat(points));
    }

    function remuxBytes(buf, durationMs) {
        var stats = { clusters: 0, unknownSized: 0, durationReplaced: false, cuePoints: 0, droppedIndex: false };
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
        var cueTrack = 1;
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
                children.push({
                    parts: element(idBytes, buf.slice(cStart, cEnd)),
                    cluster: true,
                    time: clusterTimecode(buf, cStart, cEnd)
                });
            } else if (cid.value === ID_INFO) {
                cEnd = csz.unknown ? buf.length : Math.min(cStart + csz.value, buf.length);
                var info = rebuildInfo(buf.slice(cStart, cEnd), durationMs);
                stats.durationReplaced = info.replaced;
                children.push({ parts: element(idBytes, info.bytes) });
            } else if (cid.value === ID_CUES || cid.value === ID_SEEK_HEAD) {
                // Both are tables of byte offsets into the segment, and giving
                // every element a definite size moves the bytes they point at.
                // A carried-over index would send a player to the wrong place,
                // which is worse than no index at all: drop it, and write a
                // fresh Cues below from offsets we have just measured.
                cEnd = csz.unknown ? buf.length : Math.min(cStart + csz.value, buf.length);
                stats.droppedIndex = true;
            } else {
                cEnd = csz.unknown ? buf.length : Math.min(cStart + csz.value, buf.length);
                if (cid.value === ID_TRACKS) cueTrack = findCueTrack(buf.slice(cStart, cEnd));
                children.push({ parts: [buf.slice(pos, cEnd)] });
            }

            if (cEnd <= pos) break;
            pos = cEnd;
        }

        var i, j;
        var firstCluster = children.length;
        for (i = 0; i < children.length; i++) {
            if (children[i].cluster) { firstCluster = i; break; }
        }

        // A cluster with no Timecode cannot be pointed at by time, so it is left
        // out of the index rather than indexed at a guessed position.
        var entries = [];
        for (i = 0; i < children.length; i++) {
            if (children[i].cluster && children[i].time !== null) {
                entries.push({ time: children[i].time, position: 0, at: i });
            }
        }

        // Cues goes immediately before the first cluster, so a player walking
        // the segment's children meets the index ahead of the data it describes
        // and needs no SeekHead to find it. CueClusterPosition is measured from
        // the start of the segment's content, so the index's own length counts
        // towards every offset in it.
        var cues = null;
        if (entries.length) {
            cues = buildCues(entries, cueTrack);
            var offset = 0;
            for (i = 0, j = 0; i < children.length; i++) {
                if (i === firstCluster) offset += cues.length;
                if (j < entries.length && entries[j].at === i) entries[j++].position = offset;
                offset += lengthOf(children[i].parts);
            }
            // Fixed-width values keep this second pass exactly as long as the
            // first, so the offsets just measured are still the right ones.
            cues = buildCues(entries, cueTrack);
            stats.cuePoints = entries.length;
        }

        var flat = [];
        for (i = 0; i < children.length; i++) {
            if (cues && i === firstCluster) flat.push(cues);
            for (j = 0; j < children[i].parts.length; j++) flat.push(children[i].parts[j]);
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
