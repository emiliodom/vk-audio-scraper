const fs = require("fs");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");
const { chromium } = require("playwright");

// VK audio scraper quick usage:
// 1) First full pass over the loaded list:
//    node vk_audio_scraper.js --capture-urls --download --record-fallback --profile-dir vk_profile --out vk_audios_final.json
// 2) Resume by page title (example PAGE 32 downwards):
//    node vk_audio_scraper.js --capture-urls --download --record-fallback --start-page 32 --profile-dir vk_profile --out vk_audios_resume.json
// 3) Resume by list index (0-based):
//    node vk_audio_scraper.js --capture-urls --download --record-fallback --start-index 50 --profile-dir vk_profile

let STOP_REQUESTED = false;

function parseArgs(argv) {
    const args = {
        url: "https://m.vk.com/audios-43391401",
        out: "vk_audios.json",
        stateFile: "vk_storage_state.json",
        saveState: true,
        profileDir: "vk_profile",
        captureTimeoutMs: 12000,
        downloadsDir: "downloads",
        maxScrolls: 10,
        delayMs: 1200,
        captureUrls: false,
        downloadFiles: false,
        recordFallback: false,
        recordOnly: false,
        playLimit: null,
        startIndex: 0,
        startPage: null,
        playWaitMs: 2200,
        recordMaxMs: 45000,
        headless: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];

        if (token === "--url" && argv[i + 1]) args.url = argv[++i];
        else if (token === "--out" && argv[i + 1]) args.out = argv[++i];
        else if (token === "--state-file" && argv[i + 1]) args.stateFile = argv[++i];
        else if (token === "--no-save-state") args.saveState = false;
        else if (token === "--profile-dir" && argv[i + 1]) args.profileDir = argv[++i];
        else if (token === "--capture-timeout-ms" && argv[i + 1]) args.captureTimeoutMs = Number(argv[++i]);
        else if (token === "--downloads-dir" && argv[i + 1]) args.downloadsDir = argv[++i];
        else if (token === "--max-scrolls" && argv[i + 1]) args.maxScrolls = Number(argv[++i]);
        else if (token === "--delay-ms" && argv[i + 1]) args.delayMs = Number(argv[++i]);
        else if (token === "--capture-urls") args.captureUrls = true;
        else if (token === "--download") args.downloadFiles = true;
        else if (token === "--record-fallback") args.recordFallback = true;
        else if (token === "--record-only") {
            args.recordOnly = true;
            args.recordFallback = true;
            args.downloadFiles = false;
        } else if (token === "--play-limit" && argv[i + 1]) args.playLimit = Math.max(0, Number(argv[++i]) || 0);
        else if (token === "--start-index" && argv[i + 1]) args.startIndex = Math.max(0, Number(argv[++i]) || 0);
        else if (token === "--start-page" && argv[i + 1]) args.startPage = Number(argv[++i]);
        else if (token === "--play-wait-ms" && argv[i + 1]) args.playWaitMs = Number(argv[++i]);
        else if (token === "--record-max-ms" && argv[i + 1]) args.recordMaxMs = Number(argv[++i]);
        else if (token === "--headless") args.headless = true;
    }

    return args;
}

function getContextOptions(options) {
    const ctxOptions = {};
    const statePath = path.resolve(process.cwd(), options.stateFile);

    if (fs.existsSync(statePath)) {
        ctxOptions.storageState = statePath;
        console.log(`Loaded saved session state from: ${statePath}`);
    }

    return ctxOptions;
}

function registerSignalHandlers() {
    process.on("SIGINT", () => {
        if (!STOP_REQUESTED) {
            STOP_REQUESTED = true;
            console.log("Stop requested. Finishing current track and saving current progress...");
            return;
        }

        console.log("Force stopping now.");
        process.exit(130);
    });
}

function waitForEnter(promptText) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        rl.question(promptText, () => {
            rl.close();
            resolve();
        });
    });
}

async function autoScroll(page, maxScrolls, delayMs) {
    let lastCount = 0;
    let stagnantRounds = 0;

    for (let i = 0; i < maxScrolls; i += 1) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(delayMs);

        const count = await page.locator(".audio_item").count();
        if (count === lastCount) stagnantRounds += 1;
        else stagnantRounds = 0;

        lastCount = count;
        if (stagnantRounds >= 2) break;
    }
}

function normalizeTrack(row) {
    const raw = row.parsed;
    const ownerId = raw?.[1] ?? null;
    const audioId = raw?.[0] ?? null;
    const contentId =
        row.dataId || raw?.[15]?.content_id || (ownerId !== null && audioId !== null ? `${ownerId}_${audioId}` : null);

    return {
        content_id: contentId,
        owner_id: ownerId,
        audio_id: audioId,
        title: raw?.[3] ?? row.titleText ?? null,
        artist: raw?.[4] ?? row.artistText ?? null,
        duration_sec: raw?.[5] ?? null,
        raw_stream_token: raw?.[13] ?? null,
        access_token: raw?.[20] ?? null,
        direct_url: null,
        captured_urls: [],
        downloaded_file: null,
        download_method: null,
        download_status: "not_attempted",
        download_error: null,
        data_audio_raw: row.dataAudio,
    };
}

