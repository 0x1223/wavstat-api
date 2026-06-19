#include "NetworkTransmitter.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <cmath>
#include <mutex>
#include <string>

#include <rtc/rtc.hpp>

#include <opus.h>

#if JUCE_WINDOWS
 #include <winsock2.h>
 #include <ws2tcpip.h>
 #include <iphlpapi.h>
#else
 #include <arpa/inet.h>
 #include <fcntl.h>
 #include <ifaddrs.h>
 #include <net/if.h>
 #include <unistd.h>
#endif

static_assert (AudioFifoWorker::targetSampleRate == 48000,
               "Kingz Listen native transmitter must stream 48 kHz PCM without resampling.");
static_assert (AudioFifoWorker::inputChannels == 2,
               "Kingz Listen native transmitter must stream stereo PCM.");
static_assert (AudioFifoWorker::bytesPerChunk == 960,
               "Kingz Listen native transmitter must stream 5 ms chunks of 16-bit stereo PCM.");
static_assert (AudioFifoWorker::maxBytesPerChunk == 3840,
               "Kingz Listen adaptive transmitter supports up to 20 ms PCM chunks.");
static_assert (AudioFifoWorker::telemetryBitrateBitsPerSecond == 1536000,
               "Kingz Listen native transmitter must preserve the 1536 kbps Linear PCM baseline.");

// Opus encode/resample state for the audio-track transport (declared as a nested type of
// NetworkTransmitter, defined out-of-line here). Owned by NetworkTransmitter, touched ONLY on the
// PcmSenderThread (under clientLock). Resamples the DAW-rate Int16 stream to 48 kHz float (streaming
// linear interpolation — adequate since Opus is lossy and the receiver's NetEq absorbs residual
// rate error), frames to 20 ms blocks, and Opus-encodes once per frame; the caller fans each encoded
// frame out to every client with an open send-only Opus track.
struct NetworkTransmitter::OpusEncodeState
{
    static constexpr int kOutRate      = 48000;
    static constexpr int kChannels     = 2;
    static constexpr int kFrameSamples = 960;                       // 20 ms @ 48 kHz, per channel
    static constexpr int kFrameFloats  = kFrameSamples * kChannels;

    OpusEncoder* encoder = nullptr;
    int encoderError = OPUS_OK;

    // streaming linear resampler state (interleaved stereo, srcRate -> 48 kHz)
    double cursor = 0.0;            // fractional input-frame index of the next output, from chunk start
    float carryL = 0.0f, carryR = 0.0f;  // previous chunk's final frame (index -1 for interpolation)
    bool haveCarry = false;

    std::vector<float> accum;       // resampled interleaved float @ 48 kHz awaiting framing
    std::vector<float> scratch;     // current input chunk as interleaved float
    std::array<unsigned char, 4000> packet {};

    OpusEncodeState()
    {
        encoder = opus_encoder_create (kOutRate, kChannels, OPUS_APPLICATION_RESTRICTED_LOWDELAY, &encoderError);
        if (encoder != nullptr)
        {
            opus_encoder_ctl (encoder, OPUS_SET_BITRATE (256000));
            opus_encoder_ctl (encoder, OPUS_SET_SIGNAL (OPUS_SIGNAL_MUSIC));
            opus_encoder_ctl (encoder, OPUS_SET_VBR (1));
        }
        accum.reserve (static_cast<std::size_t> (kFrameFloats) * 4);
    }

    ~OpusEncodeState()
    {
        if (encoder != nullptr)
            opus_encoder_destroy (encoder);
    }

    OpusEncodeState (const OpusEncodeState&) = delete;
    OpusEncodeState& operator= (const OpusEncodeState&) = delete;

    // Feed one DAW-rate Int16 LE stereo chunk; invoke sendFrame(data,len) for each 20 ms Opus frame.
    template <typename SendFrame>
    void process (const std::byte* bytes, std::size_t byteCount, int srcRate, SendFrame&& sendFrame)
    {
        if (encoder == nullptr || srcRate <= 0)
            return;

        const int inFrames = static_cast<int> (byteCount / (kChannels * sizeof (std::int16_t)));
        if (inFrames <= 0)
            return;

        scratch.resize (static_cast<std::size_t> (inFrames * kChannels));
        const auto* pcm = reinterpret_cast<const std::int16_t*> (bytes);
        for (int i = 0; i < inFrames * kChannels; ++i)
            scratch[static_cast<std::size_t> (i)] = static_cast<float> (pcm[i]) * (1.0f / 32768.0f);

        const double step = static_cast<double> (srcRate) / static_cast<double> (kOutRate);
        const float* in = scratch.data();
        const auto sampleL = [&] (int idx) { return idx < 0 ? carryL : in[2 * idx]; };
        const auto sampleR = [&] (int idx) { return idx < 0 ? carryR : in[2 * idx + 1]; };

        if (! haveCarry)
            cursor = 0.0;

        for (;;)
        {
            const int i0 = static_cast<int> (std::floor (cursor));
            const int i1 = i0 + 1;
            if (i1 > inFrames - 1)
                break;
            const float frac = static_cast<float> (cursor - i0);
            accum.push_back (sampleL (i0) * (1.0f - frac) + sampleL (i1) * frac);
            accum.push_back (sampleR (i0) * (1.0f - frac) + sampleR (i1) * frac);
            cursor += step;
        }

        carryL = in[2 * (inFrames - 1)];
        carryR = in[2 * (inFrames - 1) + 1];
        haveCarry = true;
        cursor -= inFrames;                 // rebase: this chunk's last frame becomes index -1 next call
        if (cursor < -1.0)
            cursor = -1.0;

        while (accum.size() >= static_cast<std::size_t> (kFrameFloats))
        {
            const auto encoded = opus_encode_float (encoder, accum.data(), kFrameSamples,
                                                    packet.data(), static_cast<opus_int32> (packet.size()));
            if (encoded > 0)
                sendFrame (reinterpret_cast<const std::byte*> (packet.data()),
                           static_cast<std::size_t> (encoded));
            accum.erase (accum.begin(), accum.begin() + kFrameFloats);
        }
    }
};

