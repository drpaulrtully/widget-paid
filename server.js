import express from "express";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Limits per tier
const LIMITS = {
  explorer: 50,
  pro: 200
};

// Tokens per tier (set these in Render Environment)
const TOKEN_EXPLORER = process.env.WIDGET_TOKEN_EXPLORER || "";
const TOKEN_PRO = process.env.WIDGET_TOKEN_PRO || "";

// In-memory daily usage (resets if Render restarts)
const usage = new Map();

function todayKey() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getClientId(req, res) {
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/fethink_cid=([a-f0-9]{32})/);
  if (m) return m[1];

  const cid = crypto.randomBytes(16).toString("hex");
  res.setHeader(
    "Set-Cookie",
    `fethink_cid=${cid}; Path=/; Max-Age=${60 * 60 * 24 * 90}; SameSite=Lax`
  );
  return cid;
}

function tokenOk(tier, token) {
  if (tier === "explorer") return !TOKEN_EXPLORER || token === TOKEN_EXPLORER;
  if (tier === "pro") return !TOKEN_PRO || token === TOKEN_PRO;
  return false;
}

function systemPrompt() {
  return `
You are FEthink's Lesson Designer for FE and HE educators.

GLOBAL RESPONSE RULES:
- Use clear headings
- Use bullet points where appropriate
- Keep language plain and accessible
- Avoid long paragraphs
- Provide timings where helpful
- Make outputs ready to teach immediately

When the user supplies Subject + Activity + Quality Lenses, follow them precisely.
If Quality Lenses are selected, apply them explicitly in the output (not just implied).
`.trim();
}

app.post("/ask", async (req, res) => {
  try {
    const { message, tier, token } = req.body;

    if (!message || typeof message !== "string") {
      return res.json({ reply: "Please enter a request.", used: null, limit: null });
    }

    if (tier !== "explorer" && tier !== "pro") {
      return res.json({ reply: "Invalid tier for this assistant.", used: null, limit: null });
    }

    if (!tokenOk(tier, token || "")) {
      return res.json({
        reply: "Access check failed. Please open this assistant from your paid FEthink page.",
        used: null,
        limit: LIMITS[tier] || null
      });
    }

    const limit = LIMITS[tier];
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

    usage.set(key, count + 1);

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: message }
      ]
    });

    return res.json({
      reply: response.output_text?.trim() || "No response generated.",
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

app.get("/", (req, res) => res.redirect("/widget-paid.html"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`FEthink Paid Widget running on port ${PORT}`));
