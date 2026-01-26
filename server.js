import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, doc, setDoc, serverTimestamp } from "firebase/firestore";

const app = express();
app.use(express.json());

// ✅ Activer CORS pour GameHub
app.use(cors({
  origin: ["https://gamehub-56km.onrender.com"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// 🔑 Clé secrète Paystack (mode test)
const PAYSTACK_SECRET_KEY = "sk_test_04aeff0b10d204734f7eab1fdb6b0234b23aa407";

// Configuration Firebase
const firebaseConfig = {
  apiKey: "AIzaSyDhySV3lXOlCQ8fMIYRlzs0YpMg6MZ_Ixo",
  authDomain: "gamehub-e45ea.firebaseapp.com",
  projectId: "gamehub-e45ea",
  storageBucket: "gamehub-e45ea.firebasestorage.app",
  messagingSenderId: "609288909968",
  appId: "1:609288909968:web:45f3716ce6b2d4970d1415"
};

// Initialiser Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ✅ Route test
app.get("/", (req, res) => {
  res.send("✅ Backend Paystack GameHub opérationnel !");
});

// 1. Initialiser un paiement avec callback_url dynamique
app.post("/create-payment", async (req, res) => {
  const { email, amount, gameId, gameName, plan, userId } = req.body;

  try {
    // Construire l'URL de callback dynamique
    const callbackUrl = `https://gamehub-56km.onrender.com/accueil.html?paid=true&gameId=${gameId}`;

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: amount * 100, // montant en Kobo
        currency: "XOF",
        callback_url: callbackUrl,
        metadata: {
          gameId,
          gameName,
          plan,
          userId
        }
      }),
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("❌ Erreur create-payment:", err);
    res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// 2. Vérifier un paiement et enregistrer dans Firestore si succès
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
      // Récupérer les métadonnées
      const metadata = data.data.metadata;
      const { gameId, gameName, plan, userId } = metadata;
      
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
      
      // Enregistrer l'achat dans Firestore SEULEMENT si le paiement est réussi
      try {
        // Enregistrer dans la collection 'purchases'
        const purchaseData = {
          userId: userId,
          gameId: gameId,
          gameName: gameName,
          plan: plan,
          price: data.data.amount / 100, // Convertir de Kobo à XOF
          purchaseDate: purchaseDate.toISOString(),
          expirationDate: expirationDate.toISOString(),
          status: 'active',
          paystackReference: reference,
          transactionId: data.data.id,
          verified: true
        };
        
        const purchaseRef = await addDoc(collection(db, 'purchases'), purchaseData);
        
        // Ajouter aussi dans la sous-collection de l'utilisateur
        if (userId) {
          const userPurchaseRef = collection(db, 'users', userId, 'purchases');
          await addDoc(userPurchaseRef, {
            ...purchaseData,
            purchaseId: purchaseRef.id
          });
          
          console.log(`✅ Achat enregistré pour l'utilisateur ${userId}, jeu: ${gameName}`);
        }
        
        res.json({
          status: 'success',
          message: 'Paiement vérifié et achat enregistré',
          data: {
            purchaseId: purchaseRef.id,
            gameId,
            gameName,
            expirationDate: expirationDate.toISOString()
          }
        });
        
      } catch (firestoreError) {
        console.error("❌ Erreur Firestore:", firestoreError);
        res.status(500).json({ 
          status: 'error', 
          message: 'Paiement réussi mais erreur lors de l\'enregistrement' 
        });
      }
      
    } else {
      res.json({
        status: data.data?.status || 'failed',
        message: data.message || 'Paiement non confirmé'
      });
    }
  } catch (err) {
    console.error("❌ Erreur verify-payment:", err);
    res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// 3. Webhook Paystack pour les mises à jour en temps réel
app.post("/webhook/paystack", async (req, res) => {
  const event = req.body;
  
  if (event.event === "charge.success") {
    const data = event.data;
    console.log("✅ Webhook: Paiement réussi:", data.reference);
    
    // Ici vous pouvez ajouter une logique supplémentaire
    // comme envoyer un email de confirmation
  }
  
  res.sendStatus(200);
});

// 🚀 Lancer serveur
const PORT = process.env.PORT || 3001; // Port différent de l'app principale
app.listen(PORT, () => {
  console.log(`🚀 Serveur Paystack GameHub lancé sur le port ${PORT}`);
});