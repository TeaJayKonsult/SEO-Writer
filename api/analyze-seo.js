// api/analyze-seo.js (with word count validation)
const https = require('https');
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
  const allowedOrigin = 'https://the-seo-writer.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Token verification (unchanged)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  const firebaseApiKey = process.env.FIREBASE_API_KEY;
  if (!firebaseApiKey) {
    return res.status(500).json({ error: 'FIREBASE_API_KEY not configured' });
  }

  let userId;
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
  } catch (err) {
    console.error('Token verification error:', err.message);
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Rate limiting (10 per minute)
  const rateLimitRef = db.collection('rateLimitsAnalyze').doc(userId);
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;
  try {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(rateLimitRef);
      let timestamps = doc.exists ? doc.data().timestamps || [] : [];
      timestamps = timestamps.filter(ts => ts > oneMinuteAgo);
      if (timestamps.length >= 10) {
        throw new Error('RATE_LIMIT_EXCEEDED');
      }
      timestamps.push(now);
      transaction.set(rateLimitRef, { timestamps }, { merge: true });
    });
  } catch (err) {
    if (err.message === 'RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({ error: 'Too many analysis requests. Please wait a minute.' });
    }
    console.error('Rate limit error:', err);
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const { content, targetKeywords = '' } = body;

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'Content is required' });
  }

  // Word count validation
  const wordCount = content.trim().split(/\s+/).length;
  if (wordCount < 1500) {
    return res.status(400).json({ error: `Content too short: ${wordCount} words. Minimum required is 1500 words.` });
  }
  if (wordCount > 3000) {
    return res.status(400).json({ error: `Content too long: ${wordCount} words. Maximum allowed is 3000 words.` });
  }

  if (targetKeywords.length > 500) {
    return res.status(413).json({ error: 'Keywords too long (max 500 characters)' });
  }

  // Call Groq
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  }

  const systemPrompt = `You are an expert SEO analyst. Analyze the provided article content and return a JSON object with the following fields:
{
  "score": number (0-100),
  "wordCount": number,
  "keywordDensity": number,
  "readability": number (Flesch Reading Ease, 0-100),
  "headings": { "h1": number, "h2": number, "h3": number },
  "suggestions": ["suggestion1", "suggestion2", ...],
  "metaTitle": "suggested meta title under 60 chars",
  "metaDescription": "suggested meta description under 160 chars",
  "relatedKeywords": ["keyword1", "keyword2", ...],
  "subKeywords": ["subkeyword1", ...]
}
Be objective and helpful. If target keywords are provided, evaluate how well they are used. Provide practical advice.`;

  const userPrompt = `Content to analyze:\n\n${content}\n\nTarget keywords: ${targetKeywords || 'none provided'}`;

  const payload = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.5,
    max_tokens: 1000,
    response_format: { type: 'json_object' }
  });

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
    const analysis = JSON.parse(groqResponse.choices[0].message.content);
    res.status(200).json(analysis);
  } catch (err) {
    console.error('Groq analysis error:', err.message);
    res.status(500).json({ error: 'Analysis failed' });
  }
};
