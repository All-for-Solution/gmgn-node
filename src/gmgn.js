const { REQUEST_GAP_MS } = require("./config");
const { NodeError, getSession, resetSession } = require("./browser");
const { log } = require("./log");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lanesFor(session) {
  if (!session.lanes) {
    const pages = session.pages?.length ? session.pages : [session.page];
    session.lanes = pages.map((page) => ({ page, pending: 0, tail: Promise.resolve() }));
  }
  return session.lanes;
}

function claimLane(session) {
  const lanes = lanesFor(session);
  let best = lanes[0];
  for (const lane of lanes) {
    if (lane.pending < best.pending) best = lane;
  }
  best.pending += 1;
  return best;
}

function schedule(lane, task) {
  const run = lane.tail.then(task, task);
  lane.tail = run.then(
    () => sleep(REQUEST_GAP_MS),
    () => undefined,
  ).then(() => {
    lane.pending -= 1;
  });
  return run;
}

function apiQuery(session) {
  const params = new URLSearchParams({
    device_id: session.state.deviceId,
    client_id: session.clientId,
    from_app: "gmgn",
    app_ver: session.appVer,
    tz_name: "Europe/Paris",
    tz_offset: String(new Date().getTimezoneOffset()),
    app_lang: "en-US",
    fp_did: session.state.fpDid,
    os: "web",
  });
  return params;
}

function allowedPath(path) {
  return path === "/api" || path.startsWith("/api/") || path.startsWith("/vas/");
}

async function evaluateFetch(page, url, options) {
  try {
    return await page.evaluate(async ({ target, method, body }) => {
      const headers = { accept: "application/json" };
      if (body) headers["content-type"] = "application/json";
      const res = await fetch(target, {
        method,
        credentials: "include",
        headers,
        body: body || undefined,
      });
      const text = await res.text();
      return { status: res.status, text };
    }, { target: url, method: options.method || "GET", body: options.body || "" });
  } catch (err) {
    await resetSession();
    throw new NodeError(`GMGN browser request failed: ${err.message}`, 503, "browser_request_failed");
  }
}

function buildUrl(session, path, query) {
  const params = apiQuery(session);
  for (const pair of query || []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    params.append(String(pair[0]), String(pair[1]));
  }
  return `https://gmgn.ai${path}?${params.toString()}`;
}

async function fetchGmgn(request) {
  const method = String(request?.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new NodeError("method must be GET or POST.", 400, "bad_request");
  }
  const path = String(request?.path || "");
  if (!path.startsWith("/") || path.includes("://") || !allowedPath(path)) {
    throw new NodeError("path must be a GMGN /api or /vas path.", 400, "bad_request");
  }
  const query = Array.isArray(request?.query) ? request.query : [];
  const payload = request?.body == null ? "" : JSON.stringify(request.body);

  const started = Date.now();
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const session = await getSession();
    const lane = claimLane(session);
    const windowNo = lanesFor(session).indexOf(lane) + 1;
    const result = await schedule(lane, async () => {
      if (attempt > 0) await sleep(REQUEST_GAP_MS);
      return evaluateFetch(lane.page, buildUrl(session, path, query), {
        method,
        body: method === "POST" ? payload : "",
      });
    });

    const blocked =
      result.status === 403 ||
      /^\s*</.test(result.text) ||
      /just a moment|attention required/i.test(result.text.slice(0, 400));

    if (result.status === 429) {
      lastError = new NodeError("GMGN rate limited the request.", 429, "rate_limited");
      log(`${method} ${path} window=${windowNo} rate limited, retry ${attempt + 1}`);
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (blocked) {
      lastError = new NodeError("Cloudflare blocked the GMGN request.", 503, "cloudflare_blocked");
      log(`${method} ${path} window=${windowNo} cloudflare blocked, retry ${attempt + 1}`);
      await resetSession();
      await sleep(1500);
      continue;
    }

    let body;
    try {
      body = JSON.parse(result.text);
    } catch (_) {
      log(`${method} ${path} window=${windowNo} non-json status=${result.status} ${Date.now() - started}ms`);
      throw new NodeError("GMGN returned a non-JSON response.", 502, "invalid_json");
    }
    const code = body && typeof body === "object" && body.code != null ? body.code : "-";
    log(`${method} ${path} window=${windowNo} -> ${result.status} code=${code} ${Date.now() - started}ms`);
    return { status: result.status, body };
  }
  log(`${method} ${path} failed ${lastError?.code || "gmgn_error"} ${Date.now() - started}ms`);
  throw lastError || new NodeError("GMGN request failed.", 502, "gmgn_error");
}

module.exports = { fetchGmgn };
