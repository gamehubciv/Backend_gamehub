// server_gamehub.js - VERSION CORRIGÉE POUR RENDER
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(express.json());

// Activer CORS
app.use(cors({
  origin: ["https://gamehub-56km.onrender.com", "http://localhost:3000"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// ===============================
// ✅ CONFIGURATION FIREBASE CORRECTE POUR RENDER
// ===============================
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY
};

// Initialiser Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
console.log("🔥 Firebase Admin initialisé avec succès !");
// ===============================

// Clé secrète Paystack
const PAYSTACK_SECRET_KEY = "sk_test_04aeff0b10d204734f7eab1fdb6b0234b23aa407";

// Route test
app.get("/", (req, res) => {
  res.json({ 
    status: "success", 
    message: "✅ Backend GameHub opérationnel avec Firebase Admin !",
    firebase: "Connecté"
  });
});

// Route pour vérifier la connexion Firebase
app.get("/test-firebase", async (req, res) => {
  try {
    // Tester une simple requête Firestore
    const testDoc = await db.collection("test").doc("connection").get();
    
    res.json({
      status: "success",
      firebase: "Connecté avec succès",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Erreur Firebase",
      error: error.message
    });
  }
});

// 1. Initialiser un paiement
app.post("/create-payment", async (req, res) => {
  const { email, amount, sourcePage, gameId, gameName, plan, userId } = req.body;

  try {
    const callbackUrl = `https://gamehub-56km.onrender.com/${sourcePage}.html?payment_ref=true`;

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
          amount: amount
        }
      }),
    });

    const data = await response.json();
    
    if (!data.status) {
      return res.status(400).json({
        status: false,
        message: data.message || "Erreur lors de l'initialisation du paiement"
      });
    }

    res.json({
      status: true,
      message: "Paiement initialisé avec succès",
      data: {
        authorization_url: data.data.authorization_url,
        access_code: data.data.access_code,
        reference: data.data.reference
      }
    });
  } catch (err) {
    console.error("❌ Erreur create-payment:", err);
    res.status(500).json({ 
      status: false, 
      error: "Erreur interne du serveur",
      details: err.message 
    });
  }
});

// 2. Vérifier un paiement et enregistrer dans Firebase
app.get("/verify-payment/:reference", async (req, res) => {
  const { reference } = req.params;

  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      },
    });

    const data = await response.json();
    
    if (data.status && data.data.status === "success") {
      const paymentData = data.data;
      const metadata = paymentData.metadata;
      
      // Enregistrer l'achat dans Firebase
      await recordPurchaseInFirebase(
        metadata.userId,
        metadata.gameId,
        metadata.gameName,
        metadata.plan,
        metadata.amount,
        reference,
        paymentData.customer.email
      );

      res.json({
        status: "success",
        message: "Paiement vérifié et achat enregistré",
        data: {
          amount: paymentData.amount / 100,
          reference: paymentData.reference
        }
      });
    } else {
      res.json({
        status: data.data?.status || "failed",
        message: data.message || "Paiement non vérifié"
      });
    }
  } catch (err) {
    console.error("❌ Erreur verify-payment:", err);
    res.status(500).json({ 
      status: "error", 
      error: "Erreur interne du serveur" 
    });
  }
});

// Fonction pour enregistrer un achat dans Firebase
async function recordPurchaseInFirebase(userId, gameId, gameName, plan, price, reference, userEmail) {
  try {
    console.log(`📝 Enregistrement achat pour ${userEmail} - ${gameName}`);
    
    // Calculer la date d'expiration
    const purchaseDate = new Date();
    let expirationDate = new Date();
    
    switch(plan) {
      case 'trial':
        expirationDate = new Date(purchaseDate.getTime() + (1 * 60 * 60 * 1000));
        break;
      case 'daily':
        expirationDate = new Date(purchaseDate.getTime() + (24 * 60 * 60 * 1000));
        break;
      case 'weekly':
        expirationDate = new Date(purchaseDate.getTime() + (7 * 24 * 60 * 60 * 1000));
        break;
      case 'monthly':
        expirationDate = new Date(purchaseDate.getTime() + (30 * 24 * 60 * 60 * 1000));
        break;
      default:
        expirationDate = new Date(purchaseDate.getTime() + (24 * 60 * 60 * 1000));
    }

    // Données de l'achat
    const purchaseData = {
      userId: userId,
      userEmail: userEmail,
      gameId: gameId,
      gameName: gameName,
      plan: plan,
      price: parseFloat(price),
      purchaseDate: purchaseDate.toISOString(),
      expirationDate: expirationDate.toISOString(),
      paystackReference: reference,
      status: 'active'
    };

    // 1. Enregistrer dans la collection 'purchases' principale
    await db.collection('purchases').add(purchaseData);

    // 2. Enregistrer dans la sous-collection de l'utilisateur
    await db.collection('users').doc(userId).collection('purchases').add(purchaseData);

    console.log(`✅ Achat enregistré pour ${userEmail}: ${gameName}`);
    return true;

  } catch (error) {
    console.error("❌ Erreur Firebase:", error);
    return false;
  }
}

// Lancer le serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend GameHub lancé sur le port ${PORT}`);
  console.log(`🔗 URL: https://backend-gamehub-eynr.onrender.com`);
});      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
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
