// server.js — FEthink Lesson Designer (Paid)
// FULL FILE
// Adds:
// - PPT themes (light/dark): pass { theme: "light" | "dark" } to /pptx
// - Logo upload: pass { logoDataUrl } to /pptx (optional)
// - Speaker notes pane: reads "Speaker notes:" from slide text and attaches to slide notes

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import crypto from "crypto";
import PptxGenJS from "pptxgenjs";

const app = express();
app.use(express.json({ limit: "6mb" })); // increased for logoDataUrl payload

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
const MAX_MESSAGE_CHARS = Number(process.env.MAX_MESSAGE_CHARS || 8000);

// PPT safety caps
const MAX_PPTX_INPUT_CHARS = Number(process.env.MAX_PPTX_INPUT_CHARS || 30000);
const PPTX_MAX_SLIDES = Number(process.env.PPTX_MAX_SLIDES || 20);

// -------------------- In-memory store (daily usage) --------------------
const usage = new Map(); // YYYY-MM-DD::clientId -> count

// -------------------- Helpers --------------------
function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getClientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").toString();
  return xf.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

function clientId(req) {
  const ip = getClientIp(req);
  const ua = (req.headers["user-agent"] || "").toString().slice(0, 120);
  return crypto.createHash("sha256").update(`${ip}::${ua}`).digest("hex").slice(0, 24);
}

function isAllowedExplorer(token) {
  if (!WIDGET_TOKEN_EXPLORER) return false; // fail closed
  return (token || "").trim() === WIDGET_TOKEN_EXPLORER;
}

// -------------------- Static --------------------
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
app.get("/", (_, res) => res.sendFile(path.join(PUBLIC_DIR, "widget-paid.html")));

// -------------------- Slide parsing --------------------
/**
Expected slide text style (your widget already prompts this):
Slide 1: Title
Layout: ...
- bullet
- bullet
Visual suggestion: ...
Speaker notes: ...
(more notes lines...)
Slide 2: ...
*/
function parseSlidesWithNotes(raw) {
  const text = (raw || "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];

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
    const block = lines.slice(start, end);

    const header = (block[0] || "").trim();
    let title = header.replace(/^\s*Slide\s+\d+\s*[:\-]?\s*/i, "").trim();
    if (!title) title = `Slide ${s + 1}`;

    const bullets = [];
    const notes = [];
    const layoutHints = [];
    let inNotes = false;

    for (let i = 1; i < block.length; i++) {
      const lineRaw = block[i] || "";
      const line = lineRaw.trim();
      if (!line) continue;

      // Speaker notes begin
      if (/^Speaker notes\b/i.test(line)) {
        inNotes = true;
        const after = line.split(":").slice(1).join(":").trim();
        if (after) notes.push(after);
        continue;
      }

      if (inNotes) {
        notes.push(lineRaw.trimEnd());
        continue;
      }

      // layout hints
      if (/^(Layout|Visual suggestion|Visual)\s*:/i.test(line)) {
        layoutHints.push(line);
        continue;
      }

      // bullets
      if (/^[-•*]\s+/.test(line)) {
        bullets.push(line.replace(/^[-•*]\s+/, "").trim());
        continue;
      }

      // fallback: treat as bullet
      bullets.push(line);
    }

    slides.push({
      title,
      bullets: bullets.slice(0, 12),
      notes: notes.join("\n").trim(),
      layoutHints: layoutHints.join("\n").trim()
    });
  }

  return slides.slice(0, PPTX_MAX_SLIDES);
}

// -------------------- PPT building --------------------
function themeTokens(themeName) {
  // Hex without '#', pptxgenjs style
  if ((themeName || "").toLowerCase() === "dark") {
    return {
      name: "dark",
      bg: "111216",
      accent: "6F2DBD",
      title: "FFFFFF",
      body: "F2F2F2",
      muted: "B8B8B8",
      rule: "2A2A2A"
    };
  }
  // default light
  return {
    name: "light",
    bg: "F7F7F9",
    accent: "6F2DBD",
    title: "111111",
    body: "111111",
    muted: "555555",
    rule: "E6E6E6"
  };
}

// Adds background + top bar + optional logo to a slide
function applyBranding(slide, pptx, t, logoDataUrl) {
  slide.background = { fill: t.bg };

  // Accent bar
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: "100%", h: 0.35,
    fill: { color: t.accent }
  });

  // Optional logo (top-right)
  // Works with PNG/JPEG DataURL like "data:image/png;base64,..."
  if (logoDataUrl && typeof logoDataUrl === "string" && logoDataUrl.startsWith("data:image/")) {
    slide.addImage({
      data: logoDataUrl,
      x: 11.55, y: 0.08, w: 1.65, h: 0.65,
      sizing: { type: "contain", w: 1.65, h: 0.65 }
    });
  }
}

