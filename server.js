// server.js - GameHub Backend PRO avec Webhook Paystack
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";
import crypto from "crypto";

const app = express();

// ===============================
// 🔥 WEBHOOK PAYSTACK (RAW BODY) - DOIT ÊTRE AVANT express.json()
// ===============================
app.post(
  "/webhooks/paystack",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      console.log("🔥 PAYSTACK WEBHOOK CALLED");

      const secret = process.env.PAYSTACK_SECRET_KEY;

      const hash = crypto
        .createHmac("sha512", secret)
        .update(req.body)
        .digest("hex");

      const signature = req.headers["x-paystack-signature"];

      if (hash !== signature) {
        console.log("❌ Invalid Paystack signature");
        return res.sendStatus(401);
      }

      const event = JSON.parse(req.body.toString());

      if (event.event === "charge.success") {
        const data = event.data;
        const metadata = data.metadata || {};
        const reference = data.reference;

        console.log("✅ Payment success via webhook:", reference);

        await recordPurchaseInFirebase(
          metadata.userId,
          metadata.gameId,
          metadata.gameName,
          metadata.plan,
          metadata.amount,
          reference,
          data.customer.email
        );
      }

      return res.sendStatus(200);
    } catch (err) {
      console.error("❌ Webhook error:", err);
      return res.sendStatus(500);
    }
  }
);

// ===============================
// JSON + CORS (APRÈS webhook)
// ===============================
app.use(express.json());

app.use(cors({
  origin: ["https://gamehub-56km.onrender.com", "http://localhost:3000"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// ===============================
// 🔥 FIREBASE ADMIN INIT
// ===============================
try {
  const serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")
  };

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  console.log("🔥 Firebase Admin initialisé avec succès !");
} catch (error) {
  console.error("❌ Erreur initialisation Firebase:", error.message);
  process.exit(1);
}

const db = admin.firestore();

// ===============================
// 🔐 PAYSTACK SECRET (ENV)
// ===============================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// ===============================
// ROUTES
// ===============================

// Test route
app.get("/", (req, res) => {
  res.json({ 
    status: "success", 
    message: "✅ Backend GameHub opérationnel avec Webhook + Firebase !"
  });
});

// Initialiser un paiement
app.post("/create-payment", async (req, res) => {
  try {
    const { email, amount, sourcePage, gameId, gameName, plan, userId } = req.body;

    if (!email || !amount || !userId) {
      return res.status(400).json({
        status: false,
        message: "Données manquantes"
      });
    }

    const callbackUrl = `https://gamehub-56km.onrender.com/${sourcePage || 'accueil'}.html?payment_ref=true`;

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
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
      }),
    });

    const data = await response.json();

    res.json({
      status: data.status,
      data: data.data
    });

  } catch (err) {
    console.error("❌ Erreur create-payment:", err);
    res.status(500).json({ status: false });
  }
});

// Vérifier paiement (BACKUP)
app.get("/verify-payment/:reference", async (req, res) => {
  try {
    const { reference } = req.params;

    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });

    const data = await response.json();

    if (data.status && data.data.status === "success") {
      const p = data.data;
      const m = p.metadata;

      await recordPurchaseInFirebase(
        m.userId,
        m.gameId,
        m.gameName,
        m.plan,
        m.amount,
        reference,
        p.customer.email
      );
    }

    res.json(data);
  } catch (err) {
    console.error("❌ verify-payment error:", err);
    res.status(500).json({ status: false });
  }
});

// ===============================
// 🔥 FIREBASE PURCHASE FUNCTION
// ===============================
async function recordPurchaseInFirebase(userId, gameId, gameName, plan, price, reference, userEmail) {
  try {
    const existing = await db.collection('purchases')
      .where('paystackReference', '==', reference)
      .limit(1)
      .get();

    if (!existing.empty) {
      console.log("⚠️ Purchase already exists:", reference);
      return true;
    }

    const purchaseDate = new Date();
    let expirationDate = new Date();

    switch(plan) {
      case 'trial': expirationDate = new Date(purchaseDate.getTime() + 1 * 60 * 60 * 1000); break;
      case 'daily': expirationDate = new Date(purchaseDate.getTime() + 24 * 60 * 60 * 1000); break;
      case 'weekly': expirationDate = new Date(purchaseDate.getTime() + 7 * 24 * 60 * 60 * 1000); break;
      case 'monthly': expirationDate = new Date(purchaseDate.getTime() + 30 * 24 * 60 * 60 * 1000); break;
      default: expirationDate = new Date(purchaseDate.getTime() + 24 * 60 * 60 * 1000);
    }

    const purchaseData = {
      userId,
      userEmail,
      gameId,
      gameName,
      plan,
      price: parseFloat(price),
      purchaseDate: purchaseDate.toISOString(),
      expirationDate: expirationDate.toISOString(),
      paystackReference: reference,
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('purchases').add(purchaseData);
    await db.collection('users').doc(userId).collection('purchases').add(purchaseData);

    console.log("✅ Purchase saved:", reference);
    return true;

  } catch (error) {
    console.error("❌ Firebase purchase error:", error);
    return false;
  }
}

// ===============================
// HEALTH
// ===============================
app.get("/health", (req, res) => {
  res.json({ status: "healthy", time: new Date().toISOString() });
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend GameHub running on port ${PORT}`);
  console.log(`🔗 https://backend-gamehub-eynr.onrender.com`);
});
