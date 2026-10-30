const fs = require("fs");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const { GMGN_WINDOWS, PROFILE_DIR } = require("./config");
const { log } = require("./log");

let sessionPromise = null;
let displayReady = null;
let xvfbChild = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class NodeError extends Error {
  constructor(message, status = 503, code = "gmgn_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function virtualDisplay() {
  const requested = process.env.GMGN_DISPLAY || ":95";
  const match = /^:(\d+)/.exec(requested);
  return match ? `:${match[1]}` : ":95";
}

function displaySocket(display) {
  return `/tmp/.X11-unix/X${display.slice(1)}`;
}

function ensureDisplay() {
  // An inherited SSH display (localhost:10.0) has no local screen and Chrome waits on it forever.
  const display = virtualDisplay();
  const socketPath = displaySocket(display);
  if (fs.existsSync(socketPath)) {
    process.env.DISPLAY = display;
    return Promise.resolve(display);
  }
  if (displayReady) return displayReady;

  displayReady = new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) {
        displayReady = null;
        if (xvfbChild) {
          xvfbChild.kill("SIGTERM");
          xvfbChild = null;
        }
        reject(err);
        return;
      }
      process.env.DISPLAY = display;
      if (xvfbChild) xvfbChild.unref();
      resolve(display);
    };

    const child = spawn(
      "Xvfb",
      [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"],
      { stdio: "ignore" },
    );
    xvfbChild = child;
    child.on("error", (err) => {
      xvfbChild = null;
      finish(new NodeError(`Xvfb failed to start (${err.message}).`, 503, "display_unavailable"));
    });
    child.on("exit", (code, signal) => {
      if (xvfbChild === child) xvfbChild = null;
      if (fs.existsSync(socketPath)) {
        finish();
        return;
      }
      finish(new NodeError(`Xvfb exited (${signal || code}).`, 503, "display_unavailable"));
    });

    const deadline = Date.now() + 5000;
    const poll = () => {
      if (settled) return;
      if (fs.existsSync(socketPath)) {
        finish();
        return;
      }
      if (Date.now() >= deadline) {
        finish(new NodeError(`Xvfb did not open ${socketPath}.`, 503, "display_unavailable"));
        return;
      }
      timer = setTimeout(poll, 50);
    };
    timer = setTimeout(poll, 50);
  });
  return displayReady;
}

function clientStamp() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const hex = (n) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${dateStr}-${hex(4)}-${hex(7)}`;
}

async function waitForGmgn(page) {
  const deadline = Date.now() + 45000;
  let lastTitle = "";
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => {
        let loggedIn = false;
        try {
          const user = JSON.parse(localStorage.getItem("userInfo") || "null");
          loggedIn = !!(user && typeof user === "object" && Object.keys(user).length > 0);
        } catch (_) {}
        return {
          title: document.title,
          href: location.href,
          deviceId: localStorage.getItem("key_device_id"),
          fpDid: localStorage.getItem("key_fp_did"),
          loggedIn,
        };
      })
      .catch(() => null);

    if (state) lastTitle = state.title || lastTitle;
    const blocked = /cloudflare|attention required|just a moment/i.test(state?.title || "");
    if (state?.deviceId && state?.fpDid && !blocked) return state;
    await sleep(1000);
  }

  throw new NodeError(
    `GMGN page did not become usable (${lastTitle || "no title"}).`,
    503,
    "gmgn_session_not_ready",
  );
}

async function openSession() {
  log(`opening ${GMGN_WINDOWS} chrome windows`);
  await ensureDisplay();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const pages = context.pages().slice(0, GMGN_WINDOWS);
  while (pages.length < GMGN_WINDOWS) pages.push(await context.newPage());
  for (const page of pages) {
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(30000);
  }
  await Promise.all(
    pages.map((page) => page.goto("https://gmgn.ai/?chain=sol", { waitUntil: "domcontentloaded" })),
  );
  const states = await Promise.all(pages.map((page) => waitForGmgn(page)));
  const state = states[0];
  const stamp = clientStamp();
  log(`session ready windows=${pages.length} loggedIn=${state.loggedIn} title="${state.title || ""}"`);
  return { context, pages, page: pages[0], clientId: `gmgn_web_${stamp}`, appVer: stamp, state };
}

function getSession() {
  if (!sessionPromise) {
    sessionPromise = openSession().catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

async function resetSession() {
  const current = sessionPromise;
  sessionPromise = null;
  if (!current) return;
  log("session reset");
  try {
    const session = await current;
    await session.context.close();
  } catch (_) {}
}

async function sessionStatus() {
  const session = await getSession();
  const state = await waitForGmgn(session.page);
  session.state = state;
  return {
    ok: true,
    loggedIn: state.loggedIn,
    title: state.title,
    windows: session.pages.length,
    mode: "chrome",
  };
}

function stopXvfb() {
  const child = xvfbChild;
  xvfbChild = null;
  displayReady = null;
  if (child && child.exitCode == null && !child.killed) child.kill("SIGTERM");
}

async function closeBrowser() {
  // Stop Xvfb before the first await. Playwright's own SIGINT handler exits the process
  // as soon as this function yields, which would leave the virtual display behind.
  stopXvfb();
  await resetSession();
}

module.exports = { NodeError, getSession, resetSession, sessionStatus, closeBrowser };
