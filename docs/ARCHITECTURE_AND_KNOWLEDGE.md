# Architecture and Knowledge for Contributors

## System Boundaries

The system is a Node.js automation and media-processing toolkit with three layers:

1. Acquisition Layer (`vk_audio_scraper.js`)
2. Validation/Transformation Layer (`tools/*.js`)
3. Visualization Layer (`scraper.html` + `tools/serve_dashboard.js`)

No remote backend exists. All data is file-based in the local workspace.

## Acquisition Layer Details

### Runtime Components

- Playwright Chromium persistent context.
- Page interaction engine to start/stop VK tracks.
- Network listeners (`request`, `response`) to capture candidate media URLs.

### Data Contracts

Track object fields used across the toolchain:

- Identity: `content_id`, `owner_id`, `audio_id`
- Metadata: `title`, `artist`, `duration_sec`
- Capture results: `direct_url`, `captured_urls`
- Download result: `download_status`, `download_method`, `downloaded_file`, `download_error`

### Download Priority Model

1. `direct_hls`
2. `direct_url`
3. `captured_segments`
4. `record_fallback`

This order reduces partial-file risk and preserves full-track continuity.

### HLS Knowledge

- VK streams can be AES-128 encrypted via `#EXT-X-KEY`.
- Segment IV can be explicit (`IV=`) or sequence-derived.
- A robust HLS implementation must parse key transitions and decrypt per segment.

## Validation/Transformation Layer

### Checksum and Assessment

`tools/checksum_assessment.js` computes:

- SHA-256 digest per downloaded file.
- Quality score based on extension sanity, file size, download method, and duration delta.
- JSON and CSV outputs for reporting and audit.

Use this layer to gate downstream operations (e.g., conversion or publication).

### MP3 Conversion

`tools/convert_to_mp3.js`:

- Converts non-MP3 artifacts to MP3 (`libmp3lame`, VBR quality mode).
- Handles missing inputs and existing outputs explicitly.
- Emits machine-readable conversion report JSON.

## Visualization Layer

### Dashboard Contract

`scraper.html` expects a manifest array matching the acquisition track object shape.

Playback model:

- Resolve basename from `downloaded_file`.
- Prefer `downloads_mp3/<stem>.mp3` for `.ts` sources when conversion exists.
- Mark `.ts` tracks as `needs_conversion` when no MP3 exists yet.
- Only attach verified local sources to the HTML audio element.

### Static Serving

`tools/serve_dashboard.js` serves workspace files over HTTP to avoid local file CORS issues.

Runtime endpoints:

- `POST /api/run` and `GET /api/run?script=<name>`: launch whitelisted scripts.
- `GET /api/jobs` / `GET /api/jobs?id=<id>`: command execution status and log tails.
- `GET /api/tools`: local tool probing (ffmpeg availability + install hints).

Job model highlights:

- Each launch is tracked with `id`, `script`, `status`, timestamps, `exitCode`, and logs.
- Dashboard polls jobs and updates UI status in near real-time.
- Successful conversion jobs trigger playback-source rescan so MP3 is preferred when available.

## Extension Patterns

1. Add new download methods:
   - Introduce method function.
   - Insert into priority chain.
   - Preserve `download_method` taxonomy.

2. Add new assessment checks:
   - Append deterministic rule with clear warning key.
   - Update scoring logic and report schema.

3. Add format conversion targets:
   - Reuse conversion pipeline with different ffmpeg codec presets.

4. Add CI automation:
   - Run assessment script and assert quality thresholds.
   - Publish report artifacts.

## Operational Knowledge

- Always run non-headless once when session expires.
- Keep `vk_profile` directory persistent across runs.
- Use `--start-page` or `--start-index` to resume exactly where an interruption occurred.
- Omit `--play-limit` to process the full loaded manifest window.
- Treat `.bin` and standalone `.m3u8` outputs as suspicious unless validated.

## Troubleshooting

- No visible audio list:
  - Re-run without `--headless`, log in, continue.
- Very short output files:
  - Confirm method is `direct_hls`; run assessment script.
- Conversion failures:
  - Verify ffmpeg installation and inspect conversion report errors.
