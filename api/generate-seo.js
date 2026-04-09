// api/generate-seo.js
const https = require('https');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Initialize Firebase Admin SDK using the JSON from environment variable
const adminJson = process.env.FIREBASE_ADMIN_JSON;
if (!adminJson) {
  console.error('FIREBASE_ADMIN_JSON environment variable not set');
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

  // Auth header and token verification (same as before)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const idToken = authHeader.split('Bearer ')[1];

  const firebaseApiKey = process.env.FIREBASE_API_KEY;
  if (!firebaseApiKey) {
    return res.status(500).json({ error: 'FIREBASE_API_KEY not configured' });
  }

  let userId, email;
  try {
    const verifyData = JSON.stringify({ idToken });
    const verifyRes = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'identitytoolkit.googleapis.com',
        path: `/v1/accounts:lookup?key=${firebaseApiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(verifyData)
        }
      };
      const request = https.request(options, (response) => {
        let raw = '';
        response.on('data', chunk => raw += chunk);
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Token verification failed: ${response.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.users && parsed.users.length > 0) {
              resolve(parsed.users[0]);
            } else {
              reject(new Error('No user found'));
            }
          } catch (e) { reject(e); }
        });
      });
      request.on('error', reject);
      request.write(verifyData);
      request.end();
    });
    userId = verifyRes.localId;
    email = verifyRes.email;
  } catch (err) {
    console.error('Token verification error:', err.message);
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Parse request body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const { topic, keywords, tone = 'professional', length = 'medium' } = body;
  if (!topic || !keywords) {
    return res.status(400).json({ error: 'Topic and keywords are required' });
  }

  // --- RATE LIMITING (5 requests per minute per user) ---
  const rateLimitRef = db.collection('users').doc(userId).collection('rateLimit').doc('requests');
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;

  try {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(rateLimitRef);
      let timestamps = doc.exists ? doc.data().timestamps || [] : [];
      // Keep only timestamps within the last minute
      timestamps = timestamps.filter(ts => ts > oneMinuteAgo);
      if (timestamps.length >= 5) {
        throw new Error('RATE_LIMIT_EXCEEDED');
      }
      timestamps.push(now);
      transaction.set(rateLimitRef, { timestamps }, { merge: true });
    });
  } catch (err) {
    if (err.message === 'RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    }
    console.error('Rate limit check error:', err);
    // Fall through – allow request if rate limit check fails (avoid blocking users)
  }

  // --- Monthly usage limits (existing) ---
  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();
  let userData = userDoc.exists ? userDoc.data() : null;
  if (!userData) {
    const nowDate = new Date().toISOString();
    await userRef.set({
      plan: 'free',
      generationsUsedThisMonth: 0,
      monthlyResetDate: nowDate,
      createdAt: nowDate,
      email: email
    });
    userData = { plan: 'free', generationsUsedThisMonth: 0, monthlyResetDate: nowDate };
  }

  // Monthly reset logic
  const lastReset = new Date(userData.monthlyResetDate);
  const nowDate = new Date();
  if (nowDate.getMonth() !== lastReset.getMonth() || nowDate.getFullYear() !== lastReset.getFullYear()) {
    await userRef.update({
      generationsUsedThisMonth: 0,
      monthlyResetDate: nowDate.toISOString()
    });
    userData.generationsUsedThisMonth = 0;
    userData.monthlyResetDate = nowDate.toISOString();
  }

  const plan = userData.plan || 'free';
  let limit = 8;
  if (plan === 'starter') limit = 15;
  else if (plan === 'pro') limit = 25;

  if (userData.generationsUsedThisMonth >= limit) {
    return res.status(429).json({ error: `Monthly limit reached (${limit}). Upgrade to continue.` });
  }

  // --- Groq content generation (unchanged) ---
  let wordCount;
  if (length === 'short') wordCount = 500;
  else if (length === 'medium') wordCount = 1000;
  else wordCount = 1800;

  const systemPrompt = `You are an expert SEO content writer...`; // (keep your existing prompt)
  const userPrompt = `Write an SEO article about "${topic}" focusing on keywords: ${keywords}. Tone: ${tone}. Length: about ${wordCount} words.`;

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  }

  const payload = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 2500,
    response_format: { type: 'json_object' }
  });

  let generatedContent;
  try {
    const groqResponse = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqApiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      const request = https.request(options, (response) => {
        let raw = '';
        response.on('data', chunk => raw += chunk);
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Groq API error ${response.statusCode}: ${raw}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) { reject(new Error('Invalid JSON from Groq')); }
        });
      });
      request.on('error', reject);
      request.write(payload);
      request.end();
    });
    generatedContent = JSON.parse(groqResponse.choices[0].message.content);
  } catch (err) {
    console.error('Groq generation error:', err.message);
    return res.status(500).json({ error: 'AI generation failed' });
  }

  const result = {
    article: generatedContent.article || '<p>Failed to generate article.</p>',
    metaTitle: generatedContent.metaTitle || `${topic} - SEO Writer`,
    metaDescription: generatedContent.metaDescription || `Learn about ${topic} with our SEO-optimized content.`,
    suggestedTags: Array.isArray(generatedContent.suggestedTags) ? generatedContent.suggestedTags : [],
    seoScore: typeof generatedContent.seoScore === 'number' ? generatedContent.seoScore : 70
  };

  // Save generation to Firestore and increment counter
  try {
    const generationRef = userRef.collection('generations').doc();
    await generationRef.set({
      topic,
      keywords,
      tone,
      length,
      generatedAt: new Date().toISOString(),
      result: result
    });
    await userRef.update({
      generationsUsedThisMonth: userData.generationsUsedThisMonth + 1
    });
  } catch (err) {
    console.error('Failed to save generation:', err.message);
  }

  res.status(200).json(result);
};
