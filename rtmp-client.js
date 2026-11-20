/*
 * A publishing-only RTMP client, for pushing a live stream to YouTube.
 *
 * Runs in the main process, where net and tls live, and takes FLV tag bodies
 * from renderer/flv-tag.js over IPC. It speaks just enough RTMP to publish:
 * handshake, chunk framing, the AMF0 commands that get a stream open, then
 * audio and video messages. It does not play, record, or subscribe.
 *
 * Deliberately left out, because a first version is easier to trust without
 * them: reconnection, bitrate adaptation, and the HMAC "complex" handshake that
 * Flash-era servers wanted. YouTube accepts the simple handshake.
 *
 * No dependencies, Electron included - which keeps it testable under plain node
 * against a stub server.
 */
"use strict";

const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const EventEmitter = require("events");

// RTMP message type ids we care about.
const MSG_SET_CHUNK_SIZE = 1;
const MSG_ACK = 3;
const MSG_WINDOW_ACK_SIZE = 5;
const MSG_SET_PEER_BANDWIDTH = 6;
const MSG_AUDIO = 8;
const MSG_VIDEO = 9;
const MSG_DATA_AMF0 = 18;
const MSG_COMMAND_AMF0 = 20;

// Chunk stream ids. 2 is reserved for protocol control; the rest are ours to
// pick, and these are the conventional choices.
const CSID_CONTROL = 2;
const CSID_COMMAND = 3;
const CSID_AUDIO = 4;
const CSID_DATA = 5;
const CSID_VIDEO = 6;

const HANDSHAKE_SIZE = 1536;
const DEFAULT_CHUNK_SIZE = 4096;

/* ---------------------------------------------------------------- AMF0 ---- */

const AMF0_NUMBER = 0x00;
const AMF0_BOOLEAN = 0x01;
const AMF0_STRING = 0x02;
const AMF0_OBJECT = 0x03;
const AMF0_NULL = 0x05;
const AMF0_ECMA_ARRAY = 0x08;
const AMF0_OBJECT_END = 0x09;
const AMF0_STRICT_ARRAY = 0x0A;

function amfString(value) {
    const body = Buffer.from(String(value), "utf8");
    const out = Buffer.allocUnsafe(3 + body.length);
    out.writeUInt8(AMF0_STRING, 0);
    out.writeUInt16BE(body.length, 1);
    body.copy(out, 3);
    return out;
}

// A key inside an object carries no type marker, just the length and bytes.
function amfKey(name) {
    const body = Buffer.from(String(name), "utf8");
    const out = Buffer.allocUnsafe(2 + body.length);
    out.writeUInt16BE(body.length, 0);
    body.copy(out, 2);
    return out;
}

function amfNumber(value) {
    const out = Buffer.allocUnsafe(9);
    out.writeUInt8(AMF0_NUMBER, 0);
    out.writeDoubleBE(value, 1);
    return out;
}

function amfBoolean(value) {
    return Buffer.from([AMF0_BOOLEAN, value ? 1 : 0]);
}

function amfNull() {
    return Buffer.from([AMF0_NULL]);
}

function amfValue(value) {
    if (value === null || value === undefined) return amfNull();
    if (typeof value === "number") return amfNumber(value);
    if (typeof value === "boolean") return amfBoolean(value);
    if (typeof value === "string") return amfString(value);
    if (Array.isArray(value)) {
        const parts = [Buffer.alloc(5)];
        parts[0].writeUInt8(AMF0_STRICT_ARRAY, 0);
        parts[0].writeUInt32BE(value.length, 1);
        for (const item of value) parts.push(amfValue(item));
        return Buffer.concat(parts);
    }
    return amfObject(value);
}

function amfObject(props) {
    const parts = [Buffer.from([AMF0_OBJECT])];
    for (const key of Object.keys(props)) {
        if (props[key] === undefined) continue;
        parts.push(amfKey(key), amfValue(props[key]));
    }
    // An object ends with an empty key followed by the end marker.
    parts.push(Buffer.from([0x00, 0x00, AMF0_OBJECT_END]));
    return Buffer.concat(parts);
}

