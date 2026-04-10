const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 8787);
const NODE_BIN = process.execPath;
const MAX_JOB_LOG_LINES = 500;
const MAX_JOBS = 60;

const JOBS = new Map();
let NEXT_JOB_ID = 1;

const RUN_SCRIPTS = {
    "vk:full": [
        "vk_audio_scraper.js",
        "--capture-urls",
        "--download",
        "--record-fallback",
        "--play-wait-ms",
        "5000",
        "--capture-timeout-ms",
        "15000",
        "--record-max-ms",
        "180000",
        "--profile-dir",
        "vk_profile",
        "--out",
        "vk_audios_final.json",
    ],
    "vk:resume": [
        "vk_audio_scraper.js",
        "--capture-urls",
        "--download",
        "--record-fallback",
        "--start-page",
        "32",
        "--play-wait-ms",
        "5000",
        "--capture-timeout-ms",
        "15000",
        "--record-max-ms",
        "180000",
        "--profile-dir",
        "vk_profile",
        "--out",
        "vk_audios_resume_32_06.json",
    ],
    "vk:assess": ["tools/checksum_assessment.js", "--manifest", "vk_audios_complete.json"],
    "vk:convert-mp3": [
        "tools/convert_to_mp3.js",
        "--manifest",
        "vk_audios_complete.json",
        "--out-dir",
        "downloads_mp3",
    ],
};

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ts": "video/mp2t",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".txt": "text/plain; charset=utf-8",
};