function sanitizeFilePart(value) {
    return String(value || "track")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
}

function extensionFrom(url, contentType) {
    const loweredUrl = (url || "").toLowerCase();
    const loweredCt = (contentType || "").toLowerCase();

    if (loweredUrl.includes(".mp3") || loweredCt.includes("audio/mpeg")) return ".mp3";
    if (loweredUrl.includes(".m4a") || loweredCt.includes("audio/mp4")) return ".m4a";
    if (loweredUrl.includes(".ogg") || loweredCt.includes("audio/ogg")) return ".ogg";
    if (loweredUrl.includes(".webm") || loweredCt.includes("audio/webm")) return ".webm";
    if (loweredUrl.includes(".m3u8") || loweredCt.includes("application/vnd.apple.mpegurl")) return ".m3u8";
    return ".bin";
}

function isLikelyHtmlBody(bodyBuffer) {
    if (!bodyBuffer || bodyBuffer.length === 0) return false;
    const probe = bodyBuffer.subarray(0, Math.min(256, bodyBuffer.length)).toString("utf8").toLowerCase();
    return probe.includes("<!doctype html") || probe.includes("<html") || probe.includes("<head");
}

function isLikelyAudioPayload(contentType, bodyBuffer, url) {
    const ct = (contentType || "").toLowerCase();
    const loweredUrl = (url || "").toLowerCase();

    if (ct.startsWith("audio/")) return true;
    if (ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl")) return true;
    if (
        loweredUrl.includes(".mp3") ||
        loweredUrl.includes(".m4a") ||
        loweredUrl.includes(".ogg") ||
        loweredUrl.includes(".webm")
    ) {
        return !isLikelyHtmlBody(bodyBuffer);
    }
    if (loweredUrl.includes(".m3u8")) return true;

    return false;
}

function addHit(hitMap, contentId, url) {
    if (!contentId || !url) return;
    if (!hitMap.has(contentId)) hitMap.set(contentId, new Set());
    hitMap.get(contentId).add(url);
}

function urlLooksLikeMedia(url) {
    if (!url) return false;

    const lowered = url.toLowerCase();
    return (
        lowered.includes(".mp3") ||
        lowered.includes(".m3u8") ||
        lowered.includes(".m4a") ||
        lowered.includes(".ts") ||
        lowered.includes(".aac") ||
        lowered.includes("vkuseraudio.net") ||
        lowered.includes("/stream") ||
        lowered.includes("/audio") ||
        lowered.includes("audio_api_unavailable")
    );
}

function urlScore(url) {
    const lowered = String(url || "").toLowerCase();
    if (lowered.includes(".m3u8")) return 100;
    if (lowered.includes(".mp3") || lowered.includes(".m4a") || lowered.includes(".ogg") || lowered.includes(".webm"))
        return 95;
    if (lowered.includes("vkuseraudio.net")) return 90;
    if (lowered.includes("/audio?act=reload_audios")) return 5;
    if (lowered.endsWith("/audio") || lowered.includes("m.vk.com/audio")) return 1;
    if (urlLooksLikeMedia(lowered)) return 40;
    return 10;
}

function sortUrlsByPriority(urls) {
    return Array.from(urls).sort((a, b) => urlScore(b) - urlScore(a));
}

function isGenericVkAudioEndpoint(url) {
    const lowered = String(url || "").toLowerCase();
    return (
        lowered.includes("m.vk.com/audio?act=reload_audios") ||
        lowered.endsWith("/audio") ||
        lowered.includes("m.vk.com/audio")
    );
}

function getDownloadableUrls(urls) {
    return sortUrlsByPriority(urls).filter((url) => !url.startsWith("blob:") && !isGenericVkAudioEndpoint(url));
}

function isStrongAudioUrl(url) {
    const lowered = String(url || "").toLowerCase();
    return (
        lowered.includes("vkuseraudio.net") ||
        lowered.includes(".m3u8") ||
        lowered.includes(".mp3") ||
        lowered.includes(".ts")
    );
}

function mergeCaptureResults(tracks, captureHits) {
    const grouped = new Map();

    for (const hit of captureHits) {
        if (!grouped.has(hit.content_id)) grouped.set(hit.content_id, []);
        grouped.get(hit.content_id).push(hit.url);
    }

    return tracks.map((track) => {
        const urls = Array.from(new Set(grouped.get(track.content_id) || []));
        const sortedUrls = sortUrlsByPriority(urls);
        return {
            ...track,
            captured_urls: sortedUrls,
            direct_url: sortedUrls[0] || null,
        };
    });
}

async function collectDomMediaUrls(page) {
    return page
        .evaluate(() => {
            const urls = new Set();

            const pushIfUrl = (value) => {
                if (typeof value !== "string") return;
                if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("blob:")) {
                    urls.add(value);
                }
            };

            for (const media of document.querySelectorAll("audio,video,source")) {
                pushIfUrl(media.currentSrc);
                pushIfUrl(media.src);
            }

            const walk = (obj, depth) => {
                if (!obj || depth <= 0) return;
                if (typeof obj === "string") {
                    pushIfUrl(obj);
                    return;
                }
                if (typeof obj !== "object") return;

                const keys = Object.keys(obj).slice(0, 200);
                for (const key of keys) {
                    try {
                        walk(obj[key], depth - 1);
                    } catch (_error) {
                        // Ignore cross-object access issues.
                    }
                }
            };

            if (typeof window.audioplayer === "object" && window.audioplayer) {
                walk(window.audioplayer, 3);
            }

            return Array.from(urls);
        })
        .catch(() => []);
}