async function buildPptxBuffer({ deckTitle, subtitle, slides, theme, logoDataUrl }) {
  const t = themeTokens(theme);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "FEthink";
  pptx.company = "FEthink";

  const FONT = "Calibri";

  // Title slide
  {
    const s = pptx.addSlide();
    applyBranding(s, pptx, t, logoDataUrl);

    s.addText(deckTitle || "FEthink – Lesson Slides", {
      x: 0.9, y: 2.0, w: 11.6, h: 1.0,
      fontFace: FONT, fontSize: 40, bold: true, color: t.title
    });

    if (subtitle) {
      s.addText(subtitle, {
        x: 0.9, y: 3.1, w: 11.6, h: 0.6,
        fontFace: FONT, fontSize: 18, color: t.muted
      });
    }

    s.addText(`Theme: ${t.name}`, {
      x: 0.9, y: 6.9, w: 11.6, h: 0.3,
      fontFace: FONT, fontSize: 12, color: t.muted
    });
  }

  // Content slides
  for (const sl of slides) {
    const s = pptx.addSlide();
    applyBranding(s, pptx, t, logoDataUrl);

    // Slide title
    s.addText(sl.title || "Slide", {
      x: 0.8, y: 0.6, w: 12.0, h: 0.8,
      fontFace: FONT, fontSize: 34, bold: true, color: t.title
    });

    // A subtle divider line under the title
    s.addShape(pptx.ShapeType.line, {
      x: 0.8, y: 1.35, w: 11.9, h: 0,
      line: { color: t.rule, width: 1 }
    });

    // Body bullets at 24pt
    const bulletText = (sl.bullets && sl.bullets.length)
      ? sl.bullets.map(b => `• ${b}`).join("\n")
      : " ";

    s.addText(bulletText, {
      x: 1.05, y: 1.55, w: 11.55, h: 4.9,
      fontFace: FONT, fontSize: 24, color: t.body,
      valign: "top"
    });

    // Speaker notes pane (Presenter View)
    // pptxgenjs supports slide notes via addNotes (string)
    const notesParts = [];
    if (sl.layoutHints) notesParts.push(sl.layoutHints);
    if (sl.notes) notesParts.push(sl.notes);

    const notesText = notesParts.join("\n\n").trim();
    if (notesText) {
      s.addNotes(notesText);
    }
  }

  return await pptx.write("nodebuffer");
}

// -------------------- /ask --------------------
app.post("/ask", async (req, res) => {
  try {
    const { message, tier, token } = req.body || {};

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.json({ reply: "Please enter a question." });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.json({ reply: `Your request is too long (max ${MAX_MESSAGE_CHARS} characters).` });
    }

    // Explorer gating
    if ((tier || "").toLowerCase() === "explorer") {
      if (!isAllowedExplorer(token)) {
        return res.json({ reply: "Access check failed. Please open this assistant from your paid FEthink page." });
      }

      const id = clientId(req);
      const key = `${dayKey()}::${id}`;
      const used = usage.get(key) || 0;

      if (used >= EXPLORER_DAILY_LIMIT) {
        return res.json({ reply: "Daily limit reached.", used, limit: EXPLORER_DAILY_LIMIT });
      }

      usage.set(key, used + 1);

      const ai = await openai.responses.create({
        model: "gpt-4o-mini",
        input: message
      });

      return res.json({
        reply: ai.output_text || "No response generated.",
        used: used + 1,
        limit: EXPLORER_DAILY_LIMIT
      });
    }

    // If you later add PRO, handle here. For now:
    return res.json({ reply: "Tier not supported." });
  } catch (err) {
    console.error("ASK ERROR:", err);
    return res.status(500).json({ reply: "AI error — check server logs." });
  }
});

// -------------------- /pptx --------------------
app.post("/pptx", async (req, res) => {
  try {
    const { slidesText, tier, token, theme, logoDataUrl, deckTitle, subtitle } = req.body || {};

    // Gate PPT export to Explorer
    if ((tier || "").toLowerCase() === "explorer") {
      if (!isAllowedExplorer(token)) {
        return res.status(403).json({ error: "Access denied" });
      }
    } else {
      return res.status(403).json({ error: "Tier not supported" });
    }

    if (!slidesText || typeof slidesText !== "string" || !slidesText.trim()) {
      return res.status(400).json({ error: "Missing slidesText" });
    }

    if (slidesText.length > MAX_PPTX_INPUT_CHARS) {
      return res.status(400).json({ error: "Slides text is too long for PPT export." });
    }

    const slides = parseSlidesWithNotes(slidesText);
    if (!slides.length) {
      return res.status(400).json({
        error: "No slides detected. Ensure the slides include lines like “Slide 1: Title”."
      });
    }

    const buf = await buildPptxBuffer({
      deckTitle: deckTitle || "FEthink – Lesson Slides",
      subtitle: subtitle || "",
      slides,
      theme: (theme || "light"),
      logoDataUrl: logoDataUrl || null
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="FEthink-slides-${dayKey()}.pptx"`
    );
    return res.send(buf);
  } catch (err) {
    console.error("PPTX ERROR:", err);
    return res.status(500).json({ error: "PPT generation failed" });
  }
});

// -------------------- Start --------------------
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => console.log(`FEthink server running on port ${PORT}`));
