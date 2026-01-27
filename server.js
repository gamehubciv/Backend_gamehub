// server.js - BACKEND GAMEHUB FINAL (RENDER + FIREBASE ADMIN + PAYSTACK)

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
// FIREBASE ADMIN (CORRECTION CLÉ PEM)
// ===============================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("❌ FIREBASE_SERVICE_ACCOUNT manquant dans les variables d'environnement");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// 🔥 CORRECTION CRITIQUE POUR RENDER
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
console.log("🔥 Firebase Admin initialisé");

// ===============================
// PAYSTACK (clé laissée telle quelle)
// ===============================
const PAYSTACK_SECRET_KEY = "sk_test_04aeff0b10d204734f7eab1fdb6b0234b23aa407";

// ===============================
// ROUTE TEST
// ===============================
app.get("/", (req, res) => {
  res.json({
    status: "success",
    message: "✅ Backend GameHub opérationnel (Render + Firebase Admin + Paystack)"
  });
});

// ===============================
// 1. INITIALISER UN PAIEMENT
// ===============================
app.post("/create-payment", async (req, res) => {
  const { email, amount, sourcePage, gameId, gameName, plan, userId } = req.body;

  try {
    const callbackUrl = `https://gamehub-56km.onrender.com/${sourcePage}.html?payment_ref=true`;

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
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
    });

    const data = await response.json();

    if (!data.status) {
      return res.status(400).json({
        status: false,
        message: data.message || "Erreur Paystack"
      });
    }

    res.json({
      status: true,
      authorization_url: data.data.authorization_url,
      access_code: data.data.access_code,
      reference: data.data.reference
    });

  } catch (error) {
    console.error("❌ create-payment:", error);
    res.status(500).json({ status: false, error: "Erreur serveur" });
  }
});

// ===============================
// 2. VERIFIER UN PAIEMENT
// ===============================
app.get("/verify-payment/:reference", async (req, res) => {
  const { reference } = req.params;

  try {
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );

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
        p.reference,
        p.customer.email
      );

      res.json({ status: "success", reference: p.reference });
    } else {
      res.json({ status: "failed", message: data.message });
    }

  } catch (error) {
    console.error("❌ verify-payment:", error);
    res.status(500).json({ status: "error" });
  }
});