async function tryDownloadUrl(context, url, track, outDir, index) {
    if (!url || url.startsWith("blob:")) {
        return { ok: false, reason: "blob_or_empty_url" };
    }

    try {
        const response = await context.request.get(url, {
            failOnStatusCode: false,
            timeout: 30000,
        });

        if (!response.ok()) {
            return { ok: false, reason: `http_${response.status()}` };
        }

        const contentType = (response.headers()["content-type"] || "").toLowerCase();
        const body = await response.body();

        if (!body || body.length === 0) {
            return { ok: false, reason: "empty_response" };
        }

        if (isLikelyHtmlBody(body)) {
            return { ok: false, reason: "html_instead_of_media" };
        }

        if (!isLikelyAudioPayload(contentType, body, url)) {
            return { ok: false, reason: `unsupported_content_type_${contentType || "unknown"}` };
        }

        const ext = extensionFrom(url, contentType);
        const baseName = sanitizeFilePart(
            `${String(index + 1).padStart(4, "0")}_${track.artist || "artist"}_${track.title || track.content_id || "track"}`,
        );
        const targetPath = path.resolve(outDir, `${baseName}${ext}`);

        fs.writeFileSync(targetPath, body);

        return {
            ok: true,
            filePath: targetPath,
            bytes: body.length,
            contentType,
            url,
        };
    } catch (error) {
        return { ok: false, reason: error?.message || "request_failed" };
    }
}

function m3u8SegmentUrls(playlistText, playlistUrl) {
    const lines = String(playlistText || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const variantCandidates = [];
    const mediaCandidates = [];
    let mediaSequence = 0;
    let segmentSequence = 0;
    let currentKey = { method: "NONE", uri: null, iv: null };

    const parseAttributes = (raw) => {
        const out = {};
        const re = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
        let match;
        while ((match = re.exec(String(raw || ""))) !== null) {
            const key = match[1];
            const valueRaw = match[2] || "";
            const value = valueRaw.startsWith('"') && valueRaw.endsWith('"') ? valueRaw.slice(1, -1) : valueRaw;
            out[key] = value;
        }
        return out;
    };

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.startsWith("#EXT-X-STREAM-INF")) {
            const nextLine = lines[i + 1];
            if (nextLine && !nextLine.startsWith("#")) variantCandidates.push(nextLine);
            continue;
        }

        if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
            mediaSequence = Number(line.split(":")[1]) || 0;
            segmentSequence = mediaSequence;
            continue;
        }

        if (line.startsWith("#EXT-X-KEY:")) {
            const attrs = parseAttributes(line.slice("#EXT-X-KEY:".length));
            const method = String(attrs.METHOD || "NONE").toUpperCase();
            if (method === "NONE") {
                currentKey = { method: "NONE", uri: null, iv: null };
            } else {
                currentKey = {
                    method,
                    uri: attrs.URI ? new URL(attrs.URI, playlistUrl).toString() : null,
                    iv: attrs.IV || null,
                };
            }
            continue;
        }

        if (!line.startsWith("#")) {
            mediaCandidates.push({
                url: new URL(line, playlistUrl).toString(),
                keyMethod: currentKey.method,
                keyUri: currentKey.uri,
                iv: currentKey.iv,
                sequence: segmentSequence,
            });
            segmentSequence += 1;
        }
    }

    if (variantCandidates.length > 0) {
        const bestVariant = variantCandidates[0];
        return {
            type: "variant",
            urls: [new URL(bestVariant, playlistUrl).toString()],
        };
    }

    return {
        type: "media",
        segments: mediaCandidates,
    };
}

