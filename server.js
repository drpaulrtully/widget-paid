import express from "express";
import cors from "cors";
import crypto from "crypto";
import PptxGenJS from "pptxgenjs";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "15mb" })); // allow base64 logo

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------- Config --------------------
const LIMITS = {
  free: 5,
  explorer: 50,
  pro: 200
};

const TOKENS = {
  free: process.env.WIDGET_TOKEN_FREE || "",
  explorer: process.env.WIDGET_TOKEN_EXPLORER || "",
  pro: process.env.WIDGET_TOKEN_PRO || ""
};

// In-memory daily usage (resets if server restarts)
const usage = new Map();

// -------------------- Helpers --------------------
function todayKey() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getClientId(req, res) {
  // Cookie-based stable id
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/fethink_cid=([^;]+)/);
  if (match && match[1]) return match[1];

  const id = crypto.randomBytes(16).toString("hex");
  res.setHeader("Set-Cookie", `fethink_cid=${id}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  return id;
}

function deny(res, msg = "Access check failed. Please open this assistant from your paid FEthink page.") {
  return res.status(403).json({ reply: msg, used: null, limit: null });
}

function checkAccess(req, res, tier, token) {
  const expected = TOKENS[tier] || "";
  if (!expected) return deny(res, "Server token is not configured for this tier.");
  if (!token || token !== expected) return deny(res);
  return null;
}

function bumpUsage(req, res, tier) {
  const limit = LIMITS[tier] ?? 0;
  if (!limit) return { used: null, limit: null, ok: true };

  const cid = getClientId(req, res);
  const key = `${todayKey()}::${tier}::${cid}`;
  const current = usage.get(key) || 0;

  if (current >= limit) {
    return { ok: false, used: current, limit };
  }

  const next = current + 1;
  usage.set(key, next);
  return { ok: true, used: next, limit };
}

function parseSlides(slidesText) {
  // Expect blocks like:
  // Slide 1: Title
  // - bullet
  // Speaker notes: ...
  const blocks = slidesText
    .split(/\n(?=Slide\s+\d+\s*:)/i)
    .map(s => s.trim())
    .filter(Boolean);

  const slides = [];
  for (const b of blocks) {
    const lines = b.split("\n").map(l => l.trim());
    const head = lines.shift() || "";
    const m = head.match(/^Slide\s+(\d+)\s*:\s*(.*)$/i);
    if (!m) continue;

    const title = (m[2] || "").trim() || `Slide ${m[1]}`;
    const bullets = [];
    let notes = "";

    for (const line of lines) {
      const noteMatch = line.match(/^Speaker\s*notes\s*:\s*(.*)$/i);
      if (noteMatch) {
        notes += (notes ? "\n" : "") + (noteMatch[1] || "");
        continue;
      }
      if (/^-\s+/.test(line)) bullets.push(line.replace(/^-+\s*/, ""));
      else if (line) {
        // treat as plain bullet
        bullets.push(line);
      }
    }

    slides.push({ title, bullets, notes });
  }
  return slides;
}

function dataUrlToImage(dataUrl) {
  // data:image/png;base64,....
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:(image\/png|image\/jpeg);base64,(.+)$/);
  if (!m) return null;
  const ext = m[1] === "image/png" ? "png" : "jpg";
  const b64 = m[2];
  return { ext, b64 };
}

// -------------------- Routes --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/ask", async (req, res) => {
  try {
    const { message, tier = "explorer", token = "" } = req.body || {};
    const safeTier = String(tier).toLowerCase();

    if (!message || typeof message !== "string") {
      return res.json({ reply: "Please enter a question.", used: null, limit: null });
    }

    // Enforce access for paid tiers (and for free if you want)
    // Here we enforce for explorer/pro; free can be open if you prefer.
    if (safeTier === "explorer" || safeTier === "pro") {
      const denyResp = checkAccess(req, res, safeTier, token);
      if (denyResp) return;
    }

    // Usage
    const u = bumpUsage(req, res, safeTier);
    if (!u.ok) {
      return res.json({
        reply: `You’ve reached today’s limit (${u.limit}). Please try again tomorrow.`,
        used: u.used,
        limit: u.limit
      });
    }

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: message
    });

    return res.json({
      reply: response.output_text || "No response generated.",
      used: u.used,
      limit: u.limit
    });
  } catch (err) {
    console.error("ASK ERROR:", err);
    return res.json({ reply: "Temporary error. Please try again shortly.", used: null, limit: null });
  }
});

app.post("/pptx", async (req, res) => {
  try {
    const { tier = "explorer", token = "", slidesText = "", deckTitle = "FEthink Slides", subtitle = "", theme = "light", logoDataUrl = null } = req.body || {};
    const safeTier = String(tier).toLowerCase();

    if (safeTier === "explorer" || safeTier === "pro") {
      const denyResp = checkAccess(req, res, safeTier, token);
      if (denyResp) return;
    }

    // (Optional) count PPT export as usage too
    const u = bumpUsage(req, res, safeTier);
    if (!u.ok) {
      return res.status(429).json({ error: `Daily limit reached (${u.limit}).`, used: u.used, limit: u.limit });
    }

    const slides = parseSlides(String(slidesText || ""));
    if (!slides.length) {
      return res.status(400).json({ error: "No slides found. Ensure output contains 'Slide 1:' etc." });
    }

    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = "FEthink";
    pptx.company = "FEthink";
    pptx.subject = "Lesson Slides";
    pptx.title = deckTitle;

    // Theme colours
    const isDark = String(theme).toLowerCase() === "dark";
    const BG = isDark ? "111111" : "FFFFFF";
    const TEXT = isDark ? "F3F3F3" : "111111";
    const MUTED = isDark ? "CFCFCF" : "444444";
    const ACCENT = "6F2DBD";

    // Logo (optional)
    const logo = dataUrlToImage(logoDataUrl);

    // Sizes (WIDE)
    // slide size approx 13.333 x 7.5 inches
    const SLIDE_W = 13.333;
    const SLIDE_H = 7.5;

    for (let i = 0; i < slides.length; i++) {
      const s = slides[i];
      const slide = pptx.addSlide();

      // Background
      slide.background = { color: BG };

      // Top accent bar
      slide.addShape(pptx.ShapeType.rect, {
        x: 0, y: 0, w: SLIDE_W, h: 0.45,
        fill: { color: ACCENT },
        line: { color: ACCENT }
      });

      // Logo top-right (inside bar area)
      if (logo) {
        try {
          slide.addImage({
            data: `data:image/${logo.ext};base64,${logo.b64}`,
            x: SLIDE_W - 1.55,
            y: 0.07,
            w: 1.35,
            h: 0.31
          });
        } catch (e) {
          // ignore logo errors
        }
      }

      // Title
      slide.addText(s.title || `Slide ${i+1}`, {
        x: 0.6, y: 0.65, w: SLIDE_W - 1.2, h: 0.7,
        fontFace: "Calibri",
        fontSize: 36,
        bold: true,
        color: TEXT
      });

      // Subtitle (context line)
      if (subtitle) {
        slide.addText(subtitle, {
          x: 0.6, y: 1.35, w: SLIDE_W - 1.2, h: 0.35,
          fontFace: "Calibri",
          fontSize: 16,
          color: MUTED
        });
      }

      // Bullets
      const bulletText = (s.bullets || []).slice(0, 7).map(b => b.trim()).filter(Boolean);
      const bulletBlock = bulletText.length ? bulletText.join("\n") : " ";
      slide.addText(bulletBlock, {
        x: 0.9, y: 2.0, w: SLIDE_W - 1.6, h: 4.9,
        fontFace: "Calibri",
        fontSize: 24,
        color: TEXT,
        valign: "top",
        bullet: { indent: 18 },
        lineSpacingMultiple: 1.15
      });

      // Speaker notes (Presenter View)
      const notes = (s.notes || "").trim();
      if (notes) {
        slide.addNotes(notes);
      }
    }

    const buf = await pptx.write("nodebuffer");

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="FEthink-slides.pptx"`);
    return res.send(buf);
  } catch (err) {
    console.error("PPTX ERROR:", err);
    return res.status(500).json({ error: "PPT export failed. Check server logs." });
  }
});

// -------------------- Start --------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`FEthink server running on port ${PORT}`));
