// server.js (ESM) — FEthink Lesson Designer (Paid)
// - Serves public/widget-paid.html reliably
// - /ask enforces tier token + daily limits + basic rate limiting
// - /pptx builds a real .pptx from the Slides artefact (premium export)

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import crypto from "crypto";
import PptxGenJS from "pptxgenjs";

const app = express();
app.use(express.json({ limit: "2mb" }));

// -------------------- Paths --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

// -------------------- OpenAI --------------------
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
if (!OPENAI_API_KEY) console.error("ERROR: Missing OPENAI_API_KEY in environment.");
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -------------------- Config --------------------
const WIDGET_TOKEN_EXPLORER = (process.env.WIDGET_TOKEN_EXPLORER || "").trim();
const EXPLORER_DAILY_LIMIT = Number(process.env.EXPLORER_DAILY_LIMIT || 50);

// Optional origin allow-list for POST routes (comma-separated)
// Example: https://fethink.co.uk,https://payhip.com,https://*.payhip.com
const ALLOWED_ORIGINS_RAW = (process.env.ALLOWED_ORIGINS || "").trim();

// Basic rate limiting (in-memory)
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000);
const RATE_MAX_REQ = Number(process.env.RATE_MAX_REQ || 30);

// Prompt length cap
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 8000);

// PPTX limits
const MAX_PPTX_INPUT_CHARS = Number(process.env.MAX_PPTX_INPUT_CHARS || 20000);
const PPTX_MAX_SLIDES = Number(process.env.PPTX_MAX_SLIDES || 20);

// -------------------- In-memory stores --------------------
const dailyUsage = new Map(); // YYYY-MM-DD::clientId -> count
const rateBuckets = new Map(); // ip -> { windowStart, count }

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
  return xf.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

function getClientId(req) {
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
  if (!WIDGET_TOKEN_EXPLORER) return false;
  return (token || "").trim() === WIDGET_TOKEN_EXPLORER;
}

// ---- Origin checks (optional) ----
function parseAllowedOrigins(raw) {
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}
const ALLOWED_ORIGINS = parseAllowedOrigins(ALLOWED_ORIGINS_RAW);

function originAllowed(originOrReferer) {
  if (!ALLOWED_ORIGINS.length) return true;
  if (!originOrReferer) return false;

  let url;
  try { url = new URL(originOrReferer); } catch { return false; }
  const origin = url.origin;

  return ALLOWED_ORIGINS.some(allowed => {
    if (allowed.includes("*.")) {
      const [scheme, rest] = allowed.split("://");
      if (!rest) return false;
      const domain = rest.replace("*.", "");
      return origin.startsWith(`${scheme}://`) && url.hostname.endsWith(`.${domain}`);
    }
    return origin === allowed;
  });
}

// ---- Rate limiting ----
function rateLimitCheck(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket) {
    rateBuckets.set(ip, { windowStart: now, count: 1 });
    return { ok: true };
  }

  if (now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket.windowStart = now;
    bucket.count = 1;
    rateBuckets.set(ip, bucket);
    return { ok: true };
  }

  bucket.count += 1;
  rateBuckets.set(ip, bucket);

  if (bucket.count > RATE_MAX_REQ) return { ok: false };
  return { ok: true };
}

// -------------------- Static hosting --------------------
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

function sendWidgetPaid(req, res) {
  res.sendFile(path.join(PUBLIC_DIR, "widget-paid.html"));
}
app.get("/", sendWidgetPaid);
app.get("/widget-paid.html", sendWidgetPaid);
app.get("/widget-paid", sendWidgetPaid);
app.get("/widget-paid/", sendWidgetPaid);

// -------------------- PPTX builder --------------------
function splitSlidesFromText(raw) {
  // Expects sections like:
  // Slide 1 + title (or "Slide 1: Title")
  // bullets with "- ..."
  // speaker notes lines (optional)
  const text = (raw || "").replace(/\r\n/g, "\n").trim();

  // Find slide headers
  const lines = text.split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*Slide\s+\d+\b/i.test(lines[i])) starts.push(i);
  }
  if (!starts.length) return [];

  const slides = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s];
    const end = s === starts.length - 1 ? lines.length : starts[s + 1];

    const block = lines.slice(start, end).map(l => l.trimEnd());
    const header = block[0].trim();

    // Title inference
    let title = header
      .replace(/^\s*Slide\s+\d+\s*[:\-]?\s*/i, "")
      .trim();
    if (!title) title = `Slide ${s + 1}`;

    const bullets = [];
    const notes = [];

    for (let i = 1; i < block.length; i++) {
      const line = block[i].trim();
      if (!line) continue;

      // If line looks like "Speaker notes:" treat subsequent lines as notes
      if (/^Speaker notes\b/i.test(line)) {
        const after = line.split(":").slice(1).join(":").trim();
        if (after) notes.push(after);
        continue;
      }

      // bullets
      if (/^[-•*]\s+/.test(line)) {
        bullets.push(line.replace(/^[-•*]\s+/, "").trim());
        continue;
      }

      // If it looks like "Layout:" or "Visual suggestion:" put into notes
      if (/^(Layout|Visual suggestion|Visual|Notes?)\s*:/i.test(line)) {
        notes.push(line);
        continue;
      }

      // Otherwise treat as bullet-like content
      bullets.push(line);
    }

    slides.push({ title, bullets, notes: notes.join("\n") });
  }

  return slides.slice(0, PPTX_MAX_SLIDES);
}

