const fs = require("fs");
const path = require("path");

function loadEnvFile() {
  const envPath = path.join(__dirname, "..", ".env");
  let text = "";
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT) || 4400;
const PROFILE_DIR =
  process.env.GMGN_PROFILE_DIR || path.join(__dirname, "..", "session", "chrome-profile");
const REQUEST_GAP_MS = Number(process.env.GMGN_GAP_MS) || 120;
const GMGN_WINDOWS = Math.max(1, Math.floor(Number(process.env.GMGN_WINDOWS)) || 3);
const NODE_SECRET = process.env.GMGN_NODE_SECRET || "";

module.exports = {
  PORT,
  PROFILE_DIR,
  REQUEST_GAP_MS,
  GMGN_WINDOWS,
  NODE_SECRET,
};
