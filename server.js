// server_gamehub.js - VERSION AVEC FIREBASE ADMIN
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";
import crypto from "crypto"; // Pour les webhooks Paystack

const app = express();
app.use(express.json());

// Activer CORS pour votre frontend
app.use(cors({
  origin: ["https://gamehub-56km.onrender.com", "http://localhost:3000"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Initialiser Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Clé secrète Paystack
const PAYSTACK_SECRET_KEY = "sk_test_04aeff0b10d204734f7eab1fdb6b0234b23aa407";

// Route test
app.get("/", (req, res) => {
  res.json({ 
    status: "success", 
    message: "✅ Backend GameHub opérationnel avec Firebase Admin !" 
  });
});

// 1. Initialiser un paiement avec callback_url dynamique
app.post("/create-payment", async (req, res) => {
  const { email, amount, sourcePage, gameId, gameName, plan, userId } = req.body;

  try {
    // Construire l'URL de callback dynamique
    const callbackUrl = `https://gamehub-56km.onrender.com/${sourcePage}.html?payment_ref=true`;

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: amount * 100, // montant en centimes (pour XOF)
        currency: "XOF",
        callback_url: callbackUrl,
        metadata: {
          userId, // IMPORTANT: Inclure l'UID Firebase
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
          currency: paymentData.currency,
          paid_at: paymentData.paid_at,
          reference: paymentData.reference,
          metadata: metadata
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
    // Vérifier si l'achat existe déjà
    const purchaseQuery = await db.collection('purchases')
      .where('paystackReference', '==', reference)
      .limit(1)
      .get();
    
    if (!purchaseQuery.empty) {
      console.log(`Achat déjà enregistré pour la référence: ${reference}`);
      return true;
    }

    // Calculer la date d'expiration
    const purchaseDate = new Date();
    let expirationDate = new Date();
    
    switch(plan) {
      case 'trial':
        expirationDate = new Date(purchaseDate.getTime() + (1 * 60 * 60 * 1000)); // 1 heure
        break;
      case 'daily':
        expirationDate = new Date(purchaseDate.getTime() + (24 * 60 * 60 * 1000)); // 24 heures
        break;
      case 'weekly':
        expirationDate = new Date(purchaseDate.getTime() + (7 * 24 * 60 * 60 * 1000)); // 7 jours
        break;
      case 'monthly':
        expirationDate = new Date(purchaseDate.getTime() + (30 * 24 * 60 * 60 * 1000)); // 30 jours
        break;
      default:
        expirationDate = new Date(purchaseDate.getTime() + (24 * 60 * 60 * 1000)); // 24h par défaut
    }

    // Récupérer les données utilisateur pour le parrainage
    let referredBy = null;
    try {
      const userDoc = await db.collection('users').doc(userId).get();
      if (userDoc.exists) {
        referredBy = userDoc.data().referredBy;
      }
    } catch (error) {
      console.error("Erreur récupération données utilisateur:", error);
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
      referredBy: referredBy,
      paystackReference: reference,
      commission: parseFloat(price) * 0.3, // 30% de commission
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // 1. Enregistrer dans la collection 'purchases' principale
    await db.collection('purchases').add(purchaseData);

    // 2. Enregistrer dans la sous-collection de l'utilisateur
    const userPurchaseData = {
      ...purchaseData,
      purchaseId: reference,
      type: ['1xbet', 'betwinner', 'betclic', 'betmomo'].includes(gameId) ? 'bookmaker' : 'game'
    };
    
    await db.collection('users').doc(userId).collection('purchases').add(userPurchaseData);

    // 3. Mettre à jour les statistiques de l'utilisateur
    await updateUserStats(userId, parseFloat(price));
    
    // 4. Gérer la commission de parrainage
    if (referredBy) {
      await handleReferralCommission(referredBy, userId, userEmail, gameName, parseFloat(price));
    }

    console.log(`✅ Achat enregistré pour ${userEmail}: ${gameName} (${plan})`);
    return true;

  } catch (error) {
    console.error("❌ Erreur lors de l'enregistrement dans Firebase:", error);
    return false;
  }
}

// Fonction pour mettre à jour les statistiques utilisateur
async function updateUserStats(userId, amount) {
  try {
    const userRef = db.collection('users').doc(userId);
    
    // Mettre à jour les statistiques
    await userRef.update({
      totalPurchases: admin.firestore.FieldValue.increment(1),
      totalSpent: admin.firestore.FieldValue.increment(amount),
      lastPurchaseDate: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`📊 Stats mises à jour pour l'utilisateur ${userId}`);
  } catch (error) {
    console.error("Erreur mise à jour stats:", error);
  }
}

// Fonction pour gérer la commission de parrainage
async function handleReferralCommission(referralCode, referredUserId, referredUserEmail, gameName, amount) {
  try {
    // Trouver l'utilisateur qui a parrainé
    const referrerQuery = await db.collection('users')
      .where('referralCode', '==', referralCode)
      .limit(1)
      .get();
    
    if (!referrerQuery.empty) {
      const referrerDoc = referrerQuery.docs[0];
      const referrerId = referrerDoc.id;
      const referrerData = referrerDoc.data();
      
      const commission = amount * 0.3; // 30% de commission
      
      // Mettre à jour les gains du parrain
      await db.collection('users').doc(referrerId).update({
        totalEarnings: admin.firestore.FieldValue.increment(commission),
        availableEarnings: admin.firestore.FieldValue.increment(commission),
        totalReferrals: admin.firestore.FieldValue.increment(1)
      });
      
      // Ajouter une notification pour le parrain
      await db.collection('notifications').add({
        userId: referrerId,
        title: 'Nouvelle commission !',
        message: `Votre filleul ${referredUserEmail} a acheté ${gameName}. Vous avez gagné ${commission.toFixed(2)}Fr de commission.`,
        type: 'success',
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Ajouter à l'historique des commissions
      await db.collection('users').doc(referrerId).collection('commissions').add({
        referredUserId: referredUserId,
        referredUserEmail: referredUserEmail,
        gameName: gameName,
        amount: amount,
        commission: commission,
        date: admin.firestore.FieldValue.serverTimestamp(),
        status: 'paid'
      });
      
      console.log(`💰 Commission de ${commission}Fr attribuée à ${referrerData.email}`);
    }
  } catch (error) {
    console.error("Erreur gestion commission:", error);
  }
}

// 3. Route pour synchroniser les achats (appelée par le frontend)
app.post("/sync-purchases", async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({
        status: false,
        message: "UID utilisateur requis"
      });
    }
    
    // Récupérer tous les achats de l'utilisateur
    const purchasesSnapshot = await db.collection('users').doc(userId)
      .collection('purchases')
      .where('status', '==', 'active')
      .orderBy('purchaseDate', 'desc')
      .get();
    
    const purchases = [];
    purchasesSnapshot.forEach(doc => {
      const data = doc.data();
      // Convertir les timestamps Firebase en strings ISO
      purchases.push({
        id: doc.id,
        ...data,
        purchaseDate: data.purchaseDate?.toDate ? data.purchaseDate.toDate().toISOString() : data.purchaseDate,
        expirationDate: data.expirationDate?.toDate ? data.expirationDate.toDate().toISOString() : data.expirationDate,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt
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