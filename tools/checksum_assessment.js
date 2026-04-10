const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
    const args = {
        manifest: "vk_audios_complete.json",
        downloadsDir: "downloads",
        outJson: path.join("reports", "checksum_assessment.json"),
        outCsv: path.join("reports", "checksum_assessment.csv"),
        ffprobeBin: "ffprobe",
    };

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === "--manifest" && argv[i + 1]) args.manifest = argv[++i];
        else if (token === "--downloads-dir" && argv[i + 1]) args.downloadsDir = argv[++i];
        else if (token === "--out-json" && argv[i + 1]) args.outJson = argv[++i];
        else if (token === "--out-csv" && argv[i + 1]) args.outCsv = argv[++i];
        else if (token === "--ffprobe" && argv[i + 1]) args.ffprobeBin = argv[++i];
    }

    return args;
}

function fileBaseName(p) {
    return path.basename(String(p || "").replace(/\\/g, "/"));
}

function resolveInputFile(downloadedFile, downloadsDir) {
    if (!downloadedFile) return null;
    if (fs.existsSync(downloadedFile)) return downloadedFile;

    const fallback = path.resolve(process.cwd(), downloadsDir, fileBaseName(downloadedFile));
    if (fs.existsSync(fallback)) return fallback;
    return null;
}

function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    const data = fs.readFileSync(filePath);
    hash.update(data);
    return hash.digest("hex");
}

function canUseFfprobe(ffprobeBin) {
    const probe = spawnSync(ffprobeBin, ["-version"], { encoding: "utf8" });
    return probe.status === 0;
}

function probeDurationSec(ffprobeBin, filePath) {
    const result = spawnSync(
        ffprobeBin,
        ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
        { encoding: "utf8" },
    );

    if (result.status !== 0) return null;

    try {
        const parsed = JSON.parse(result.stdout || "{}");
        const formatDur = Number(parsed?.format?.duration);
        if (Number.isFinite(formatDur) && formatDur > 0) return formatDur;

        const streamDur = Number((parsed?.streams || [])[0]?.duration);
        if (Number.isFinite(streamDur) && streamDur > 0) return streamDur;
    } catch (_error) {
        return null;
    }

    return null;
}

function csvEscape(value) {
    const s = String(value ?? "");
    if (s.includes(",") || s.includes("\n") || s.includes('"')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const manifestPath = path.resolve(process.cwd(), args.manifest);

    if (!fs.existsSync(manifestPath)) {
        console.error(`Manifest not found: ${manifestPath}`);
        process.exit(1);
    }

    const tracks = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const hasFfprobe = canUseFfprobe(args.ffprobeBin);

    const report = {
        generated_at: new Date().toISOString(),
        manifest: manifestPath,
        ffprobe_enabled: hasFfprobe,
        summary: {
            total_tracks: tracks.length,
            downloaded_tracks: 0,
            status_ok: 0,
            status_warn: 0,
            status_error: 0,
        },
        items: [],
    };

    for (const track of tracks) {
        if (track.download_status !== "downloaded") continue;
        report.summary.downloaded_tracks += 1;

        const item = {
            content_id: track.content_id,
            title: track.title,
            artist: track.artist,
            expected_duration_sec: Number.isFinite(track.duration_sec) ? track.duration_sec : null,
            download_method: track.download_method || null,
            downloaded_file: track.downloaded_file || null,
            resolved_file: null,
            file_exists: false,
            file_size_bytes: null,
            file_ext: null,
            sha256: null,
            actual_duration_sec: null,
            duration_delta_sec: null,
            status: "ok",
            warnings: [],
            errors: [],
            quality_score: 100,
        };

        const inputPath = resolveInputFile(track.downloaded_file, args.downloadsDir);
        if (!inputPath) {
            item.status = "error";
            item.errors.push("missing_file");
            item.quality_score = 0;
            report.items.push(item);
            report.summary.status_error += 1;
            continue;
        }

        item.resolved_file = inputPath;
        item.file_exists = true;
        item.file_ext = path.extname(inputPath).toLowerCase();

        const st = fs.statSync(inputPath);
        item.file_size_bytes = st.size;
        item.sha256 = sha256File(inputPath);

        if (item.file_ext === ".bin" || item.file_ext === ".m3u8") {
            item.warnings.push("unexpected_output_extension");
            item.quality_score -= 35;
        }

        if (item.file_size_bytes < 120000) {
            item.warnings.push("very_small_file");
            item.quality_score -= 25;
        }

        if (item.download_method === "captured_segments") {
            item.warnings.push("fallback_segment_method_used");
            item.quality_score -= 10;
        }

        if (hasFfprobe) {
            const actual = probeDurationSec(args.ffprobeBin, inputPath);
            item.actual_duration_sec = actual;

            if (Number.isFinite(actual) && Number.isFinite(item.expected_duration_sec)) {
                item.duration_delta_sec = Math.abs(actual - item.expected_duration_sec);
                if (item.duration_delta_sec > 15) {
                    item.warnings.push("duration_mismatch_gt_15s");
                    item.quality_score -= 30;
                }
            }
        }

        item.quality_score = Math.max(0, item.quality_score);
        if (item.errors.length > 0) item.status = "error";
        else if (item.warnings.length > 0) item.status = "warn";

        if (item.status === "ok") report.summary.status_ok += 1;
        else if (item.status === "warn") report.summary.status_warn += 1;
        else report.summary.status_error += 1;

        report.items.push(item);
    }

    const outJson = path.resolve(process.cwd(), args.outJson);
    const outCsv = path.resolve(process.cwd(), args.outCsv);
    fs.mkdirSync(path.dirname(outJson), { recursive: true });

    fs.writeFileSync(outJson, JSON.stringify(report, null, 2), "utf8");

    const headers = [
        "content_id",
        "title",
        "artist",
        "status",
        "quality_score",
        "expected_duration_sec",
        "actual_duration_sec",
        "duration_delta_sec",
        "file_size_bytes",
        "file_ext",
        "sha256",
        "resolved_file",
        "warnings",
        "errors",
    ];

    const csvLines = [headers.join(",")];
    for (const item of report.items) {
        const row = [
            item.content_id,
            item.title,
            item.artist,
            item.status,
            item.quality_score,
            item.expected_duration_sec,
            item.actual_duration_sec,
            item.duration_delta_sec,
            item.file_size_bytes,
            item.file_ext,
            item.sha256,
            item.resolved_file,
            item.warnings.join("|"),
            item.errors.join("|"),
        ].map(csvEscape);

        csvLines.push(row.join(","));
    }

    fs.writeFileSync(outCsv, csvLines.join("\n"), "utf8");

    console.log(JSON.stringify(report.summary, null, 2));
    console.log(`JSON report: ${outJson}`);
    console.log(`CSV report:  ${outCsv}`);
}

main();
