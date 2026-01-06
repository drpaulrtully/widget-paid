// server.js (ESM) — FEthink Lesson Designer (Paid)
// - Serves public/widget-paid.html reliably at multiple routes
// - /ask enforces tier token + daily limits + basic rate limiting
// - Returns { reply, used, limit } for the on-screen counter

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

// -------------------- Paths --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

// -------------------- OpenAI --------------------
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
if (!OPENAI_API_KEY) {
  console.error("ERROR: Missing OPENAI_API_KEY in environment.");
}
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -------------------- Config --------------------
// Explorer access token (set in Render → Environment)
const WIDGET_TOKEN_EXPLORER = (process.env.WIDGET_TOKEN_EXPLORER || "").trim();

// Daily limits (defaults)
const EXPLORER_DAILY_LIMIT = Number(process.env.EXPLORER_DAILY_LIMIT || 50);

// Optional origin allow-list for POST /ask (comma-separated)
// Example: https://fethink.co.uk,https://payhip.com,https://*.payhip.com
const ALLOWED_ORIGINS_RAW = (process.env.ALLOWED_ORIGINS || "").trim();

// Basic rate limiting (in-memory)
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000); // 1 min
const RATE_MAX_REQ = Number(process.env.RATE_MAX_REQ || 30); // per IP per window

// Prompt length cap (simple abuse protection)
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 8000);

// -------------------- In-memory stores --------------------
// NOTE: These reset on deploy/restart. For stronger persistence, use Redis/DB later.
const dailyUsage = new Map(); // key: YYYY-MM-DD::clientId -> count
const rateBuckets = new Map(); // key: ip -> { windowStart, count }

// -------------------- Helpers --------------------
function utcDayKey() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getClientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").toString();
  const ip = xf.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  return ip;
}

function getClientId(req) {
  // Best-effort identifier for daily counting. Not perfect, but works well for MVP.
  // We hash to keep keys small and avoid storing full UA strings.
  const ip = getClientIp(req);
  const ua = (req.headers["user-agent"] || "").toString().slice(0, 120);
  const raw = `${ip}::${ua}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function readUsage(clientId) {
  const key = `${utcDayKey()}::${clientId}`;
  return dailyUsage.get(key) || 0;
}

function bumpUsage(clientId) {
  const key = `${utcDayKey()}::${clientId}`;
  const next = (dailyUsage.get(key) || 0) + 1;
  dailyUsage.set(key, next);
  return next;
}

function isAllowedExplorer(token) {
  if (!WIDGET_TOKEN_EXPLORER) return false; // fail closed if env missing
  return (token || "").trim() === WIDGET_TOKEN_EXPLORER;
}

// --- Origin checks (optional, controlled by env) ---
function parseAllowedOrigins(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

const ALLOWED_ORIGINS = parseAllowedOrigins(ALLOWED_ORIGINS_RAW);

function originAllowed(originOrReferer) {
  if (!ALLOWED_ORIGINS.length) return true; // disabled
  if (!originOrReferer) return false;

  // Normalize to just the origin portion if a full URL is given.
  let url;
  try {
    url = new URL(originOrReferer);
  } catch {
    return false;
  }
  const origin = url.origin;

  // Support exact match and simple wildcard subdomain match like https://*.payhip.com
  return ALLOWED_ORIGINS.some(allowed => {
    if (allowed.includes("*.")) {
      // Example allowed: https://*.payhip.com
      const [scheme, rest] = allowed.split("://");
      if (!rest) return false;
      const domain = rest.replace("*.", "");
      return origin.startsWith(`${scheme}://`) && url.hostname.endsWith(`.${domain}`);
    }
    return origin === allowed;
  });
}