async function downloadHlsToTs(context, m3u8Url, track, outDir, index) {
    try {
        let activePlaylistUrl = m3u8Url;
        let playlistBody = "";
        const keyCache = new Map();

        const parseIv = (ivRaw, sequence) => {
            if (ivRaw) {
                const hex = String(ivRaw).replace(/^0x/i, "");
                const iv = Buffer.from(hex.padStart(32, "0").slice(-32), "hex");
                if (iv.length === 16) return iv;
            }

            const iv = Buffer.alloc(16, 0);
            const seq = Number.isFinite(sequence) ? sequence : 0;
            iv.writeUInt32BE(Math.floor(seq / 0x100000000), 8);
            iv.writeUInt32BE(seq >>> 0, 12);
            return iv;
        };

        for (let depth = 0; depth < 3; depth += 1) {
            const playlistResponse = await context.request.get(activePlaylistUrl, {
                failOnStatusCode: false,
                timeout: 30000,
            });

            if (!playlistResponse.ok()) {
                return { ok: false, reason: `playlist_http_${playlistResponse.status()}` };
            }

            playlistBody = await playlistResponse.text();
            if (!playlistBody || isLikelyHtmlBody(Buffer.from(playlistBody))) {
                return { ok: false, reason: "playlist_html_instead_of_m3u8" };
            }

            const parsed = m3u8SegmentUrls(playlistBody, activePlaylistUrl);
            if (parsed.type === "variant" && parsed.urls[0]) {
                activePlaylistUrl = parsed.urls[0];
                continue;
            }

            const segments = parsed.segments;
            if (!segments || segments.length === 0) {
                return { ok: false, reason: "no_segments_found" };
            }

            const chunks = [];
            let totalBytes = 0;

            for (const segment of segments) {
                const segResponse = await context.request.get(segment.url, {
                    failOnStatusCode: false,
                    timeout: 30000,
                });

                if (!segResponse.ok()) {
                    return { ok: false, reason: `segment_http_${segResponse.status()}` };
                }

                let bytes = await segResponse.body();
                if (!bytes || bytes.length === 0) continue;

                if (segment.keyMethod === "AES-128" && segment.keyUri) {
                    let keyBytes = keyCache.get(segment.keyUri);
                    if (!keyBytes) {
                        const keyResponse = await context.request.get(segment.keyUri, {
                            failOnStatusCode: false,
                            timeout: 30000,
                        });

                        if (!keyResponse.ok()) {
                            return { ok: false, reason: `hls_key_http_${keyResponse.status()}` };
                        }

                        keyBytes = await keyResponse.body();
                        if (!keyBytes || keyBytes.length !== 16) {
                            return { ok: false, reason: "invalid_hls_key_length" };
                        }

                        keyCache.set(segment.keyUri, keyBytes);
                    }

                    const iv = parseIv(segment.iv, segment.sequence);
                    try {
                        const decipher = crypto.createDecipheriv("aes-128-cbc", keyBytes, iv);
                        bytes = Buffer.concat([decipher.update(bytes), decipher.final()]);
                    } catch (_error) {
                        return { ok: false, reason: "hls_decrypt_failed" };
                    }
                }

                chunks.push(bytes);
                totalBytes += bytes.length;
            }

            if (chunks.length === 0 || totalBytes === 0) {
                return { ok: false, reason: "empty_hls_segments" };
            }

            const baseName = sanitizeFilePart(
                `${String(index + 1).padStart(4, "0")}_${track.artist || "artist"}_${track.title || track.content_id || "track"}`,
            );
            const targetPath = path.resolve(outDir, `${baseName}.ts`);
            fs.writeFileSync(targetPath, Buffer.concat(chunks));

            return {
                ok: true,
                filePath: targetPath,
                bytes: totalBytes,
                contentType: "video/mp2t",
                url: m3u8Url,
            };
        }

        return { ok: false, reason: "playlist_variant_depth_exceeded" };
    } catch (error) {
        return { ok: false, reason: error?.message || "hls_download_failed" };
    }
}

function getCapturedSegmentUrls(urls) {
    const segmentUrls = Array.from(urls || []).filter((url) => /\/seg-\d+-[^/]*\.ts(\?|$)/i.test(String(url)));
    return segmentUrls.sort((a, b) => {
        const getNum = (value) => {
            const match = String(value).match(/\/seg-(\d+)-/i);
            return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
        };
        return getNum(a) - getNum(b);
    });
}

