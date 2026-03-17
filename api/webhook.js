const Stripe = require('stripe');
const { GoogleAuth } = require('google-auth-library');

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
    const { userId, plan, referrerUid } = session.metadata || {};
    const stripeCustomerId = session.customer;

    if (userId && plan) {
      try {
        const existing = await getFirestoreUser(userId);
        if (existing?.plan?.stringValue === plan && existing?.stripeCustomerId?.stringValue === stripeCustomerId) {
          console.log('Idempotent skip: plan already set for', userId);
        } else {
          await updateFirestoreUser(userId, { plan, stripeCustomerId });
          console.log('Firestore updated: userId', userId, 'plan', plan);
        }
      } catch (e) {
        console.error('Firestore update failed:', e.message);
      }
    }

    if (referrerUid) {
      try {
        await applyReferrerDiscount(stripe, referrerUid);
        console.log('Referrer discount applied:', referrerUid);
      } catch (e) {
        console.error('Referrer discount failed:', e.message);
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const customerId = sub.customer;
    try {
      const userId = await findUserIdByCustomer(customerId);
      if (userId) {
        const existing = await getFirestoreUser(userId);
        if (existing?.plan?.stringValue === 'free') {
          console.log('Idempotent skip: already free for', userId);
        } else {
          await updateFirestoreUser(userId, { plan: 'free' });
          console.log('Subscription cancelled, plan reset to free:', userId);
        }
      }
    } catch (e) {
      console.error('Cancel webhook error:', e.message);
    }
  }

  res.json({ received: true });
};

module.exports.config = { api: { bodyParser: false } };

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

async function updateFirestoreUser(userId, data) {
  const { projectId, token } = await getFirestoreToken();
  const fields = { plan_updated_at: { timestampValue: new Date().toISOString() } };
  if (data.plan) fields.plan = { stringValue: data.plan };
  if (data.stripeCustomerId) fields.stripeCustomerId = { stringValue: data.stripeCustomerId };

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) throw new Error(`Firestore error ${response.status}: ${await response.text()}`);
}

async function getFirestoreUser(userId) {
  const { projectId, token } = await getFirestoreToken();
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
  const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!response.ok) return null;
  const data = await response.json();
  return data.fields || null;
}

async function findUserIdByCustomer(customerId) {
  const { projectId, token } = await getFirestoreToken();
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: { fieldFilter: { field: { fieldPath: 'stripeCustomerId' }, op: 'EQUAL', value: { stringValue: customerId } } },
        limit: 1,
      },
    }),
  });
  const results = await response.json();
  const doc = results[0]?.document;
  if (!doc) return null;
  return doc.name.split('/').pop();
}

async function applyReferrerDiscount(stripe, referrerUid) {
  const fields = await getFirestoreUser(referrerUid);
  const customerId = fields?.stripeCustomerId?.stringValue;
  if (!customerId) {
    console.log('Referrer has no stripeCustomerId, skipping discount');
    return;
  }

  const subscriptions = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
  if (!subscriptions.data.length) {
    console.log('Referrer has no active subscription');
    return;
  }

  const sub = subscriptions.data[0];
  if (sub.discounts && sub.discounts.length > 0) {
    console.log('Referrer already has a discount, skipping');
    return;
  }

  await stripe.subscriptions.update(sub.id, {
    discounts: [{ coupon: 'REFER50' }],
  });
}
