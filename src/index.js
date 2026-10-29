const crypto = require("crypto");
const express = require("express");
const { NODE_SECRET, PORT, GMGN_WINDOWS } = require("./config");
const { NodeError, closeBrowser, getSession, sessionStatus } = require("./browser");
const { fetchGmgn } = require("./gmgn");
const { log } = require("./log");

const app = express();
app.use(express.json({ limit: "2mb" }));

function secretMatches(given) {
  if (!NODE_SECRET || !given) return false;
  const actual = crypto.createHash("sha256").update(String(given)).digest();
  const expected = crypto.createHash("sha256").update(String(NODE_SECRET)).digest();
  return crypto.timingSafeEqual(actual, expected);
}

function requireSecret(req, res, next) {
  if (!NODE_SECRET) {
    res.status(503).json({ ok: false, error: "unconfigured", message: "GMGN_NODE_SECRET is not set." });
    return;
  }
  if (!secretMatches(req.get("secret-key"))) {
    log(`rejected ${req.method} ${req.path}`);
    res.status(401).json({ ok: false, error: "invalid_secret", message: "Invalid secret key." });
    return;
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/v1/session", requireSecret, async (_req, res) => {
  try {
    const status = await sessionStatus();
    log(`session loggedIn=${status.loggedIn} windows=${status.windows}`);
    res.json(status);
  } catch (err) {
    const status = err.status || 503;
    log(`session failed ${err.code || "gmgn_error"} ${err.message}`);
    res.status(status).json({ ok: false, error: err.code || "gmgn_error", message: err.message });
  }
});

app.post("/v1/gmgn", requireSecret, async (req, res) => {
  try {
    const result = await fetchGmgn(req.body);
    res.json({ ok: true, status: result.status, body: result.body });
  } catch (err) {
    const status = err instanceof NodeError ? err.status : 500;
    res.status(status).json({
      ok: false,
      error: err.code || "gmgn_error",
      message: err.message || "GMGN request failed.",
    });
  }
});

const server = app.listen(PORT, () => {
  log(`listening on ${PORT} windows=${GMGN_WINDOWS}`);
  getSession().catch((err) => {
    log(`session failed ${err.message}`);
  });
});

server.requestTimeout = 180000;
server.headersTimeout = 180000;

async function shutdown() {
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