async function downloadCapturedSegmentsToTs(context, segmentUrls, track, outDir, index) {
    if (!segmentUrls || segmentUrls.length === 0) {
        return { ok: false, reason: "no_captured_segments" };
    }

    try {
        const chunks = [];
        let totalBytes = 0;

        for (const segmentUrl of segmentUrls) {
            const segResponse = await context.request.get(segmentUrl, {
                failOnStatusCode: false,
                timeout: 30000,
            });

            if (!segResponse.ok()) {
                return { ok: false, reason: `captured_segment_http_${segResponse.status()}` };
            }

            const bytes = await segResponse.body();
            if (!bytes || bytes.length === 0) continue;

            chunks.push(bytes);
            totalBytes += bytes.length;
        }

        if (chunks.length === 0 || totalBytes === 0) {
            return { ok: false, reason: "captured_segments_empty" };
        }

        const baseName = sanitizeFilePart(
            `${String(index + 1).padStart(4, "0")}_${track.artist || "artist"}_${track.title || track.content_id || "track"}`,
        );
        const targetPath = path.resolve(outDir, `${baseName}.ts`);
        fs.writeFileSync(targetPath, Buffer.concat(chunks));

        return {
            ok: true,
            filePath: targetPath,
            bytes: totalBytes,
            contentType: "video/mp2t",
            url: segmentUrls[0],
        };
    } catch (error) {
        return { ok: false, reason: error?.message || "captured_segments_download_failed" };
    }
}

async function recordCurrentTrack(page, maxMs, expectedDurationMs) {
    return page
        .evaluate(
            async ({ maxMsIn, expectedDurationMsIn }) => {
                const findMediaElement = () => {
                    const direct = document.querySelector("audio,video");
                    if (direct instanceof HTMLMediaElement) return direct;

                    const seen = new Set();
                    const queue = [];
                    if (window.audioplayer && typeof window.audioplayer === "object") queue.push(window.audioplayer);
                    queue.push(window);

                    while (queue.length > 0 && seen.size < 5000) {
                        const node = queue.shift();
                        if (!node || typeof node !== "object") continue;
                        if (seen.has(node)) continue;
                        seen.add(node);

                        if (node instanceof HTMLMediaElement) return node;

                        let keys = [];
                        try {
                            keys = Object.keys(node).slice(0, 150);
                        } catch (_error) {
                            keys = [];
                        }

                        for (const key of keys) {
                            let value;
                            try {
                                value = node[key];
                            } catch (_error) {
                                continue;
                            }

                            if (!value) continue;
                            if (value instanceof HTMLMediaElement) return value;
                            if (typeof value === "object" && !seen.has(value)) queue.push(value);
                        }
                    }

                    return null;
                };

                const audio = findMediaElement();
                if (!audio) return { ok: false, reason: "audio_element_not_found" };
                if (typeof audio.captureStream !== "function")
                    return { ok: false, reason: "capture_stream_unsupported" };
                if (typeof MediaRecorder === "undefined") return { ok: false, reason: "media_recorder_unavailable" };

                const stream = audio.captureStream();
                const chunks = [];
                let recorder;

                try {
                    recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
                } catch (_err) {
                    recorder = new MediaRecorder(stream);
                }

                recorder.ondataavailable = (event) => {
                    if (event.data && event.data.size > 0) chunks.push(event.data);
                };

                const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

                try {
                    audio.currentTime = 0;
                } catch (_error) {
                    // Ignore non-seekable media.
                }

                if (audio.paused) {
                    try {
                        await audio.play();
                    } catch (_error) {
                        // Playback can still be started by prior click.
                    }
                }

                recorder.start(1000);
                const elementDurationMs =
                    Number.isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration * 1000) : null;
                const fallbackExpectedMs =
                    Number.isFinite(expectedDurationMsIn) && expectedDurationMsIn > 0 ? expectedDurationMsIn : null;
                const baseDurationMs = elementDurationMs || fallbackExpectedMs || maxMsIn;
                const targetMs = Math.min(maxMsIn, Math.max(baseDurationMs + 2500, 12000));

                await Promise.race([
                    wait(targetMs),
                    new Promise((resolve) => {
                        audio.addEventListener("ended", resolve, { once: true });
                    }),
                ]);

                if (!audio.paused) {
                    audio.pause();
                }

                recorder.stop();
                await new Promise((resolve) => {
                    recorder.onstop = () => resolve();
                });

                const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
                const buffer = await blob.arrayBuffer();
                const bytes = new Uint8Array(buffer);

                let binary = "";
                const chunkSize = 0x8000;
                for (let i = 0; i < bytes.length; i += chunkSize) {
                    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
                }

                return {
                    ok: true,
                    mimeType: blob.type || "audio/webm",
                    size: bytes.length,
                    usedDurationMs: targetMs,
                    base64: btoa(binary),
                };
            },
            { maxMsIn: Math.max(4000, maxMs), expectedDurationMsIn: expectedDurationMs || null },
        )
        .catch((error) => ({ ok: false, reason: error?.message || "record_eval_failed" }));
}

