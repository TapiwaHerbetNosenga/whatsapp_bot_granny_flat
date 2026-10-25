import crypto from "node:crypto";
import fs from "node:fs";
import express from "express";

const {
  PORT = 3000,
  VERIFY_TOKEN,
  ACCESS_TOKEN,
  PHONE_NUMBER_ID,
  APP_SECRET,
  GRAPH_VERSION = "v21.0",
  DRY_RUN = "false",
} = process.env;

const LEADS_FILE = new URL("./leads.json", import.meta.url);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // WhatsApp's free-form reply window

// Edit these to suit the listing.
const GREETING =
  "Hi, thanks for your interest in this property. I have three quick questions so I can get you the right information.";

const QUESTIONS = [
  "1. Are you looking to rent or buy?",
  "2. What is your budget? For a purchase, please say if you are paying cash or need a bond.",
  "3. When would you like to view the property, and when do you need to move in?",
];

const THANKS =
  "Thank you. I have your answers and will get back to you as soon as I can. Reply RESTART if you would like to start again.";

// In-memory state per phone number. Completed leads are also written to leads.json.
const sessions = new Map();

function loadLeads() {
  try {
    return JSON.parse(fs.readFileSync(LEADS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveLead(lead) {
  const leads = loadLeads();
  leads.push(lead);
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

async function sendText(to, body) {
  if (DRY_RUN === "true") {
    console.log(`[dry run] to ${to}: ${body}`);
    return;
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
  if (!res.ok) {
    console.error("Send failed:", res.status, await res.text());
  }
}

async function handleMessage(from, text) {
  const now = Date.now();
  let session = sessions.get(from);
  const expired = session && now - session.updatedAt > SESSION_TTL_MS;
  const restart = text.trim().toLowerCase() === "restart";

  // New conversation, expired one, finished one, or a manual restart.
  if (!session || expired || restart || session.step >= QUESTIONS.length) {
    session = {
      step: 0,
      answers: [],
      firstMessage: restart ? "" : text, // often contains the listing name or ref
      startedAt: new Date().toISOString(),
      updatedAt: now,
    };
    sessions.set(from, session);
    await sendText(from, `${GREETING}\n\n${QUESTIONS[0]}`);
    return;
  }

  // Record the answer to the current question and move on.
  session.answers.push(text);
  session.step += 1;
  session.updatedAt = now;

  if (session.step < QUESTIONS.length) {
    await sendText(from, QUESTIONS[session.step]);
    return;
  }

  saveLead({
    phone: from,
    listingMessage: session.firstMessage,
    answers: {
      rentOrBuy: session.answers[0],
      budgetAndFinance: session.answers[1],
      viewingAndMoveIn: session.answers[2],
    },
    startedAt: session.startedAt,
    completedAt: new Date().toISOString(),
  });
  console.log(`Lead completed: ${from}`);
  await sendText(from, THANKS);
}

const app = express();

// Keep the raw body so the Meta signature can be checked.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

function validSignature(req) {
  if (!APP_SECRET) return true; // skipped in local testing only
  const header = req.get("x-hub-signature-256") || "";
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(req.rawBody || "").digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Meta calls this once when you register the webhook.
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Meta posts incoming messages here.
app.post("/webhook", (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);

  // Answer Meta straight away, then do the work.
  res.sendStatus(200);

  const messages =
    req.body?.entry?.flatMap((e) =>
      e.changes?.flatMap((c) => c.value?.messages ?? [])
    ) ?? [];

  for (const msg of messages) {
    if (msg.type !== "text") {
      sendText(msg.from, "Please reply with a text message so I can record your answer.").catch(
        console.error
      );
      continue;
    }
    handleMessage(msg.from, msg.text.body).catch(console.error);
  }
});

app.get("/", (_req, res) => res.send("WhatsApp screening bot is running."));

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
