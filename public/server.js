import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// --- Paths ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- OpenAI client (reads OPENAI_API_KEY from Render Environment) ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Tier limits (Explorer only for now) ---
const EXPLORER_DAILY_LIMIT = Number(process.env.EXPLORER_DAILY_LIMIT || 50);

// --- Token for Explorer (set this in Render → Environment) ---
const WIDGET_TOKEN_EXPLORER = (process.env.WIDGET_TOKEN_EXPLORER || "").trim();

// --- Simple in-memory usage store (resets on deploy/restart) ---
// For production, move to Redis/DB. This is OK for MVP.
const usage = new Map();

// --- Helpers ---
function todayKeyUTC() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getClientKey(req) {
  // Basic best-effort fingerprint (not perfect, but OK for MVP)
  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const ua = (req.headers["user-agent"] || "").toString();
  return `${ip}::${ua.slice(0, 60)}`;
}

function isExplorerAllowed(token) {
  if (!WIDGET_TOKEN_EXPLORER) return false; // if you forgot to set env var, fail closed
  return (token || "").trim() === WIDGET_TOKEN_EXPLORER;
}

function bumpUsage(clientKey) {
  const key = `${todayKeyUTC()}::${clientKey}`;
  const current = usage.get(key) || 0;
  const next = current + 1;
  usage.set(key, next);
  return next;
}

function readUsage(clientKey) {
  const key = `${todayKeyUTC()}::${clientKey}`;
  return usage.get(key) || 0;
}

// --- Serve static files from /public ---
app.use(express.static(path.join(__dirname, "public")));

// --- Serve widget at multiple routes to avoid iframe/path 404s ---
function sendWidget(req, res) {
  res.sendFile(path.join(__dirname, "public", "widget-paid.html"));
}

app.get("/", sendWidget);
app.get("/widget-paid.html", sendWidget);
app.get("/widget-paid", sendWidget);
app.get("/widget-paid/", sendWidget);
app.get("/widget-paid.html/", sendWidget);

// --- Main ask route ---
app.post("/ask", async (req, res) => {
  try {
    const { message, tier, token } = req.body || {};
    const clientKey = getClientKey(req);

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.json({ reply: "Please enter a question.", used: readUsage(clientKey), limit: EXPLORER_DAILY_LIMIT });
    }

    // --- Explorer access gate ---
    // (You can extend later for PRO)
    if (tier === "explorer") {
      if (!isExplorerAllowed(token)) {
        return res.json({
          reply: "Access check failed. Please open this assistant from your paid FEthink page.",
          used: null,
          limit: EXPLORER_DAILY_LIMIT
        });
      }

      // --- Explorer daily usage limit ---
      const used = readUsage(clientKey);
      if (used >= EXPLORER_DAILY_LIMIT) {
        return res.json({
          reply: `You’ve reached today’s Explorer limit (${EXPLORER_DAILY_LIMIT} requests). Please try again tomorrow.`,
          used,
          limit: EXPLORER_DAILY_LIMIT
        });
      }
    }

    // Count this request (only after passing access + limit)
    const usedNow = bumpUsage(clientKey);

    // --- OpenAI call (Responses API) ---
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
    return res.json({
      reply: "OpenAI error — check server logs.",
      used: null,
      limit: EXPLORER_DAILY_LIMIT
    });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`FEthink paid widget running on port ${PORT}`);
});