// onMetaData conventionally travels as an ECMA array rather than an object.
// Structurally the same, with a count in front that readers are allowed to
// ignore, so the terminator still has to be there.
function amfEcmaArray(props) {
    const keys = Object.keys(props).filter(k => props[k] !== undefined);
    const head = Buffer.allocUnsafe(5);
    head.writeUInt8(AMF0_ECMA_ARRAY, 0);
    head.writeUInt32BE(keys.length, 1);
    const parts = [head];
    for (const key of keys) parts.push(amfKey(key), amfValue(props[key]));
    parts.push(Buffer.from([0x00, 0x00, AMF0_OBJECT_END]));
    return Buffer.concat(parts);
}

/*
 * Reads one AMF0 value. Returns { value, size }, or null when the buffer holds
 * less than a whole value - the caller is parsing a stream and must wait.
 * Only the types a server actually replies with are handled.
 */
function readAmf0(buf, pos) {
    if (pos >= buf.length) return null;
    const marker = buf[pos];
    switch (marker) {
        case AMF0_NUMBER:
            if (pos + 9 > buf.length) return null;
            return { value: buf.readDoubleBE(pos + 1), size: 9 };
        case AMF0_BOOLEAN:
            if (pos + 2 > buf.length) return null;
            return { value: buf[pos + 1] !== 0, size: 2 };
        case AMF0_STRING: {
            if (pos + 3 > buf.length) return null;
            const len = buf.readUInt16BE(pos + 1);
            if (pos + 3 + len > buf.length) return null;
            return { value: buf.toString("utf8", pos + 3, pos + 3 + len), size: 3 + len };
        }
        case AMF0_NULL:
            return { value: null, size: 1 };
        case AMF0_OBJECT:
        case AMF0_ECMA_ARRAY: {
            // An ECMA array's count is advisory; both forms end at the marker.
            let p = pos + (marker === AMF0_ECMA_ARRAY ? 5 : 1);
            const obj = {};
            for (;;) {
                if (p + 2 > buf.length) return null;
                const keyLen = buf.readUInt16BE(p);
                if (keyLen === 0) {
                    if (p + 3 > buf.length) return null;
                    return { value: obj, size: p + 3 - pos };
                }
                if (p + 2 + keyLen > buf.length) return null;
                const key = buf.toString("utf8", p + 2, p + 2 + keyLen);
                const read = readAmf0(buf, p + 2 + keyLen);
                if (!read) return null;
                obj[key] = read.value;
                p = p + 2 + keyLen + read.size;
            }
        }
        default:
            // Unknown type: we cannot know its length, so stop rather than
            // guess and desynchronise the stream.
            return null;
    }
}

function readAmf0Sequence(buf) {
    const out = [];
    let pos = 0;
    for (;;) {
        const read = readAmf0(buf, pos);
        if (!read) break;
        out.push(read.value);
        pos += read.size;
        if (pos >= buf.length) break;
    }
    return out;
}

/* ------------------------------------------------------------- chunking ---- */

/*
 * Splits a message into chunks.
 *
 * The first chunk uses a type 0 header, which states the timestamp in full, and
 * continuations use type 3, which repeats nothing. Types 1 and 2 would save a
 * few bytes per message by sending deltas; at a few hundred messages a second
 * that is not worth the state it would take to track.
 */
