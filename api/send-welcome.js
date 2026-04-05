// api/send-welcome.js
const https = require('https');

module.exports = async function handler(req, res) {
  // Allow only POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get the Firebase ID token from the Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization token' });
  }
  const idToken = authHeader.split('Bearer ')[1];

  // Verify the token with Firebase
  let email;
  try {
    // Call Firebase Auth REST API to verify the token
    const verifyUrl = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.FIREBASE_API_KEY}`;
    const verifyRes = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ idToken });
      const options = {
        hostname: 'identitytoolkit.googleapis.com',
        path: `/v1/accounts:lookup?key=${process.env.FIREBASE_API_KEY}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };
      const request = https.request(options, (response) => {
        let raw = '';
        response.on('data', chunk => raw += chunk);
        response.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.users && parsed.users.length > 0) {
              resolve(parsed.users[0]);
            } else {
              reject(new Error('Invalid token'));
            }
          } catch (e) {
            reject(e);
          }
        });
      });
      request.on('error', reject);
      request.write(data);
      request.end();
    });
    email = verifyRes.email;
  } catch (err) {
    console.error('Token verification failed:', err);
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  // Ensure the email in the request body matches the authenticated user's email
  const { email: reqEmail } = req.body;
  if (!reqEmail || reqEmail !== email) {
    return res.status(403).json({ error: 'Email mismatch' });
  }

  // Now send the welcome email via Resend (same as before)
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('Missing RESEND_API_KEY');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const payload = JSON.stringify({
    from: 'SEO Writer <onboarding@seo-writer-teajay.vercel.app>',
    to: email,
    subject: 'Welcome to SEO Writer! 🚀',
    html: `<div>... (your welcome email HTML) ...</div>`
  });

  try {
    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      const request = https.request(options, (response) => {
        let raw = '';
        response.on('data', chunk => raw += chunk);
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            try {
              resolve(JSON.parse(raw));
            } catch (e) {
              reject(new Error('Invalid JSON response from Resend'));
            }
          } else {
            reject(new Error(`Resend API error ${response.statusCode}: ${raw}`));
          }
        });
      });
      request.on('error', reject);
      request.write(payload);
      request.end();
    });
    res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    console.error('Failed to send welcome email:', err.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
};
