// api/send-welcome.js
export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  // Only POST allowed
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  // Get Firebase ID token from Authorization header
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Missing authorization token' }), { status: 401 });
  }
  const idToken = authHeader.split('Bearer ')[1];

  // Verify token with Firebase REST API
  const firebaseApiKey = process.env.FIREBASE_API_KEY;
  if (!firebaseApiKey) {
    return new Response(JSON.stringify({ error: 'FIREBASE_API_KEY not configured' }), { status: 500 });
  }

  let email;
  try {
    const verifyRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });
    const verifyData = await verifyRes.json();
    if (verifyData.users && verifyData.users.length > 0) {
      email = verifyData.users[0].email;
    } else {
      throw new Error('No user found');
    }
  } catch (err) {
    console.error('Token verification error:', err.message);
    return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401 });
  }

  // Verify email matches request body
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  const { email: reqEmail } = body;
  if (!reqEmail || reqEmail !== email) {
    return new Response(JSON.stringify({ error: 'Email mismatch' }), { status: 403 });
  }

  // --- Send email using MailChannels API (no API key needed) ---
  const senderDomain = 'the-seo-writer.vercel.app';
  const senderEmail = `welcome@${senderDomain}`;
  const senderName = 'SEO Writer';
  const recipientEmail = email;

  const emailPayload = {
    personalizations: [
      {
        to: [{ email: recipientEmail }],
        dkim_domain: senderDomain,
        dkim_selector: 'mailchannels',
        dkim_private_key: ''
      },
    ],
    from: { email: senderEmail, name: senderName },
    subject: 'Welcome to The SEO Writer! 🚀',
    content: [
      {
        type: 'text/html',
        value: `
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
        `,
      },
    ],
  };

  try {
    const emailResponse = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload),
    });

    if (!emailResponse.ok) {
      const errorText = await emailResponse.text();
      console.error('MailChannels error:', emailResponse.status, errorText);
      throw new Error(`MailChannels error: ${emailResponse.status}`);
    }

    console.log('Welcome email sent to:', email);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err) {
    console.error('Failed to send email:', err.message);
    return new Response(JSON.stringify({ error: 'Failed to send email' }), { status: 500 });
  }
}
