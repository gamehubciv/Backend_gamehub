// server_gamehub.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());

// Activer CORS pour votre frontend
app.use(cors({
  origin: ["https://gamehub-56km.onrender.com", "http://localhost:3000"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Clé secrète Paystack
const PAYSTACK_SECRET_KEY = "sk_test_04aeff0b10d204734f7eab1fdb6b0234b23aa407";

// Route test
app.get("/", (req, res) => {
  res.json({ 
    status: "success", 
    message: "✅ Backend GameHub opérationnel !" 
  });
});

// 1. Initialiser un paiement avec callback_url dynamique
app.post("/create-payment", async (req, res) => {
  const { email, amount, sourcePage, gameId, gameName, plan } = req.body;

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
          gameId,
          gameName,
          plan,
          sourcePage
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

// 2. Vérifier un paiement
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
      res.json({
        status: "success",
        message: "Paiement vérifié avec succès",
        data: {
          amount: data.data.amount / 100,
          currency: data.data.currency,
          paid_at: data.data.paid_at,
          reference: data.data.reference,
          metadata: data.data.metadata
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

// 3. Webhook Paystack pour les notifications
app.post("/webhook/paystack", express.json(), async (req, res) => {
  const event = req.body;
  
  // Vérifier la signature du webhook (recommandé pour la production)
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex');
    
  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(400).send('Signature invalide');
  }

  console.log("📩 Webhook Paystack reçu :", event.event);

  if (event.event === "charge.success") {
    const paymentData = event.data;
    console.log("✅ Paiement réussi :", {
      reference: paymentData.reference,
      amount: paymentData.amount / 100,
      email: paymentData.customer.email,
      metadata: paymentData.metadata
    });

    // Ici, vous pourriez mettre à jour votre base de données Firebase
    // pour marquer l'achat comme payé
  }

  res.sendStatus(200);
});

// 4. Route pour vérifier si un paiement a été effectué récemment
app.get("/check-recent-payment/:reference", async (req, res) => {
  const { reference } = req.params;
  
  try {
    // Vérifier le paiement
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      },
    });

    const data = await response.json();
    
    if (data.status && data.data.status === "success") {
      res.json({
        status: "success",
        paid: true,
        data: {
          amount: data.data.amount / 100,
          reference: data.data.reference,
          metadata: data.data.metadata
        }
      });
    } else {
      res.json({
        status: "pending",
        paid: false,
        message: data.message || "Paiement en attente"
      });
    }
  } catch (err) {
    res.json({
      status: "error",
      paid: false,
      error: err.message
    });
  }
});

// Lancer le serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend GameHub lancé sur le port ${PORT}`);
  console.log(`🔗 URL: https://backend-gamehub-eynr.onrender.com`);
});