/*
 * Turns WebCodecs output into FLV, which is what RTMP carries.
 *
 * The two formats already agree, so nothing here rewrites a bitstream. Ask
 * VideoEncoder for avc: { format: "avc" } and it hands over exactly what FLV
 * wants: an AVCDecoderConfigurationRecord in the first chunk's metadata, then
 * length-prefixed NAL units. AudioEncoder with mp4a.40.2 gives an
 * AudioSpecificConfig and raw AAC frames with no ADTS wrapper to strip.
 *
 * Two layers, because RTMP and .flv files need different amounts of it:
 *
 *   body*()  the payload of a tag. RTMP sends these as message types 8 and 9,
 *            taking the timestamp and type from its own message header.
 *   tag()    a body wrapped in the 11-byte FLV tag header plus the trailing
 *            PreviousTagSize, which is what a .flv file is made of. Useful for
 *            dumping a stream to disk and for testing against a real player.
 *
 * Timestamps here are milliseconds from the start of the stream, not the
 * microseconds WebCodecs reports: see Timeline below.
 */
(function (root, factory) {
    if (typeof module !== "undefined" && module.exports) module.exports = factory();
    else root.flvTag = factory();
})(typeof self !== "undefined" ? self : this, function () {

    var TAG_AUDIO = 8;
    var TAG_VIDEO = 9;

    // Video tag byte 0 is FrameType<<4 | CodecID, and CodecID 7 is AVC.
    var KEYFRAME = 0x17;        // FrameType 1, keyframe
    var INTERFRAME = 0x27;      // FrameType 2, inter frame

    // Audio tag byte 0 packs SoundFormat<<4 | SoundRate<<2 | SoundSize<<1 |
    // SoundType. For AAC the spec fixes SoundRate at 3 whatever the real sample
    // rate is - the rate that counts is the one inside the AudioSpecificConfig -
    // so this byte is a constant: format 10 (AAC), rate 3, 16-bit, stereo.
    var AAC_HEADER_BYTE = 0xAF;

    function bytesOf(source) {
        if (source instanceof Uint8Array) return source;
        if (source && source.buffer instanceof ArrayBuffer) {
            return new Uint8Array(source.buffer, source.byteOffset || 0, source.byteLength);
        }
        return new Uint8Array(source);
    }

    function concat(parts) {
        var total = 0, i;
        for (i = 0; i < parts.length; i++) total += parts[i].length;
        var out = new Uint8Array(total), offset = 0;
        for (i = 0; i < parts.length; i++) {
            out.set(parts[i], offset);
            offset += parts[i].length;
        }
        return out;
    }

    function writeU24(out, pos, value) {
        out[pos] = (value >>> 16) & 0xFF;
        out[pos + 1] = (value >>> 8) & 0xFF;
        out[pos + 2] = value & 0xFF;
    }

    function writeU32(out, pos, value) {
        out[pos] = (value >>> 24) & 0xFF;
        out[pos + 1] = (value >>> 16) & 0xFF;
        out[pos + 2] = (value >>> 8) & 0xFF;
        out[pos + 3] = value & 0xFF;
    }

    // The 9-byte file header plus the PreviousTagSize0 that follows it. Only a
    // .flv file needs this; RTMP starts straight in on messages.
    function fileHeader(hasVideo, hasAudio) {
        var out = new Uint8Array(13);
        out[0] = 0x46; out[1] = 0x4C; out[2] = 0x56;    // "FLV"
        out[3] = 1;                                      // version
        out[4] = (hasVideo === false ? 0 : 0x01) | (hasAudio === false ? 0 : 0x04);
        writeU32(out, 5, 9);                             // header length
        writeU32(out, 9, 0);                             // PreviousTagSize0
        return out;
    }

    // A tag is header + body + the size of what just went past, which is how a
    // reader walks an .flv backwards.
    function tag(type, timestampMs, body) {
        body = bytesOf(body);
        var ms = Math.max(0, Math.round(timestampMs));
        var out = new Uint8Array(11 + body.length + 4);
        out[0] = type;
        writeU24(out, 1, body.length);
        // A 24-bit field plus a separate high byte, in that order: the extended
        // byte is the most significant one even though it is written last.
        writeU24(out, 4, ms & 0xFFFFFF);
        out[7] = (ms / 16777216) & 0xFF;
        writeU24(out, 8, 0);                             // StreamID, always 0
        out.set(body, 11);
        writeU32(out, 11 + body.length, 11 + body.length);
        return out;
    }

    // The decoder configuration, sent once before any picture and again after
    // any change of resolution or profile.
    function videoSequenceHeader(avcDescription) {
        var avcc = bytesOf(avcDescription);
        var out = new Uint8Array(5 + avcc.length);
        out[0] = KEYFRAME;                               // a config record counts as a keyframe
        out[1] = 0;                                      // AVCPacketType: sequence header
        writeU24(out, 2, 0);                             // CompositionTime, unused here
        out.set(avcc, 5);
        return out;
    }

    /*
     * One encoded picture.
     *
     * compositionTimeMs is PTS minus DTS, which only matters where the encoder
     * reorders pictures. WebCodecs reports a single timestamp and no DTS, so a
     * caller has nothing to compute it from; with latencyMode "realtime" the
     * encoder does not emit B-frames and the offset is genuinely 0. It stays a
     * parameter so a caller that does know better can say so.
     */
    function videoBody(data, isKeyframe, compositionTimeMs) {
        var nals = bytesOf(data);
        var out = new Uint8Array(5 + nals.length);
        out[0] = isKeyframe ? KEYFRAME : INTERFRAME;
        out[1] = 1;                                      // AVCPacketType: NALU
        var cts = Math.round(compositionTimeMs || 0);
        writeU24(out, 2, cts < 0 ? (cts + 0x1000000) & 0xFFFFFF : cts & 0xFFFFFF);
        out.set(nals, 5);
        return out;
    }

    // Tells a decoder the stream has finished. Carries no picture.
    function videoEndOfSequence() {
        var out = new Uint8Array(5);
        out[0] = KEYFRAME;
        out[1] = 2;                                      // AVCPacketType: end of sequence
        writeU24(out, 2, 0);
        return out;
    }

    function audioSequenceHeader(audioSpecificConfig) {
        var asc = bytesOf(audioSpecificConfig);
        var out = new Uint8Array(2 + asc.length);
        out[0] = AAC_HEADER_BYTE;
        out[1] = 0;                                      // AACPacketType: sequence header
        out.set(asc, 2);
        return out;
    }

    function audioBody(data) {
        var aac = bytesOf(data);
        var out = new Uint8Array(2 + aac.length);
        out[0] = AAC_HEADER_BYTE;
        out[1] = 1;                                      // AACPacketType: raw frame
        out.set(aac, 2);
        return out;
    }

    /*
     * Timeline
     *
     * WebCodecs counts microseconds from whenever the encoder was started; FLV
     * and RTMP count milliseconds from the start of the stream. Feeding the raw
     * encoder timestamps to a server would therefore start the stream at some
     * arbitrary offset, which players read as a very long seek.
     *
     * So the first chunk through here defines zero and everything after it is
     * measured from that. Audio and video must share one of these or they drift
     * apart.
     */
    function timeline() {
        var origin = null;
        return {
            ms: function (timestampMicros) {
                if (origin === null) origin = timestampMicros;
                var ms = (timestampMicros - origin) / 1000;
                return ms < 0 ? 0 : ms;
            },
            started: function () { return origin !== null; },
            reset: function () { origin = null; }
        };
    }

    return {
        TAG_AUDIO: TAG_AUDIO,
        TAG_VIDEO: TAG_VIDEO,
        fileHeader: fileHeader,
        tag: tag,
        videoSequenceHeader: videoSequenceHeader,
        videoBody: videoBody,
        videoEndOfSequence: videoEndOfSequence,
        audioSequenceHeader: audioSequenceHeader,
        audioBody: audioBody,
        timeline: timeline,
        concat: concat
    };
});
