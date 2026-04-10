const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const PDF_DIR = path.resolve(ROOT, "pdfs");
const OUT_FILE = path.resolve(PDF_DIR, "manifest.json");

if (!fs.existsSync(PDF_DIR) || !fs.statSync(PDF_DIR).isDirectory()) {
  console.error("pdfs folder not found.");
  process.exit(1);
}

const files = fs
  .readdirSync(PDF_DIR)
  .filter((name) => /\.pdf$/i.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
  .map((name) => ({ name, url: `./pdfs/${encodeURIComponent(name)}` }));

fs.writeFileSync(OUT_FILE, JSON.stringify({ files }, null, 2) + "\n", "utf8");
console.log(`Wrote ${files.length} PDF entries to ${OUT_FILE}`);