// ===============================
// ENREGISTRER UN ACHAT
// ===============================
async function recordPurchaseInFirebase(
  userId,
  gameId,
  gameName,
  plan,
  price,
  reference,
  userEmail
) {
  const existing = await db.collection("purchases")
    .where("paystackReference", "==", reference)
    .limit(1)
    .get();

  if (!existing.empty) return true;

  const now = new Date();
  let expiration = new Date(now);

  switch (plan) {
    case "trial": expiration.setHours(expiration.getHours() + 1); break;
    case "daily": expiration.setDate(expiration.getDate() + 1); break;
    case "weekly": expiration.setDate(expiration.getDate() + 7); break;
    case "monthly": expiration.setDate(expiration.getDate() + 30); break;
    default: expiration.setDate(expiration.getDate() + 1);
  }

  let referredBy = null;
  const userSnap = await db.collection("users").doc(userId).get();
  if (userSnap.exists) referredBy = userSnap.data().referredBy || null;

  const data = {
    userId,
    userEmail,
    gameId,
    gameName,
    plan,
    price: Number(price),
    purchaseDate: now.toISOString(),
    expirationDate: expiration.toISOString(),
    referredBy,
    paystackReference: reference,
    commission: price * 0.3,
    status: "active",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await db.collection("purchases").add(data);
  await db.collection("users").doc(userId).collection("purchases").add(data);
  await updateUserStats(userId, price);

  if (referredBy) {
    await handleReferralCommission(referredBy, userId, userEmail, gameName, price);
  }

  return true;
}

// ===============================
// STATS UTILISATEUR
// ===============================
async function updateUserStats(userId, amount) {
  await db.collection("users").doc(userId).update({
    totalPurchases: admin.firestore.FieldValue.increment(1),
    totalSpent: admin.firestore.FieldValue.increment(amount),
    lastPurchaseDate: admin.firestore.FieldValue.serverTimestamp()
  });
}

// ===============================
// COMMISSION PARRAINAGE
// ===============================
async function handleReferralCommission(referralCode, uid, email, game, amount) {
  const q = await db.collection("users")
    .where("referralCode", "==", referralCode)
    .limit(1)
    .get();

  if (q.empty) return;

  const ref = q.docs[0];
  const commission = amount * 0.3;

  await db.collection("users").doc(ref.id).update({
    totalEarnings: admin.firestore.FieldValue.increment(commission),
    availableEarnings: admin.firestore.FieldValue.increment(commission),
    totalReferrals: admin.firestore.FieldValue.increment(1)
  });

  await db.collection("notifications").add({
    userId: ref.id,
    title: "Nouvelle commission 🎉",
    message: `Votre filleul ${email} a acheté ${game}. Gain : ${commission} Fr`,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

// ===============================
// WEBHOOK PAYSTACK
// ===============================
app.post("/webhook/paystack", async (req, res) => {
  const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    return res.status(400).send("Signature invalide");
  }

  if (req.body.event === "charge.success") {
    const d = req.body.data;
    const m = d.metadata;

    await recordPurchaseInFirebase(
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
// LANCEMENT SERVEUR
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 GameHub backend lancé sur le port ${PORT}`);
});      });
    });
    
    res.json({
      status: true,
      purchases: purchases,
      count: purchases.length
    });
    
  } catch (error) {
    console.error("❌ Erreur sync-purchases:", error);
    res.status(500).json({
      status: false,
      error: "Erreur lors de la synchronisation des achats"
    });
  }
});

// 4. Webhook Paystack pour notifications en temps réel
app.post("/webhook/paystack", express.json(), async (req, res) => {
  const event = req.body;
  
  // Vérifier la signature du webhook (important pour la production)
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex');
    
  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(400).send('Signature invalide');
  }

  console.log("📩 Webhook Paystack reçu :", event.event);

  if (event.event === "charge.success") {
    const paymentData = event.data;
    const metadata = paymentData.metadata;
    
    console.log("✅ Paiement réçu via webhook:", {
      reference: paymentData.reference,
      amount: paymentData.amount / 100,
      email: paymentData.customer.email,
      metadata: metadata
    });

    // Enregistrer automatiquement dans Firebase via webhook
    if (metadata.userId && metadata.gameId) {
      const purchaseRecorded = await recordPurchaseInFirebase(
        metadata.userId,
        metadata.gameId,
        metadata.gameName,
        metadata.plan,
        metadata.amount,
        paymentData.reference,
        paymentData.customer.email
      );
      
      console.log("📝 Achat enregistré via webhook:", purchaseRecorded);
    }
  }

  res.sendStatus(200);
});

// 5. Route pour vérifier les licences expirées
app.post("/check-expired-licenses", async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        status: false,
        message: "UID utilisateur requis"
      });
    }
    
    const currentDate = new Date().toISOString();
    
    // Récupérer les licences expirées
    const expiredQuery = await db.collection('users').doc(userId)
      .collection('purchases')
      .where('status', '==', 'active')
      .where('expirationDate', '<', currentDate)
      .get();
    
    const updatePromises = [];
    expiredQuery.forEach(doc => {
      updatePromises.push(
        doc.ref.update({
          status: 'expired',
          expiredAt: admin.firestore.FieldValue.serverTimestamp()
        })
      );
    });
    
    await Promise.all(updatePromises);
    
    res.json({
      status: true,
      expiredCount: updatePromises.length,
      message: `Mise à jour de ${updatePromises.length} licence(s) expirée(s)`
    });
    
  } catch (error) {
    console.error("❌ Erreur check-expired-licenses:", error);
    res.status(500).json({
      status: false,
      error: "Erreur lors de la vérification des licences"
    });
  }
});

// Lancer le serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend GameHub lancé sur le port ${PORT}`);
  console.log(`🔥 Firebase Admin initialisé avec succès`);
  console.log(`🔗 URL: https://backend-gamehub-eynr.onrender.com`);
});
