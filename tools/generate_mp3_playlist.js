const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const MP3_DIR = path.resolve(ROOT, "downloads_mp3");
const OUT_FILE = path.resolve(MP3_DIR, "playlist.js");

if (!fs.existsSync(MP3_DIR) || !fs.statSync(MP3_DIR).isDirectory()) {
  console.error("downloads_mp3 folder not found.");
  process.exit(1);
}

const files = fs
  .readdirSync(MP3_DIR)
  .filter((name) => /\.mp3$/i.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
  .map((name) => ({
    name,
    url: `./downloads_mp3/${encodeURIComponent(name)}`,
  }));

const content = `window.MP3_PLAYLIST = ${JSON.stringify(files, null, 2)};\n`;
fs.writeFileSync(OUT_FILE, content, "utf8");

console.log(`Wrote ${files.length} tracks to ${OUT_FILE}`);
