import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

// ---------- SETUP ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const WIDGET_TOKEN_EXPLORER = process.env.WIDGET_TOKEN_EXPLORER;

// ---------- OPENAI ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ---------- STATIC FILES ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- FORCE WIDGET ROUTES (PREVENTS 404s) ----------
function sendWidget(req, res) {
  res.sendFile(path.join(__dirname, "public", "widget-paid.html"));
}

app.get("/", sendWidget);
app.get("/widget-paid", sendWidget);
app.get("/widget-paid/", sendWidget);
app.get("/widget-paid.html", sendWidget);
app.get("/widget-paid.html/", sendWidget);

// ---------- ACCESS CHECK ----------
function checkAccess(req) {
  const { tier, token } = req.body || {};

  if (tier !== "explorer") return false;
  if (!token) return false;
  if (token !== WIDGET_TOKEN_EXPLORER) return false;

  return true;
}

// ---------- ASK ROUTE ----------
app.post("/ask", async (req, res) => {
  try {
    if (!checkAccess(req)) {
      return res.json({
        reply:
          "Access check failed. Please open this assistant from your paid FEthink page."
      });
    }

    const { message } = req.body;

    if (!message) {
      return res.json({ reply: "Please enter a request." });
    }

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: message
    });

    res.json({
      reply: response.output_text || "No response generated.",
      used: 1,
      limit: 50
    });

  } catch (err) {
    console.error("OPENAI ERROR:", err);
    res.json({
      reply: "Temporary error. Please try again shortly."
    });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`FEthink Lesson Designer running on port ${PORT}`);
});

