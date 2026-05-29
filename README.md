# Monaco Whop Referral System

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000/monaco.html` or `http://localhost:3000/checkout.html`.

For Whop sandbox external affiliate links/webhooks, use a public HTTPS tunnel such as ngrok and set `APP_URL` in `.env` to that tunnel URL, then restart the server.

## Main URLs

- Landing: `/monaco.html`
- Checkout: `/checkout.html`
- Referral dashboard: `/thankyou-referral-dashboard.html`
- Admin refund queue: `/admin-refunds.html`

## UI merge notes

This package keeps the original backend functionality in `server.js`, including the Whop checkout session creation, referral tracking APIs, Google login hooks, member dashboard, and admin refund dashboard.

The public landing/checkout/thank-you pages have been updated with the visual HTML/assets from the provided Monaco UI zip. The checkout form still posts to `/api/referrals/create-whop-session` and renders the Whop embedded checkout instead of using the static UI-only placeholder card fields.
