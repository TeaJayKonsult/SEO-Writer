// api/paystack-webhook.js
const crypto = require('crypto');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    console.error('PAYSTACK_SECRET_KEY not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Verify Paystack signature
  const signature = req.headers['x-paystack-signature'];
  if (!signature) {
    return res.status(401).json({ error: 'No signature header' });
  }
  const hash = crypto.createHmac('sha512', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');
  if (hash !== signature) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  if (event.event !== 'charge.success') {
    return res.status(200).json({ received: true });
  }

  const transactionRef = event.data.reference;
  const metadata = event.data.metadata || {};
  const userId = metadata.userId;
  const requestedPlan = metadata.plan; // 'pro'

  if (!userId || requestedPlan !== 'pro') {
    console.error('Invalid metadata:', metadata);
    return res.status(400).json({ error: 'Missing or invalid metadata' });
  }

  // Optionally verify transaction with Paystack API (recommended)
  // For simplicity, we trust the webhook signature and update the user's plan.
  try {
    const userRef = db.collection('users').doc(userId);
    await userRef.update({
      plan: 'pro',
      updatedAt: new Date().toISOString()
    });
    console.log(`User ${userId} upgraded to Pro`);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Failed to update user plan' });
  }
};