async function buildPptxBuffer({ deckTitle, subtitle, slides }) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "FEthink";
  pptx.company = "FEthink";
  pptx.subject = "Lesson Designer – Slides Export";

  const fontBody = "Calibri";
  const fontTitle = "Calibri";

  // Title slide
  {
    const slide = pptx.addSlide();
    slide.addText(deckTitle || "FEthink – Slides", {
      x: 0.6, y: 1.2, w: 12.2, h: 0.8,
      fontFace: fontTitle, fontSize: 36, bold: true, color: "111111"
    });
    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.6, y: 2.2, w: 12.2, h: 0.6,
        fontFace: fontBody, fontSize: 16, color: "444444"
      });
    }
    slide.addText("Generated by FEthink Lesson Designer", {
      x: 0.6, y: 6.6, w: 12.2, h: 0.4,
      fontFace: fontBody, fontSize: 12, color: "666666"
    });
  }

  // Content slides
  for (const s of slides) {
    const slide = pptx.addSlide();

    // Title
    slide.addText(s.title || "Slide", {
      x: 0.6, y: 0.5, w: 12.2, h: 0.6,
      fontFace: fontTitle, fontSize: 28, bold: true, color: "111111"
    });

    // Bullets
    const bulletText = (s.bullets || []).slice(0, 10).map(b => `• ${b}`).join("\n");
    slide.addText(bulletText || " ", {
      x: 0.9, y: 1.4, w: 11.6, h: 4.8,
      fontFace: fontBody, fontSize: 18, color: "111111",
      valign: "top"
    });

    // Notes / footer (small)
    const notesText = (s.notes || "").trim();
    if (notesText) {
      slide.addText(notesText, {
        x: 0.9, y: 6.3, w: 11.6, h: 0.9,
        fontFace: fontBody, fontSize: 10, color: "555555"
      });
    }
  }

  // Generate buffer
  const buf = await pptx.write("nodebuffer");
  return buf;
}

// -------------------- API: /ask --------------------
app.post("/ask", async (req, res) => {
  try {
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
    }

    const usedNow = bumpUsage(clientId);

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

// -------------------- API: /pptx --------------------
app.post("/pptx", async (req, res) => {
  try {
    const origin = (req.headers.origin || "").toString();
    const referer = (req.headers.referer || "").toString();
    const originOrReferer = origin || referer;

    if (!originAllowed(originOrReferer)) {
      return res.status(403).json({ error: "Access blocked." });
    }

    const rl = rateLimitCheck(req);
    if (!rl.ok) {
      return res.status(429).json({ error: "Rate limit. Please slow down." });
    }

    const { tier, token, slidesText, deckTitle, subtitle } = req.body || {};
    const clientId = getClientId(req);

    if ((tier || "").toLowerCase() === "explorer") {
      if (!isAllowedExplorer(token)) {
        return res.status(403).json({ error: "Access check failed." });
      }
      const used = readUsage(clientId);
      if (used >= EXPLORER_DAILY_LIMIT) {
        return res.status(403).json({ error: "Daily limit reached." });
      }
    }

    if (!slidesText || typeof slidesText !== "string" || !slidesText.trim()) {
      return res.status(400).json({ error: "Missing slidesText." });
    }

    if (slidesText.length > MAX_PPTX_INPUT_CHARS) {
      return res.status(400).json({ error: "Slides text is too long for PPT export." });
    }

    const slides = splitSlidesFromText(slidesText);
    if (!slides.length) {
      return res.status(400).json({
        error: "Could not detect slide structure. Ensure the artefact includes lines like “Slide 1 …”"
      });
    }

    const buf = await buildPptxBuffer({
      deckTitle: deckTitle || "FEthink – Slides",
      subtitle: subtitle || "",
      slides
    });

    const filename = `FEthink-slides-${utcDayKey()}.pptx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(buf);
  } catch (err) {
    console.error("PPTX ERROR:", err);
    return res.status(500).json({ error: "Failed to generate PPTX. Check server logs." });
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
