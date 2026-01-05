import express from "express";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// Serve static files (our widget page)
app.use(express.static("public"));

// ---- CONFIG ----
const LIMITS = {
  explorer: 50,
  pro: 200
};

// OPTIONAL: add simple “token” gating per tier (not perfect security, but reduces casual abuse).
// Set these in Render Environment as WIDGET_TOKEN_EXPLORER and WIDGET_TOKEN_PRO.
// If you don’t want tokens, leave them blank in Render and the checks will be skipped.
const TOKEN_EXPLORER = process.env.WIDGET_TOKEN_EXPLORER || "";
const TOKEN_PRO = process.env.WIDGET_TOKEN_PRO || "";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- SIMPLE DAILY USAGE TRACKING (in-memory) ----
// NOTE: This resets if Render restarts. For bulletproof persistence you’d use Redis/DB.
// For most Payhip use-cases, this is fine to control day-to-day cost.
const usage = new Map(); // key: `${YYYY-MM-DD}::${tier}::${clientId}` -> count

function todayKey() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Client id via cookie (more stable than IP; doesn’t change with refresh)
function getClientId(req, res) {
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/fethink_cid=([a-f0-9]{32})/);
  if (m) return m[1];

  const cid = crypto.randomBytes(16).toString("hex");
  // 90 days cookie
  res.setHeader(
    "Set-Cookie",
    `fethink_cid=${cid}; Path=/; Max-Age=${60 * 60 * 24 * 90}; SameSite=Lax`
  );
  return cid;
}

// Optional token check per tier (helps stop random external use if someone finds your endpoint)
function tokenOk(tier, token) {
  if (tier === "explorer") return !TOKEN_EXPLORER || token === TOKEN_EXPLORER;
  if (tier === "pro") return !TOKEN_PRO || token === TOKEN_PRO;
  return false;
}

function getLimit(tier) {
  return LIMITS[tier] ?? 0;
}

function systemPrompt() {
  return `
You are FEthink's Lesson Designer for FE and HE educators.

GLOBAL RESPONSE RULES (apply to every answer):
- Use clear headings
- Use bullet points where appropriate
- Keep language plain and accessible
- Avoid long paragraphs
- Include timing suggestions when helpful
- Include differentiation ideas (SEND/EAL) when appropriate
- Provide something a teacher can use immediately

When the user selects a Subject and Activity type, tailor your output accordingly.
`.trim();
}

app.post("/ask", async (req, res) => {
  try {
    const { message, tier, token } = req.body;

    if (!message || typeof message !== "string") {
      return res.json({ reply: "Please enter a request.", used: null, limit: null });
    }

    // Only allow paid tiers on this paid service
    if (tier !== "explorer" && tier !== "pro") {
      return res.json({ reply: "Invalid tier for this assistant.", used: null, limit: null });
    }

    // Optional token gating
    if (!tokenOk(tier, token || "")) {
      return res.json({
        reply: "Access check failed. Please open this assistant from your paid FEthink page.",
        used: null,
        limit: getLimit(tier)
      });
    }

    const limit = getLimit(tier);
    const clientId = getClientId(req, res);
    const key = `${todayKey()}::${tier}::${clientId}`;
    const count = usage.get(key) || 0;

    if (count >= limit) {
      return res.json({
        reply: `You’ve reached today’s ${tier.toUpperCase()} limit (${limit} questions). Please try again tomorrow.`,
        used: count,
        limit
      });
    }

    // Count this request
    usage.set(key, count + 1);

    // Call OpenAI (Responses API)
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: message }
      ]
    });

    const out = response.output_text?.trim() || "No response generated.";

    return res.json({
      reply: out,
      used: count + 1,
      limit
    });
  } catch (err) {
    console.error("ASK ERROR:", err);
    return res.json({
      reply: "Temporary error. Please try again shortly.",
      used: null,
      limit: null
    });
  }
});

// Convenience route: open the widget directly (Render URL + /widget-paid.html)
app.get("/", (req, res) => {
  res.redirect("/widget-paid.html");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`FEthink Paid Widget running on port ${PORT}`);
});
