# VK Audio Extractor Toolkit

## Legal Notice

This repository is published for academic and educational purposes (research, reproducibility, and learning).

You are responsible for using this code lawfully and ethically, including compliance with:

- Copyright and neighboring-rights laws in your jurisdiction.
- Platform Terms of Service (including VK policies).
- Privacy and consent requirements for any collected data.

Do not use this project to access, copy, or distribute content you do not have rights to use.

No legal guarantee: adding a notice or license does not by itself prevent legal claims. It does, however, clarify intent and provide license/warranty terms for your source code.

This workspace contains a production-ready VK audio extraction pipeline with:

- Auth-persistent scraping via Playwright.
- Direct HLS-first download path with AES-128 key handling.
- Resume support by page or index.
- Post-processing tools for MP3 conversion.
- Integrity/quality assessment with checksums and duration validation.
- A local dashboard for browsing and playing extracted files.
- A dashboard command runner with live job status and logs.

## Fast Start

1. Install dependencies:

```bash
npm install
```

2. Run full extraction over the loaded list:

```bash
npm run vk:full
```

3. Resume from PAGE 32 to the end of the remaining manifest window:

```bash
npm run vk:resume
```

4. Merge/inspect complete manifest:

- Main complete manifest: `vk_audios_complete.json`

5. Run checksum + quality assessment:

```bash
npm run vk:assess
```

6. Convert downloaded files to MP3:

```bash
npm run vk:convert-mp3
```

7. Launch local dashboard:

```bash
npm run dashboard
```

Then open: `http://localhost:8787/scraper.html`

## Output Files

- `vk_audios_complete.json`: consolidated track metadata and download results.
- `downloads/`: extracted media files.
- `downloads_mp3/`: converted MP3 files.
- `reports/checksum_assessment.json`: integrity and quality report.
- `reports/checksum_assessment.csv`: tabular assessment report.
- `reports/mp3_conversion_report.json`: conversion outcomes.
- `scraper.html`: local dashboard that scans the manifest, verifies local playback sources, and plays only local files.
- The dashboard footer includes stats plus launch buttons for scraper, resume, checksum audit, and MP3 conversion.

## Dashboard Runtime APIs

The local dashboard server (`tools/serve_dashboard.js`) exposes:

- `POST /api/run` with body `{ "script": "vk:full|vk:resume|vk:assess|vk:convert-mp3" }`
- `GET /api/run?script=<name>` fallback
- `GET /api/jobs` and `GET /api/jobs?id=<job_id>` for live status/log monitoring
- `GET /api/tools` for ffmpeg availability and install hints

The dashboard includes:

- **FFmpeg Setup & Convert panel** with install command copy buttons and a recheck action.
- **Job Monitor panel** showing running/succeeded/failed states and process log tails.

## Workspace Baseline

Legacy artifacts are removed from the active workflow:

- Removed `archive/`
- Removed `downloads_legacy/`
- Removed deprecated `download_from_json.js`

## Required Tools

- Node.js 18+
- ffmpeg (for MP3 conversion)
- ffprobe (recommended for duration validation; usually bundled with ffmpeg)

If ffmpeg/ffprobe are missing, conversion/advanced assessment steps will warn or fail with actionable messages.

## Documentation Map

- High-level technical: `docs/TECHNICAL_OVERVIEW.md`
- Engineering architecture + extension guide: `docs/ARCHITECTURE_AND_KNOWLEDGE.md`

## License

This project is licensed under the ISC License. See `LICENSE`.
