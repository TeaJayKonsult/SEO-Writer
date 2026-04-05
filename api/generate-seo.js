// api/generate-seo.js
const https = require('https');

module.exports = async function handler(req, res) {
  // Only POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get Firebase ID token from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const idToken = authHeader.split('Bearer ')[1];

  // Verify token with Firebase
  const firebaseApiKey = process.env.FIREBASE_API_KEY;
  if (!firebaseApiKey) {
    return res.status(500).json({ error: 'Server configuration error' });
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

  // Map length to approximate word count
  const wordCount = length === 'short' ? 300 : length === 'medium' ? 800 : 1500;

  // Build system prompt
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
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.error('Groq returned invalid JSON:', content);
      return res.status(500).json({ error: 'Invalid response from AI' });
    }

    // Ensure all fields exist
    const result = {
      article: parsed.article || '<p>Failed to generate article.</p>',
      metaTitle: parsed.metaTitle || `${topic} - SEO Writer`,
      metaDescription: parsed.metaDescription || `Learn about ${topic} with our SEO-optimized content.`,
      suggestedTags: Array.isArray(parsed.suggestedTags) ? parsed.suggestedTags : [],
      seoScore: typeof parsed.seoScore === 'number' ? parsed.seoScore : 70
    };

    // Optionally store generation in Firestore (we'll implement later)
    // For now, just return the result
    res.status(200).json(result);
  } catch (err) {
    console.error('Groq generation error:', err.message);
    res.status(500).json({ error: 'AI generation failed' });
  }
};