function encodeChunks(csid, messageTypeId, messageStreamId, timestamp, payload, chunkSize) {
    const ts = Math.max(0, Math.round(timestamp));
    const extended = ts >= 0xFFFFFF;
    const parts = [];
    let offset = 0;
    let first = true;

    while (offset < payload.length || first) {
        const take = Math.min(chunkSize, payload.length - offset);
        if (first) {
            const header = Buffer.allocUnsafe(12);
            header.writeUInt8((0 << 6) | csid, 0);
            header.writeUIntBE(extended ? 0xFFFFFF : ts, 1, 3);
            header.writeUIntBE(payload.length, 4, 3);
            header.writeUInt8(messageTypeId, 7);
            // The one little-endian field in the whole protocol.
            header.writeUInt32LE(messageStreamId, 8);
            parts.push(header);
            if (extended) {
                const ext = Buffer.allocUnsafe(4);
                ext.writeUInt32BE(ts, 0);
                parts.push(ext);
            }
            first = false;
        } else {
            parts.push(Buffer.from([(3 << 6) | csid]));
            // A type 3 chunk on a message with an extended timestamp repeats it.
            if (extended) {
                const ext = Buffer.allocUnsafe(4);
                ext.writeUInt32BE(ts, 0);
                parts.push(ext);
            }
        }
        if (take > 0) parts.push(payload.subarray(offset, offset + take));
        offset += take;
        if (offset >= payload.length) break;
    }
    return Buffer.concat(parts);
}

/*
 * Reassembles incoming messages.
 *
 * Only what a publisher must understand: the server's control messages and the
 * command replies. Per-chunk-stream state is kept because a type 3 header means
 * "same as last time on this chunk stream".
 */
class ChunkReader {
    constructor() {
        this.buffer = Buffer.alloc(0);
        this.chunkSize = 128;
        this.streams = new Map();
    }

    push(data) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
        const messages = [];
        for (;;) {
            const message = this._read();
            if (!message) break;
            if (message.complete) messages.push(message);
        }
        return messages;
    }

    _read() {
        const buf = this.buffer;
        if (buf.length < 1) return null;
        const fmt = buf[0] >> 6;
        const csidField = buf[0] & 0x3F;

        let csid, basicLen;
        if (csidField === 0) {
            if (buf.length < 2) return null;
            csid = 64 + buf[1]; basicLen = 2;
        } else if (csidField === 1) {
            if (buf.length < 3) return null;
            csid = 64 + buf[1] + buf[2] * 256; basicLen = 3;
        } else {
            csid = csidField; basicLen = 1;
        }

        const headerLen = [11, 7, 3, 0][fmt];
        if (buf.length < basicLen + headerLen) return null;

        let state = this.streams.get(csid);
        if (!state) {
            state = { timestamp: 0, length: 0, typeId: 0, streamId: 0, payload: null, received: 0 };
            this.streams.set(csid, state);
        }

        let pos = basicLen;
        let timestampField = state.timestamp;
        if (fmt <= 2) {
            timestampField = buf.readUIntBE(pos, 3);
            pos += 3;
        }
        if (fmt <= 1) {
            state.length = buf.readUIntBE(pos, 3);
            state.typeId = buf[pos + 3];
            pos += 4;
        }
        if (fmt === 0) {
            state.streamId = buf.readUInt32LE(pos);
            pos += 4;
        }

        let timestamp = timestampField;
        if (timestampField === 0xFFFFFF) {
            if (buf.length < pos + 4) return null;
            timestamp = buf.readUInt32BE(pos);
            pos += 4;
        }

        if (state.received === 0) {
            state.payload = Buffer.allocUnsafe(state.length);
            state.timestamp = fmt === 0 ? timestamp : state.timestamp + timestamp;
        }

        const remaining = state.length - state.received;
        const take = Math.min(this.chunkSize, remaining);
        if (buf.length < pos + take) return null;
        buf.copy(state.payload, state.received, pos, pos + take);
        state.received += take;
        this.buffer = buf.subarray(pos + take);

        if (state.received < state.length) return { complete: false };
        const message = {
            complete: true,
            csid,
            typeId: state.typeId,
            streamId: state.streamId,
            timestamp: state.timestamp,
            payload: state.payload
        };
        /*
         * Set Chunk Size has to take effect here, not when the consumer gets
         * round to the message. A peer can put it in the same TCP segment as
         * the data that follows, and push() parses a whole buffer in one go, so
         * applying it later would parse the rest at the old size and lose sync.
         */
        if (message.typeId === MSG_SET_CHUNK_SIZE && message.payload.length >= 4) {
            const size = message.payload.readUInt32BE(0) & 0x7FFFFFFF;
            if (size > 0) this.chunkSize = size;
        }
        state.received = 0;
        state.payload = null;
        return message;
    }
}

