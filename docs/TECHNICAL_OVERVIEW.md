# Technical Overview (High Level)

## Purpose

The project extracts audio tracks from a VK audio page and writes playable local files with metadata.

## Core Flow

1. Browser session bootstraps with persistent profile (`vk_profile`) and optional storage state.
2. Track metadata is scraped from `.audio_item[data-audio]` entries.
3. For each selected track, playback is triggered to capture network URLs.
4. Download strategy executes in strict order:
   - Direct HLS playlist (`.m3u8`) download and segment merge.
   - Decryption for AES-128-protected HLS segments using `#EXT-X-KEY`.
   - Direct non-segment media URL fallback.
   - Captured segment fallback.
   - Browser recording fallback (optional).
5. Output JSON is written with per-track fields (`download_status`, `download_method`, `downloaded_file`, etc.).

The scraper now defaults to the full loaded manifest window unless the caller explicitly sets `--play-limit` or a resume range.

## Reliability Features

- Session persistence avoids repetitive login.
- Retry loop per track during URL capture.
- URL prioritization prefers stable audio endpoints.
- Signal handling (`Ctrl+C`) preserves partial progress.
- Resume support:
  - `--start-index N`
  - `--start-page XX`

## Post-Processing

- `tools/checksum_assessment.js`:
  - Computes SHA-256 checksums.
  - Evaluates file quality via extension, size, and optional duration checks.
- `tools/convert_to_mp3.js`:
  - Converts downloaded assets to MP3 using ffmpeg.

## Dashboard

`scraper.html` provides a local UI to:

- Load a manifest (`vk_audios_complete.json` or custom).
- Choose a start index and item count, or auto-use the full loaded manifest length.
- Filter/search tracks by title, artist, method, and status.
- Scan local files on load and mark each track as playable, needs conversion, or missing.
- Play verified local files from `downloads/` or `downloads_mp3/`.
- Review summary metrics.
- Launch whitelisted local scripts from the footer through the local dashboard server.

Command execution visibility:

- Dashboard command launches create tracked jobs.
- Job monitor reports running/succeeded/failed state.
- Recent process logs are shown for each job.

Tooling visibility:

- Dashboard queries local ffmpeg availability through `/api/tools`.
- Conversion can be triggered from the FFmpeg Setup panel once prerequisites are met.
