// server_gamehub.js - VERSION FINALE SANS ERREURS
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
// ✅ CONFIGURATION FIREBASE POUR RENDER
// ===============================
try {
  const serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY
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
    const testRef = db.collection("test").doc("connection");
    await testRef.set({ 
      test: true, 
      timestamp: new Date().toISOString() 
    });
    
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
  try {
    const { email, amount, sourcePage, gameId, gameName, plan, userId } = req.body;
    
    if (!email || !amount || !userId) {
      return res.status(400).json({
        status: false,
        message: "Données manquantes: email, amount et userId sont requis"
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
      const purchaseRecorded = await recordPurchaseInFirebase(
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
        purchaseRecorded: purchaseRecorded,
        data: {
          amount: paymentData.amount / 100,
          reference: paymentData.reference,
          gameName: metadata.gameName,
          plan: metadata.plan
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
    
    // Vérifier si l'achat existe déjà
    const existingPurchase = await db.collection('purchases')
      .where('paystackReference', '==', reference)
      .limit(1)
      .get();
    
    if (!existingPurchase.empty) {
      console.log(`⚠️ Achat déjà enregistré pour la référence: ${reference}`);
      return true;
    }
    
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
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // 1. Enregistrer dans la collection 'purchases' principale
    await db.collection('purchases').add(purchaseData);

    // 2. Enregistrer dans la sous-collection de l'utilisateur
    const userPurchaseRef = db.collection('users').doc(userId).collection('purchases');
    await userPurchaseRef.add(purchaseData);

    console.log(`✅ Achat enregistré pour ${userEmail}: ${gameName} (${plan})`);
    return true;

  } catch (error) {
    console.error("❌ Erreur Firebase:", error.message);
    return false;
  }
}

// 3. Synchroniser les achats d'un utilisateur
app.post("/sync-purchases", async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        status: false,
        message: "UID utilisateur requis"
      });
    }
    
    // Récupérer tous les achats actifs de l'utilisateur
    const purchasesSnapshot = await db.collection('users').doc(userId)
      .collection('purchases')
      .where('status', '==', 'active')
      .get();
    
    const purchases = [];
    purchasesSnapshot.forEach(doc => {
      purchases.push({
        id: doc.id,
        ...doc.data()
      });
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

// 4. Route de santé pour Render
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "GameHub Backend",
    version: "2.0.0"
  });
});

// Lancer le serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend GameHub lancé sur le port ${PORT}`);
  console.log(`🔗 URL: https://backend-gamehub-eynr.onrender.com`);
  console.log(`🔥 Firebase: Connecté au projet ${process.env.FIREBASE_PROJECT_ID}`);
});