/* --------------------------------------------------------------- client ---- */

function parseUrl(url) {
    const match = /^(rtmps?):\/\/([^/:]+)(?::(\d+))?\/(.+)$/i.exec(String(url).trim());
    if (!match) throw new Error("not an RTMP url: " + url);
    const secure = match[1].toLowerCase() === "rtmps";
    const app = match[4].replace(/\/+$/, "");
    const scheme = match[1].toLowerCase();
    // tcUrl has to echo the address as given, port included: a server behind a
    // non-default port checks it against the one it is listening on.
    const authority = match[2] + (match[3] ? ":" + match[3] : "");
    return {
        secure,
        host: match[2],
        port: match[3] ? Number(match[3]) : (secure ? 443 : 1935),
        app,
        tcUrl: scheme + "://" + authority + "/" + app
    };
}

class RtmpPublisher extends EventEmitter {
    /*
     * url is the ingest address, e.g. rtmp://a.rtmp.youtube.com/live2, and
     * streamKey is the per-stream secret that becomes the publish name. The key
     * is never logged or emitted: it goes to the socket and nowhere else.
     */
    constructor(options) {
        super();
        const target = parseUrl(options.url);
        this.target = target;
        this.streamKey = String(options.streamKey || "");
        this.chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
        this.socket = null;
        this.reader = new ChunkReader();
        this.state = "idle";
        this.streamId = 0;
        this.transaction = 0;
        this.pending = new Map();
        this.bytesIn = 0;
        this.ackWindow = 2500000;
        this.lastAckSent = 0;
        this.bytesOut = 0;
        this.lastError = null;
        this.connectTimeoutMs = options.connectTimeoutMs || 15000;
    }

    /* Resolves once the server has accepted publish, so a caller can start
     * sending media as soon as it returns. */
    connect() {
        if (this.state !== "idle") return Promise.reject(new Error("already " + this.state));
        this.state = "connecting";

        return new Promise((resolve, reject) => {
            let settled = false;
            const done = (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (err) { this.state = "failed"; this._destroy(); reject(err); }
                else { this.state = "publishing"; resolve(); }
            };
            const timer = setTimeout(
                () => done(new Error("timed out after " + this.connectTimeoutMs + "ms in state " + this.state)),
                this.connectTimeoutMs
            );
            this.once("_publishing", () => done(null));
            this.once("_failed", (err) => done(err));

            const onConnected = () => {
                this.socket.setNoDelay(true);
                this._handshake().catch((err) => this.emit("_failed", err));
            };

            this.socket = this.target.secure
                ? tls.connect({ host: this.target.host, port: this.target.port,
                                servername: this.target.host }, onConnected)
                : net.connect({ host: this.target.host, port: this.target.port }, onConnected);

            this.socket.on("error", (err) => {
                // Before connect() settles, a socket error is that promise's
                // rejection and nothing else: emitting it as well would report
                // the same failure twice.
                if (!settled) return this.emit("_failed", err);
                this._reportError(err);
            });
            this.socket.on("close", () => {
                if (this.state === "publishing") this.state = "closed";
                this.emit("close");
            });
        });
    }

