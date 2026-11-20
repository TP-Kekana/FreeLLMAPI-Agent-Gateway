import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";

const port = integerEnv("PORT", 8080);
const upstreamOrigin = new URL(process.env.FREELLMAPI_ORIGIN || "http://freellmapi:3001");
const upstreamKey = process.env.FREELLMAPI_UNIFIED_KEY || "";
const maxBodyBytes = integerEnv("MAX_BODY_BYTES", 20 * 1024 * 1024);
const requestTimeoutMs = integerEnv("REQUEST_TIMEOUT_MS", 300_000);

const roles = Object.freeze({
  worker: roleConfig("WORKER", "auto:worker"),
  planner: roleConfig("PLANNER", "auto:planner"),
  manager: roleConfig("MANAGER", "auto:manager"),
  ui: roleConfig("UI", "auto:ui"),
});

const allowedCorsOrigins = new Set(
  (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

function integerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function roleConfig(prefix, defaultModel) {
  return Object.freeze({
    key: process.env[`${prefix}_API_KEY`] || "",
    model: process.env[`${prefix}_MODEL`] || defaultModel,
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left, right) {
  if (!left || !right) return false;
  return timingSafeEqual(digest(left), digest(right));
}

function bearerToken(req) {
  const authorization = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || "";
}

function sendJson(res, statusCode, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !allowedCorsOrigins.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-request-id",
    "access-control-expose-headers": "x-request-id,x-served-model",
    vary: "Origin",
  };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error("request body exceeds configured limit");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function rewriteJsonBody(rawBody, contentType, role) {
  if (!rawBody.length || !contentType.includes("application/json")) return rawBody;
  const payload = JSON.parse(rawBody.toString("utf8"));
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (!payload.model || payload.model === "auto") payload.model = role.model;
    payload.metadata = {
      ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
      nextgen_role: role.name,
    };
  }
  return Buffer.from(JSON.stringify(payload));
}

function filteredResponseHeaders(headers) {
  const blocked = new Set([
    "connection",
    "content-length",
    "content-encoding",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  const output = {};
  for (const [name, value] of headers.entries()) {
    if (!blocked.has(name.toLowerCase())) output[name] = value;
  }
  return output;
}

async function health(req, res) {
  let upstream = "unreachable";
  try {
    const response = await fetch(new URL("/api/ping", upstreamOrigin), {
      signal: AbortSignal.timeout(5_000),
    });
    upstream = response.ok ? "healthy" : `http_${response.status}`;
  } catch {
    upstream = "unreachable";
  }

  const configuredRoles = Object.fromEntries(
    Object.entries(roles).map(([name, role]) => [name, Boolean(role.key)]),
  );
  const ready = upstream === "healthy" && Boolean(upstreamKey) && Object.values(configuredRoles).every(Boolean);
  sendJson(res, ready ? 200 : 503, {
    status: ready ? "ready" : "not_ready",
    upstream,
    upstream_key_configured: Boolean(upstreamKey),
    roles: configuredRoles,
  }, corsHeaders(req));
}

async function proxyRequest(req, res, roleName, upstreamPath) {
  const roleBase = roles[roleName];
  const role = { ...roleBase, name: roleName };
  if (!role.key) {
    sendJson(res, 503, { error: { type: "configuration_error", message: `${roleName} API is not configured` } });
    return;
  }
  if (!safeEqual(bearerToken(req), role.key)) {
    sendJson(res, 401, { error: { type: "authentication_error", message: "invalid role API key" } }, corsHeaders(req));
    return;
  }
  if (!upstreamKey) {
    sendJson(res, 503, { error: { type: "configuration_error", message: "FreeLLMAPI upstream key is not configured" } });
    return;
  }

  const rawBody = ["GET", "HEAD"].includes(req.method) ? Buffer.alloc(0) : await readBody(req);
  let body;
  try {
    body = rewriteJsonBody(rawBody, req.headers["content-type"] || "", role);
  } catch {
    sendJson(res, 400, { error: { type: "invalid_request_error", message: "request body must be valid JSON" } });
    return;
  }

  const requestId = String(req.headers["x-request-id"] || randomUUID());
  const target = new URL(upstreamPath + new URL(req.url, "http://gateway.invalid").search, upstreamOrigin);
  const headers = new Headers();
  for (const name of ["accept", "content-type", "user-agent"]) {
    const value = req.headers[name];
    if (value) headers.set(name, String(value));
  }
  headers.set("authorization", `Bearer ${upstreamKey}`);
  headers.set("x-request-id", requestId);
  headers.set("x-nextgen-role", roleName);

  const upstreamResponse = await fetch(target, {
    method: req.method,
    headers,
    body: body.length ? body : undefined,
    duplex: body.length ? "half" : undefined,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  res.writeHead(upstreamResponse.status, {
    ...filteredResponseHeaders(upstreamResponse.headers),
    ...corsHeaders(req),
    "x-request-id": requestId,
    "cache-control": "no-store",
  });
  if (!upstreamResponse.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstreamResponse.body).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/livez") {
      sendJson(res, 200, { status: "alive" }, corsHeaders(req));
      return;
    }
    if (req.url === "/healthz" || req.url === "/readyz") {
      await health(req, res);
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    if (!new Set(["GET", "POST"]).has(req.method)) {
      sendJson(res, 405, { error: { type: "method_not_allowed", message: "only GET and POST are supported" } });
      return;
    }

    const match = /^\/(worker|planner|manager|ui)(\/v1(?:\/.*)?)$/.exec(new URL(req.url, "http://gateway.invalid").pathname);
    if (!match) {
      sendJson(res, 404, {
        error: {
          type: "not_found",
          message: "use /worker/v1, /planner/v1, /manager/v1, or /ui/v1",
        },
      });
      return;
    }
    await proxyRequest(req, res, match[1], match[2]);
  } catch (error) {
    const statusCode = error?.statusCode || (error?.name === "TimeoutError" ? 504 : 502);
    sendJson(res, statusCode, {
      error: {
        type: statusCode === 504 ? "upstream_timeout" : "gateway_error",
        message: statusCode === 504 ? "upstream request timed out" : "gateway request failed",
      },
    });
  }
});

server.requestTimeout = requestTimeoutMs + 5_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 65_000;

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "gateway_started", port, upstream: upstreamOrigin.origin }));
  });
}

export { server, rewriteJsonBody, safeEqual };