async function captureTrackUrls(page, tracks, playLimit, playWaitMs) {
    const captureHits = [];
    let activeContentId = null;

    const handleResponse = async (response) => {
        if (!activeContentId) return;

        const url = response.url();
        const headers = response.headers();
        const contentType = (headers["content-type"] || "").toLowerCase();

        if (!urlLooksLikeMedia(url) && !contentType.includes("audio")) return;

        captureHits.push({
            content_id: activeContentId,
            url,
        });
    };

    page.on("response", handleResponse);

    try {
        const probeCount = Number.isFinite(playLimit) ? Math.max(0, playLimit) : tracks.length;
        const toProbe = tracks.slice(0, probeCount);

        for (const track of toProbe) {
            if (!track.content_id) continue;

            const row = page.locator(`.audio_item[data-id="${track.content_id}"]`).first();
            const isVisible = await row.isVisible().catch(() => false);
            if (!isVisible) continue;

            activeContentId = track.content_id;

            await row.scrollIntoViewIfNeeded().catch(() => {});
            await row.click({ force: true }).catch(async () => {
                await row
                    .locator(".ai_play")
                    .first()
                    .click({ force: true })
                    .catch(() => {});
            });

            await page.waitForTimeout(playWaitMs);

            await row.click({ force: true }).catch(() => {});
            await page.waitForTimeout(350);
            activeContentId = null;
        }
    } finally {
        page.off("response", handleResponse);
    }

    return captureHits;
}