    /*
     * The simple handshake: a version byte and 1536 bytes each way, with C2
     * echoing what the server sent. The digest variant exists for Flash-era
     * servers that verify an HMAC; YouTube does not require it.
     */
    _handshake() {
        return new Promise((resolve, reject) => {
            const c0c1 = Buffer.alloc(1 + HANDSHAKE_SIZE);
            c0c1.writeUInt8(3, 0);                       // protocol version
            c0c1.writeUInt32BE(0, 1);                    // our epoch
            c0c1.writeUInt32BE(0, 5);                    // zero, per spec
            crypto.randomFillSync(c0c1, 9, HANDSHAKE_SIZE - 8);
            this.socket.write(c0c1);

            let got = Buffer.alloc(0);
            const onData = (data) => {
                got = Buffer.concat([got, data]);
                if (got.length < 1 + HANDSHAKE_SIZE * 2) return;
                if (got[0] !== 3) {
                    this.socket.removeListener("data", onData);
                    return reject(new Error("server offered RTMP version " + got[0]));
                }
                const s1 = got.subarray(1, 1 + HANDSHAKE_SIZE);
                this.socket.write(s1);                   // C2 echoes S1
                this.socket.removeListener("data", onData);

                const leftover = got.subarray(1 + HANDSHAKE_SIZE * 2);
                this.state = "handshaken";
                this.socket.on("data", (chunk) => this._onData(chunk));
                if (leftover.length) this._onData(leftover);
                this._sendConnect();
                resolve();
            };
            this.socket.on("data", onData);
        });
    }

    _onData(data) {
        this.bytesIn += data.length;
        // The server asks to be acknowledged every ackWindow bytes.
        if (this.bytesIn - this.lastAckSent >= this.ackWindow) {
            this.lastAckSent = this.bytesIn;
            const payload = Buffer.allocUnsafe(4);
            payload.writeUInt32BE(this.bytesIn >>> 0, 0);
            this._send(CSID_CONTROL, MSG_ACK, 0, 0, payload);
        }

        let messages;
        try {
            messages = this.reader.push(data);
        } catch (err) {
            return this.emit("_failed", new Error("could not parse server data: " + err.message));
        }
        for (const message of messages) this._onMessage(message);
    }

    _onMessage(message) {
        switch (message.typeId) {
            case MSG_SET_CHUNK_SIZE:
                // Already applied by the reader, which has to act on it the
                // moment it parses it. Nothing left to do here.
                return;
            case MSG_WINDOW_ACK_SIZE:
                this.ackWindow = message.payload.readUInt32BE(0) || this.ackWindow;
                return;
            case MSG_SET_PEER_BANDWIDTH:
            case MSG_ACK:
                return;
            case MSG_COMMAND_AMF0:
                return this._onCommand(readAmf0Sequence(message.payload));
            default:
                return;
        }
    }

    _onCommand(args) {
        const name = args[0];
        const transactionId = args[1];

        if (name === "_error") {
            const info = args[3] || args[2] || {};
            return this.emit("_failed",
                new Error("server rejected " + (this.pending.get(transactionId) || "request") +
                          ": " + (info.description || info.code || "no reason given")));
        }
        if (name === "_result") {
            const what = this.pending.get(transactionId);
            this.pending.delete(transactionId);
            if (what === "connect") return this._sendCreateStream();
            if (what === "createStream") {
                this.streamId = typeof args[3] === "number" ? args[3] : 1;
                return this._sendPublish();
            }
            return;
        }
        // publish is confirmed by onStatus, not by _result.
        if (name === "onStatus") {
            const info = args[3] || {};
            this.emit("status", { code: info.code, description: info.description });
            if (info.code === "NetStream.Publish.Start") return this.emit("_publishing");
            if (info.level === "error") {
                return this.emit("_failed",
                    new Error("publish failed: " + (info.code || "unknown") +
                              (info.description ? " - " + info.description : "")));
            }
        }
    }

    _command(csid, streamId, name, args) {
        this.transaction += 1;
        const id = this.transaction;
        this.pending.set(id, name);
        const parts = [amfString(name), amfNumber(id)];
        for (const arg of args) parts.push(amfValue(arg));
        this._send(csid, MSG_COMMAND_AMF0, streamId, 0, Buffer.concat(parts));
        return id;
    }

