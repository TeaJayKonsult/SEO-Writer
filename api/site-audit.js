// api/site-audit.js
const https = require('https');
const cheerio = require('cheerio');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// Helper to fetch HTML from URL
function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/1.0)' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify Firebase token (same pattern as generate-seo and analyze-seo)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  const firebaseApiKey = process.env.FIREBASE_API_KEY;
  if (!firebaseApiKey) return res.status(500).json({ error: 'FIREBASE_API_KEY missing' });

  let userId;
  try {
    const verifyData = JSON.stringify({ idToken });
    const verifyRes = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'identitytoolkit.googleapis.com',
        path: `/v1/accounts:lookup?key=${firebaseApiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(verifyData) }
      };
      const request = https.request(options, (response) => {
        let raw = '';
        response.on('data', chunk => raw += chunk);
        response.on('end', () => {
          if (response.statusCode !== 200) reject(new Error(`Token verification failed: ${response.statusCode}`));
          else {
            const parsed = JSON.parse(raw);
            if (parsed.users && parsed.users.length) resolve(parsed.users[0]);
            else reject(new Error('No user found'));
          }
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

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const { url, targetKeywords = '' } = body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Fetch HTML
  let html;
  try {
    html = await fetchHTML(url);
  } catch (err) {
    return res.status(400).json({ error: 'Failed to fetch URL. Check if site is accessible.' });
  }

  const $ = cheerio.load(html);
  // Remove scripts, styles, etc. for text extraction
  $('script, style, noscript, iframe').remove();
  const textContent = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = textContent.split(/\s+/).length;

  // Technical SEO data
  const pageTitle = $('title').text().trim() || 'N/A';
  const metaDescription = $('meta[name="description"]').attr('content') || 'N/A';
  const canonical = $('link[rel="canonical"]').attr('href') || 'N/A';
  const headings = {
    h1: $('h1').length,
    h2: $('h2').length,
    h3: $('h3').length
  };
  const imagesWithAlt = $('img[alt]').length;
  const imagesWithoutAlt = $('img:not([alt])').length;
  const internalLinks = $('a[href^="/"], a[href^="' + url.replace(/\/$/, '') + '"]').length;
  const externalLinks = $('a[href^="http"]').not(`a[href^="${url}"]`).length;

  // AI analysis via Groq (same prompt as analyze-seo)
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) return res.status(500).json({ error: 'GROQ_API_KEY missing' });

  // Truncate text to avoid token limits (8000 chars is safe)
  const truncatedText = textContent.substring(0, 8000);
  const systemPrompt = `You are an expert SEO analyst. Analyze the provided web page content and return a JSON object with the following fields:
{
  "score": number (0-100),
  "keywordDensity": number,
  "readability": number (Flesch Reading Ease, 0-100),
  "suggestions": ["suggestion1", "suggestion2", ...],
  "metaTitle": "suggested meta title under 60 chars",
  "metaDescription": "suggested meta description under 160 chars",
  "relatedKeywords": ["keyword1", "keyword2", ...],
  "subKeywords": ["subkeyword1", ...]
}
Be objective and helpful. If target keywords are provided, evaluate how well they are used.`;

  const userPrompt = `Page content:\n\n${truncatedText}\n\nTarget keywords: ${targetKeywords || 'none provided'}`;

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

  let analysis;
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
          if (response.statusCode !== 200) reject(new Error(`Groq API error ${response.statusCode}: ${raw}`));
          else resolve(JSON.parse(raw));
        });
      });
      request.on('error', reject);
      request.write(payload);
      request.end();
    });
    analysis = JSON.parse(groqResponse.choices[0].message.content);
  } catch (err) {
    console.error('Groq analysis error:', err.message);
    return res.status(500).json({ error: 'AI analysis failed' });
  }

  // Combine results
  const finalResult = {
    url,
    pageTitle,
    metaDescription,
    canonical,
    wordCount,
    missingAltCount: imagesWithoutAlt,
    internalLinks,
    externalLinks,
    headings,
    seoScore: analysis.score,
    readability: analysis.readability,
    keywordDensity: analysis.keywordDensity,
    suggestions: analysis.suggestions,
    relatedKeywords: analysis.relatedKeywords,
    subKeywords: analysis.subKeywords,
    metaTitle: analysis.metaTitle,
    metaDescriptionSuggestion: analysis.metaDescription
  };

  // Save audit to Firestore (subcollection 'audits' under user document)
  try {
    const userRef = db.collection('users').doc(userId);
    const auditRef = userRef.collection('audits').doc();
    await auditRef.set({
      ...finalResult,
      targetKeywords: targetKeywords || '',
      auditedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Failed to save audit to Firestore:', err.message);
    // Continue anyway – we still return the result to the user
  }

  res.status(200).json(finalResult);
};
