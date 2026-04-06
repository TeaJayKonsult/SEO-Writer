// api/send-welcome.js
const https = require('https');
const nodemailer = require('nodemailer');

// Create transporter using Brevo SMTP
const transporter = nodemailer.createTransport({
  host: 'smtp-relay.sendinblue.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_KEY,
    pass: process.env.BREVO_SMTP_KEY
  }
});

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const idToken = authHeader.split('Bearer ')[1];

  const firebaseApiKey = process.env.FIREBASE_API_KEY;
  if (!firebaseApiKey) {
    return res.status(500).json({ error: 'FIREBASE_API_KEY not configured' });
  }

  let email;
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
    email = verifyRes.email;
  } catch (err) {
    console.error('Token verification error:', err.message);
    return res.status(401).json({ error: 'Invalid token' });
  }

  const { email: reqEmail } = req.body;
  if (!reqEmail || reqEmail !== email) {
    return res.status(403).json({ error: 'Email mismatch' });
  }

  const fromEmail = process.env.BREVO_FROM_EMAIL;
  if (!fromEmail) {
    return res.status(500).json({ error: 'BREVO_FROM_EMAIL not configured' });
  }

  try {
    await transporter.sendMail({
      from: `"SEO Writer" <${fromEmail}>`,
      to: email,
      subject: 'Welcome to The SEO Writer! 🚀',
      html: `
        <div style="font-family: system-ui; max-width: 500px; margin: 0 auto;">
          <h2 style="color: #0d9488;">Welcome to The SEO Writer</h2>
          <p>Thank you for signing up on the SEO Writer, your no.1 content generator platform for blogs and social media platforms.</p>
          <p>You are on the default tier which is the <strong>Free tier</strong>. Upgrade to enjoy more benefits on our platform.</p>
          <p><strong>What you can do on our platform:</strong></p>
          <ul>
            <li>Generate SEO optimized articles</li>
            <li>Get meta tags and keywords suggestions</li>
            <li>Analyse content with SEO score, and many more.</li>
          </ul>
          <p>Once again, welcome onboard. Cheers 🥂</p>
          <hr />
          <p style="font-size: 12px;">© 2026 TeaJay Konsult Ltd.</p>
        </div>
      `
    });
    console.log('Welcome email sent to:', email);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Failed to send email:', err.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
};
