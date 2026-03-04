const Stripe = require('stripe');
const { GoogleAuth } = require('google-auth-library');

module.exports.config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature error:', e.message);
    return res.status(400).send(`Webhook error: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, plan } = session.metadata || {};
    console.log('Payment completed. userId:', userId, 'plan:', plan);
    if (userId && plan) {
      try {
        await updateFirestorePlan(userId, plan);
        console.log('Firestore updated successfully');
      } catch (e) {
        console.error('Firestore update failed:', e.message);
      }
    } else {
      console.error('Missing metadata. userId:', userId, 'plan:', plan);
    }
  }

  res.json({ received: true });
};

module.exports.config = { api: { bodyParser: false } };

async function updateFirestorePlan(userId, plan) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/datastore'],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${tokenResponse.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        plan: { stringValue: plan },
        plan_updated_at: { timestampValue: new Date().toISOString() },
      }
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Firestore error ${response.status}: ${text}`);
  }
}
