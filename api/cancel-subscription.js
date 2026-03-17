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

async function updateFirestoreUser(userId, data) {
  const { projectId, token } = await getFirestoreToken();
  const fields = {};
  if (data.cancel_reason) fields.cancel_reason = { stringValue: data.cancel_reason };
  if (data.cancel_comment) fields.cancel_comment = { stringValue: data.cancel_comment };
  if (data.plan_expiry) fields.plan_expiry = { stringValue: data.plan_expiry };

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) throw new Error(`Firestore error ${response.status}`);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { userId, reason, comment } = req.body;
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

    const expiryDate = new Date(sub.current_period_end * 1000).toISOString();
    await updateFirestoreUser(userId, {
      cancel_reason: reason || 'not_specified',
      cancel_comment: comment || '',
      plan_expiry: expiryDate,
    });

    res.json({ ok: true, cancelAt: sub.current_period_end, expiryDate });
  } catch (e) {
    console.error('Cancel subscription error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
