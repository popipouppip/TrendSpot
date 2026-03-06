const Stripe = require('stripe');

const PRICES = {
  pro: process.env.STRIPE_PRICE_PRO,
  maximum: process.env.STRIPE_PRICE_MAXIMUM,
};

async function ensureReferralCoupon(stripe) {
  try {
    await stripe.coupons.retrieve('REFER50');
  } catch {
    await stripe.coupons.create({
      id: 'REFER50',
      name: 'Referral discount — 50% off first month',
      percent_off: 50,
      duration: 'once',
    });
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { plan, userId, email, referrerUid } = req.body;
  if (!plan || !userId || !PRICES[plan]) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const baseUrl = process.env.SITE_URL || 'https://trend-spot-8nim.vercel.app';

  try {
    const metadata = { userId, plan };
    if (referrerUid && referrerUid !== userId) metadata.referrerUid = referrerUid;

    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: PRICES[plan], quantity: 1 }],
      metadata,
      success_url: `${baseUrl}/?payment=success`,
      cancel_url: `${baseUrl}/?payment=cancelled`,
    };

    if (metadata.referrerUid) {
      await ensureReferralCoupon(stripe);
      sessionParams.discounts = [{ coupon: 'REFER50' }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
