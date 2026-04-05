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
    initializeApp({
      credential: cert(serviceAccount)
    });
  } catch (err) {
    console.error('Failed to parse FIREBASE_ADMIN_JSON:', err.message);
  }
}
const db = getFirestore();

module.exports = async function handler(req, res) {
  // Only POST allowed
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get Firebase ID token from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const idToken = authHeader.split('Bearer ')[1];

  // Verify token with Firebase REST API
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
          } catch (e) {
            reject(e);
          }
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

  // --- Firestore: Get or create user document ---
  let userData;
  try {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (!doc.exists) {
      const now = new Date().toISOString();
      await userRef.set({
        plan: 'free',
        generationsUsedThisMonth: 0,
        monthlyResetDate: now,
        createdAt: now,
        email: email
      });
      userData = {
        plan: 'free',
        generationsUsedThisMonth: 0,
        monthlyResetDate: now
      };
    } else {
      userData = doc.data();
    }

    // Check monthly reset
    const lastReset = new Date(userData.monthlyResetDate);
    const now = new Date();
    if (now.getMonth() !== lastReset.getMonth() || now.getFullYear() !== lastReset.getFullYear()) {
      await userRef.update({
        generationsUsedThisMonth: 0,
        monthlyResetDate: now.toISOString()
      });
      userData.generationsUsedThisMonth = 0;
      userData.monthlyResetDate = now.toISOString();
    }

    // Determine limit based on plan
    let limit;
    let plan = userData.plan || 'free';
    if (plan === 'pro') limit = 25;
    else if (plan === 'starter') limit = 15;
    else limit = 8;

    if (userData.generationsUsedThisMonth >= limit) {
      return res.status(429).json({ error: `Monthly generation limit reached (${limit} per month). Upgrade to Starter (15) or Pro (25) for more.` });
    }
  } catch (err) {
    console.error('Firestore error:', err.message);
    return res.status(500).json({ error: 'Failed to verify usage limits' });
  }

  // --- Call Groq API for content generation ---
  let wordCount;
  if (length === 'short') wordCount = 500;
  else if (length === 'medium') wordCount = 1000;
  else wordCount = 1800;

  const systemPrompt = `You are an expert SEO content writer. Your task is to generate a high-quality, SEO-optimized article based on the user's input.

Topic: ${topic}
Target keywords: ${keywords}
Tone: ${tone}
Target length: approximately ${wordCount} words.

Return a JSON object with the following structure:
{
  "article": "Full HTML article content (use <p>, <h2>, <h3>, <ul>, etc.)",
  "metaTitle": "SEO title under 60 characters",
  "metaDescription": "Meta description under 160 characters",
  "suggestedTags": ["tag1", "tag2", "tag3"],
  "seoScore": 85
}

The SEO score should be a number from 0 to 100 based on keyword usage, readability, and structure. Ensure the article is unique, well-researched, and includes the target keywords naturally. Do not include any explanations outside the JSON.`;

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
          } catch (e) {
            reject(new Error('Invalid JSON from Groq'));
          }
        });
      });
      request.on('error', reject);
      request.write(payload);
      request.end();
    });
    const content = groqResponse.choices[0].message.content;
    generatedContent = JSON.parse(content);
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

  // --- Save generation to Firestore ---
  try {
    const userRef = db.collection('users').doc(userId);
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
    console.error('Failed to save generation to Firestore:', err.message);
  }

  res.status(200).json(result);
};