    _sendConnect() {
        // Our chunk size has to be set before anything large goes out.
        const payload = Buffer.allocUnsafe(4);
        payload.writeUInt32BE(this.chunkSize, 0);
        this._send(CSID_CONTROL, MSG_SET_CHUNK_SIZE, 0, 0, payload);

        this.state = "connecting";
        this._command(CSID_COMMAND, 0, "connect", [{
            app: this.target.app,
            type: "nonprivate",
            flashVer: "FMLE/3.0 (compatible; NoBS)",
            tcUrl: this.target.tcUrl
        }]);
    }

    _sendCreateStream() {
        this.state = "creating-stream";
        this._command(CSID_COMMAND, 0, "createStream", [null]);
    }

    _sendPublish() {
        this.state = "publishing-requested";
        this._command(CSID_COMMAND, this.streamId, "publish", [null, this.streamKey, "live"]);
    }

    /* Describes the stream to the server. Optional, but servers log warnings
     * without it and some players read the dimensions from it. */
    sendMetadata(info) {
        const payload = Buffer.concat([
            amfString("@setDataFrame"),
            amfString("onMetaData"),
            amfEcmaArray({
                duration: 0,
                width: info.width,
                height: info.height,
                videocodecid: 7,                 // AVC
                videodatarate: info.videoBitrate ? info.videoBitrate / 1000 : undefined,
                framerate: info.framerate,
                audiocodecid: 10,                // AAC
                audiodatarate: info.audioBitrate ? info.audioBitrate / 1000 : undefined,
                audiosamplerate: info.audioSampleRate,
                audiosamplesize: 16,
                stereo: info.channels === undefined ? true : info.channels > 1,
                encoder: info.encoder || "NoBS Recorder"
            })
        ]);
        this._send(CSID_DATA, MSG_DATA_AMF0, this.streamId, 0, payload);
    }

    /* body is an FLV tag body from renderer/flv-tag.js, timestamp in ms. */
    sendVideo(timestampMs, body) {
        this._send(CSID_VIDEO, MSG_VIDEO, this.streamId, timestampMs, Buffer.from(body));
    }

    sendAudio(timestampMs, body) {
        this._send(CSID_AUDIO, MSG_AUDIO, this.streamId, timestampMs, Buffer.from(body));
    }

    _send(csid, typeId, streamId, timestamp, payload) {
        if (!this.socket || this.socket.destroyed) return false;
        const chunks = encodeChunks(csid, typeId, streamId, timestamp, payload, this.chunkSize);
        this.bytesOut += chunks.length;
        // Backpressure is the caller's to notice: a full socket buffer during a
        // live stream means frames need dropping, not queueing without limit.
        return this.socket.write(chunks);
    }

    /*
     * Node kills the process on an "error" event with no listener, which during
     * a live stream would be a crash instead of a dropped frame. So an error
     * after connect() has settled is emitted only if someone is listening, and
     * kept on lastError either way.
     */
    _reportError(err) {
        this.lastError = err;
        if (this.listenerCount("error") > 0) this.emit("error", err);
    }

    get bufferedBytes() {
        return this.socket ? this.socket.writableLength : 0;
    }

    close() {
        if (this.state === "publishing") {
            try { this._command(CSID_COMMAND, this.streamId, "FCUnpublish", [null, this.streamKey]); }
            catch (err) { /* going away anyway */ }
        }
        this._destroy();
        this.state = "closed";
    }

    _destroy() {
        if (this.socket) {
            this.socket.removeAllListeners("data");
            this.socket.destroy();
            this.socket = null;
        }
    }
}

module.exports = {
    RtmpPublisher,
    parseUrl,
    encodeChunks,
    ChunkReader,
    amf: {
        string: amfString,
        number: amfNumber,
        boolean: amfBoolean,
        null: amfNull,
        object: amfObject,
        ecmaArray: amfEcmaArray,
        value: amfValue,
        read: readAmf0,
        readSequence: readAmf0Sequence
    }
};
