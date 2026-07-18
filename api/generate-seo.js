// api/generate-seo.js
const https = require('https');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// Helper: get days remaining until next month
function getDaysUntilNextMonth(date) {
  const nextMonth = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  const diff = nextMonth - date;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ====== VERIFY FIREBASE TOKEN ======
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
    return res.status(401).json({ error: 'Invalid token' });
  }

  // ====== PARSE REQUEST BODY ======
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const {
    primaryKeyword,
    secondaryKeywords = '',
    blogTitle = '',
    targetAudience = '',
    country = 'Nigeria',
    language = 'English',
    searchIntent = 'informational',
    authorName = '',
    authorCredentials = '',
    length = 'medium',
    tone = 'professional',
    readingLevel = 'intermediate',
    seoTitle = '',
    metaDescription = '',
    includeFaq = true,
    includeToc = true,
    includeTakeaways = true,
    eeatMode = false,
    humanizationMode = false
  } = body;

  if (!primaryKeyword) return res.status(400).json({ error: 'Primary keyword is required' });

  // ====== USER USAGE TRACKING ======
  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();
  let userData = userDoc.exists ? userDoc.data() : null;

  if (!userData) {
    const now = new Date();
    await userRef.set({
      plan: 'free',
      generationsUsedThisMonth: 0,
      monthlyResetDate: now.toISOString(),
      createdAt: now.toISOString()
    });
    userData = { plan: 'free', generationsUsedThisMonth: 0, monthlyResetDate: now.toISOString() };
  }

  const lastReset = new Date(userData.monthlyResetDate);
  const now = new Date();

  if (now.getMonth() !== lastReset.getMonth() || now.getFullYear() !== lastReset.getFullYear()) {
    await userRef.update({
      generationsUsedThisMonth: 0,
      monthlyResetDate: now.toISOString()
    });
    userData.generationsUsedThisMonth = 0;
  }

  const limit = userData.plan === 'pro' ? 25 : 8;

  if (userData.generationsUsedThisMonth >= limit) {
    const remainingDays = getDaysUntilNextMonth(now);
    return res.status(429).json({
      error: 'limit_reached',
      message: `You've used all ${limit} free generations this month. Your limit resets in ${remainingDays} days.`,
      remainingDays: remainingDays,
      limit: limit,
      used: userData.generationsUsedThisMonth
    });
  }

  // ====== MAP LENGTH TO WORD COUNT ======
  let wordCount;
  if (length === 'short') wordCount = 500;
  else if (length === 'medium') wordCount = 1000;
  else wordCount = 1800;

  // ====== BUILD SYSTEM PROMPT ======
  let systemPrompt = `You are an expert SEO content writer with 10+ years of experience. Generate a high-quality, SEO-optimized article that ranks well and engages readers.

Topic / Primary Keyword: ${primaryKeyword}
Secondary Keywords: ${secondaryKeywords || 'None provided'}
${blogTitle ? `Blog Title (user defined): ${blogTitle}` : 'Generate a compelling title based on the topic.'}
Target Audience: ${targetAudience || 'General audience'}
Country: ${country}
Language: ${language}
Search Intent: ${searchIntent}
${authorName ? `Author: ${authorName}${authorCredentials ? ` (${authorCredentials})` : ''}` : ''}
Reading Level: ${readingLevel}
Writing Style: ${tone}
Target Length: approximately ${wordCount} words.

${eeatMode ? `EEAT Mode ON: Emphasize Experience, Expertise, Authoritativeness, and Trustworthiness throughout the article. Include author credentials, real-world experience, and demonstrate deep knowledge of the subject. Use specific examples, case studies, and cite credible sources.` : ''}

${humanizationMode ? `Humanization Mode ON: Write in a natural, conversational tone. Avoid robotic language. Use contractions, rhetorical questions, relatable anecdotes, and a warm, engaging voice. Write like a human expert talking to another human.` : ''}

${blogTitle ? `Use this exact title: ${blogTitle}` : 'Generate a compelling, SEO-friendly title.'}

${seoTitle ? `Use this exact SEO title: ${seoTitle}` : 'Generate an SEO-optimized title under 60 characters.'}

${metaDescription ? `Use this exact meta description: ${metaDescription}` : 'Generate a compelling meta description under 160 characters.'}

IMPORTANT: You must return a JSON object with EXACTLY the following structure:

{
  "article": "Full HTML article content (use <p>, <h2>, <h3>, <ul>, <li>, etc.)",
  "metaTitle": "SEO title (under 60 characters)",
  "metaDescription": "Meta description (under 160 characters)",
  "suggestedTags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "seoScore": 85,
  "readabilityScore": 70,
  ${includeFaq ? `"faqSection": [{"question": "Question 1", "answer": "Answer 1"}, {"question": "Question 2", "answer": "Answer 2"}]` : `"faqSection": []`},
  ${includeToc ? `"tableOfContents": ["Heading 1", "Heading 2", "Heading 3", "Heading 4"]` : `"tableOfContents": []`},
  ${includeTakeaways ? `"keyTakeaways": ["Takeaway 1", "Takeaway 2", "Takeaway 3"]` : `"keyTakeaways": []`}
}

The SEO score should be 0-100 based on keyword usage, readability, and structure. The readability score should be 0-100 (higher is better).`;

  const userPrompt = `Write a high-quality SEO article about "${primaryKeyword}" targeting ${targetAudience || 'general readers'} in ${country}. The content should be in ${language} and match ${searchIntent} search intent.`;

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  const payload = JSON.stringify({
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 4000,
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
          if (response.statusCode !== 200) reject(new Error(`Groq API error ${response.statusCode}: ${raw}`));
          else resolve(JSON.parse(raw));
        });
      });
      request.on('error', reject);
      request.write(payload);
      request.end();
    });

    const content = groqResponse.choices[0].message.content;
    const result = JSON.parse(content);

    // Ensure all fields exist
    const finalResult = {
      article: result.article || '<p>Failed to generate article.</p>',
      metaTitle: result.metaTitle || `${primaryKeyword} - SEO Writer`,
      metaDescription: result.metaDescription || `Learn about ${primaryKeyword} with our SEO-optimized content.`,
      suggestedTags: Array.isArray(result.suggestedTags) ? result.suggestedTags : [],
      seoScore: typeof result.seoScore === 'number' ? result.seoScore : 70,
      readabilityScore: typeof result.readabilityScore === 'number' ? result.readabilityScore : 60,
      faqSection: Array.isArray(result.faqSection) ? result.faqSection : [],
      tableOfContents: Array.isArray(result.tableOfContents) ? result.tableOfContents : [],
      keyTakeaways: Array.isArray(result.keyTakeaways) ? result.keyTakeaways : []
    };

    // ====== SAVE GENERATION TO FIRESTORE ======
    const generationRef = userRef.collection('generations').doc();
    await generationRef.set({
      topic: primaryKeyword,
      keywords: secondaryKeywords,
      tone,
      length,
      generatedAt: new Date().toISOString(),
      result: finalResult
    });

    await userRef.update({
      generationsUsedThisMonth: admin.firestore.FieldValue.increment(1)
    });

    res.status(200).json(finalResult);
  } catch (err) {
    console.error('Groq generation error:', err.message);
    res.status(500).json({ error: 'AI generation failed: ' + err.message });
  }
};
