const Stripe = require('stripe');
const { GoogleAuth } = require('google-auth-library');

async function getFirestoreToken() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/datastore'],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  return { projectId: process.env.FIREBASE_PROJECT_ID, token: tokenResponse.token };
}

async function getFirestoreUser(userId) {
  const { projectId, token } = await getFirestoreToken();
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
  const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!response.ok) return null;
  const data = await response.json();
  return data.fields || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const fields = await getFirestoreUser(userId);
    const customerId = fields?.stripeCustomerId?.stringValue;
    if (!customerId) return res.status(400).json({ error: 'No subscription found' });

    const subscriptions = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
    if (!subscriptions.data.length) return res.status(400).json({ error: 'No active subscription' });

    const sub = await stripe.subscriptions.update(subscriptions.data[0].id, {
      cancel_at_period_end: true,
    });

    res.json({ ok: true, cancelAt: sub.cancel_at });
  } catch (e) {
    console.error('Cancel subscription error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