async function captureAndDownload(page, context, tracks, options) {
    const outputDir = path.resolve(process.cwd(), options.downloadsDir);
    fs.mkdirSync(outputDir, { recursive: true });

    const hitMap = new Map();
    let activeContentId = null;

    const collectTrackUrls = async (track, row, playButton) => {
        if (!track?.content_id) return [];

        for (let attempt = 1; attempt <= 3; attempt += 1) {
            activeContentId = track.content_id;

            await row.scrollIntoViewIfNeeded().catch(() => {});
            await playButton.click({ force: true }).catch(async () => {
                await page
                    .evaluate((contentId) => {
                        try {
                            if (window.audioplayer && typeof window.audioplayer.playPause === "function") {
                                window.audioplayer.playPause({ type: "click", preventDefault: () => {} }, contentId);
                            }
                        } catch (_error) {
                            // Ignore action errors and continue trying.
                        }
                    }, track.content_id)
                    .catch(() => {});
            });

            await page.waitForTimeout(options.recordOnly ? 1200 : options.playWaitMs);

            const startedAt = Date.now();
            while (Date.now() - startedAt < options.captureTimeoutMs) {
                const domUrls = await collectDomMediaUrls(page);
                for (const u of domUrls) addHit(hitMap, track.content_id, u);

                const urls = getDownloadableUrls(hitMap.get(track.content_id) || []);
                if (urls.some(isStrongAudioUrl)) return urls;

                await page.waitForTimeout(450);
            }

            const urls = getDownloadableUrls(hitMap.get(track.content_id) || []);
            if (urls.some(isStrongAudioUrl)) return urls;

            // Pause before retrying capture so next attempt starts a fresh playback request.
            await playButton.click({ force: true }).catch(() => {});
            await page.waitForTimeout(500);
        }

        return getDownloadableUrls(hitMap.get(track.content_id) || []);
    };

    const handleRequest = async (request) => {
        if (!activeContentId) return;

        const url = request.url();
        if (urlLooksLikeMedia(url)) addHit(hitMap, activeContentId, url);
    };

    const handleResponse = async (response) => {
        if (!activeContentId) return;

        const url = response.url();
        const headers = response.headers();
        const contentType = (headers["content-type"] || "").toLowerCase();

        if (!urlLooksLikeMedia(url) && !contentType.includes("audio")) return;
        addHit(hitMap, activeContentId, url);
    };

    page.on("request", handleRequest);
    page.on("response", handleResponse);

    try {
        const startIndex = Math.min(Math.max(0, options.startIndex || 0), tracks.length);
        const maxCount = Number.isFinite(options.playLimit)
            ? Math.max(0, options.playLimit)
            : tracks.length - startIndex;
        const endExclusive = Math.min(tracks.length, startIndex + maxCount);
        const probeCount = Math.max(0, endExclusive - startIndex);

        if (probeCount === 0) {
            console.log("No tracks selected for capture/download. Check --start-index/--start-page and --play-limit.");
            return tracks;
        }

        console.log(`Selected track window: start_index=${startIndex}, count=${probeCount}`);

        for (let i = startIndex; i < endExclusive; i += 1) {
            if (STOP_REQUESTED) {
                console.log("Stop requested. Ending loop before next track.");
                break;
            }

            const track = tracks[i];
            const runNumber = i - startIndex + 1;
            if (!track.content_id) continue;

            const row = page.locator(`.audio_item[data-id="${track.content_id}"]`).first();
            const isVisible = await row.isVisible().catch(() => false);
            if (!isVisible) {
                track.download_status = "not_visible";
                continue;
            }

            const playButton = row.locator(".ai_play").first();
            const urls = await collectTrackUrls(track, row, playButton);
            track.captured_urls = urls;
            track.direct_url = urls[0] || null;
            const expectedDurationMs = Number.isFinite(track.duration_sec)
                ? Math.max(0, track.duration_sec * 1000)
                : null;

            if (options.recordOnly) {
                const rec = await recordCurrentTrack(page, options.recordMaxMs, expectedDurationMs);
                if (rec.ok) {
                    const name = sanitizeFilePart(
                        `${String(i + 1).padStart(4, "0")}_${track.artist || "artist"}_${track.title || track.content_id || "track"}`,
                    );
                    const recExt = extensionFrom("", rec.mimeType || "audio/webm");
                    const recPath = path.resolve(outputDir, `${name}${recExt}`);
                    fs.writeFileSync(recPath, Buffer.from(rec.base64, "base64"));

                    track.download_status = "downloaded";
                    track.download_method = "record_only";
                    track.downloaded_file = recPath;
                    track.download_error = null;
                } else {
                    track.download_status = "failed";
                    track.download_method = "record_only";
                    track.download_error = rec.reason || "recording_failed";
                }
            } else if (options.downloadFiles && urls.length > 0) {
                let downloaded = null;

                const isSegmentUrl = (url) => /\/seg-\d+-[^/]*\.ts(\?|$)/i.test(String(url));

                // Prefer direct HLS playlist URLs first (full-track path).
                const m3u8Urls = urls.filter((url) => String(url).toLowerCase().includes(".m3u8"));
                for (const m3u8Url of m3u8Urls) {
                    downloaded = await downloadHlsToTs(context, m3u8Url, track, outputDir, i);
                    if (downloaded.ok) {
                        downloaded.source = "direct_hls";
                        break;
                    }
                }

                // Then try direct non-segment media URLs.
                for (const url of urls) {
                    if (downloaded && downloaded.ok) break;
                    if (String(url).toLowerCase().includes(".m3u8")) continue;
                    if (isSegmentUrl(url)) continue;

                    downloaded = await tryDownloadUrl(context, url, track, outputDir, i);
                    if (downloaded.ok) {
                        downloaded.source = "direct_url";
                        break;
                    }
                }

                // Only if direct URL paths fail, fall back to captured segment merge.
                if (!downloaded || !downloaded.ok) {
                    const capturedSegments = getCapturedSegmentUrls(urls);
                    if (capturedSegments.length > 0) {
                        downloaded = await downloadCapturedSegmentsToTs(context, capturedSegments, track, outputDir, i);
                        if (downloaded.ok) downloaded.source = "captured_segments";
                    }
                }

                if (downloaded && downloaded.ok) {
                    track.download_status = "downloaded";
                    track.download_method = downloaded.source || "direct_url";
                    track.downloaded_file = downloaded.filePath;
                    track.download_error = null;
                } else if (options.recordFallback) {
                    const rec = await recordCurrentTrack(page, options.recordMaxMs, expectedDurationMs);
                    if (rec.ok) {
                        const name = sanitizeFilePart(
                            `${String(i + 1).padStart(4, "0")}_${track.artist || "artist"}_${track.title || track.content_id || "track"}`,
                        );
                        const recExt = extensionFrom("", rec.mimeType || "audio/webm");
                        const recPath = path.resolve(outputDir, `${name}${recExt}`);
                        fs.writeFileSync(recPath, Buffer.from(rec.base64, "base64"));

                        track.download_status = "downloaded";
                        track.download_method = "record_fallback";
                        track.downloaded_file = recPath;
                        track.download_error = null;
                    } else {
                        track.download_status = "failed";
                        track.download_method = "record_fallback";
                        track.download_error = rec.reason || "recording_failed";
                    }
                } else {
                    track.download_status = "failed";
                    track.download_method = "direct_url";
                    track.download_error = downloaded?.reason || "no_downloadable_url";
                }
            } else if (options.recordFallback) {
                const rec = await recordCurrentTrack(page, options.recordMaxMs, expectedDurationMs);
                if (rec.ok) {
                    const name = sanitizeFilePart(
                        `${String(i + 1).padStart(4, "0")}_${track.artist || "artist"}_${track.title || track.content_id || "track"}`,
                    );
                    const recExt = extensionFrom("", rec.mimeType || "audio/webm");
                    const recPath = path.resolve(outputDir, `${name}${recExt}`);
                    fs.writeFileSync(recPath, Buffer.from(rec.base64, "base64"));

                    track.download_status = "downloaded";
                    track.download_method = "record_fallback";
                    track.downloaded_file = recPath;
                    track.download_error = null;
                } else {
                    track.download_status = "failed";
                    track.download_method = "record_fallback";
                    track.download_error = rec.reason || "recording_failed";
                }
            } else {
                track.download_status = "failed";
                track.download_method = "none";
                track.download_error = "no_download_mode_enabled";
            }

            await playButton.click({ force: true }).catch(() => {});
            await page.waitForTimeout(300);
            activeContentId = null;

            console.log(
                `[${runNumber}/${probeCount}] ${track.title || track.content_id}: ${track.download_status}, urls=${track.captured_urls.length}, expected_sec=${track.duration_sec || "n/a"}, method=${track.download_method || "n/a"}, error=${track.download_error || "none"}`,
            );
        }
    } finally {
        page.off("request", handleRequest);
        page.off("response", handleResponse);
    }

    return tracks;
}