namespace
{
constexpr auto websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
constexpr auto KINGZ_LISTEN_PLUGIN = "KINGZ_LISTEN_PLUGIN";

// --- Opus audio-track transport (low-latency mode) ---
// When the receiver selects the Opus transport it offers a recv-only m=audio line; the plugin
// answers with a send-only Opus track identified by these in the answer SDP / RTP stream.
constexpr int opusPayloadType = 111;                  // dynamic RTP payload type for Opus
constexpr std::uint32_t opusTrackSsrc = 0x4B5A4C69u;  // "KZLi" — stable SSRC for the Opus track

// Extract the mid of the offer's m=audio section so the answer's audio m-line matches it
// (m-line/mid agreement is what makes the answer acceptable — same discipline as the data channel).
// Returns empty when the offer has no audio section (PCM mode → no Opus track added).
juce::String extractOfferAudioMid (const juce::String& sdp)
{
    bool inAudioSection = false;
    for (auto& line : juce::StringArray::fromLines (sdp))
    {
        if (line.startsWith ("m="))
            inAudioSection = line.startsWith ("m=audio");
        else if (inAudioSection && line.startsWith ("a=mid:"))
            return line.fromFirstOccurrenceOf ("a=mid:", false, false).trim();
    }
    return {};
}

juce::String base64Encode (const std::array<std::uint8_t, 20>& input)
{
    static constexpr char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    juce::String output;

    for (std::size_t i = 0; i < input.size(); i += 3)
    {
        const auto remaining = input.size() - i;
        const auto octetA = input[i];
        const auto octetB = remaining > 1 ? input[i + 1] : 0;
        const auto octetC = remaining > 2 ? input[i + 2] : 0;
        const auto triple = (static_cast<std::uint32_t> (octetA) << 16u)
                          | (static_cast<std::uint32_t> (octetB) << 8u)
                          | static_cast<std::uint32_t> (octetC);

        output << alphabet[(triple >> 18u) & 0x3fu]
               << alphabet[(triple >> 12u) & 0x3fu]
               << (remaining > 1 ? alphabet[(triple >> 6u) & 0x3fu] : '=')
               << (remaining > 2 ? alphabet[triple & 0x3fu] : '=');
    }

    return output;
}

std::array<std::uint8_t, 20> sha1Digest (const juce::String& input)
{
    auto bytes = input.toRawUTF8();
    auto byteCount = static_cast<std::size_t> (input.getNumBytesAsUTF8());

    std::vector<std::uint8_t> data (bytes, bytes + byteCount);
    const auto bitLength = static_cast<std::uint64_t> (data.size()) * 8u;
    data.push_back (0x80);

    while ((data.size() % 64u) != 56u)
        data.push_back (0);

    for (auto shift = 56; shift >= 0; shift -= 8)
        data.push_back (static_cast<std::uint8_t> ((bitLength >> static_cast<unsigned> (shift)) & 0xffu));

    std::uint32_t h0 = 0x67452301u;
    std::uint32_t h1 = 0xefcdab89u;
    std::uint32_t h2 = 0x98badcfeu;
    std::uint32_t h3 = 0x10325476u;
    std::uint32_t h4 = 0xc3d2e1f0u;

    auto rotateLeft = [] (std::uint32_t value, int bits)
    {
        return (value << bits) | (value >> (32 - bits));
    };

    for (std::size_t chunk = 0; chunk < data.size(); chunk += 64)
    {
        std::array<std::uint32_t, 80> w {};

        for (auto i = 0; i < 16; ++i)
        {
            const auto offset = chunk + static_cast<std::size_t> (i * 4);
            w[static_cast<std::size_t> (i)] =
                (static_cast<std::uint32_t> (data[offset]) << 24u)
              | (static_cast<std::uint32_t> (data[offset + 1]) << 16u)
              | (static_cast<std::uint32_t> (data[offset + 2]) << 8u)
              | static_cast<std::uint32_t> (data[offset + 3]);
        }

        for (auto i = 16; i < 80; ++i)
            w[static_cast<std::size_t> (i)] = rotateLeft (w[static_cast<std::size_t> (i - 3)]
                                                        ^ w[static_cast<std::size_t> (i - 8)]
                                                        ^ w[static_cast<std::size_t> (i - 14)]
                                                        ^ w[static_cast<std::size_t> (i - 16)],
                                                        1);

        auto a = h0;
        auto b = h1;
        auto c = h2;
        auto d = h3;
        auto e = h4;

        for (auto i = 0; i < 80; ++i)
        {
            std::uint32_t f = 0;
            std::uint32_t k = 0;

            if (i < 20)
            {
                f = (b & c) | (~b & d);
                k = 0x5a827999u;
            }
            else if (i < 40)
            {
                f = b ^ c ^ d;
                k = 0x6ed9eba1u;
            }
            else if (i < 60)
            {
                f = (b & c) | (b & d) | (c & d);
                k = 0x8f1bbcdcu;
            }
            else
            {
                f = b ^ c ^ d;
                k = 0xca62c1d6u;
            }

            const auto temp = rotateLeft (a, 5) + f + e + k + w[static_cast<std::size_t> (i)];
            e = d;
            d = c;
            c = rotateLeft (b, 30);
            b = a;
            a = temp;
        }

        h0 += a;
        h1 += b;
        h2 += c;
        h3 += d;
        h4 += e;
    }

    std::array<std::uint8_t, 20> digest {};
    const std::array<std::uint32_t, 5> words { h0, h1, h2, h3, h4 };
    for (std::size_t i = 0; i < words.size(); ++i)
    {
        digest[i * 4] = static_cast<std::uint8_t> ((words[i] >> 24u) & 0xffu);
        digest[i * 4 + 1] = static_cast<std::uint8_t> ((words[i] >> 16u) & 0xffu);
        digest[i * 4 + 2] = static_cast<std::uint8_t> ((words[i] >> 8u) & 0xffu);
        digest[i * 4 + 3] = static_cast<std::uint8_t> (words[i] & 0xffu);
    }

    return digest;
}

bool isPrivateLanAddress (const juce::String& address)
{
    return address.startsWith ("10.")
        || address.startsWith ("192.168.")
        || address.startsWith ("172.16.")
        || address.startsWith ("172.17.")
        || address.startsWith ("172.18.")
        || address.startsWith ("172.19.")
        || address.startsWith ("172.20.")
        || address.startsWith ("172.21.")
        || address.startsWith ("172.22.")
        || address.startsWith ("172.23.")
        || address.startsWith ("172.24.")
        || address.startsWith ("172.25.")
        || address.startsWith ("172.26.")
        || address.startsWith ("172.27.")
        || address.startsWith ("172.28.")
        || address.startsWith ("172.29.")
        || address.startsWith ("172.30.")
        || address.startsWith ("172.31.");
}

bool isUsableIpv4Address (const juce::String& address)
{
    return address.isNotEmpty()
        && ! address.startsWith ("127.")
        && ! address.startsWith ("169.254.");
}

std::vector<std::uint8_t> toExactUtf8Bytes (const juce::String& text)
{
    const auto* utf8 = text.toRawUTF8();
    const auto byteCount = std::strlen (utf8);
    return { reinterpret_cast<const std::uint8_t*> (utf8),
             reinterpret_cast<const std::uint8_t*> (utf8) + byteCount };
}

std::size_t exactUtf8ByteCount (const juce::String& text)
{
    return std::strlen (text.toRawUTF8());
}

juce::String withKingzListenSourceId (const juce::String& json)
{
    auto parsed = juce::JSON::parse (json);
    if (auto* object = parsed.getDynamicObject())
    {
        object->setProperty ("source_id", KINGZ_LISTEN_PLUGIN);
        return juce::JSON::toString (parsed, true);
    }

    auto* wrapper = new juce::DynamicObject();
    wrapper->setProperty ("source_id", KINGZ_LISTEN_PLUGIN);
    wrapper->setProperty ("payload", json);
    return juce::JSON::toString (juce::var (wrapper), true);
}

juce::String getWebUiCss()
{
    return R"CSS(*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--gold:#c9a227;--gold-dim:rgba(201,162,39,0.25);--gold-border:rgba(201,162,39,0.35);--bg:#0a0a0a;--card:#111;--text:#fff;--muted:#888;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:dark}
body{background:var(--bg);color:var(--text);min-height:100vh;padding:20px 16px 32px;max-width:420px;margin:0 auto}
.page-label{font-size:11px;font-weight:700;letter-spacing:.12em;color:var(--gold);text-transform:uppercase;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--gold-border);border-radius:16px;padding:18px;margin-bottom:14px}
.card-label{font-size:10px;font-weight:700;letter-spacing:.14em;color:var(--gold);text-transform:uppercase;margin-bottom:12px}
.row{display:flex;gap:10px;align-items:stretch}
.field{flex:1}
.field label{display:block;font-size:11px;color:var(--muted);margin-bottom:6px}
.field input{width:100%;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:12px;color:#fff;font:inherit;font-size:15px;outline:none;-webkit-appearance:none}
.field input:focus{border-color:var(--gold)}
.field.port{flex:0 0 90px}
.btn-row{display:flex;gap:10px;margin-top:12px}
.btn{flex:1;border:none;border-radius:10px;padding:14px;font:inherit;font-size:15px;font-weight:700;cursor:pointer;transition:opacity .15s}
.btn:active{opacity:.75}
.btn-primary{background:var(--gold);color:#000}
.btn-secondary{background:#1e1e1e;color:#fff;border:1px solid #333}
.btn:disabled{opacity:.4;cursor:default}
.session-name{font-size:26px;font-weight:800;margin:4px 0 2px}
.session-sub{font-size:13px;color:var(--muted);margin-bottom:14px}
.stats{display:flex;gap:8px}
.stat{flex:1;background:#1a1a1a;border-radius:10px;padding:10px 8px;text-align:center}
.stat-label{font-size:10px;color:var(--muted);margin-bottom:4px}
.stat-value{font-size:13px;font-weight:700;color:var(--gold)}
.mode-row{display:flex;gap:8px}
.mode-btn{flex:1;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:12px 6px;font:inherit;font-size:13px;font-weight:600;color:var(--muted);cursor:pointer;transition:all .15s;-webkit-appearance:none}
.mode-btn.active{background:var(--gold-dim);border-color:var(--gold);color:var(--gold)}
.monitor-center{text-align:center;padding:8px 0 16px}
.monitor-btn{width:110px;height:110px;border-radius:50%;background:linear-gradient(145deg,#d4a820,#a07c10);border:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 0 30px rgba(201,162,39,0.3);transition:box-shadow .2s,transform .1s;-webkit-appearance:none}
.monitor-btn:active{transform:scale(.96)}
.monitor-btn.inactive{background:linear-gradient(145deg,#2a2a2a,#1a1a1a);box-shadow:none}
.monitor-btn svg{width:44px;height:44px}
.ctrl-row{display:flex;gap:10px;margin-top:14px}
.vol-row{display:flex;align-items:center;gap:10px;margin-top:14px}
.vol-icon{font-size:18px;color:var(--muted)}
.vol-slider{flex:1;-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;background:#2a2a2a;outline:none}
.vol-slider::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:var(--gold);cursor:pointer}
.status-bar{background:#111;border:1px solid var(--gold-border);border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:10px;margin-bottom:12px}
.status-dot{width:9px;height:9px;border-radius:50%;background:#333;flex-shrink:0;transition:background .3s}
.status-dot.live{background:var(--gold);box-shadow:0 0 6px var(--gold)}
.status-text{font-size:14px;font-weight:600}
.footer-note{text-align:center;font-size:12px;color:#444;margin-top:4px})CSS";
}

juce::String getWebUiJs()
{
    return R"JS(var host = window.location.hostname || "";
var port = window.location.port || "8082";
document.getElementById("ip-input").value   = host;
document.getElementById("port-input").value = port;

var socket        = null;
var peerConn      = null;
var dataChannel   = null;
var audioCtx      = null;
var gainNode      = null;
var mediaDest     = null;
var mediaAudio    = null;
var streamName    = "Kingz Listen";  // inherited from the plugin via {type:"stream.name"}
var nextPlayTime  = 0;
var muted         = false;
var stopped       = false;
var connected     = false;
var wantConnected = false;
var lastHost      = "";
var lastPort      = "";
var durationSecs  = 0;
var durationTimer = null;
var signalId      = "";
var pcmSampleRate = 48000;
var bufferAhead   = 0.06;
var maxLead       = 0.16;
var minLead       = 0.012;
var underruns     = 0;
var droppedChunks = 0;
var scheduledSources = [];
var pendingCandidates = [];
var lastHiddenAt = 0;
var restoreInFlight = false;

function tryParse(s){ try{ return JSON.parse(s); }catch(_){ return null; } }

function setStatus(txt, live){
  document.getElementById("status-text").textContent = txt;
  document.getElementById("status-dot").className = "status-dot" + (live ? " live" : "");
}

function showCards(show){
  ["session-card","mode-card","monitor-card"].forEach(function(id){
    document.getElementById(id).style.display = show ? "block" : "none";
  });
}

function startDuration(){
  durationSecs = 0;
  if(durationTimer) clearInterval(durationTimer);
  durationTimer = setInterval(function(){
    durationSecs++;
    var m = Math.floor(durationSecs/60), s = durationSecs%60;
    document.getElementById("stat-duration").textContent =
      m + ":" + (s < 10 ? "0" : "") + s;
  }, 1000);
}
function stopDuration(){
  if(durationTimer){ clearInterval(durationTimer); durationTimer = null; }
  document.getElementById("stat-duration").textContent = "0:00";
}

function configureMediaSession(){
  if(!("mediaSession" in navigator)) return;
  try{
    navigator.mediaSession.metadata = new MediaMetadata({
      title: streamName,
      artist:"LAN Audio Receiver",
      album:"Studio Session"
    });
    navigator.mediaSession.playbackState = stopped ? "paused" : "playing";
    navigator.mediaSession.setActionHandler("play", function(){
      stopped = false;
      ensureAudio();
      if(mediaAudio && mediaAudio.paused) mediaAudio.play().catch(function(){});
      if(audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(function(){});
      document.getElementById("stop-btn").innerHTML = "&#9644; Stop";
    });
    navigator.mediaSession.setActionHandler("pause", function(){
      stopped = true;
      stopScheduledSources();
      if(mediaAudio) mediaAudio.pause();
      navigator.mediaSession.playbackState = "paused";
      document.getElementById("stop-btn").innerHTML = "&#9654; Resume";
    });
    // Live monitor (LISTENTO-style): null the skip/seek actions so iOS grays them out, and leave
    // positionState unset so the card shows LIVE instead of a --:-- scrubber (the audio element is
    // already a live MediaStream, so there's no seekable timeline).
    ["previoustrack","nexttrack","seekbackward","seekforward","seekto"].forEach(function(action){
      try{ navigator.mediaSession.setActionHandler(action, null); }catch(_){}
    });
  }catch(_){}
}

function ensureMediaAudio(){
  if(mediaAudio) return mediaAudio;
  var audio = document.createElement("audio");
  audio.autoplay = true;
  audio.controls = false;
  audio.muted = false;
  audio.defaultMuted = false;
  audio.volume = 1;
  audio.setAttribute("playsinline", "");
  audio.setAttribute("webkit-playsinline", "");
  audio.setAttribute("data-kingz-listen-output", "true");
  audio.setAttribute("style", "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10000px;top:auto;");
  audio.addEventListener("play", function(){
    if("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  });
  audio.addEventListener("pause", function(){
    if("mediaSession" in navigator && stopped) navigator.mediaSession.playbackState = "paused";
  });
  document.body.appendChild(audio);
  mediaAudio = audio;
  return audio;
}

function ensureAudio(){
  if(!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    gainNode = audioCtx.createGain();
    gainNode.gain.value = parseFloat(document.getElementById("vol-slider").value) / 100;
    configureMediaSession();
    try{
      mediaDest = audioCtx.createMediaStreamDestination();
      gainNode.connect(mediaDest);
      var audio = ensureMediaAudio();
      audio.srcObject = mediaDest.stream;
      audio.play().catch(function(e){ console.warn("media element play blocked", e); });
    }catch(e){
      console.warn("media element output unavailable; falling back to AudioContext destination", e);
      mediaDest = null;
      gainNode.connect(audioCtx.destination);
    }
  }
  if(mediaAudio && mediaAudio.paused && !stopped) mediaAudio.play().catch(function(){});
  if(audioCtx.state === "suspended") audioCtx.resume().catch(function(){});
  if("mediaSession" in navigator) navigator.mediaSession.playbackState = stopped ? "paused" : "playing";
}

function stopScheduledSources(){
  var sources = scheduledSources.splice(0);
  sources.forEach(function(src){
    try{ src.stop(0); }catch(_){}
    try{ src.disconnect(); }catch(_){}
  });
}

function formatSampleRate(rate){
  return rate >= 1000 ? (rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1) + "kHz" : rate + "Hz";
}

function updateStreamFormat(msg){
  var advertised = Number(msg && msg.sampleRate);
  if(Number.isFinite(advertised) && advertised >= 8000 && advertised <= 384000){
    var nextRate = Math.round(advertised);
    if(nextRate !== pcmSampleRate){
      pcmSampleRate = nextRate;
      nextPlayTime = 0;
      stopScheduledSources();
    }
  }
  document.getElementById("stat-quality").textContent = formatSampleRate(pcmSampleRate) + " / 16-bit";
}

function playPcm(arrayBuffer){
  if(!audioCtx || stopped) return;
  var samples = new Int16Array(arrayBuffer);
  var frames  = samples.length / 2;
  if(frames < 1) return;
  var buf = audioCtx.createBuffer(2, frames, pcmSampleRate);
  var L = buf.getChannelData(0), R = buf.getChannelData(1);
  for(var i = 0; i < frames; i++){
    L[i] = samples[i*2]   / 32768.0;
    R[i] = samples[i*2+1] / 32768.0;
  }
  var src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(gainNode);
  src.onended = function(){
    var idx = scheduledSources.indexOf(src);
    if(idx >= 0) scheduledSources.splice(idx, 1);
  };
  var now = audioCtx.currentTime;
  var lead = nextPlayTime > 0 ? nextPlayTime - now : 0;
  if(lead > maxLead){
    droppedChunks++;
    stopScheduledSources();
    nextPlayTime = now + bufferAhead;
    lead = bufferAhead;
  } else if(nextPlayTime < now + minLead){
    if(nextPlayTime > 0) underruns++;
    nextPlayTime = now + bufferAhead;
    lead = bufferAhead;
  }
  src.start(nextPlayTime);
  scheduledSources.push(src);
  nextPlayTime += buf.duration;
  lead = Math.max(0, nextPlayTime - now);
  document.getElementById("stat-latency").textContent =
    Math.round(Math.min(lead, maxLead) * 1000) + " ms";
}

function sendSignal(payload){
  if(!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(Object.assign({ source_id:"kingz-web", signal_id:signalId }, payload)));
}

function flushCandidates(){
  if(!peerConn || !peerConn.remoteDescription) return;
  var cs = pendingCandidates.splice(0);
  cs.forEach(function(c){ peerConn.addIceCandidate(c).catch(function(){}); });
}

function onSignal(msg){
  if(!msg || (msg.signal_id && msg.signal_id !== signalId)) return;
  if(msg.type === "webrtc.answer" || msg.type === "webrtc-answer"){
    if(!peerConn) return;
    peerConn.setRemoteDescription({ type: msg.descriptionType || "answer", sdp: msg.sdp })
      .then(flushCandidates).catch(function(e){ console.error("SDP answer",e); });
    return;
  }
  if(msg.type === "webrtc.ice-candidate" || msg.type === "webrtc-candidate"){
    var cp = (msg.candidate && msg.candidate.candidate)
      ? msg.candidate
      : { candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex };
    if(!cp.candidate) return;
    var c = new RTCIceCandidate(cp);
    if(!peerConn || !peerConn.remoteDescription){ pendingCandidates.push(c); return; }
    peerConn.addIceCandidate(c).catch(function(){});
  }
}

function startWebRtc(){
  if(peerConn){ try{ peerConn.close(); }catch(_){} }
  pendingCandidates = [];
  signalId = "kw-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  peerConn = new RTCPeerConnection({ iceServers:[{ urls:"stun:stun.l.google.com:19302" }] });

  peerConn.onicecandidate = function(e){
    if(e.candidate) sendSignal({ type:"webrtc.ice-candidate", candidate:e.candidate.toJSON() });
  };
  peerConn.onconnectionstatechange = function(){
    var s = peerConn.connectionState;
    if(s === "connected"){
      setStatus("Live - receiving audio", true);
      ensureAudio();
      showCards(true);
      startDuration();
      document.getElementById("monitor-btn").classList.remove("inactive");
    } else if(s === "failed" || s === "disconnected"){
      setStatus("WebRTC " + s, false);
    }
  };

  var dc = peerConn.createDataChannel("kingz-pcm", { ordered:false, maxRetransmits:0 });
  dc.binaryType = "arraybuffer";
  dc.onopen  = function(){ ensureAudio(); };
  dc.onmessage = function(e){ playPcm(e.data); };
  dc.onclose = function(){ setStatus("Data channel closed", false); };
  dataChannel = dc;

  peerConn.createOffer()
    .then(function(offer){ return peerConn.setLocalDescription(offer).then(function(){ return offer; }); })
    .then(function(offer){
      sendSignal({ type:"webrtc.offer", sdp:offer.sdp, descriptionType:offer.type, offerGeneration:Date.now() });
    })
    .catch(function(e){ setStatus("Offer failed", false); console.error(e); });
}

function openSocket(h, p){
  lastHost = h;
  lastPort = p;
  restoreInFlight = true;
  if(socket){ try{ socket.close(); }catch(_){} }
  setStatus("Connecting…", false);
  socket = new WebSocket("ws://" + h + ":" + p + "/");
  socket.onopen = function(){
    restoreInFlight = false;
    connected = true;
    setStatus("Connected - starting audio...", true);
    startWebRtc();
  };
  socket.onmessage = function(e){
    var msg = tryParse(e.data);
    if(!msg) return;
    if(msg.type === "telemetry.report"){
      var lat = Number(msg.latencyMs || 0);
      if(lat > 0) document.getElementById("stat-latency").textContent = lat.toFixed(0) + " ms";
    }
    if(msg.type === "stream.name"){
      if(msg.name){ streamName = msg.name; configureMediaSession(); }
      return;
    }
    if(msg.type === "webrtc.data-channel-open" || msg.type === "webrtc-data-channel-open"){
      updateStreamFormat(msg);
      return;
    }
    onSignal(msg);
  };
  socket.onclose = function(){
    restoreInFlight = false;
    connected = false;
    if(wantConnected && !stopped){
      setStatus(document.hidden ? "Paused - waiting for restore" : "Connection interrupted - restoring...", false);
      document.getElementById("connect-btn").disabled = true;
      document.getElementById("disconnect-btn").disabled = false;
      if(!document.hidden) window.setTimeout(function(){ handleRestore("socket-close"); }, 250);
    } else {
      setStatus("Disconnected", false);
      document.getElementById("connect-btn").disabled = false;
      document.getElementById("disconnect-btn").disabled = true;
      showCards(false);
      stopDuration();
    }
  };
  socket.onerror = function(){ setStatus("Connection error", false); };
}

function handleRestore(reason){
  if(!wantConnected || stopped || restoreInFlight) return;
  ensureAudio();
  if(!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING){
    if(lastHost){
      setStatus("Restoring audio...", false);
      openSocket(lastHost, lastPort || "8082");
    }
    return;
  }
  if(peerConn){
    var s = peerConn.connectionState;
    if((s === "failed" || s === "disconnected" || s === "closed") && socket && socket.readyState === WebSocket.OPEN){
      setStatus("Restoring audio...", false);
      startWebRtc();
    }
  }
}

document.addEventListener("visibilitychange", function(){
  if(document.hidden){
    lastHiddenAt = Date.now();
    return;
  }
  handleRestore("visibility");
});
window.addEventListener("pageshow", function(){ handleRestore("pageshow"); });
window.addEventListener("focus", function(){ handleRestore("focus"); });

document.getElementById("connect-btn").addEventListener("click", function(){
  var h = document.getElementById("ip-input").value.trim();
  var p = document.getElementById("port-input").value.trim() || "8082";
  if(!h){ setStatus("Enter a server IP", false); return; }
  ensureAudio();
  wantConnected = true;
  connected = true;
  stopped   = false;
  document.getElementById("connect-btn").disabled = true;
  document.getElementById("disconnect-btn").disabled = false;
  openSocket(h, p);
});

document.getElementById("disconnect-btn").addEventListener("click", function(){
  wantConnected = false;
  restoreInFlight = false;
  connected = false;
  stopped = true;
  nextPlayTime = 0;
  stopScheduledSources();
  if(socket){ try{ socket.close(); }catch(_){} socket = null; }
  if(peerConn){ try{ peerConn.close(); }catch(_){} peerConn = null; }
  if(mediaAudio){ try{ mediaAudio.pause(); }catch(_){} try{ mediaAudio.remove(); }catch(_){} mediaAudio = null; }
  if(audioCtx){ try{ audioCtx.close(); }catch(_){} audioCtx = null; gainNode = null; }
  mediaDest = null;
  if("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  stopDuration();
  showCards(false);
  setStatus("Disconnected", false);
  document.getElementById("connect-btn").disabled = false;
  document.getElementById("disconnect-btn").disabled = true;
  document.getElementById("monitor-btn").classList.add("inactive");
});

document.getElementById("stop-btn").addEventListener("click", function(){
  stopped = !stopped;
  this.innerHTML = stopped ? "&#9654; Resume" : "&#9644; Stop";
  nextPlayTime = 0;
  if(stopped){
    stopScheduledSources();
    if(mediaAudio) mediaAudio.pause();
  } else {
    ensureAudio();
  }
  if("mediaSession" in navigator) navigator.mediaSession.playbackState = stopped ? "paused" : "playing";
});

document.getElementById("mute-btn").addEventListener("click", function(){
  muted = !muted;
  if(gainNode) gainNode.gain.value = muted ? 0 : parseFloat(document.getElementById("vol-slider").value)/100;
  this.textContent = muted ? "Unmute" : "Mute";
  this.style.color = muted ? "var(--gold)" : "";
});

document.getElementById("vol-slider").addEventListener("input", function(){
  if(gainNode && !muted) gainNode.gain.value = parseFloat(this.value) / 100;
});

document.getElementById("monitor-btn").classList.add("inactive");

var modes = {
  "mode-low":  { target: 0.035, max: 0.10 },
  "mode-bal":  { target: 0.06,  max: 0.16 },
  "mode-safe": { target: 0.12,  max: 0.28 }
};
Object.keys(modes).forEach(function(id){
  document.getElementById(id).addEventListener("click", function(){
    document.querySelectorAll(".mode-btn").forEach(function(b){ b.classList.remove("active"); });
    this.classList.add("active");
    bufferAhead  = modes[id].target;
    maxLead      = modes[id].max;
    nextPlayTime = 0;
    stopScheduledSources();
  });
});)JS";
}

juce::String getWebUiHtml()
{
    return R"HTML(<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <title>Kingz Listen</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="page-label">LAN Audio Receiver</div>

  <div class="card">
    <div class="card-label">Connection</div>
    <div class="row">
      <div class="field">
        <label>Server IP</label>
        <input id="ip-input" type="text" inputmode="decimal" placeholder="192.168.x.x">
      </div>
      <div class="field port">
        <label>Port</label>
        <input id="port-input" type="text" inputmode="numeric" placeholder="8082">
      </div>
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" id="connect-btn">Connect</button>
      <button class="btn btn-secondary" id="disconnect-btn" disabled>Disconnect</button>
    </div>
  </div>

  <div class="card" id="session-card" style="display:none">
    <div class="card-label">Now Listening</div>
    <div class="session-name">Studio Session</div>
    <div class="session-sub">Engineer: KINGZ Studio</div>
    <div class="stats">
      <div class="stat"><div class="stat-label">Quality</div><div class="stat-value" id="stat-quality">48kHz / 16-bit</div></div>
      <div class="stat"><div class="stat-label">Duration</div><div class="stat-value" id="stat-duration">0:00</div></div>
      <div class="stat"><div class="stat-label">Latency</div><div class="stat-value" id="stat-latency">-- ms</div></div>
    </div>
  </div>

  <div class="card" id="mode-card" style="display:none">
    <div class="card-label">Monitoring Mode</div>
    <div class="mode-row">
      <button class="mode-btn" id="mode-low">Low Latency</button>
      <button class="mode-btn active" id="mode-bal">Balanced</button>
      <button class="mode-btn" id="mode-safe">Safe Buffer</button>
    </div>
  </div>

  <div class="card" id="monitor-card" style="display:none">
    <div class="card-label">Monitor</div>
    <div class="monitor-center">
      <button class="monitor-btn" id="monitor-btn">
        <svg viewBox="0 0 44 44" fill="none">
          <rect x="6"  y="14" width="4" height="16" rx="2" fill="#000" opacity=".9"/>
          <rect x="13" y="9"  width="4" height="26" rx="2" fill="#000" opacity=".9"/>
          <rect x="20" y="12" width="4" height="20" rx="2" fill="#000" opacity=".9"/>
          <rect x="27" y="7"  width="4" height="30" rx="2" fill="#000" opacity=".9"/>
          <rect x="34" y="14" width="4" height="16" rx="2" fill="#000" opacity=".9"/>
        </svg>
      </button>
    </div>
    <div class="ctrl-row">
      <button class="btn btn-secondary" id="stop-btn">&#9644; Stop</button>
      <button class="btn btn-secondary" id="mute-btn">Mute</button>
    </div>
    <div class="vol-row">
      <span class="vol-icon">&#128266;</span>
      <input class="vol-slider" type="range" id="vol-slider" min="0" max="100" value="100">
    </div>
  </div>

  <div class="status-bar">
    <div class="status-dot" id="status-dot"></div>
    <div class="status-text" id="status-text">Enter IP and tap Connect</div>
  </div>
  <div class="footer-note">Fields pre-filled from this page&#39;s URL. Tap Connect &amp; Listen.</div>

  <script src="/app.js"></script>
</body>
</html>)HTML";
}

} // namespace

struct NetworkTransmitter::ClientConnection final
{
    explicit ClientConnection (NativeSocket socketIn)
        : socket (socketIn)
    {
    }

    NativeSocket socket = invalidSocket;
    bool websocket = false;
    bool externalSignaling = false;
    std::atomic<bool> closeRequested { false };
    juce::String textBuffer;
    std::vector<std::uint8_t> binaryBuffer;
    juce::int64 lastSeenMs = juce::Time::currentTimeMillis();
    juce::int64 lastPingSentMs = 0;
    juce::int64 graceStartedMs = 0;
    int offerGeneration = 0;
    juce::String signalId;
    std::mutex sendMutex;
    std::shared_ptr<rtc::PeerConnection> peerConnection;
    std::shared_ptr<rtc::DataChannel> pcmChannel;
    std::shared_ptr<rtc::Track> opusTrack;                       // Opus mode: send-only audio track
    std::shared_ptr<rtc::RtpPacketizationConfig> opusRtpConfig;  // RTP seq/timestamp state for the track
};

#if JUCE_WINDOWS
NetworkTransmitter::WsaSession::WsaSession()
{
    WSADATA data {};
    ready = WSAStartup (MAKEWORD (2, 2), &data) == 0;
}

NetworkTransmitter::WsaSession::~WsaSession()
{
    if (ready)
        WSACleanup();
}
#endif

NetworkTransmitter::NetworkTransmitter (AudioFifoWorker& fifoToRead)
    : juce::Thread ("Kingz Listen Network Transmitter"),
      fifo (fifoToRead)
{
}

NetworkTransmitter::~NetworkTransmitter()
{
    stop();
}

bool NetworkTransmitter::start (int portToUse)
{
    stop();
    port = portToUse;
    isConnected.store (false, std::memory_order_release);
    activeClientCount.store (0, std::memory_order_release);
    bufferHealth.store (1.0f, std::memory_order_release);
    targetChunkMs.store (AudioFifoWorker::chunkDurationMs, std::memory_order_release);
    chunkSizeTransitionPending.store (false, std::memory_order_release);
    lastPacketAdaptationMs = 0;
    lastTransportSyncMs = 0;
    lastTransportStateBroadcastMs = 0;
    lastBroadcastHostPlaying = false;
    streamTransmitSamplePosition.store (0, std::memory_order_release);
    transportSyncSequence.store (0, std::memory_order_release);
    transportStateSequence.store (0, std::memory_order_release);
    shouldListen.store (true, std::memory_order_release);

    // CRITICAL DEBUGGING
    std::cout << "[KINGZ] NetworkTransmitter::start() - portToUse=" << portToUse << std::endl;

    startThread();

    // Dedicated PCM sender at elevated priority so DAW CPU load can't starve audio delivery,
    // and so PCM cadence is independent of the main thread's HTTP/WS/signaling/JSON work.
    pcmSenderThread = std::make_unique<PcmSenderThread> (*this);
    pcmSenderThread->startThread (juce::Thread::Priority::high);

    std::cout << "[KINGZ] NetworkTransmitter::start() - thread started (+ PCM sender)" << std::endl;
    return true;
}

void NetworkTransmitter::stop()
{
    shouldListen.store (false, std::memory_order_release);
    isConnected.store (false, std::memory_order_release);
    activeClientCount.store (0, std::memory_order_release);
    bufferHealth.store (1.0f, std::memory_order_release);
    targetChunkMs.store (AudioFifoWorker::chunkDurationMs, std::memory_order_release);
    chunkSizeTransitionPending.store (false, std::memory_order_release);
    lastPacketAdaptationMs = 0;
    lastTransportSyncMs = 0;
    lastTransportStateBroadcastMs = 0;
    lastBroadcastHostPlaying = false;
    streamTransmitSamplePosition.store (0, std::memory_order_release);
    transportSyncSequence.store (0, std::memory_order_release);
    transportStateSequence.store (0, std::memory_order_release);
    // Stop the PCM sender first (before closing clients/sockets) so it can't touch a
    // half-torn-down client list.
    if (pcmSenderThread != nullptr)
    {
        pcmSenderThread->signalThreadShouldExit();
        pcmSenderThread->stopThread (2000);
        pcmSenderThread.reset();
    }
    signalThreadShouldExit();
    closeSocket (listener);
    stopThread (2000);
    closeAllClients();
}

int NetworkTransmitter::getPort() const noexcept
{
    return port;
}

int NetworkTransmitter::getConnectedClientCount() const noexcept
{
    return connectedClients.load (std::memory_order_acquire);
}

void NetworkTransmitter::setStreamSampleRate (double sampleRate) noexcept
{
    const auto rounded = static_cast<int> (sampleRate + 0.5);
    streamSampleRate.store (juce::jlimit (8000, 384000, rounded > 0 ? rounded : AudioFifoWorker::targetSampleRate),
                            std::memory_order_release);
}

void NetworkTransmitter::updateTransportSnapshot (bool isPlaying,
                                                  juce::int64 hostSamplePosition,
                                                  juce::int64 streamWritePosition,
                                                  double bpm,
                                                  double ppqPosition) noexcept
{
    hostTransportPlaying.store (isPlaying, std::memory_order_release);
    hostTransportSamplePosition.store (juce::jmax (static_cast<juce::int64> (0), hostSamplePosition),
                                       std::memory_order_release);
    streamWriteSamplePosition.store (juce::jmax (static_cast<juce::int64> (0), streamWritePosition),
                                     std::memory_order_release);
    hostTempoBpmX100.store (juce::jlimit (0, 100000, static_cast<int> (std::lround (bpm * 100.0))),
                            std::memory_order_release);
    hostPpqPositionX1000.store (static_cast<juce::int64> (std::llround (ppqPosition * 1000.0)),
                                std::memory_order_release);
}

void NetworkTransmitter::setExternalSignalingSender (std::function<void (const juce::String&)> sender)
{
    const juce::ScopedLock lock { externalSignalingLock };
    externalSignalingSender = std::move (sender);
}

void NetworkTransmitter::handleExternalSignalingMessage (const juce::var& message)
{
    const auto* object = message.getDynamicObject();
    if (object == nullptr)
        return;

    const auto type = object->getProperty ("type").toString();

    std::shared_ptr<ClientConnection> client;
    {
        const juce::ScopedLock lock { clientLock };

        if (externalSignalingClient == nullptr
            || externalSignalingClient->closeRequested.load (std::memory_order_acquire))
        {
            externalSignalingClient = std::make_shared<ClientConnection> (invalidSocket);
            externalSignalingClient->websocket = true;
            externalSignalingClient->externalSignaling = true;
            clients.push_back (externalSignalingClient);
        }

        client = externalSignalingClient;
        client->lastSeenMs = juce::Time::currentTimeMillis();
        client->graceStartedMs = 0;
    }

    if (type == "webrtc-offer")
    {
        handleWebRtcOffer (client, *object);
        return;
    }

    if (type == "webrtc-candidate")
        handleRemoteIceCandidate (client, *object);
}

juce::String NetworkTransmitter::getLocalLanIpAddress() const
{
   #if JUCE_WINDOWS
    ULONG bufferLength = 15 * 1024;
    std::vector<std::uint8_t> buffer (bufferLength);
    auto* addresses = reinterpret_cast<IP_ADAPTER_ADDRESSES*> (buffer.data());

    const auto result = GetAdaptersAddresses (AF_INET,
                                              GAA_FLAG_SKIP_ANYCAST
                                                  | GAA_FLAG_SKIP_MULTICAST
                                                  | GAA_FLAG_SKIP_DNS_SERVER,
                                              nullptr,
                                              addresses,
                                              &bufferLength);
    if (result != NO_ERROR)
        return "127.0.0.1";

    juce::String fallback;
    for (auto* adapter = addresses; adapter != nullptr; adapter = adapter->Next)
    {
        if (adapter->OperStatus != IfOperStatusUp)
            continue;

        for (auto* unicast = adapter->FirstUnicastAddress; unicast != nullptr; unicast = unicast->Next)
        {
            if (unicast->Address.lpSockaddr == nullptr
                || unicast->Address.lpSockaddr->sa_family != AF_INET)
                continue;

            char addressBuffer[INET_ADDRSTRLEN] {};
            const auto* sockaddr = reinterpret_cast<sockaddr_in*> (unicast->Address.lpSockaddr);
            if (inet_ntop (AF_INET, &sockaddr->sin_addr, addressBuffer, sizeof (addressBuffer)) == nullptr)
                continue;

            const juce::String address { addressBuffer };
            if (! isUsableIpv4Address (address))
                continue;

            if (isPrivateLanAddress (address))
                return address;

            if (fallback.isEmpty())
                fallback = address;
        }
    }

    return fallback.isNotEmpty() ? fallback : juce::String { "127.0.0.1" };
   #else
    ifaddrs* interfaces = nullptr;
    if (getifaddrs (&interfaces) != 0 || interfaces == nullptr)
        return "127.0.0.1";

    juce::String fallback;
    for (auto* item = interfaces; item != nullptr; item = item->ifa_next)
    {
        if (item->ifa_addr == nullptr || item->ifa_addr->sa_family != AF_INET)
            continue;

        const auto flags = item->ifa_flags;
        if ((flags & IFF_UP) == 0 || (flags & IFF_LOOPBACK) != 0)
            continue;

        char addressBuffer[INET_ADDRSTRLEN] {};
        const auto* sockaddr = reinterpret_cast<sockaddr_in*> (item->ifa_addr);
        if (inet_ntop (AF_INET, &sockaddr->sin_addr, addressBuffer, sizeof (addressBuffer)) == nullptr)
            continue;

        const juce::String address { addressBuffer };
        if (! isUsableIpv4Address (address))
            continue;

        if (isPrivateLanAddress (address))
        {
            freeifaddrs (interfaces);
            return address;
        }

        if (fallback.isEmpty())
            fallback = address;
    }

    freeifaddrs (interfaces);
    return fallback.isNotEmpty() ? fallback : juce::String { "127.0.0.1" };
   #endif
}

void NetworkTransmitter::run()
{
   #if JUCE_WINDOWS
    WsaSession wsa;
    if (! wsa.ready)
        return;
   #endif

    // CRITICAL DEBUGGING
    std::cout << "[KINGZ] NetworkTransmitter::run() STARTED - port=" << port << std::endl;

    listener = port > 0 ? createListenerSocket (port) : invalidSocket;

    std::cout << "[KINGZ] NetworkTransmitter::run() - createListenerSocket returned: " << (listener != invalidSocket ? "SUCCESS" : "FAILED") << std::endl;

    if (port > 0 && listener == invalidSocket)
        DBG ("NetworkTransmitter::run continuing without local signaling listener");
    else if (port <= 0)
        DBG ("NetworkTransmitter::run using external WebSocket signaling only");

    // CRITICAL: HTTP server loop - must stay responsive regardless of WebRTC state
    while (! threadShouldExit() && shouldListen.load (std::memory_order_acquire))
    {
        acceptPendingClient();      // Accept new HTTP/WebSocket connections
        pumpClients();              // Process HTTP/WebSocket messages
        processWebRtcQueue();        // Handle queued WebRTC operations (non-blocking)
        maybeBroadcastTransportState();
        // PCM streaming now runs on the dedicated pcmSenderThread (decoupled from this loop).
        // transport.sync is broadcast here, off the PCM path; it self-rate-limits to 100ms.
        maybeBroadcastTransportSync (AudioFifoWorker::framesForChunkMs (targetChunkMs.load (std::memory_order_acquire)));
        wait (2);                   // Small sleep to prevent busy-wait
    }

    closeSocket (listener);
    closeAllClients();
}

void NetworkTransmitter::processWebRtcQueue()
{
    // CRITICAL: Process ONE WebRTC task per loop iteration to keep HTTP server responsive
    WebRtcSignalingTask task {};
    bool hasTask = false;

    {
        const juce::ScopedLock lock (webRtcQueueLock);
        if (! webRtcQueue.empty())
        {
            task = webRtcQueue.front();
            webRtcQueue.erase (webRtcQueue.begin());
            hasTask = true;
        }
    }

    if (! hasTask)
        return;

    // Process the task (may take time, but only one per loop iteration)
    std::cout << "[KINGZ] Processing WebRTC offer (queued task)" << std::endl;
    createPeerConnection (task.client, task.sdp, task.offerGeneration);
    std::cout << "[KINGZ] WebRTC offer processed" << std::endl;
}

NetworkTransmitter::NativeSocket NetworkTransmitter::createListenerSocket (int portToBind)
{
    auto socketHandle = ::socket (AF_INET, SOCK_STREAM, 0);
    if (socketHandle == invalidSocket)
        return invalidSocket;

    const int reuse = 1;
   #if JUCE_WINDOWS
    setsockopt (socketHandle, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*> (&reuse), sizeof (reuse));
   #else
    setsockopt (socketHandle, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof (reuse));
   #endif

    sockaddr_in address {};
    address.sin_family = AF_INET;
    address.sin_port = htons (static_cast<std::uint16_t> (portToBind));
    address.sin_addr.s_addr = htonl (INADDR_ANY);

    if (::bind (socketHandle, reinterpret_cast<sockaddr*> (&address), sizeof (address)) != 0
        || ::listen (socketHandle, 8) != 0)
    {
        closeSocket (socketHandle);
        return invalidSocket;
    }

    setNonBlocking (socketHandle);
    return socketHandle;
}

void NetworkTransmitter::acceptPendingClient()
{
    if (listener == invalidSocket)
        return;

    for (;;)
    {
        sockaddr_in clientAddress {};
       #if JUCE_WINDOWS
        int addressLength = sizeof (clientAddress);
       #else
        socklen_t addressLength = sizeof (clientAddress);
       #endif
        auto socketHandle = ::accept (listener,
                                      reinterpret_cast<sockaddr*> (&clientAddress),
                                      &addressLength);

        if (socketHandle == invalidSocket)
            return;

        setNonBlocking (socketHandle);
        const juce::ScopedLock lock { clientLock };
        clients.push_back (std::make_shared<ClientConnection> (socketHandle));
        connectedClients.store (static_cast<int> (clients.size()), std::memory_order_release);
        // Do NOT increment activeClientCount here - wait until RTCDataChannel is open
    }
}

void NetworkTransmitter::pumpClients()
{
    const auto now = juce::Time::currentTimeMillis();
    const juce::ScopedLock lock { clientLock };

    for (auto& client : clients)
    {
        if (! client->externalSignaling)
            readFromClient (*client);

        if (client->websocket && ! client->externalSignaling && now - client->lastPingSentMs >= heartbeatMs)
        {
            sendWebSocketFrame (*client, {}, 0x9);
            client->lastPingSentMs = now;
        }

        // Start grace period for LOCAL clients if no heartbeat (external clients exempt - they negotiate async)
        if (client->websocket
            && ! client->externalSignaling  // External clients don't send continuous messages during negotiation
            && now - client->lastSeenMs > heartbeatMs
            && client->graceStartedMs == 0)
            client->graceStartedMs = now;

        // Close client if grace period exceeded
        if (client->graceStartedMs > 0 && now - client->graceStartedMs > graceHoldMs)
            client->closeRequested.store (true, std::memory_order_release);
    }

    clients.erase (std::remove_if (clients.begin(),
                                   clients.end(),
                                   [this] (const std::shared_ptr<ClientConnection>& client)
                                   {
                                       if (! client->closeRequested.load (std::memory_order_acquire))
                                           return false;

                                       closePeerConnection (*client);
                                       closeSocket (client->socket);
                                       if (client == externalSignalingClient)
                                           externalSignalingClient.reset();
                                       return true;
                                   }),
                   clients.end());
    connectedClients.store (static_cast<int> (clients.size()), std::memory_order_release);

    // Only count clients with open PCM channels as active (not still negotiating)
    const auto activeCount = static_cast<int> (std::count_if (clients.begin(),
                                                             clients.end(),
                                                             [] (const std::shared_ptr<ClientConnection>& client)
                                                             {
                                                                 return isClientReadyForPcm (*client);
                                                             }));
    activeClientCount.store (activeCount, std::memory_order_release);
    isConnected.store (activeCount > 0, std::memory_order_release);
    adaptPacketSize();
}

void NetworkTransmitter::readFromClient (ClientConnection& client)
{
    std::array<char, 4096> scratch {};

    for (;;)
    {
       #if JUCE_WINDOWS
        const auto bytesRead = ::recv (client.socket, scratch.data(), static_cast<int> (scratch.size()), 0);
       #else
        const auto bytesRead = ::recv (client.socket, scratch.data(), scratch.size(), 0);
       #endif

        if (bytesRead == 0)
        {
            client.closeRequested.store (true, std::memory_order_release);
            return;
        }

        if (bytesRead < 0)
            return;

        client.lastSeenMs = juce::Time::currentTimeMillis();
        client.graceStartedMs = 0;

        if (client.websocket)
        {
            client.binaryBuffer.insert (client.binaryBuffer.end(),
                                        scratch.begin(),
                                        scratch.begin() + bytesRead);
            parseWebSocketFrames (client);
        }
        else
        {
            client.textBuffer += juce::String::fromUTF8 (scratch.data(), static_cast<int> (bytesRead));
            if (client.textBuffer.contains ("\r\n\r\n"))
                handleHttpRequest (client);
        }
    }
}

void NetworkTransmitter::handleHttpRequest (ClientConnection& client)
{
    const auto request = client.textBuffer;

    if (request.containsIgnoreCase ("upgrade: websocket"))
    {
        upgradeToWebSocket (client, request);
        return;
    }

    if (request.startsWithIgnoreCase ("GET /health "))
    {
        sendHttpResponse (client, "application/json", R"JSON({"ok":true,"service":"KINGZ_LISTEN_PLUGIN"})JSON");
        client.closeRequested.store (true, std::memory_order_release);
        return;
    }

    if (request.startsWithIgnoreCase ("GET /metadata "))
    {
        const auto currentChunkMs = targetChunkMs.load (std::memory_order_acquire);
        const auto currentSampleRate = streamSampleRate.load (std::memory_order_acquire);
        auto* realtime = new juce::DynamicObject();
        realtime->setProperty ("transport", "native-plugin-libdatachannel-pcm");
        realtime->setProperty ("chunkMs", currentChunkMs);
        realtime->setProperty ("framesPerChunk", static_cast<int> (AudioFifoWorker::bytesForChunkMs (currentChunkMs)
                                                                    / (AudioFifoWorker::inputChannels * sizeof (std::int16_t))));
        realtime->setProperty ("sampleRate", currentSampleRate);
        realtime->setProperty ("channels", AudioFifoWorker::inputChannels);
        realtime->setProperty ("bitDepth", 16);
        realtime->setProperty ("bytesPerChunk", static_cast<int> (AudioFifoWorker::bytesForChunkMs (currentChunkMs)));
        realtime->setProperty ("bitrate", pcmTelemetryBitrateBitsPerSecond);
        realtime->setProperty ("ordered", false);
        realtime->setProperty ("maxRetransmits", juce::var());
        realtime->setProperty ("maxPacketLifeTimeMs", pcmMaxPacketLifetimeMs);
        realtime->setProperty ("dropWhenBufferedBytesExceed",
                               static_cast<int> (AudioFifoWorker::bytesForChunkMs (currentChunkMs) * 2));
        realtime->setProperty ("adaptiveChunkSizing", true);
        realtime->setProperty ("minChunkMs", AudioFifoWorker::minChunkDurationMs);
        realtime->setProperty ("maxChunkMs", AudioFifoWorker::maxChunkDurationMs);
        realtime->setProperty ("udpOnly", true);
        realtime->setProperty ("jitterBuffer", "bypassed-data-channel");
        realtime->setProperty ("signalProcessing", "disabled-raw-pcm");
        realtime->setProperty ("webrtcMtuBytes", lanOptimisedWebRtcMtuBytes);

        auto* metadata = new juce::DynamicObject();
        metadata->setProperty ("source_id", KINGZ_LISTEN_PLUGIN);
        metadata->setProperty ("realtime", juce::var (realtime));
        sendHttpResponse (client, "application/json", jsonString (juce::var (metadata)));
        client.closeRequested.store (true, std::memory_order_release);
        return;
    }

    if (request.startsWithIgnoreCase ("GET / ")
        || request.startsWithIgnoreCase ("GET /index.html "))
    {
        sendHttpResponse (client, "text/html; charset=utf-8", getWebUiHtml());
        client.closeRequested.store (true, std::memory_order_release);
        return;
    }

    if (request.startsWithIgnoreCase ("GET /style.css "))
    {
        sendHttpResponse (client, "text/css; charset=utf-8", getWebUiCss());
        client.closeRequested.store (true, std::memory_order_release);
        return;
    }

    if (request.startsWithIgnoreCase ("GET /app.js "))
    {
        sendHttpResponse (client, "application/javascript; charset=utf-8", getWebUiJs());
        client.closeRequested.store (true, std::memory_order_release);
        return;
    }

    sendHttpResponse (client, "text/plain", "Kingz Listen native transmitter");
    client.closeRequested.store (true, std::memory_order_release);
}

void NetworkTransmitter::upgradeToWebSocket (ClientConnection& client, const juce::String& request)
{
    const auto key = getHeaderValue (request, "Sec-WebSocket-Key");
    if (key.isEmpty())
    {
        client.closeRequested.store (true, std::memory_order_release);
        return;
    }

    const auto accept = createWebSocketAcceptKey (key);
    const auto response =
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";

    sendRaw (client.socket, response.toRawUTF8(), exactUtf8ByteCount (response));
    client.websocket = true;
    client.textBuffer.clear();

    // Announce the current transport mode immediately so this client offers the right m-lines
    // on its first WebRTC offer (auto-follow). transport.sync can't carry it — it's gated on an
    // open pcmChannel, which doesn't exist yet at WS-upgrade time.
    {
        auto* modeMsg = new juce::DynamicObject();
        modeMsg->setProperty ("type", "transport.mode");
        modeMsg->setProperty ("transport", transportMode.load (std::memory_order_acquire) == 1 ? "opus" : "pcm");
        sendJson (client, jsonString (juce::var (modeMsg)));
    }

    // Announce the current display name so a receiver joining mid-session (app + web) inherits the
    // engineer's current name immediately, not the default. (Re-broadcast on change in setStreamName.)
    {
        auto* nameMsg = new juce::DynamicObject();
        nameMsg->setProperty ("type", "stream.name");
        nameMsg->setProperty ("name", getStreamName());
        sendJson (client, jsonString (juce::var (nameMsg)));
    }
}

juce::String NetworkTransmitter::getHeaderValue (const juce::String& request, const juce::String& header)
{
    juce::StringArray lines;
    lines.addLines (request);

    for (auto line : lines)
    {
        if (line.startsWithIgnoreCase (header + ":"))
            return line.fromFirstOccurrenceOf (":", false, false).trim();
    }

    return {};
}

void NetworkTransmitter::parseWebSocketFrames (ClientConnection& client)
{
    for (;;)
    {
        if (client.binaryBuffer.size() < 2)
            return;

        const auto first = client.binaryBuffer[0];
        const auto second = client.binaryBuffer[1];
        const auto opcode = first & 0x0fu;
        const auto masked = (second & 0x80u) != 0;
        std::uint64_t payloadLength = second & 0x7fu;
        std::size_t headerSize = 2;

        if (payloadLength == 126)
        {
            if (client.binaryBuffer.size() < 4)
                return;

            payloadLength = (static_cast<std::uint64_t> (client.binaryBuffer[2]) << 8u)
                          | static_cast<std::uint64_t> (client.binaryBuffer[3]);
            headerSize = 4;
        }
        else if (payloadLength == 127)
        {
            client.closeRequested.store (true, std::memory_order_release);
            return;
        }

        if (masked)
            headerSize += 4;

        if (payloadLength > maxTextFrameBytes
            || client.binaryBuffer.size() < headerSize + static_cast<std::size_t> (payloadLength))
            return;

        std::array<std::uint8_t, 4> mask {};
        if (masked)
            std::memcpy (mask.data(), client.binaryBuffer.data() + headerSize - 4, mask.size());

        std::vector<std::uint8_t> payload (static_cast<std::size_t> (payloadLength));
        for (std::size_t i = 0; i < payload.size(); ++i)
        {
            auto byte = client.binaryBuffer[headerSize + i];
            if (masked)
                byte ^= mask[i % 4];
            payload[i] = byte;
        }

        client.binaryBuffer.erase (client.binaryBuffer.begin(),
                                   client.binaryBuffer.begin()
                                       + static_cast<std::ptrdiff_t> (headerSize + payload.size()));

        if (opcode == 0x1)
            handleTextFrame (client, juce::String::fromUTF8 (reinterpret_cast<const char*> (payload.data()),
                                                             static_cast<int> (payload.size())));
        else if (opcode == 0x8)
            client.closeRequested.store (true, std::memory_order_release);
        else if (opcode == 0x9)
            sendWebSocketFrame (client, payload, 0xau);
        else if (opcode == 0xau)
            client.lastSeenMs = juce::Time::currentTimeMillis();
    }
}

void NetworkTransmitter::handleTextFrame (ClientConnection& client, const juce::String& text)
{
    const auto parsed = juce::JSON::parse (text);
    const auto* object = parsed.getDynamicObject();
    if (object == nullptr)
        return;

    const auto type = object->getProperty ("type").toString();
    if (type == "client.ping")
    {
        sendJson (client, R"JSON({"type":"pong"})JSON");
        return;
    }

    if (type == "webrtc.pong")
    {
        client.lastSeenMs = juce::Time::currentTimeMillis();
        client.graceStartedMs = 0;
        return;
    }

    if (type == "webrtc.offer")
    {
        if (auto clientPtr = findClient (client))
            handleWebRtcOffer (clientPtr, *object);
        return;
    }

    if (type == "webrtc.ice-candidate")
    {
        if (auto clientPtr = findClient (client))
            handleRemoteIceCandidate (clientPtr, *object);
        return;
    }

    if (type == "webrtc.stop")
    {
        closePeerConnection (client);
        client.closeRequested.store (true, std::memory_order_release);
    }
}

std::shared_ptr<NetworkTransmitter::ClientConnection> NetworkTransmitter::findClient (ClientConnection& client)
{
    const juce::ScopedLock lock { clientLock };
    const auto iter = std::find_if (clients.begin(),
                                    clients.end(),
                                    [&client] (const std::shared_ptr<ClientConnection>& candidate)
                                    {
                                        return candidate.get() == &client;
                                    });

    return iter != clients.end() ? *iter : nullptr;
}

void NetworkTransmitter::handleWebRtcOffer (const std::shared_ptr<ClientConnection>& client,
                                            const juce::DynamicObject& object)
{
    const auto offerGeneration = static_cast<int> (object.getProperty ("offerGeneration"));
    client->signalId = object.getProperty ("signal_id").toString();
    auto sdp = object.getProperty ("sdp").toString();

    if (sdp.isEmpty())
    {
        const auto description = object.getProperty ("description");
        if (const auto* descriptionObject = description.getDynamicObject())
            sdp = descriptionObject->getProperty ("sdp").toString();
    }

    if (sdp.isEmpty())
    {
        auto* response = new juce::DynamicObject();
        response->setProperty ("type", "webrtc.error");
        response->setProperty ("message", "missing_remote_sdp");
        response->setProperty ("offerGeneration", offerGeneration);
        sendJson (client, jsonString (juce::var (response)));
        return;
    }

    // CRITICAL: Queue WebRTC operation to prevent blocking HTTP server
    {
        const juce::ScopedLock lock (webRtcQueueLock);
        webRtcQueue.push_back ({ client, sdp, offerGeneration });
    }
    std::cout << "[KINGZ] WebRTC offer queued (will process async)" << std::endl;
}

void NetworkTransmitter::handleRemoteIceCandidate (const std::shared_ptr<ClientConnection>& client,
                                                   const juce::DynamicObject& object)
{
    if (client == nullptr || client->peerConnection == nullptr)
        return;

    if (! object.getProperty ("offerGeneration").isVoid())
    {
        const auto generation = static_cast<int> (object.getProperty ("offerGeneration"));
        if (generation != client->offerGeneration)
            return;
    }

    const auto signalId = object.getProperty ("signal_id").toString();
    if (signalId.isNotEmpty())
        client->signalId = signalId;

    auto candidateValue = object.getProperty ("candidate");
    juce::String candidate;
    juce::String mid;

    if (const auto* candidateObject = candidateValue.getDynamicObject())
    {
        candidate = candidateObject->getProperty ("candidate").toString();
        mid = candidateObject->getProperty ("sdpMid").toString();
    }
    else
    {
        candidate = candidateValue.toString();
        mid = object.getProperty ("sdpMid").toString();
    }

    if (candidate.isEmpty())
        return;

    try
    {
        client->peerConnection->addRemoteCandidate (rtc::Candidate (candidate.toStdString(), mid.toStdString()));
    }
    catch (const std::exception& error)
    {
        auto* response = new juce::DynamicObject();
        response->setProperty ("type", "webrtc.error");
        response->setProperty ("message", "remote_ice_rejected");
        response->setProperty ("detail", error.what());
        response->setProperty ("offerGeneration", client->offerGeneration);
        sendJson (client, jsonString (juce::var (response)));
    }
}

void NetworkTransmitter::createPeerConnection (const std::shared_ptr<ClientConnection>& client,
                                               const juce::String& sdp,
                                               int offerGeneration)
{
    if (client == nullptr)
        return;

    closePeerConnection (*client);
    client->offerGeneration = offerGeneration;

    rtc::Configuration configuration;
    configuration.enableIceTcp = false;
    configuration.disableAutoNegotiation = false;
    configuration.disableAutoGathering = false;
    configuration.mtu = static_cast<std::size_t> (lanOptimisedWebRtcMtuBytes);

    auto peer = std::make_shared<rtc::PeerConnection> (configuration);
    const auto weakClient = std::weak_ptr<ClientConnection> (client);

    peer->onLocalDescription ([this, weakClient, offerGeneration] (rtc::Description description)
    {
        if (auto lockedClient = weakClient.lock())
        {
            const auto answerSdp = std::string (description);
            // Full answer SDP dump — critical for diagnosing m-line mismatches
            std::cout << "[KINGZ_SDP_ANSWER_BEGIN offerGen=" << offerGeneration << "]\n"
                      << answerSdp
                      << "[KINGZ_SDP_ANSWER_END]\n" << std::flush;

            auto* response = new juce::DynamicObject();
            response->setProperty ("type", lockedClient->externalSignaling ? "webrtc-answer" : "webrtc.answer");
            response->setProperty ("sdp", juce::String (answerSdp));
            response->setProperty ("descriptionType", juce::String (description.typeString()));
            response->setProperty ("offerGeneration", offerGeneration);
            if (lockedClient->signalId.isNotEmpty())
                response->setProperty ("signal_id", lockedClient->signalId);
            sendJson (lockedClient, jsonString (juce::var (response)));
        }
    });

    peer->onLocalCandidate ([this, weakClient, offerGeneration] (rtc::Candidate candidate)
    {
        if (auto lockedClient = weakClient.lock())
        {
            auto* candidateObject = new juce::DynamicObject();
            candidateObject->setProperty ("candidate", juce::String (std::string (candidate)));
            candidateObject->setProperty ("sdpMid", juce::String (candidate.mid()));

            auto* response = new juce::DynamicObject();
            response->setProperty ("type", lockedClient->externalSignaling ? "webrtc-candidate" : "webrtc.ice-candidate");
            response->setProperty ("candidate", juce::var (candidateObject));
            response->setProperty ("offerGeneration", offerGeneration);
            if (lockedClient->signalId.isNotEmpty())
                response->setProperty ("signal_id", lockedClient->signalId);
            sendJson (lockedClient, jsonString (juce::var (response)));
        }
    });

    peer->onStateChange ([this, weakClient] (rtc::PeerConnection::State state)
    {
        if (auto lockedClient = weakClient.lock())
        {
            auto* response = new juce::DynamicObject();
            response->setProperty ("type", "webrtc.state");
            response->setProperty ("state", static_cast<int> (state));
            response->setProperty ("offerGeneration", lockedClient->offerGeneration);
            sendJson (lockedClient, jsonString (juce::var (response)));
        }
    });

    client->peerConnection = peer;

    try
    {
        // Full offer SDP dump — critical for diagnosing m-line mismatches
        std::cout << "[KINGZ_SDP_OFFER_BEGIN offerGen=" << offerGeneration << "]\n"
                  << sdp.toStdString()
                  << "\n[KINGZ_SDP_OFFER_END]\n" << std::flush;

        // Flutter (the OFFERER) pre-creates "kingz-pcm" before generating its offer, so the
        // offer SDP already contains m=application. As the ANSWERER, we must receive that
        // channel via onDataChannel — NOT by calling createDataChannel ourselves.
        //
        // Why NOT createDataChannel here:
        //   The answerer's createDataChannel assigns EVEN SCTP stream IDs (0, 2, 4…).
        //   The offerer's channel uses ODD SCTP stream IDs (1, 3, 5…).
        //   They are completely separate streams — the plugin would be sending PCM on stream 0
        //   while Flutter's localDc listens on stream 1. No data would ever arrive.
        //
        // Why NOT call setLocalDescription() after setRemoteDescription():
        //   With disableAutoNegotiation=false, libdatachannel automatically generates and sends
        //   the answer when setRemoteDescription(offer) is called. An explicit setLocalDescription()
        //   afterward starts a NEW re-negotiation offer, fires onLocalDescription a second time,
        //   and the plugin sends a second "webrtc.answer" whose SDP is actually an offer — which
        //   corrupts the Flutter peer's session state.
        peer->onDataChannel ([this, weakClient] (std::shared_ptr<rtc::DataChannel> channel)
        {
            const auto label = channel->label();
            std::cout << "[KINGZ WEBRTC] onDataChannel: label=" << label
                      << " id=" << channel->id().value_or (-1)
                      << " isOpen=" << channel->isOpen() << "\n" << std::flush;

            if (label != "kingz-pcm")
            {
                std::cout << "[KINGZ WEBRTC] onDataChannel: unexpected label=" << label << " — ignoring\n" << std::flush;
                return;
            }

            const auto lockedClient = weakClient.lock();
            if (lockedClient == nullptr)
                return;

            channel->setBufferedAmountLowThreshold (pcmChunkBytes);
            lockedClient->pcmChannel = channel;

            // Build and send the webrtc.data-channel-open notification over the WebSocket.
            // Extracted as a named lambda so it can be called either immediately (if the channel
            // is already open when onDataChannel fires, which libdatachannel guarantees) or
            // deferred to onOpen as a safety net.
            auto notifyOpen = [this, weakClient]
            {
                if (auto lc = weakClient.lock())
                {
                    std::cout << "[KINGZ WEBRTC] kingz-pcm OPEN — sending webrtc.data-channel-open\n" << std::flush;
                    const auto currentChunkMs = targetChunkMs.load (std::memory_order_acquire);
                    const auto currentSampleRate = streamSampleRate.load (std::memory_order_acquire);
                    auto* response = new juce::DynamicObject();
                    response->setProperty ("type", "webrtc.data-channel-open");
                    response->setProperty ("label", "kingz-pcm");
                    response->setProperty ("format", "pcm_s16le");
                    response->setProperty ("sampleRate", currentSampleRate);
                    response->setProperty ("channels", AudioFifoWorker::inputChannels);
                    response->setProperty ("chunkMs", currentChunkMs);
                    response->setProperty ("framesPerChunk", static_cast<int> (AudioFifoWorker::bytesForChunkMs (currentChunkMs)
                                                                               / (AudioFifoWorker::inputChannels * sizeof (std::int16_t))));
                    response->setProperty ("bytesPerChunk", static_cast<int> (AudioFifoWorker::bytesForChunkMs (currentChunkMs)));
                    response->setProperty ("bitrate", pcmTelemetryBitrateBitsPerSecond);
                    response->setProperty ("ordered", false);
                    response->setProperty ("maxRetransmits", juce::var());
                    response->setProperty ("maxPacketLifeTimeMs", pcmMaxPacketLifetimeMs);
                    response->setProperty ("dropWhenBufferedBytesExceed",
                                          static_cast<int> (AudioFifoWorker::bytesForChunkMs (currentChunkMs) * 2));
                    response->setProperty ("adaptiveChunkSizing", true);
                    response->setProperty ("minChunkMs", AudioFifoWorker::minChunkDurationMs);
                    response->setProperty ("maxChunkMs", AudioFifoWorker::maxChunkDurationMs);
                    response->setProperty ("udpOnly", true);
                    response->setProperty ("jitterBuffer", "bypassed-data-channel");
                    response->setProperty ("signalProcessing", "disabled-raw-pcm");
                    response->setProperty ("webrtcMtuBytes", lanOptimisedWebRtcMtuBytes);
                    sendJson (lc, jsonString (juce::var (response)));
                }
            };

            // libdatachannel documents that onDataChannel fires after DATA_CHANNEL_ACK is sent,
            // meaning the channel is already open. Call notifyOpen immediately; register onOpen
            // as a fallback in case the state transition hasn't completed yet.
            if (channel->isOpen())
                notifyOpen();
            else
                channel->onOpen (notifyOpen);

            channel->onClosed ([weakClient]
            {
                std::cout << "[KINGZ WEBRTC] kingz-pcm channel CLOSED\n" << std::flush;
                if (auto lc = weakClient.lock())
                    lc->pcmChannel.reset();
            });

            channel->onError ([] (const std::string& err)
            {
                std::cout << "[KINGZ WEBRTC] kingz-pcm channel ERROR: " << err << "\n" << std::flush;
            });
        });

        // --- Opus audio-track transport (low-latency mode), added BEFORE setRemoteDescription ---
        // If the offer carries an m=audio line, the receiver chose the Opus transport. As the
        // answerer we add a matching SEND-ONLY Opus track now, so libdatachannel reflects m=audio
        // (send-only) into the auto-generated answer with the SAME mid as the offer. When there is
        // no audio m-line (PCM mode / today's clients) this is skipped and the data-channel path is
        // byte-for-byte unchanged.
        if (const auto audioMid = extractOfferAudioMid (sdp); audioMid.isNotEmpty())
        {
            try
            {
                rtc::Description::Audio media (audioMid.toStdString(), rtc::Description::Direction::SendOnly);
                media.addOpusCodec (opusPayloadType);
                media.addSSRC (opusTrackSsrc, "kingz-opus");

                auto track = peer->addTrack (media);
                auto rtpConfig = std::make_shared<rtc::RtpPacketizationConfig> (
                    opusTrackSsrc, "kingz-opus", static_cast<std::uint8_t> (opusPayloadType),
                    rtc::OpusRtpPacketizer::DefaultClockRate);
                track->setMediaHandler (std::make_shared<rtc::OpusRtpPacketizer> (rtpConfig));

                client->opusTrack = track;
                client->opusRtpConfig = rtpConfig;
                std::cout << "[KINGZ WEBRTC] Opus mode: send-only Opus track added (mid=" << audioMid
                          << " pt=" << opusPayloadType << " ssrc=" << opusTrackSsrc << ")\n" << std::flush;
            }
            catch (const std::exception& opusError)
            {
                std::cout << "[KINGZ WEBRTC] Opus track setup FAILED: " << opusError.what() << "\n" << std::flush;
            }
        }

        // Process the offer. disableAutoNegotiation=false means libdatachannel auto-generates
        // the answer, fires onLocalDescription, and sends it — no setLocalDescription() needed.
        peer->setRemoteDescription (rtc::Description (sdp.toStdString(), "offer"));
    }
    catch (const std::exception& error)
    {
        auto* response = new juce::DynamicObject();
        response->setProperty ("type", "webrtc.error");
        response->setProperty ("message", "peer_connection_offer_failed");
        response->setProperty ("detail", error.what());
        response->setProperty ("offerGeneration", offerGeneration);
        sendJson (client, jsonString (juce::var (response)));
        closePeerConnection (*client);
    }
}

void NetworkTransmitter::closePeerConnection (ClientConnection& client)
{
    if (client.pcmChannel != nullptr)
    {
        try
        {
            client.pcmChannel->close();
        }
        catch (const std::exception&)
        {
        }

        client.pcmChannel.reset();
    }

    client.opusTrack.reset();
    client.opusRtpConfig.reset();

    if (client.peerConnection != nullptr)
    {
        try
        {
            client.peerConnection->close();
        }
        catch (const std::exception&)
        {
        }

        client.peerConnection.reset();
    }
}

void NetworkTransmitter::adaptPacketSize()
{
    // PINNED to the minimum chunk size (5ms). Growing chunks 5→20ms under "stress" made
    // delivery chunkier/burstier — the opposite of what we want now that the receiver absorbs
    // latency. And since bufferHealth is measured against the raised drop ceiling, the old
    // health-driven growth would misbehave. Smaller, even 5ms chunks = smoothest stream.
    // (Kept as a function/no-op-style pin so the call site and transition signalling stay intact.)
    if (targetChunkMs.load (std::memory_order_acquire) != AudioFifoWorker::minChunkDurationMs)
    {
        targetChunkMs.store (AudioFifoWorker::minChunkDurationMs, std::memory_order_release);
        chunkSizeTransitionPending.store (true, std::memory_order_release);
    }
}

void NetworkTransmitter::pumpPcmOnce()
{
    // Send AT MOST one ready chunk per wake — a scheduling backlog drains as a gentle
    // catch-up (≤1 chunk/ms), never an all-at-once burst. (Previously a while-loop drained
    // the whole FIFO each pass, so any thread stall became a delivery burst.)
    AudioFifoWorker::DynamicPcmChunk chunk {};
    if (fifo.readPcmChunk (chunk, targetChunkMs))
        broadcastPcmChunk (chunk);
}

void NetworkTransmitter::PcmSenderThread::run()
{
    // Even-paced PCM drain, independent of the main thread's HTTP/WS/signaling/JSON work.
    while (! threadShouldExit() && owner.shouldListen.load (std::memory_order_acquire))
    {
        owner.pumpPcmOnce();
        wait (1);  // ~1ms wake; chunks arrive ~every 5ms → steady ~1 send / 5ms
    }
}

void NetworkTransmitter::broadcastPcmChunk (const AudioFifoWorker::DynamicPcmChunk& chunk)
{
    const juce::ScopedLock lock { clientLock };
    const auto chunkFrames = static_cast<int> (chunk.byteCount
        / (AudioFifoWorker::inputChannels * sizeof (std::int16_t)));

    // Measure health against the (raised) drop ceiling so it stays meaningful — otherwise
    // normal buffering above the old 10ms would peg health at 0 and mislead telemetry.
    const auto srForHealth = streamSampleRate.load (std::memory_order_acquire);
    const auto bytesPerMsForHealth = juce::jmax (1, srForHealth * AudioFifoWorker::inputChannels
                                                    * static_cast<int> (sizeof (std::int16_t)) / 1000);
    const auto dropCeilingBytes = static_cast<std::size_t> (bytesPerMsForHealth)
                                  * static_cast<std::size_t> (pcmDropCeilingMs);

    auto openPcmClientCount = 0;
    auto worstBufferedBytes = std::size_t { 0 };
    auto criticalClientsCount = 0;

    for (auto& client : clients)
    {
        if (client == nullptr)
            continue;

        // Only include clients with open channels in health calculation (exclude still-negotiating clients)
        if (auto channel = client->pcmChannel; channel != nullptr && channel->isOpen())
        {
            ++openPcmClientCount;
            const auto clientBuffered = channel->bufferedAmount();
            worstBufferedBytes = std::max (worstBufferedBytes, clientBuffered);

            // Count clients approaching the drop ceiling (>half of it)
            if (clientBuffered > dropCeilingBytes / 2)
                ++criticalClientsCount;
        }

        trySendPcmChunk (*client, chunk);
    }

    // --- Opus audio-track transport: encode the shared stream once per 20 ms frame and fan it out
    // to every client with an open send-only Opus track. Skipped (zero cost) when no client is in
    // Opus mode, so the PCM path above is unaffected. Placed BEFORE the no-PCM-clients early return
    // below, because in pure-Opus mode there are no open PCM channels. ---
    bool anyOpusClient = false;
    for (auto& client : clients)
        if (client != nullptr && client->opusTrack != nullptr && client->opusTrack->isOpen())
        {
            anyOpusClient = true;
            break;
        }

    if (anyOpusClient)
    {
        if (opusEncode == nullptr)
            opusEncode = std::make_unique<OpusEncodeState>();

        opusEncode->process (chunk.bytes.data(), chunk.byteCount,
                             streamSampleRate.load (std::memory_order_acquire),
                             [this] (const std::byte* data, std::size_t len)
        {
            for (auto& opusClient : clients)
            {
                if (opusClient == nullptr || opusClient->opusTrack == nullptr
                    || ! opusClient->opusTrack->isOpen())
                    continue;
                if (opusClient->opusRtpConfig != nullptr)
                    opusClient->opusRtpConfig->timestamp += OpusEncodeState::kFrameSamples;
                try { opusClient->opusTrack->send (data, len); }
                catch (const std::exception&) {}
            }
        });
    }
    else if (opusEncode != nullptr)
    {
        opusEncode.reset();  // no Opus clients → drop encoder + resampler state (fresh on next join)
    }

    // If no clients have open PCM channels yet, health is perfect
    if (openPcmClientCount == 0)
    {
        bufferHealth.store (1.0f, std::memory_order_release);
        return;
    }

    // Health = 1.0 - (ratio of buffer used on worst client), measured against the drop ceiling.
    // This excludes clients still in WebRTC negotiation.
    const auto maxBufferedBytes = dropCeilingBytes;
    const auto ratio = static_cast<float> (worstBufferedBytes)
        / static_cast<float> (maxBufferedBytes);

    const auto health = juce::jlimit (0.0f, 1.0f, 1.0f - ratio);
    bufferHealth.store (health, std::memory_order_release);

    // Log when health degrades below 80% (critical threshold)
    if (health < 0.8f && health > 0.0f)
    {
        static auto lastLogTimeMs = juce::Time::getCurrentTime().toMilliseconds();
        const auto nowMs = juce::Time::getCurrentTime().toMilliseconds();

        // Rate-limit logging to once per second to avoid spam
        if (nowMs - lastLogTimeMs > 1000)
        {
            lastLogTimeMs = nowMs;
            const auto healthPercent = static_cast<int> (health * 100.0f);
            juce::Logger::writeToLog (
                juce::String ("BUFFER_HEALTH_WARN: health=") + juce::String (healthPercent) + "%"
                + " worstClient=" + juce::String (static_cast<int> (worstBufferedBytes)) + "B"
                + " clients=" + juce::String (openPcmClientCount)
                + " critical=" + juce::String (criticalClientsCount)
                + " dropped=" + juce::String (droppedPacketCount.load (std::memory_order_acquire))
            );
        }
    }

    chunkSizeTransitionPending.store (false, std::memory_order_release);
    streamTransmitSamplePosition.fetch_add (chunkFrames, std::memory_order_release);
    // transport.sync is now broadcast from the main signaling thread (off the PCM path).
}

void NetworkTransmitter::maybeBroadcastTransportSync (int chunkFrames)
{
    const auto nowMs = juce::Time::currentTimeMillis();
    if (nowMs - lastTransportSyncMs < 100)
        return;

    lastTransportSyncMs = nowMs;

    const auto sampleRate = streamSampleRate.load (std::memory_order_acquire);
    const auto streamTransmitPosition = streamTransmitSamplePosition.load (std::memory_order_acquire);
    const auto hostSamplePosition = hostTransportSamplePosition.load (std::memory_order_acquire);
    const auto streamWritePosition = streamWriteSamplePosition.load (std::memory_order_acquire);
    const auto bpmX100 = hostTempoBpmX100.load (std::memory_order_acquire);
    const auto ppqX1000 = hostPpqPositionX1000.load (std::memory_order_acquire);
    const auto sequence = transportSyncSequence.fetch_add (1, std::memory_order_relaxed) + 1;

    auto* response = new juce::DynamicObject();
    response->setProperty ("type", "transport.sync");
    response->setProperty ("sequence", sequence);
    response->setProperty ("sentAtMs", nowMs);
    response->setProperty ("sampleRate", sampleRate);
    response->setProperty ("chunkFrames", chunkFrames);
    response->setProperty ("streamSamplePosition", streamTransmitPosition);
    response->setProperty ("streamWriteSamplePosition", streamWritePosition);
    response->setProperty ("hostSamplePosition", hostSamplePosition);
    response->setProperty ("hostPlaying", hostTransportPlaying.load (std::memory_order_acquire));
    response->setProperty ("hostTimeSeconds",
                           sampleRate > 0 ? static_cast<double> (hostSamplePosition) / static_cast<double> (sampleRate) : 0.0);
    response->setProperty ("bpm", static_cast<double> (bpmX100) / 100.0);
    response->setProperty ("ppqPosition", static_cast<double> (ppqX1000) / 1000.0);
    response->setProperty ("targetLeadMs", 80);
    response->setProperty ("syncMode", "sideband-low-rate");

    const auto json = jsonString (juce::var (response));

    for (auto& client : clients)
    {
        if (client != nullptr
            && client->websocket
            && ! client->closeRequested.load (std::memory_order_acquire)
            && client->pcmChannel != nullptr
            && client->pcmChannel->isOpen())
        {
            sendJson (*client, json);
        }
    }
}

void NetworkTransmitter::maybeBroadcastTransportState()
{
    const auto nowMs = juce::Time::currentTimeMillis();
    const auto hostPlaying = hostTransportPlaying.load (std::memory_order_acquire);
    const auto stateChanged = hostPlaying != lastBroadcastHostPlaying;

    if (! stateChanged && nowMs - lastTransportStateBroadcastMs < (hostPlaying ? 250 : 1000))
        return;

    lastTransportStateBroadcastMs = nowMs;
    lastBroadcastHostPlaying = hostPlaying;

    const auto sampleRate = streamSampleRate.load (std::memory_order_acquire);
    const auto hostSamplePosition = hostTransportSamplePosition.load (std::memory_order_acquire);
    const auto streamWritePosition = streamWriteSamplePosition.load (std::memory_order_acquire);
    const auto bpmX100 = hostTempoBpmX100.load (std::memory_order_acquire);
    const auto ppqX1000 = hostPpqPositionX1000.load (std::memory_order_acquire);
    const auto sequence = transportStateSequence.fetch_add (1, std::memory_order_relaxed) + 1;

    auto* response = new juce::DynamicObject();
    response->setProperty ("type", "transport.state");
    response->setProperty ("sequence", sequence);
    response->setProperty ("sentAtMs", nowMs);
    response->setProperty ("stateChanged", stateChanged);
    response->setProperty ("hostPlaying", hostPlaying);
    response->setProperty ("sampleRate", sampleRate);
    response->setProperty ("hostSamplePosition", hostSamplePosition);
    response->setProperty ("streamWriteSamplePosition", streamWritePosition);
    response->setProperty ("hostTimeSeconds",
                           sampleRate > 0 ? static_cast<double> (hostSamplePosition) / static_cast<double> (sampleRate) : 0.0);
    response->setProperty ("bpm", static_cast<double> (bpmX100) / 100.0);
    response->setProperty ("ppqPosition", static_cast<double> (ppqX1000) / 1000.0);

    const auto json = jsonString (juce::var (response));
    const juce::ScopedLock lock { clientLock };

    for (auto& client : clients)
    {
        if (client != nullptr
            && client->websocket
            && ! client->closeRequested.load (std::memory_order_acquire))
        {
            sendJson (*client, json);
        }
    }
}

void NetworkTransmitter::setTransportMode (int mode)
{
    // Source of truth for the broadcast codec. Called from the message thread (editor UI).
    const int clamped = (mode == 1) ? 1 : 0;
    const int previous = transportMode.exchange (clamped, std::memory_order_acq_rel);
    if (previous != clamped)
        broadcastTransportMode();  // tell already-connected listeners to auto-follow
}

void NetworkTransmitter::broadcastTransportMode()
{
    auto* msg = new juce::DynamicObject();
    msg->setProperty ("type", "transport.mode");
    msg->setProperty ("transport", transportMode.load (std::memory_order_acquire) == 1 ? "opus" : "pcm");
    const auto json = jsonString (juce::var (msg));

    const juce::ScopedLock lock { clientLock };

    for (auto& client : clients)
    {
        if (client != nullptr
            && client->websocket
            && ! client->closeRequested.load (std::memory_order_acquire))
        {
            sendJson (*client, json);
        }
    }
}

juce::String NetworkTransmitter::getStreamName() const
{
    const juce::ScopedLock lock { streamNameLock };
    return streamName;
}

void NetworkTransmitter::setStreamName (const juce::String& name)
{
    // Source of truth for the broadcast display name (LISTENTO parity). Called from the message
    // thread (editor UI). Blank falls back to the default.
    const auto trimmed = name.trim();
    const auto finalName = trimmed.isNotEmpty() ? trimmed : juce::String ("Kingz Listen");
    bool changed = false;
    {
        const juce::ScopedLock lock { streamNameLock };
        if (streamName != finalName)
        {
            streamName = finalName;
            changed = true;
        }
    }
    if (changed)
        broadcastStreamName();  // tell already-connected receivers to inherit the new name
}

void NetworkTransmitter::broadcastStreamName()
{
    auto* msg = new juce::DynamicObject();
    msg->setProperty ("type", "stream.name");
    msg->setProperty ("name", getStreamName());
    const auto json = jsonString (juce::var (msg));

    const juce::ScopedLock lock { clientLock };

    for (auto& client : clients)
    {
        if (client != nullptr
            && client->websocket
            && ! client->closeRequested.load (std::memory_order_acquire))
        {
            sendJson (*client, json);
        }
    }
}

bool NetworkTransmitter::trySendPcmChunk (ClientConnection& client,
                                          const AudioFifoWorker::DynamicPcmChunk& chunk) noexcept
{
    if (! client.websocket || client.closeRequested.load (std::memory_order_acquire))
        return false;

    auto channel = client.pcmChannel;
    if (channel == nullptr || ! channel->isOpen())
        return false;

    const auto bufferedAmount = channel->bufferedAmount();

    // Drop ceiling in bytes, rate-accurate for pcmDropCeilingMs of audio at the live stream
    // rate (handles 44.1/48/88.2/96k without pinning a value).
    const auto sr = streamSampleRate.load (std::memory_order_acquire);
    const auto bytesPerMs = juce::jmax (1, sr * AudioFifoWorker::inputChannels
                                           * static_cast<int> (sizeof (std::int16_t)) / 1000);
    const auto dropCeilingBytes = static_cast<std::size_t> (bytesPerMs)
                                  * static_cast<std::size_t> (pcmDropCeilingMs);

    // LAST-RESORT drop ONLY. The old design dropped at 10ms buffered ("prefer a click over
    // latency"), which punched a hole in the stream on every minor link stall — the receiver
    // hears those gaps as the periodic click. The receiver now absorbs latency (adaptive
    // jitter buffer + ±2% drift catch-up); it cannot recover dropped samples. So we let the
    // SCTP buffer ride through normal stalls and drop only when it genuinely runs away
    // (>pcmDropCeilingMs ≈ link effectively dead), which also caps memory/latency.
    if (bufferedAmount > dropCeilingBytes)
    {
        droppedPacketCount.fetch_add (1, std::memory_order_relaxed);
        if (bufferHealthAlert.load (std::memory_order_acquire) == 0)
        {
            bufferHealthAlert.store (1, std::memory_order_release);
            juce::Logger::writeToLog (
                juce::String ("PCM_DROP (runaway): buffered=") + juce::String (static_cast<int> (bufferedAmount))
                + "B > ceiling=" + juce::String (static_cast<int> (dropCeilingBytes))
                + "B (" + juce::String (pcmDropCeilingMs) + "ms) link stalled; dropCount="
                + juce::String (droppedPacketCount.load (std::memory_order_acquire))
            );
        }
        return false;
    }

    // Recovered: clear the alert once the buffer drains back under a quarter of the ceiling.
    if (bufferedAmount < dropCeilingBytes / 4 && bufferHealthAlert.load (std::memory_order_acquire) != 0)
    {
        bufferHealthAlert.store (0, std::memory_order_release);
        juce::Logger::writeToLog (
            juce::String ("PCM_DROP_RECOVERED: buffered=") + juce::String (static_cast<int> (bufferedAmount)) + "B"
        );
    }

    try
    {
        return channel->send (reinterpret_cast<const rtc::byte*> (chunk.bytes.data()), chunk.byteCount);
    }
    catch (const std::exception&)
    {
        return false;
    }
}

bool NetworkTransmitter::isClientReadyForPcm (const ClientConnection& client) noexcept
{
    // Client is ready for PCM if:
    // 1. Not closed
    // 2. Has an open PCM data channel
    if (client.closeRequested.load (std::memory_order_acquire))
        return false;

    auto channel = client.pcmChannel;
    return channel != nullptr && channel->isOpen();
}

void NetworkTransmitter::sendJson (ClientConnection& client, const juce::String& json)
{
    const auto payload = toExactUtf8Bytes (withKingzListenSourceId (json));

    if (client.externalSignaling)
    {
        std::function<void (const juce::String&)> sender;
        {
            const juce::ScopedLock lock { externalSignalingLock };
            sender = externalSignalingSender;
        }

        if (sender != nullptr)
            sender (juce::String::fromUTF8 (reinterpret_cast<const char*> (payload.data()),
                                            static_cast<int> (payload.size())));
        return;
    }

    sendWebSocketFrame (client, payload, 0x1);
}

void NetworkTransmitter::sendJson (const std::shared_ptr<ClientConnection>& client, const juce::String& json)
{
    if (client != nullptr && client->websocket && ! client->closeRequested.load (std::memory_order_acquire))
        sendJson (*client, json);
}

void NetworkTransmitter::sendHttpResponse (ClientConnection& client,
                                           const juce::String& contentType,
                                           const juce::String& body)
{
    const auto response = "HTTP/1.1 200 OK\r\nContent-Type: " + contentType
        + "\r\nContent-Length: " + juce::String (exactUtf8ByteCount (body))
        + "\r\nConnection: close\r\n\r\n" + body;
    sendRaw (client.socket, response.toRawUTF8(), exactUtf8ByteCount (response));
}

void NetworkTransmitter::sendWebSocketFrame (ClientConnection& client,
                                             const std::vector<std::uint8_t>& payload,
                                             std::uint8_t opcode)
{
    std::vector<std::uint8_t> frame;
    frame.reserve (payload.size() + 10);
    frame.push_back (static_cast<std::uint8_t> (0x80u | opcode));

    if (payload.size() < 126)
    {
        frame.push_back (static_cast<std::uint8_t> (payload.size()));
    }
    else
    {
        frame.push_back (126);
        frame.push_back (static_cast<std::uint8_t> ((payload.size() >> 8u) & 0xffu));
        frame.push_back (static_cast<std::uint8_t> (payload.size() & 0xffu));
    }

    frame.insert (frame.end(), payload.begin(), payload.end());

    const std::scoped_lock lock { client.sendMutex };
    sendRaw (client.socket, frame.data(), frame.size());
}

void NetworkTransmitter::setNonBlocking (NativeSocket socketHandle)
{
   #if JUCE_WINDOWS
    u_long mode = 1;
    ioctlsocket (socketHandle, FIONBIO, &mode);
   #else
    const auto flags = fcntl (socketHandle, F_GETFL, 0);
    if (flags >= 0)
        fcntl (socketHandle, F_SETFL, flags | O_NONBLOCK);
   #endif
}

void NetworkTransmitter::closeSocket (NativeSocket& socketHandle)
{
    if (socketHandle == invalidSocket)
        return;

   #if JUCE_WINDOWS
    closesocket (socketHandle);
   #else
    ::close (socketHandle);
   #endif
    socketHandle = invalidSocket;
}

void NetworkTransmitter::sendRaw (NativeSocket socketHandle, const void* data, std::size_t byteCount)
{
    const auto* bytes = static_cast<const char*> (data);
    std::size_t sent = 0;

    while (sent < byteCount)
    {
       #if JUCE_WINDOWS
        const auto result = ::send (socketHandle,
                                    bytes + sent,
                                    static_cast<int> (byteCount - sent),
                                    0);
       #else
        const auto result = ::send (socketHandle, bytes + sent, byteCount - sent, 0);
       #endif
        if (result <= 0)
            return;

        sent += static_cast<std::size_t> (result);
    }
}

juce::String NetworkTransmitter::createWebSocketAcceptKey (const juce::String& key)
{
    return sha1Base64 (key + websocketGuid);
}

juce::String NetworkTransmitter::sha1Base64 (const juce::String& input)
{
    return base64Encode (sha1Digest (input));
}

juce::String NetworkTransmitter::jsonString (const juce::var& value)
{
    return juce::JSON::toString (value, true);
}

void NetworkTransmitter::closeAllClients()
{
    const juce::ScopedLock lock { clientLock };

    for (auto& client : clients)
    {
        closePeerConnection (*client);
        closeSocket (client->socket);
    }

    clients.clear();
    externalSignalingClient.reset();
    connectedClients.store (0, std::memory_order_release);
    activeClientCount.store (0, std::memory_order_release);
    isConnected.store (false, std::memory_order_release);
    bufferHealth.store (1.0f, std::memory_order_release);
    targetChunkMs.store (AudioFifoWorker::chunkDurationMs, std::memory_order_release);
    chunkSizeTransitionPending.store (false, std::memory_order_release);
}
