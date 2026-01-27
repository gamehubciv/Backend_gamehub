// server.js — BACKEND GAMEHUB FINAL (RENDER + FIREBASE FIX)

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";
import crypto from "crypto";

const app = express();
app.use(express.json());

// ===============================
// CORS
// ===============================
app.use(cors({
  origin: [
    "https://gamehub-56km.onrender.com",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// ===============================
// FIREBASE ADMIN (RENDER OFFICIAL)
// ===============================
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
  })
});

const db = admin.firestore();
console.log("🔥 Firebase Admin connecté");

// ===============================
// PAYSTACK
// ===============================
const PAYSTACK_SECRET_KEY = "sk_test_04aeff0b10d204734f7eab1fdb6b0234b23aa407";

// ===============================
// ROUTE TEST
// ===============================
app.get("/", (req, res) => {
  res.json({
    status: "success",
    message: "✅ Backend GameHub opérationnel"
  });
});

// ===============================
// CREATE PAYMENT
// ===============================
app.post("/create-payment", async (req, res) => {
  try {
    const { email, amount, sourcePage, gameId, gameName, plan, userId } = req.body;

    const callbackUrl = `https://gamehub-56km.onrender.com/${sourcePage}.html?payment_ref=true`;

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          amount: amount * 100,
          currency: "XOF",
          callback_url: callbackUrl,
          metadata: {
            userId,
            gameId,
            gameName,
            plan,
            sourcePage,
            amount
          }
        })
      }
    );

    const data = await response.json();

    if (!data.status) {
      return res.status(400).json({ status: false, message: data.message });
    }

    res.json({
      status: true,
      authorization_url: data.data.authorization_url,
      reference: data.data.reference
    });

  } catch (err) {
    console.error("create-payment:", err);
    res.status(500).json({ status: false });
  }
});

// ===============================
// VERIFY PAYMENT
// ===============================
app.get("/verify-payment/:reference", async (req, res) => {
  try {
    const { reference } = req.params;

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );

    const data = await response.json();

    if (data.status && data.data.status === "success") {
      const p = data.data;
      const m = p.metadata;

      await recordPurchase(
        m.userId,
        m.gameId,
        m.gameName,
        m.plan,
        m.amount,
        p.reference,
        p.customer.email
      );

      res.json({ status: "success" });
    } else {
      res.json({ status: "failed" });
    }

  } catch (err) {
    console.error("verify-payment:", err);
    res.status(500).json({ status: "error" });
  }
});

// ===============================
// RECORD PURCHASE
// ===============================
async function recordPurchase(userId, gameId, gameName, plan, price, ref, email) {
  const exists = await db.collection("purchases")
    .where("paystackReference", "==", ref)
    .limit(1)
    .get();

  if (!exists.empty) return;

  const now = new Date();
  const exp = new Date(now);

  if (plan === "trial") exp.setHours(exp.getHours() + 1);
  else if (plan === "daily") exp.setDate(exp.getDate() + 1);
  else if (plan === "weekly") exp.setDate(exp.getDate() + 7);
  else exp.setDate(exp.getDate() + 30);

  const data = {
    userId,
    userEmail: email,
    gameId,
    gameName,
    plan,
    price,
    purchaseDate: now.toISOString(),
    expirationDate: exp.toISOString(),
    paystackReference: ref,
    status: "active",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await db.collection("purchases").add(data);
  await db.collection("users").doc(userId).collection("purchases").add(data);
}

// ===============================
// PAYSTACK WEBHOOK
// ===============================
app.post("/webhook/paystack", (req, res) => {
  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    return res.sendStatus(400);
  }

  if (req.body.event === "charge.success") {
    const d = req.body.data;
    const m = d.metadata;

    recordPurchase(
      m.userId,
      m.gameId,
      m.gameName,
      m.plan,
      m.amount,
      d.reference,
      d.customer.email
    );
  }

  res.sendStatus(200);
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
