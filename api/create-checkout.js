const Stripe = require('stripe');

const PRICES = {
  pro: process.env.STRIPE_PRICE_PRO,
  maximum: process.env.STRIPE_PRICE_MAXIMUM,
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { plan, userId, email } = req.body;
  if (!plan || !userId || !PRICES[plan]) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const baseUrl = process.env.SITE_URL || 'https://trend-spot-8nim.vercel.app';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: PRICES[plan], quantity: 1 }],
      metadata: { userId, plan },
      success_url: `${baseUrl}/?payment=success`,
      cancel_url: `${baseUrl}/?payment=cancelled`,
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