function safePath(urlPath) {
    const raw = decodeURIComponent(urlPath.split("?")[0]);
    const cleaned = raw === "/" ? "/scraper.html" : raw;
    const candidate = path.resolve(ROOT, `.${cleaned}`);
    if (!candidate.startsWith(ROOT)) return null;
    return candidate;
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1024 * 32) {
                reject(new Error("Request body too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload, null, 2));
}

function sendRunJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(JSON.stringify(payload, null, 2));
}

function launchScript(scriptName) {
    const args = RUN_SCRIPTS[scriptName];
    if (!args) return { ok: false, error: "unknown_script" };

    const childProcess = require("child_process");

    if (scriptName === "vk:convert-mp3") {
        const ffmpegProbe = childProcess.spawnSync("ffmpeg", ["-version"], { cwd: ROOT, windowsHide: true });
        if (ffmpegProbe.error || ffmpegProbe.status !== 0) {
            return {
                ok: false,
                error: "ffmpeg_not_found_on_PATH",
                details: "Install ffmpeg and ensure ffmpeg is available in PATH before running conversion.",
            };
        }
    }

    const jobId = String(NEXT_JOB_ID++);
    const job = {
        id: jobId,
        script: scriptName,
        args,
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        pid: null,
        exitCode: null,
        signal: null,
        error: null,
        logs: [],
    };

    const appendLog = (line) => {
        const normalized = String(line || "").replace(/\r/g, "");
        const lines = normalized.split("\n").filter((x) => x.length > 0);
        for (const l of lines) {
            job.logs.push(`[${new Date().toISOString()}] ${l}`);
        }
        if (job.logs.length > MAX_JOB_LOG_LINES) {
            job.logs.splice(0, job.logs.length - MAX_JOB_LOG_LINES);
        }
    };

    const child = childProcess.spawn(NODE_BIN, args, {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });

    job.pid = child.pid;
    JOBS.set(jobId, job);
    while (JOBS.size > MAX_JOBS) {
        const oldest = JOBS.keys().next().value;
        JOBS.delete(oldest);
    }

    child.stdout.on("data", (chunk) => appendLog(chunk));
    child.stderr.on("data", (chunk) => appendLog(`[stderr] ${chunk}`));

    child.on("error", (error) => {
        job.status = "failed";
        job.error = error.message || "spawn_failed";
        job.finishedAt = new Date().toISOString();
        appendLog(`[error] ${job.error}`);
    });

    child.on("close", (code, signal) => {
        job.exitCode = code;
        job.signal = signal || null;
        if (job.status !== "failed") {
            job.status = code === 0 ? "succeeded" : "failed";
        }
        job.finishedAt = new Date().toISOString();
        appendLog(`[process] exited with code=${code} signal=${signal || "none"}`);
    });

    return {
        ok: true,
        job: {
            id: job.id,
            script: job.script,
            status: job.status,
            startedAt: job.startedAt,
            pid: job.pid,
        },
    };
}

function detectFfmpeg() {
    const childProcess = require("child_process");
    const probe = childProcess.spawnSync("ffmpeg", ["-version"], { cwd: ROOT, windowsHide: true, encoding: "utf8" });

    if (probe.error || probe.status !== 0) {
        return {
            available: false,
            version: null,
            install: {
                winget: "winget install --id Gyan.FFmpeg -e",
                choco: "choco install ffmpeg -y",
                scoop: "scoop install ffmpeg",
            },
        };
    }

    const firstLine = String(probe.stdout || "").split(/\r?\n/).find(Boolean) || "ffmpeg available";
    return {
        available: true,
        version: firstLine,
        install: {
            winget: "winget install --id Gyan.FFmpeg -e",
            choco: "choco install ffmpeg -y",
            scoop: "scoop install ffmpeg",
        },
    };
}

function listMp3Files() {
    const dir = path.resolve(ROOT, "downloads_mp3");
    if (!dir.startsWith(ROOT) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return [];
    }

    return fs
        .readdirSync(dir)
        .filter((name) => /\.mp3$/i.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
        .map((name) => ({
            name,
            url: `/downloads_mp3/${encodeURIComponent(name)}`,
        }));
}

const server = http.createServer((req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    if (url.pathname === "/api/run") {
        if (method === "OPTIONS") {
            sendRunJson(res, 204, { ok: true });
            return;
        }

        if (method === "GET") {
            const script = url.searchParams.get("script");
            const result = launchScript(script);
            if (!result.ok) {
                sendRunJson(res, 400, result);
                return;
            }
            sendRunJson(res, 202, result);
            return;
        }

        if (method === "POST") {
            readJsonBody(req)
                .then((body) => {
                    const result = launchScript(body.script);
                    if (!result.ok) {
                        sendRunJson(res, 400, result);
                        return;
                    }
                    sendRunJson(res, 202, result);
                })
                .catch((error) => sendRunJson(res, 400, { ok: false, error: error.message || "invalid_json" }));
            return;
        }

        sendRunJson(res, 405, {
            ok: false,
            error: "method_not_allowed",
            details: "Use POST /api/run with JSON body { script }, or GET /api/run?script=<name>",
        });
        return;
    }

    if (url.pathname === "/api/tools") {
        if (method === "OPTIONS") {
            sendRunJson(res, 204, { ok: true });
            return;
        }

        if (method === "GET") {
            sendRunJson(res, 200, { ok: true, ffmpeg: detectFfmpeg() });
            return;
        }

        sendRunJson(res, 405, {
            ok: false,
            error: "method_not_allowed",
            details: "Use GET /api/tools",
        });
        return;
    }

    if (url.pathname === "/api/jobs") {
        if (method === "OPTIONS") {
            sendRunJson(res, 204, { ok: true });
            return;
        }

        if (method === "GET") {
            const id = url.searchParams.get("id");
            if (id) {
                const job = JOBS.get(id);
                if (!job) {
                    sendRunJson(res, 404, { ok: false, error: "job_not_found" });
                    return;
                }
                sendRunJson(res, 200, { ok: true, job });
                return;
            }

            const jobs = Array.from(JOBS.values()).map((job) => ({
                id: job.id,
                script: job.script,
                status: job.status,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt,
                pid: job.pid,
                exitCode: job.exitCode,
                error: job.error,
                logTail: job.logs.slice(-6),
            }));
            sendRunJson(res, 200, { ok: true, jobs });
            return;
        }

        sendRunJson(res, 405, {
            ok: false,
            error: "method_not_allowed",
            details: "Use GET /api/jobs or GET /api/jobs?id=<job_id>",
        });
        return;
    }

    if (url.pathname === "/api/mp3-list") {
        if (method === "OPTIONS") {
            sendRunJson(res, 204, { ok: true });
            return;
        }

        if (method === "GET") {
            sendRunJson(res, 200, { ok: true, files: listMp3Files() });
            return;
        }

        sendRunJson(res, 405, {
            ok: false,
            error: "method_not_allowed",
            details: "Use GET /api/mp3-list",
        });
        return;
    }

    const filePath = safePath(req.url || "/");
    if (!filePath) {
        res.writeHead(400);
        res.end("Bad request");
        return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";

    res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
        Expires: "0",
    });
    if (method === "HEAD") {
        res.end();
        return;
    }
    fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
    console.log(`Dashboard server running: http://localhost:${PORT}/scraper.html`);
});

server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use. Stop the previous dashboard server process and retry.`);
        process.exitCode = 1;
        return;
    }

    console.error("Dashboard server failed:", error?.message || error);
    process.exitCode = 1;
});