async function scrapeVkAudios(options) {
    const profilePath = path.resolve(process.cwd(), options.profileDir);
    const context = await chromium.launchPersistentContext(profilePath, {
        headless: options.headless,
    });
    const page = context.pages()[0] || (await context.newPage());

    try {
        await page.goto(options.url, { waitUntil: "domcontentloaded" });

        const hasAudioList = await page
            .locator(".audio_item")
            .first()
            .isVisible({ timeout: 6000 })
            .catch(() => false);

        if (!hasAudioList) {
            if (options.headless) {
                throw new Error("Audio list not visible in headless mode. Re-run without --headless and login first.");
            }
            console.log("Audio list not visible. You may need to log in manually in the opened browser.");
            await waitForEnter("After login and loading the page, press Enter to continue... ");
        }

        await page.waitForSelector(".audio_item", { timeout: 30000 });
        await autoScroll(page, options.maxScrolls, options.delayMs);

        const rows = await page.$$eval(".audio_item", (nodes) =>
            nodes.map((node) => {
                const dataAudio = node.getAttribute("data-audio") || "";
                let parsed = null;

                try {
                    parsed = JSON.parse(dataAudio);
                } catch (_error) {
                    parsed = null;
                }

                const titleText = node.querySelector(".ai_title")?.textContent?.trim() || null;
                const artistText = node.querySelector(".ai_artist")?.textContent?.trim() || null;

                return {
                    dataId: node.getAttribute("data-id"),
                    dataAudio,
                    parsed,
                    titleText,
                    artistText,
                };
            }),
        );

        const normalized = rows.map(normalizeTrack);
        let deduped = Array.from(
            new Map(normalized.map((item, index) => [item.content_id || `row_${index}`, item])).values(),
        );

        if (Number.isFinite(options.startPage)) {
            const targetPage = Number(options.startPage);
            const idx = deduped.findIndex((track) => {
                const m = String(track.title || "").match(/PAGE\s*(\d+)/i);
                return m ? Number(m[1]) === targetPage : false;
            });

            if (idx >= 0) {
                options.startIndex = idx;
                console.log(`Resolved --start-page ${targetPage} to start_index=${idx}.`);
            } else {
                console.log(`Could not find PAGE ${targetPage}. Using start_index=${options.startIndex || 0}.`);
            }
        }

        if (options.captureUrls || options.downloadFiles || options.recordFallback) {
            console.log("Capture/download mode is on. The script will play tracks and inspect network/media sources.");
            deduped = await captureAndDownload(page, context, deduped, options);

            const summaryStart = Math.min(Math.max(0, options.startIndex || 0), deduped.length);
            const summaryEnd = Math.min(
                deduped.length,
                summaryStart +
                    (Number.isFinite(options.playLimit)
                        ? Math.max(0, options.playLimit)
                        : deduped.length - summaryStart),
            );
            const summary = deduped.slice(summaryStart, summaryEnd).reduce(
                (acc, track) => {
                    if (track.download_status === "downloaded") acc.downloaded += 1;
                    if (track.captured_urls.length > 0) acc.withUrls += 1;
                    if (track.download_status === "failed") acc.failed += 1;
                    return acc;
                },
                { downloaded: 0, withUrls: 0, failed: 0 },
            );

            console.log(
                `Probe summary: with_urls=${summary.withUrls}, downloaded=${summary.downloaded}, failed=${summary.failed}`,
            );
        }

        const outputPath = path.resolve(process.cwd(), options.out);
        fs.writeFileSync(outputPath, JSON.stringify(deduped, null, 2), "utf8");

        if (options.saveState) {
            const statePath = path.resolve(process.cwd(), options.stateFile);
            await context.storageState({ path: statePath });
            console.log(`Saved session state to: ${statePath}`);
        }

        return { outputPath, count: deduped.length };
    } finally {
        await context.close();
    }
}

async function main() {
    registerSignalHandlers();
    const options = parseArgs(process.argv.slice(2));
    const result = await scrapeVkAudios(options);

    console.log(`Saved ${result.count} tracks to: ${result.outputPath}`);
    if (options.captureUrls || options.downloadFiles || options.recordFallback) {
        console.log(
            "Output includes capture/download fields: direct_url, captured_urls, downloaded_file, download_status, download_method.",
        );
    }
    console.log(
        "Session tip: use --state-file vk_storage_state.json to reuse login and reduce repeated auth attempts.",
    );
    console.log(`Profile tip: browser profile is persisted at ${path.resolve(process.cwd(), options.profileDir)}.`);
}

main().catch((error) => {
    console.error("Scrape failed:", error);
    process.exitCode = 1;
});
