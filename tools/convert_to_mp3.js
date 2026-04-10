const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
    const args = {
        manifest: "vk_audios_complete.json",
        downloadsDir: "downloads",
        outDir: "downloads_mp3",
        ffmpegBin: "ffmpeg",
        reportPath: path.join("reports", "mp3_conversion_report.json"),
        overwrite: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === "--manifest" && argv[i + 1]) args.manifest = argv[++i];
        else if (token === "--downloads-dir" && argv[i + 1]) args.downloadsDir = argv[++i];
        else if (token === "--out-dir" && argv[i + 1]) args.outDir = argv[++i];
        else if (token === "--ffmpeg" && argv[i + 1]) args.ffmpegBin = argv[++i];
        else if (token === "--report" && argv[i + 1]) args.reportPath = argv[++i];
        else if (token === "--overwrite") args.overwrite = true;
    }

    return args;
}

function ensureTool(bin) {
    const probe = spawnSync(bin, ["-version"], { encoding: "utf8" });
    return probe.status === 0;
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

function runFfmpeg(ffmpegBin, inputPath, outPath, overwrite) {
    const args = ["-hide_banner", "-loglevel", "error"];
    if (overwrite) args.push("-y");
    else args.push("-n");

    args.push("-i", inputPath, "-vn", "-codec:a", "libmp3lame", "-q:a", "2", outPath);

    const result = spawnSync(ffmpegBin, args, { encoding: "utf8" });
    return {
        ok: result.status === 0,
        code: result.status,
        stderr: result.stderr || "",
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!ensureTool(args.ffmpegBin)) {
        console.error("ffmpeg not found on PATH. Install ffmpeg and retry.");
        process.exit(1);
    }

    const manifestPath = path.resolve(process.cwd(), args.manifest);
    if (!fs.existsSync(manifestPath)) {
        console.error(`Manifest not found: ${manifestPath}`);
        process.exit(1);
    }

    const tracks = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const outDir = path.resolve(process.cwd(), args.outDir);
    fs.mkdirSync(outDir, { recursive: true });

    const report = {
        generated_at: new Date().toISOString(),
        manifest: manifestPath,
        out_dir: outDir,
        summary: {
            total_tracks: tracks.length,
            candidate_tracks: 0,
            converted: 0,
            skipped_existing: 0,
            skipped_missing_input: 0,
            skipped_already_mp3: 0,
            failed: 0,
        },
        items: [],
    };

    for (const track of tracks) {
        if (track.download_status !== "downloaded") continue;
        report.summary.candidate_tracks += 1;

        const inputPath = resolveInputFile(track.downloaded_file, args.downloadsDir);
        if (!inputPath) {
            report.summary.skipped_missing_input += 1;
            report.items.push({
                content_id: track.content_id,
                title: track.title,
                status: "skipped_missing_input",
            });
            continue;
        }

        const inExt = path.extname(inputPath).toLowerCase();
        const base = path.basename(inputPath, inExt);
        const outPath = path.resolve(outDir, `${base}.mp3`);

        if (inExt === ".mp3") {
            report.summary.skipped_already_mp3 += 1;
            report.items.push({
                content_id: track.content_id,
                title: track.title,
                status: "skipped_already_mp3",
                input: inputPath,
            });
            continue;
        }

        if (!args.overwrite && fs.existsSync(outPath)) {
            report.summary.skipped_existing += 1;
            report.items.push({
                content_id: track.content_id,
                title: track.title,
                status: "skipped_existing",
                output: outPath,
            });
            continue;
        }

        const conversion = runFfmpeg(args.ffmpegBin, inputPath, outPath, args.overwrite);
        if (!conversion.ok) {
            report.summary.failed += 1;
            report.items.push({
                content_id: track.content_id,
                title: track.title,
                status: "failed",
                input: inputPath,
                output: outPath,
                error: conversion.stderr.trim() || `ffmpeg_exit_${conversion.code}`,
            });
            continue;
        }

        report.summary.converted += 1;
        report.items.push({
            content_id: track.content_id,
            title: track.title,
            status: "converted",
            input: inputPath,
            output: outPath,
        });
    }

    const reportPath = path.resolve(process.cwd(), args.reportPath);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

    console.log(JSON.stringify(report.summary, null, 2));
    console.log(`Report written: ${reportPath}`);
}

main();
