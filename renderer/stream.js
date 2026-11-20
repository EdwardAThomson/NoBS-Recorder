/*
 * Live streaming: encodes the mix canvas and the audio graph, and hands FLV tag
 * bodies to the main process, which owns the RTMP socket.
 *
 * Where recording hands a MediaStream to MediaRecorder and gets a file, this
 * drives WebCodecs directly, because streaming needs two things MediaRecorder
 * will not give: keyframes on demand, so a viewer joining mid-stream can decode
 * within a couple of seconds, and H.264 Main profile, which is what hardware
 * encoders implement. The audio path is untouched - the same getUserMedia and
 * the same gain-and-limiter graph recording uses - so a microphone that behaves
 * while recording behaves while streaming.
 *
 * Video frames come from the draw loop that was already painting the canvas, so
 * there is no second capture. Audio is read off the AudioContext's destination
 * with a MediaStreamTrackProcessor.
 *
 * Degrades the way the rest of the app does: anything unexpected stops the
 * stream and reports why, rather than leaving a half-running encoder behind.
 */
(function (root) {
    "use strict";

    // Main profile, level 4.1. Baseline has no hardware encoder on much of the
    // hardware people actually own, and High buys little at these bitrates.
    var VIDEO_CODEC = "avc1.4d0028";
    var AUDIO_CODEC = "mp4a.40.2";

    // A viewer who joins cannot see anything until the next keyframe, so this is
    // the worst-case wait to first picture. YouTube asks for 2s and allows 4.
    var KEYFRAME_INTERVAL_MS = 2000;

    // Frames waiting on the encoder. Past this the encoder is behind realtime
    // and the honest thing is to drop a frame rather than add latency that never
    // comes back.
    var MAX_QUEUED_FRAMES = 6;

    // Bytes sitting in the socket. Past this the network is behind, and again
    // dropping beats queueing: a live stream has nowhere to catch up to.
    var MAX_SOCKET_BACKLOG = 2 * 1024 * 1024;

    var flv = root.flvTag;

    var state = {
        live: false,
        starting: false,
        videoEncoder: null,
        audioEncoder: null,
        audioReader: null,
        timeline: null,
        sentVideoHeader: false,
        sentAudioHeader: false,
        sentMetadata: false,
        lastKeyframeMs: -Infinity,
        lastFrameMs: -Infinity,
        frameIntervalMs: 0,
        // Audio and video arrive on different clocks: AudioData counts samples
        // from when the context started, while a canvas frame is stamped off the
        // wall clock. Anchoring the audio clock to the wall clock once, on the
        // first frame that arrives, puts both on one timeline.
        audioClockOffsetUs: null,
        audioOffsetMs: 0,
        socketBacklog: 0,
        stats: { framesSent: 0, framesDropped: 0, audioSent: 0, bytesSent: 0, keyframes: 0 },
        onStatus: null,
        config: null
    };

    function report(message, fatal) {
        if (state.onStatus) state.onStatus({ message: message, fatal: !!fatal, stats: statsCopy() });
    }

    function statsCopy() {
        var s = state.stats;
        return { framesSent: s.framesSent, framesDropped: s.framesDropped,
                 audioSent: s.audioSent, bytesSent: s.bytesSent, keyframes: s.keyframes,
                 socketBacklog: state.socketBacklog };
    }

    function send(kind, timestampMs, body) {
        state.stats.bytesSent += body.length;
        // A copy, because the body is a view on a buffer we are about to reuse
        // and IPC hands the bytes over asynchronously.
        root.api.streamSend(kind, timestampMs, body.slice().buffer);
    }

    function onVideoChunk(chunk, metadata) {
        if (!state.live) return;
        try {
            if (!state.sentMetadata) {
                state.sentMetadata = true;
                root.api.streamMetadata({
                    width: state.config.width,
                    height: state.config.height,
                    framerate: state.config.fps,
                    videoBitrate: state.config.videoBitrate,
                    audioBitrate: state.config.audioBitrate,
                    audioSampleRate: state.config.audioSampleRate,
                    channels: state.config.channels
                });
            }
            // The decoder configuration has to precede the first picture, and it
            // only arrives attached to a chunk, so it is sent from here.
            if (!state.sentVideoHeader && metadata && metadata.decoderConfig &&
                metadata.decoderConfig.description) {
                state.sentVideoHeader = true;
                send("video", 0, flv.videoSequenceHeader(
                    new Uint8Array(metadata.decoderConfig.description)));
            }
            if (!state.sentVideoHeader) return;   // nothing can decode this yet

            var data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            var ms = state.timeline.ms(chunk.timestamp);
            send("video", ms, flv.videoBody(data, chunk.type === "key", 0));
            state.stats.framesSent++;
            if (chunk.type === "key") state.stats.keyframes++;
        } catch (err) {
            stop("video packaging failed: " + err.message, true);
        }
    }

    function onAudioChunk(chunk, metadata) {
        if (!state.live) return;
        try {
            if (!state.sentAudioHeader && metadata && metadata.decoderConfig &&
                metadata.decoderConfig.description) {
                state.sentAudioHeader = true;
                send("audio", 0, flv.audioSequenceHeader(
                    new Uint8Array(metadata.decoderConfig.description)));
            }
            if (!state.sentAudioHeader) return;

            var data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            var us = chunk.timestamp + (state.audioClockOffsetUs || 0);
            var ms = state.timeline.ms(us) + state.audioOffsetMs;
            send("audio", ms < 0 ? 0 : ms, flv.audioBody(data));
            state.stats.audioSent++;
        } catch (err) {
            stop("audio packaging failed: " + err.message, true);
        }
    }

    // Pulls AudioData off the graph for as long as the stream is live. Runs
    // detached: the stream does not wait on it, and it ends when the reader is
    // cancelled by stop().
    async function pumpAudio(track) {
        var processor;
        try {
            processor = new MediaStreamTrackProcessor({ track: track });
        } catch (err) {
            report("no audio: " + err.message, false);
            return;
        }
        var reader = processor.readable.getReader();
        state.audioReader = reader;
        try {
            for (;;) {
                var result = await reader.read();
                if (result.done || !state.live) break;
                var frame = result.value;
                if (!frame) continue;
                if (state.audioClockOffsetUs === null) {
                    // Anchor the audio clock to the wall clock, once.
                    state.audioClockOffsetUs = performance.now() * 1000 - frame.timestamp;
                }
                try {
                    if (state.audioEncoder && state.audioEncoder.state === "configured") {
                        state.audioEncoder.encode(frame);
                    }
                } finally {
                    frame.close();
                }
            }
        } catch (err) {
            if (state.live) report("audio tap stopped: " + err.message, false);
        } finally {
            try { reader.releaseLock(); } catch (e) { /* already gone */ }
            if (state.audioReader === reader) state.audioReader = null;
        }
    }

    var api = {
        isLive: function () { return state.live; },

        stats: statsCopy,

        // Main tells us how much is waiting in the socket, so pushFrame can
        // decide to drop rather than pile on.
        setSocketBacklog: function (bytes) {
            state.socketBacklog = bytes || 0;
        },

        /*
         * Opens the connection and configures the encoders. Resolves once the
         * server has accepted publish, so the caller can start pushing frames
         * the moment it returns.
         */
        start: async function (config) {
            if (state.live || state.starting) throw new Error("already streaming");
            if (!flv) throw new Error("flv-tag.js is not loaded");
            if (typeof VideoEncoder === "undefined") throw new Error("WebCodecs is unavailable");

            state.starting = true;
            state.config = config;
            state.onStatus = config.onStatus || null;
            state.audioOffsetMs = config.audioOffsetMs || 0;

            try {
                var support = await VideoEncoder.isConfigSupported({
                    codec: VIDEO_CODEC, width: config.width, height: config.height,
                    bitrate: config.videoBitrate, framerate: config.fps,
                    latencyMode: "realtime", avc: { format: "avc" }
                });
                if (!support || !support.supported) {
                    throw new Error("this machine cannot encode H.264 at " +
                                    config.width + "x" + config.height);
                }

                report("connecting...");
                await root.api.streamConnect({ url: config.url, streamKey: config.streamKey });

                state.timeline = flv.timeline();
                state.sentVideoHeader = false;
                state.sentAudioHeader = false;
                state.sentMetadata = false;
                state.lastKeyframeMs = -Infinity;
                state.lastFrameMs = -Infinity;
                // The draw loop runs at the display's refresh rate, which on a
                // 144Hz panel is nearly five times the frame rate the encoder
                // was configured for. Pacing here keeps the stream at the rate
                // it claims in its metadata instead of overshooting the bitrate.
                state.frameIntervalMs = 1000 / Math.max(1, config.fps || 30);
                state.audioClockOffsetUs = null;
                state.stats = { framesSent: 0, framesDropped: 0, audioSent: 0,
                                bytesSent: 0, keyframes: 0 };

                state.videoEncoder = new VideoEncoder({
                    output: onVideoChunk,
                    error: function (err) { stop("video encoder failed: " + err.message, true); }
                });
                state.videoEncoder.configure({
                    codec: VIDEO_CODEC, width: config.width, height: config.height,
                    bitrate: config.videoBitrate, framerate: config.fps,
                    latencyMode: "realtime", avc: { format: "avc" }
                });

                if (config.audioTrack && typeof AudioEncoder !== "undefined") {
                    state.audioEncoder = new AudioEncoder({
                        output: onAudioChunk,
                        error: function (err) { report("audio encoder failed: " + err.message, false); }
                    });
                    state.audioEncoder.configure({
                        codec: AUDIO_CODEC,
                        sampleRate: config.audioSampleRate || 48000,
                        numberOfChannels: config.channels || 2,
                        bitrate: config.audioBitrate || 128000
                    });
                }

                state.live = true;
                state.starting = false;
                if (config.audioTrack) pumpAudio(config.audioTrack);
                report("live");
                return true;
            } catch (err) {
                state.starting = false;
                await teardown();
                throw err;
            }
        },

        /*
         * Called once per painted frame. nowMs is the wall clock at the moment
         * the canvas was drawn; the encoder wants microseconds.
         *
         * Drops rather than queues when the encoder or the socket is behind.
         * Latency added to a live stream is never recovered, so a dropped frame
         * costs less than a growing backlog.
         */
        pushFrame: function (canvas, nowMs) {
            if (!state.live || !state.videoEncoder) return false;
            if (state.videoEncoder.state !== "configured") return false;
            // Pace to the configured frame rate. A little tolerance, because
            // a frame arriving a hair early should be kept rather than skipped
            // and waited a whole interval for.
            if (nowMs - state.lastFrameMs < state.frameIntervalMs * 0.92) return false;

            if (state.videoEncoder.encodeQueueSize > MAX_QUEUED_FRAMES ||
                state.socketBacklog > MAX_SOCKET_BACKLOG) {
                state.stats.framesDropped++;
                return false;
            }
            var frame = null;
            try {
                frame = new VideoFrame(canvas, { timestamp: Math.round(nowMs * 1000) });
                // A viewer can only start decoding at a keyframe, so one is
                // forced on schedule regardless of what the encoder would pick.
                state.lastFrameMs = nowMs;
                var keyFrame = (nowMs - state.lastKeyframeMs) >= KEYFRAME_INTERVAL_MS;
                if (keyFrame) state.lastKeyframeMs = nowMs;
                state.videoEncoder.encode(frame, { keyFrame: keyFrame });
                return true;
            } catch (err) {
                stop("could not encode a frame: " + err.message, true);
                return false;
            } finally {
                if (frame) frame.close();
            }
        },

        stop: function (reason) { return stop(reason || "stopped", false); }
    };

    async function teardown() {
        var reader = state.audioReader;
        state.audioReader = null;
        if (reader) { try { await reader.cancel(); } catch (e) { /* already gone */ } }

        if (state.audioEncoder) {
            try { if (state.audioEncoder.state === "configured") await state.audioEncoder.flush(); }
            catch (e) { /* nothing to be done about it now */ }
            try { state.audioEncoder.close(); } catch (e) { /* already closed */ }
            state.audioEncoder = null;
        }
        if (state.videoEncoder) {
            try { if (state.videoEncoder.state === "configured") await state.videoEncoder.flush(); }
            catch (e) { /* nothing to be done about it now */ }
            try { state.videoEncoder.close(); } catch (e) { /* already closed */ }
            state.videoEncoder = null;
        }
        try { await root.api.streamStop(); } catch (e) { /* socket may already be gone */ }
        state.timeline = null;
    }

    async function stop(reason, fatal) {
        if (!state.live && !state.starting) return false;
        state.live = false;
        await teardown();
        report(reason, fatal);
        return true;
    }

    root.liveStream = api;
})(typeof self !== "undefined" ? self : this);
