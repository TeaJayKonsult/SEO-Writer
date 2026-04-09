// api/paystack-webhook.js
const https = require('https');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const adminJson = process.env.FIREBASE_ADMIN_JSON;
if (!adminJson) {
  console.error('FIREBASE_ADMIN_JSON not set');
} else {
  try {
    const serviceAccount = JSON.parse(adminJson);
    initializeApp({ credential: cert(serviceAccount) });
  } catch (err) {
    console.error('Failed to parse FIREBASE_ADMIN_JSON:', err.message);
  }
}
const db = getFirestore();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Verify Paystack signature
  const paystackSecret = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackSecret) {
    console.error('PAYSTACK_SECRET_KEY not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const signature = req.headers['x-paystack-signature'];
  if (!signature) {
    return res.status(401).json({ error: 'No signature header' });
  }

  const hash = crypto.createHmac('sha512', paystackSecret)
    .update(JSON.stringify(req.body))
    .digest('hex');
  if (hash !== signature) {
    console.error('Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  if (event.event !== 'charge.success') {
    return res.status(200).json({ received: true });
  }

  const transactionRef = event.data.reference;
  const amount = event.data.amount; // in kobo
  const metadata = event.data.metadata || {};
  const userId = metadata.userId;
  const requestedPlan = metadata.plan; // 'starter' or 'pro'

  if (!userId || !requestedPlan) {
    console.error('Missing userId or plan in metadata');
    return res.status(400).json({ error: 'Missing metadata' });
  }

  // --- IDEMPOTENCY: Check if this transaction was already processed ---
  const processedRef = db.collection('processedTransactions').doc(transactionRef);
  const processedDoc = await processedRef.get();
  if (processedDoc.exists) {
    console.log(`Duplicate webhook ignored for reference ${transactionRef}`);
    return res.status(200).json({ received: true, alreadyProcessed: true });
  }

  // 2. Verify transaction with Paystack API
  try {
    const verifyRes = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.paystack.co',
        path: `/transaction/verify/${transactionRef}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${paystackSecret}` }
      };
      const request = https.request(options, (response) => {
        let raw = '';
        response.on('data', chunk => raw += chunk);
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Paystack verify error ${response.statusCode}: ${raw}`));
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.status && parsed.data.status === 'success') {
              resolve(parsed.data);
            } else {
              reject(new Error('Transaction not successful'));
            }
          } catch (e) { reject(e); }
        });
      });
      request.on('error', reject);
      request.end();
    });

    // Check amount
    let expectedAmount;
    if (requestedPlan === 'starter') expectedAmount = 1000 * 100;
    else if (requestedPlan === 'pro') expectedAmount = 1500 * 100;
    else expectedAmount = 0;

    if (verifyRes.amount !== expectedAmount) {
      console.error(`Amount mismatch: expected ${expectedAmount}, got ${verifyRes.amount}`);
      return res.status(400).json({ error: 'Amount mismatch' });
    }

    // 3. Update user's plan in Firestore
    const userRef = db.collection('users').doc(userId);
    await userRef.update({
      plan: requestedPlan,
      updatedAt: new Date().toISOString()
    });

    // 4. Store transaction reference for idempotency
    await processedRef.set({
      userId,
      plan: requestedPlan,
      amount: verifyRes.amount,
      processedAt: new Date().toISOString()
    });

    console.log(`Updated user ${userId} to plan ${requestedPlan}`);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};