// --- Rate limiting (very basic) ---
function rateLimitCheck(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket) {
    rateBuckets.set(ip, { windowStart: now, count: 1 });
    return { ok: true };
  }

  if (now - bucket.windowStart > RATE_WINDOW_MS) {
    // new window
    bucket.windowStart = now;
    bucket.count = 1;
    rateBuckets.set(ip, bucket);
    return { ok: true };
  }

  bucket.count += 1;
  rateBuckets.set(ip, bucket);

  if (bucket.count > RATE_MAX_REQ) {
    return { ok: false };
  }

  return { ok: true };
}

// -------------------- Static hosting --------------------
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

function sendWidgetPaid(req, res) {
  res.sendFile(path.join(PUBLIC_DIR, "widget-paid.html"));
}

// Serve widget reliably (prevents “Not found” in embeds)
app.get("/", sendWidgetPaid);
app.get("/widget-paid.html", sendWidgetPaid);
app.get("/widget-paid", sendWidgetPaid);
app.get("/widget-paid/", sendWidgetPaid);

// -------------------- API --------------------
app.post("/ask", async (req, res) => {
  try {
    // Optional origin/referrer enforcement
    const origin = (req.headers.origin || "").toString();
    const referer = (req.headers.referer || "").toString();
    const originOrReferer = origin || referer;

    if (!originAllowed(originOrReferer)) {
      return res.status(403).json({
        reply: "Access blocked. Please open this assistant from the FEthink website.",
        used: null,
        limit: EXPLORER_DAILY_LIMIT
      });
    }

    // Rate limit
    const rl = rateLimitCheck(req);
    if (!rl.ok) {
      return res.status(429).json({
        reply: "You’re sending requests too quickly. Please wait a moment and try again.",
        used: null,
        limit: EXPLORER_DAILY_LIMIT
      });
    }

    const { message, tier, token } = req.body || {};
    const clientId = getClientId(req);

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.json({
        reply: "Please enter a question.",
        used: readUsage(clientId),
        limit: EXPLORER_DAILY_LIMIT
      });
    }

    if (message.length > MAX_MESSAGE_CHARS) {
      return res.json({
        reply: `Your request is too long. Please shorten it (max ${MAX_MESSAGE_CHARS} characters).`,
        used: readUsage(clientId),
        limit: EXPLORER_DAILY_LIMIT
      });
    }

    // ---- Tier gate: Explorer (you said Pro later) ----
    if ((tier || "").toLowerCase() === "explorer") {
      if (!isAllowedExplorer(token)) {
        return res.json({
          reply: "Access check failed. Please open this assistant from your paid FEthink page.",
          used: null,
          limit: EXPLORER_DAILY_LIMIT
        });
      }

      const used = readUsage(clientId);
      if (used >= EXPLORER_DAILY_LIMIT) {
        return res.json({
          reply: `You’ve reached today’s Explorer limit (${EXPLORER_DAILY_LIMIT} requests). Please try again tomorrow.`,
          used,
          limit: EXPLORER_DAILY_LIMIT
        });
      }
    } else {
      // If you want to restrict non-explorer calls:
      // return res.json({ reply: "Unsupported tier.", used: null, limit: EXPLORER_DAILY_LIMIT });
      // For now, default to Explorer rules if tier missing:
      // (Your widget should pass tier=explorer.)
    }

    // Count only after passing access + limit checks
    const usedNow = bumpUsage(clientId);

    // OpenAI call
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: message
    });

    return res.json({
      reply: response.output_text || "No response generated.",
      used: usedNow,
      limit: EXPLORER_DAILY_LIMIT
    });
  } catch (err) {
    console.error("ASK ERROR:", err);
    return res.status(500).json({
      reply: "OpenAI error — check server logs.",
      used: null,
      limit: EXPLORER_DAILY_LIMIT
    });
  }
});

// -------------------- Start --------------------
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => {
  console.log(`FEthink paid widget running on port ${PORT}`);
  if (ALLOWED_ORIGINS.length) {
    console.log(`Origin allow-list enabled: ${ALLOWED_ORIGINS.join(", ")}`);
  } else {
    console.log("Origin allow-list disabled (ALLOWED_ORIGINS not set).");
  }
});
