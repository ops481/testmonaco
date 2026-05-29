require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");

const app = express();
const GOOGLE_SCRIPT_URL = String(process.env.GOOGLE_SCRIPT_URL || "").trim();
const PORT = Number(process.env.PORT || 3000);
const APP_URL = trimTrailingSlash(process.env.APP_URL || `http://localhost:${PORT}`);

const WHOP_API_KEY = String(process.env.WHOP_API_KEY || "").trim();
const WHOP_COMPANY_ID = String(process.env.WHOP_COMPANY_ID || "").trim();
const WHOP_ENVIRONMENT = String(process.env.WHOP_ENVIRONMENT || "sandbox").trim();
const WHATSAPP_GROUP_INVITE_URL = String(process.env.WHATSAPP_GROUP_INVITE_URL || "").trim();
const WHATSAPP_SUPPORT_NUMBER = String(process.env.WHATSAPP_SUPPORT_NUMBER || "").replace(/\D/g, "");
const WHOP_API_BASE = trimTrailingSlash(
  process.env.WHOP_API_BASE ||
    (WHOP_ENVIRONMENT === "sandbox"
      ? "https://sandbox-api.whop.com/api/v1"
      : "https://api.whop.com/api/v1")
);
const GOOGLE_CLIENT_ID = String(
  process.env.GOOGLE_CLIENT_ID || ""
).trim();

const GOOGLE_CLIENT_SECRET = String(
  process.env.GOOGLE_CLIENT_SECRET || ""
).trim();

const GOOGLE_REDIRECT_URI = String(
  process.env.GOOGLE_REDIRECT_URI ||
  `${APP_URL}/auth/google/callback`
).trim();
const WHOP_WEBHOOK_SECRET = String(process.env.WHOP_WEBHOOK_SECRET || "").trim();
const ADMIN_API_KEY = String(process.env.ADMIN_API_KEY || "").trim();

const TICKET_PRICE_CENTS = Number(process.env.TICKET_PRICE_CENTS || 260000);
const MAX_REFERRALS = Number(process.env.MAX_REFERRALS || 2);
const CURRENCY = String(process.env.CURRENCY || "EUR").toUpperCase();

const DATA_FILE = path.join("/tmp", "referrals.json");

app.use(cookieParser());

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

ensureStore();

app.get("/", (_req, res) => {
  res.redirect("/monaco.html");
});

app.get("/api/debug/config", requireAdmin, (_req, res) => {
  res.json({
    app_url: APP_URL,
    whop_environment: WHOP_ENVIRONMENT,
    whop_api_base: WHOP_API_BASE,
    has_whop_api_key: Boolean(WHOP_API_KEY),
    whop_company_id: WHOP_COMPANY_ID || null,
    referral_mode: "manual_local_tracking_only",
    payment_processor: "whop_checkout_only",
    ticket_price_cents: TICKET_PRICE_CENTS,
    max_referrals: MAX_REFERRALS,
    currency: CURRENCY
  });
});

app.post("/api/referrals/create-whop-session", async (req, res) => {
  try {
    requireEnv(["WHOP_API_KEY", "WHOP_COMPANY_ID"]);

    const body = req.body || {};

const email = cleanEmail(body.email);
const fullName = cleanText(body.full_name || body.fullName || body.name, 120);
const sourceUrl = cleanUrl(
  body.source_url || body.landing_url || `${APP_URL}/checkout.html`
);
const referredByCode = cleanReferralCode(
  body.referral_code ||
    body.referred_by ||
    body.r ||
    referralCodeFromUrl(sourceUrl) ||
    ""
);

    if (!fullName) {
      return res.status(400).json({ error: "Full name is required." });
    }

    if (!email) {
      return res.status(400).json({ error: "A valid booking email is required." });
    }

    const store = readStore();
    const localSessionId = `local_${crypto.randomUUID()}`;
    const redirectUrl = `${APP_URL}/thankyou.html`;
    if (referredByCode) {
  const paidUses = Object.values(store.referrals || {}).filter(
    (referral) =>
      cleanReferralCode(referral.referrer_referral_code) === referredByCode &&
      referral.friend_payment_status === "paid"
  ).length;

  if (paidUses >= MAX_REFERRALS) {
    return res.status(409).json({
      error: "This referral link has already been used by the maximum number of paid friends."
    });
  }
}

const metadata = {
  local_session_id: localSessionId,
  full_name: fullName,
  email,
  phone: cleanText(body.phone, 80),
  company: cleanText(body.company, 120),
  instagram: cleanText(body.instagram, 120),
  lead_source: cleanText(body.lead_source, 120),
  podia_email: cleanEmail(body.podia_email) || email,

  referred_by: referredByCode,
  referral_code: referredByCode,

  visitor_id: cleanText(body.visitor_id, 120),
  source_url: sourceUrl,
  app: "monaco-content-retreat"
};

    const checkoutConfig = await whopFetch("/checkout_configurations", {
      method: "POST",
      body: {
        mode: "payment",
        plan: {
          company_id: WHOP_COMPANY_ID,
          initial_price: TICKET_PRICE_CENTS / 100,
          plan_type: "one_time",
          currency: CURRENCY.toLowerCase()
        },
        metadata,
        redirect_url: redirectUrl,
        source_url: sourceUrl,
        allow_promo_codes: true
      }
    });

    const sessionId =
      checkoutConfig.id ||
      checkoutConfig.checkout_configuration_id ||
      checkoutConfig.checkoutConfig?.id;

    if (!sessionId) {
      throw withDetails("Whop did not return a checkout configuration ID.", checkoutConfig);
    }

    const planId =
      checkoutConfig.plan?.id ||
      checkoutConfig.plan_id ||
      checkoutConfig.planId ||
      "";

    store.checkout_sessions[sessionId] = {
      id: sessionId,
      local_session_id: localSessionId,
      full_name: fullName,
      email,
      phone: metadata.phone,
      company: metadata.company,
      podia_email: metadata.podia_email,
      referred_by: referredByCode,
      referral_code: referredByCode,
      visitor_id: metadata.visitor_id,
      source_url: sourceUrl,
      whop_purchase_url: checkoutConfig.purchase_url || checkoutConfig.purchaseUrl || "",
      whop_plan_id: planId,
      status: "created",
      payment_status: "pending",
      created_at: now(),
      updated_at: now()
    };

    writeStore(store);

    res.json({
      session_id: sessionId,
      checkout_configuration_id: sessionId,
      plan_id: planId,
      environment: WHOP_ENVIRONMENT,
      return_url: redirectUrl,
      purchase_url: checkoutConfig.purchase_url || checkoutConfig.purchaseUrl || "",
      referral_code: referredByCode
    });
  } catch (error) {
    console.error("create-whop-session failed:", error);

    res.status(500).json({
      error: error.message || "Could not create Whop checkout session.",
      details: error.details || undefined
    });
  }
});

app.get("/api/referrals/complete-checkout", async (req, res) => {
  try {
    const sessionId = cleanText(req.query.checkout_session_id || req.query.session_id, 160);

    if (!sessionId) {
      return res.status(400).json({ error: "Missing checkout_session_id." });
    }

    const store = readStore();
    const session = store.checkout_sessions[sessionId];

    if (!session) {
      return res.status(202).json({
        status: "processing",
        message: "Waiting for checkout session to sync."
      });
    }
if (session.payment_status !== "paid") {
  await syncPaidWhopPaymentForSession(store, session);
}
    const customer = upsertCustomerFromSession(store, session, {
      paid: session.payment_status === "paid"
    });

    setSessionCookie(res, customer.email);
    writeStore(store);

    res.json({
  status: session.payment_status === "paid" ? "complete" : "processing",
  dashboard: {
    ...buildDashboard(store, customer.email),
    google_connected: false
  }
});
  } catch (error) {
    console.error("complete-checkout failed:", error);
    res.status(500).json({ error: error.message || "Could not complete checkout." });
  }
});
function normaliseWhatsappPhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function buildWhatsappAccess(customer) {
  const phone = normaliseWhatsappPhone(customer.phone);

  const message = encodeURIComponent(
    `Hi, I just joined the Monaco Content Retreat. My name is ${customer.name || ""} and my booking email is ${customer.email || ""}.`
  );

  const supportUrl = WHATSAPP_SUPPORT_NUMBER
    ? `https://wa.me/${WHATSAPP_SUPPORT_NUMBER}?text=${message}`
    : "";

  return {
    enabled: Boolean(WHATSAPP_GROUP_INVITE_URL || supportUrl),
    customer_phone: customer.phone || "",
    group_invite_url: WHATSAPP_GROUP_INVITE_URL,
    support_url: supportUrl,
    label: WHATSAPP_GROUP_INVITE_URL ? "Join WhatsApp group" : "Message us on WhatsApp"
  };
}
app.post("/api/whop/webhook", async (req, res) => {
  try {
    if (WHOP_WEBHOOK_SECRET && !verifyWhopWebhook(req)) {
      return res.status(401).json({ error: "Invalid webhook signature." });
    }

    const event = req.body || {};
    const eventType = String(event.type || event.event || event.name || "").toLowerCase();
    const object = event.data?.object || event.data || event.object || event;

    if (isSuccessfulWhopPayment(eventType, object)) {
      const store = readStore();
      await handlePaymentSucceeded(store, object);
      writeStore(store);
    } else {
      console.log("Ignored Whop webhook:", {
        eventType,
        status: object.status,
        payment_status: object.payment_status,
        substatus: object.substatus
      });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("webhook failed:", error);

    res.status(200).json({
      ok: false,
      error: error.message || "Webhook error."
    });
  }
});

app.get("/api/referrals/me", (req, res) => {
  const email = sessionEmail(req);

  if (!email) {
    return res.status(401).json({ error: "Please log in." });
  }

  const store = readStore();

  if (!store.customers[email]) {
    return res.status(404).json({ error: "No booking found for this email yet." });
  }

  const googleConnected = Object.values(store.google_accounts || {}).some(
    (row) => cleanEmail(row.customer_email) === email
  );

  res.json({
    dashboard: {
      ...buildDashboard(store, email),
      google_connected: googleConnected
    }
  });
});


app.post("/api/referrals/login", (req, res) => {
  const email = cleanEmail(req.body?.email);

  if (!email) {
    return res.status(400).json({ error: "Enter a valid email." });
  }

  const store = readStore();

  if (!store.customers[email]) {
    return res.status(404).json({ error: "No booking was found for this email yet." });
  }

  const token = crypto.randomBytes(24).toString("hex");

  store.login_tokens[token] = {
    email,
    expires_at: Date.now() + 1000 * 60 * 30
  };

  writeStore(store);

  res.json({
    message: "Sandbox login link created. In production, email this link instead of showing it.",
    login_url: `${APP_URL}/thankyou-referral-dashboard.html?token=${token}`
  });
});

app.post("/api/referrals/session", (req, res) => {
  const token = cleanText(req.body?.token, 100);

  const store = readStore();
  const row = store.login_tokens[token];

  if (!row || row.expires_at < Date.now()) {
    return res.status(401).json({ error: "Login link expired." });
  }

  delete store.login_tokens[token];
  writeStore(store);

  setSessionCookie(res, row.email);

  res.json({ ok: true });
});

app.post("/api/referrals/logout", (_req, res) => {
  res.clearCookie("monaco_session");
  res.json({ ok: true });
});

app.get("/api/admin/referrals", requireAdmin, async (_req, res) => {
  const store = readStore();
  await syncPendingWhopPayments(store);
  writeStore(store);

  const customers = Object.values(store.customers)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((customer) => adminCustomerRow(store, customer));

  const referrals = Object.values(store.referrals)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((referral) => adminReferralRow(store, referral));

  const sessions = Object.values(store.checkout_sessions)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((session) => ({
      local_session_id: session.local_session_id,
      full_name: session.full_name || "",
      email: session.email || "",
      payment_status: session.payment_status || "pending",
      referred_by: session.referred_by || "",
      whop_payment_id: session.whop_payment_id || "",
      created_at: session.created_at || "",
      updated_at: session.updated_at || ""
    }));

  const summary = {
    total_customers: customers.length,
    paid_customers: customers.filter((c) => c.status === "paid").length,
    total_referral_relationships: referrals.length,
    paid_referral_relationships: referrals.filter((r) => r.friend_payment_status === "paid").length,
    pending_checkout_sessions: sessions.filter((s) => s.payment_status !== "paid").length,
    currency: CURRENCY
  };

  res.json({
    summary,
    customers,
    referrals,
    sessions
  });
});

// Backwards-compatible URL so your old admin-refunds.html can still call something if needed.
app.get("/api/admin/referrals/refund-queue", requireAdmin, (_req, res) => {
  const store = readStore();

  const referrals = Object.values(store.referrals)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((referral) => adminReferralRow(store, referral));

  res.json({
    summary: {
      total_referral_relationships: referrals.length,
      paid_referral_relationships: referrals.filter((r) => r.friend_payment_status === "paid").length
    },
    referrals
  });
});

app.post("/api/dev/mark-paid", requireAdmin, async (req, res) => {
  try {
    const sessionId = cleanText(req.body?.checkout_session_id, 160);
    const store = readStore();

    const session = sessionId
      ? store.checkout_sessions[sessionId]
      : Object.values(store.checkout_sessions).at(-1);

    if (!session) {
      return res.status(404).json({ error: "No checkout session found." });
    }

    await handlePaymentSucceeded(store, {
      id: req.body?.payment_id || `sandbox_pay_${Date.now()}`,
      checkout_configuration_id: session.id,
      total: TICKET_PRICE_CENTS / 100,
      currency: CURRENCY.toLowerCase(),
      metadata: {
        full_name: session.full_name,
        email: session.email,
        referred_by: session.referred_by,
        referral_code: session.referral_code || session.referred_by,
        podia_email: session.podia_email,
        phone: session.phone,
        company: session.company,
        source_url: session.source_url
      },
      user: {
        email: session.email,
        name: session.full_name
      }
    });

    writeStore(store);

    res.json({
      ok: true,
      session
    });
  } catch (error) {
    console.error("dev mark-paid failed:", error);

    res.status(500).json({
      error: error.message || "Could not mark paid.",
      details: error.details || undefined
    });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Monaco referral server running on http://localhost:${PORT}`);
  });
}


module.exports = app;
async function handlePaymentSucceeded(store, payment) {
  const session = findCheckoutSession(store, payment);
  const metadata = {
    ...(session || {}),
    ...(payment.metadata || {})
  };

  const sessionId = session?.id || cleanText(
    payment.checkout_configuration_id ||
      payment.checkoutConfigurationId ||
      payment.checkout_config_id ||
      payment.checkoutConfigId ||
      payment.checkout_session_id ||
      payment.checkoutSessionId ||
      payment.session_id ||
      payment.sessionId ||
      payment.metadata?.checkout_configuration_id ||
      payment.metadata?.checkout_session_id ||
      "",
    200
  );

  const email = cleanEmail(
    metadata.email ||
      payment.user?.email ||
      payment.customer?.email
  );

  if (!email) {
    throw new Error("Paid payment webhook did not include a customer email.");
  }

  const fullName = cleanText(
    metadata.full_name ||
      payment.user?.name ||
      payment.customer?.name ||
      "Founder",
    120
  );

  const whopPaymentId =
    payment.id ||
    payment.payment_id ||
    payment.paymentId ||
    payment.pay_id ||
    "";

  const customer = upsertCustomer(store, {
    email,
    name: fullName,
    phone: metadata.phone || "",
    company: metadata.company || "",
    podia_email: metadata.podia_email || email,
    whop_payment_id: whopPaymentId,
    checkout_session_id: sessionId || "",
    status: "paid",
    paid_at: now(),
    currency: String(payment.currency || CURRENCY).toUpperCase(),
    ticket_price_cents: moneyToCents(payment.total || payment.amount || payment.final_amount) || TICKET_PRICE_CENTS
  });
await sendPaidCustomerToAirtable({
  payment,
  session,
  customer,
  metadata,
  sessionId,
  whopPaymentId
});
  if (session) {
    session.payment_status = "paid";
    session.status = "paid";
    session.whop_payment_id = whopPaymentId;
    session.updated_at = now();
  } else {
    console.warn("Paid Whop payment could not be matched to a local checkout session.", {
      payment_id: whopPaymentId,
      email
    });
  }

const referredByCode = cleanReferralCode(
  metadata.referred_by ||
    metadata.referral_code ||
    session?.referred_by ||
    session?.referral_code ||
    referralCodeFromUrl(metadata.source_url || session?.source_url || "") ||
    ""
);

  if (!referredByCode) {
    return;
  }

  const referrer = Object.values(store.customers).find(
    (c) => cleanReferralCode(c.referral_code) === referredByCode
  );

  if (!referrer) {
    console.warn(`Referral code ${referredByCode} was used, but no matching local referrer exists yet.`);
    return;
  }

  if (referrer.email === customer.email) {
    console.warn(`Customer ${customer.email} tried to use their own referral code.`);
    return;
  }

  const existing = Object.values(store.referrals).find(
    (r) => r.referrer_email === referrer.email && r.friend_email === customer.email
  );

  if (existing) {
    existing.friend_payment_status = "paid";
    existing.friend_whop_payment_id = whopPaymentId;
    existing.paid_at = existing.paid_at || now();
    existing.updated_at = now();
    return;
  }

  const referralId = crypto.randomUUID();

  store.referrals[referralId] = {
    id: referralId,

    referrer_email: referrer.email,
    referrer_name: referrer.name || "",
    referrer_referral_code: referrer.referral_code || "",

    friend_email: customer.email,
    friend_name: customer.name,
    friend_whop_payment_id: whopPaymentId,
    friend_payment_status: "paid",

    created_from_checkout_session_id: sessionId || session?.id || "",
    created_from_referral_code: referredByCode,

    paid_at: now(),
    created_at: now(),
    updated_at: now()
  };
}
function isSuccessfulWhopPayment(eventType, object = {}) {
  const type = String(eventType || "").toLowerCase();
  const status = String(object.status || object.payment_status || "").toLowerCase();

  return (
    Boolean(object.paid_at) ||
    type.includes("payment.succeeded") ||
    type.includes("payment.paid") ||
    type.includes("payment.success") ||
    status === "paid" ||
    status === "succeeded" ||
    status === "complete" ||
    status === "completed"
  );
}

function findCheckoutSession(store, payment) {
  const metadata = payment.metadata || {};

  const possibleIds = [
    payment.checkout_configuration_id,
    payment.checkoutConfigurationId,
    payment.checkout_config_id,
    payment.checkoutConfigId,
    payment.checkout_session_id,
    payment.checkoutSessionId,
    payment.session_id,
    payment.sessionId,
    payment.configuration_id,
    payment.configurationId,
    metadata.checkout_configuration_id,
    metadata.checkoutConfigurationId,
    metadata.checkout_config_id,
    metadata.checkoutConfigId,
    metadata.checkout_session_id,
    metadata.checkoutSessionId,
    metadata.session_id,
    metadata.sessionId
  ]
    .map((v) => cleanText(v, 200))
    .filter(Boolean);

  for (const id of possibleIds) {
    if (store.checkout_sessions[id]) {
      return store.checkout_sessions[id];
    }
  }

  const localSessionId = cleanText(
    metadata.local_session_id ||
      payment.local_session_id ||
      payment.localSessionId,
    200
  );

  if (localSessionId) {
    const byLocalId = Object.values(store.checkout_sessions).find(
      (s) => s.local_session_id === localSessionId
    );

    if (byLocalId) return byLocalId;
  }

  const email = cleanEmail(
    metadata.email ||
      payment.user?.email ||
      payment.customer?.email
  );

  if (email) {
    const matchingPending = Object.values(store.checkout_sessions)
      .filter((s) => cleanEmail(s.email) === email && s.payment_status !== "paid")
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    if (matchingPending[0]) return matchingPending[0];
  }

  return null;
}
function isSuccessfulWhopPayment(eventType, object) {
  const type = String(eventType || "").toLowerCase();

  const status = String(
    object.status ||
    object.payment_status ||
    object.checkout_status ||
    object.substatus ||
    ""
  ).toLowerCase();

  return (
    type.includes("payment.succeeded") ||
    type.includes("payment.paid") ||
    type.includes("payment.success") ||
    status === "paid" ||
    status === "succeeded" ||
    status === "successful" ||
    status === "complete" ||
    status === "completed"
  );
}

function findCheckoutSession(store, payment) {
  const metadata = payment.metadata || {};

  const possibleIds = [
    payment.checkout_configuration_id,
    payment.checkoutConfigurationId,
    payment.checkout_config_id,
    payment.checkoutConfigId,
    payment.checkout_session_id,
    payment.checkoutSessionId,
    payment.session_id,
    payment.sessionId,
    payment.configuration_id,
    payment.configurationId,
    metadata.checkout_configuration_id,
    metadata.checkoutConfigurationId,
    metadata.checkout_config_id,
    metadata.checkoutConfigId,
    metadata.checkout_session_id,
    metadata.checkoutSessionId,
    metadata.session_id,
    metadata.sessionId
  ]
    .map((v) => cleanText(v, 200))
    .filter(Boolean);

  for (const id of possibleIds) {
    if (store.checkout_sessions[id]) {
      return store.checkout_sessions[id];
    }
  }

  const localSessionId = cleanText(
    metadata.local_session_id ||
      payment.local_session_id ||
      payment.localSessionId,
    200
  );

  if (localSessionId) {
    const byLocalId = Object.values(store.checkout_sessions).find(
      (s) => s.local_session_id === localSessionId
    );

    if (byLocalId) return byLocalId;
  }

  const email = cleanEmail(
    metadata.email ||
      payment.user?.email ||
      payment.customer?.email
  );

  if (email) {
    const matchingPending = Object.values(store.checkout_sessions)
      .filter((s) => cleanEmail(s.email) === email && s.payment_status !== "paid")
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    if (matchingPending[0]) return matchingPending[0];
  }

  return null;
}

function buildDashboard(store, email) {
  const customer = store.customers[email];

  if (!customer) {
    throw new Error("Customer not found.");
  }

  const referredFriends = Object.values(store.referrals)
    .filter((r) => r.referrer_email === email)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  return {
    name: customer.name || "Founder",
    email: customer.email,
    phone: customer.phone || "",
    company: customer.company || "",

    whatsapp: buildWhatsappAccess(customer),

    referral_code: customer.referral_code || "",
    referral_link: customer.referral_code
      ? `${APP_URL}/checkout.html?r=${encodeURIComponent(customer.referral_code)}`
      : "",

    max_referrals: MAX_REFERRALS,
    paid_referrals: referredFriends.filter((r) => r.friend_payment_status === "paid").length,

    currency: customer.currency || CURRENCY,

    referrals: referredFriends.map((r) => ({
      id: r.id,
      friend_name: r.friend_name || "Friend",
      friend_email_masked: maskEmail(r.friend_email),
      friend_payment_status: r.friend_payment_status || "paid",
      paid_at: r.paid_at || r.created_at || ""
    }))
  };
}

function adminCustomerRow(store, customer) {
  const referredFriends = Object.values(store.referrals).filter(
    (r) => r.referrer_email === customer.email
  );

const referredBy = Object.values(store.referrals).find(
  (r) => r.friend_email === customer.email
);

const checkoutSession = Object.values(store.checkout_sessions || {}).find(
  (s) =>
    s.id === customer.checkout_session_id ||
    cleanEmail(s.email) === cleanEmail(customer.email)
);

  return {
    name: customer.name || "",
    email: customer.email || "",
    phone: customer.phone || "",
    company: customer.company || "",
    status: customer.status || "pending",
    paid_at: customer.paid_at || "",
    referral_code: customer.referral_code || "",
    referral_link: customer.referral_code
      ? `${APP_URL}/checkout.html?r=${encodeURIComponent(customer.referral_code)}`
      : "",
    checkout_session_id: customer.checkout_session_id || "",
    whop_payment_id: customer.whop_payment_id || "",
    referred_friend_count: referredFriends.length,
    referred_by_name: referredBy?.referrer_name || "",
    referred_by_email: referredBy?.referrer_email || "",
    referred_by_code:
  referredBy?.referrer_referral_code ||
  checkoutSession?.referred_by ||
  checkoutSession?.referral_code ||
  "",
    created_at: customer.created_at || "",
    updated_at: customer.updated_at || ""
  };
}

function adminReferralRow(store, referral) {
  const referrer = store.customers[referral.referrer_email] || {};
  const friend = store.customers[referral.friend_email] || {};

  return {
    id: referral.id,

    referrer_name: referral.referrer_name || referrer.name || "Referrer",
    referrer_email: referral.referrer_email || "",
    referrer_referral_code: referral.referrer_referral_code || referrer.referral_code || "",

    friend_name: referral.friend_name || friend.name || "Friend",
    friend_email: referral.friend_email || "",
    friend_whop_payment_id: referral.friend_whop_payment_id || friend.whop_payment_id || "",
    friend_payment_status: referral.friend_payment_status || friend.status || "paid",

    created_from_checkout_session_id: referral.created_from_checkout_session_id || "",
    created_from_referral_code: referral.created_from_referral_code || "",

    paid_at: referral.paid_at || "",
    created_at: referral.created_at || "",
    updated_at: referral.updated_at || ""
  };
}

function upsertCustomerFromSession(store, session, options = {}) {
  return upsertCustomer(store, {
    email: session.email,
    name: session.full_name,
    phone: session.phone,
    company: session.company,
    podia_email: session.podia_email || session.email,
    checkout_session_id: session.id,
    whop_payment_id: session.whop_payment_id || "",
    status: options.paid ? "paid" : "pending",
    paid_at: options.paid ? session.updated_at || now() : "",
    currency: CURRENCY,
    ticket_price_cents: TICKET_PRICE_CENTS
  });
}

function upsertCustomer(store, input) {
  const email = cleanEmail(input.email);

  if (!email) {
    throw new Error("Customer email is required.");
  }

  const existing = store.customers[email] || {};
  const referralCode =
    existing.referral_code || generateReferralCode(input.name || existing.name || email, store);

  const customer = {
    ...existing,
    email,
    name: cleanText(input.name || existing.name || "Founder", 120),
    phone: cleanText(input.phone || existing.phone || "", 80),
    company: cleanText(input.company || existing.company || "", 120),
    podia_email: cleanEmail(input.podia_email || existing.podia_email || email) || email,
    referral_code: referralCode,
    checkout_session_id: input.checkout_session_id || existing.checkout_session_id || "",
    whop_payment_id: input.whop_payment_id || existing.whop_payment_id || "",
    status: input.status || existing.status || "pending",
    paid_at: input.paid_at || existing.paid_at || "",
    currency: input.currency || existing.currency || CURRENCY,
    ticket_price_cents: Number(
      input.ticket_price_cents || existing.ticket_price_cents || TICKET_PRICE_CENTS
    ),
    created_at: existing.created_at || now(),
    updated_at: now()
  };

  store.customers[email] = customer;

  return customer;
}

function generateReferralCode(seed, store) {
  const base =
    String(seed || "FOUNDER")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 10) || "FOUNDER";

  for (let i = 0; i < 100; i += 1) {
    const code = `${base}${crypto.randomInt(1000, 9999)}`;
    const exists = Object.values(store.customers || {}).some((c) => c.referral_code === code);
    if (!exists) return code;
  }

  return `${base}${Date.now()}`.slice(0, 24);
}

async function whopFetch(endpoint, options = {}) {
  const response = await fetch(`${WHOP_API_BASE}${endpoint}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${WHOP_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data.error?.message ||
      data.message ||
      data.error ||
      `Whop request failed (${response.status}).`;

    throw withDetails(message, data);
  }

  return data;
}

function ensureStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    writeStore(emptyStore());
    return;
  }

  const store = readStore();
  writeStore(normaliseStore(store));
}

function emptyStore() {
  return {
    checkout_sessions: {},
    customers: {},
    referrals: {},
    login_tokens: {},
    google_accounts: {}
  };
}


function normaliseStore(store) {
  return {
    ...emptyStore(),
    ...(store || {}),
    checkout_sessions: store?.checkout_sessions || {},
    customers: store?.customers || {},
    referrals: store?.referrals || {},
    login_tokens: store?.login_tokens || {},
    google_accounts: store?.google_accounts || {}
  };
}


function readStore() {
  try {
    return normaliseStore(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(normaliseStore(store), null, 2)}\n`);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(500).json({ error: "ADMIN_API_KEY is not set." });
  }

  const provided =
    req.get("X-Admin-Key") ||
    req.get("X-Admin-API-Key") ||
    req.query.admin_key ||
    req.body?.admin_key ||
    "";

  if (provided !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "Invalid admin key." });
  }

  next();
}

function requireEnv(names) {
  const missing = names.filter((name) => !String(process.env[name] || "").trim());

  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}.`);
  }
}

function verifyWhopWebhook(req) {
  const signature =
    req.get("whop-signature") ||
    req.get("x-whop-signature") ||
    req.get("x-signature") ||
    "";

  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", WHOP_WEBHOOK_SECRET)
    .update(req.rawBody || "")
    .digest("hex");

  const cleanSignature = signature.replace(/^sha256=/, "");

  try {
    return crypto.timingSafeEqual(Buffer.from(cleanSignature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function setSessionCookie(res, email) {
  const value = Buffer.from(JSON.stringify({ email: cleanEmail(email) })).toString("base64url");

  res.cookie("monaco_session", value, {
    httpOnly: true,
    sameSite: "lax",
    secure: APP_URL.startsWith("https://"),
    maxAge: 1000 * 60 * 60 * 24 * 30
  });
}

function sessionEmail(req) {
  try {
    const raw = req.cookies?.monaco_session;
    if (!raw) return "";

    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return cleanEmail(parsed.email);
  } catch {
    return "";
  }
}

function cleanEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function cleanText(value, max = 200) {
  return String(value || "")
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, max);
}

function cleanReferralCode(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80)
    .toUpperCase();
}
function referralCodeFromUrl(value) {
  const text = cleanText(value, 1000);

  try {
    const url = new URL(text, APP_URL);
    return cleanReferralCode(
      url.searchParams.get("r") ||
        url.searchParams.get("ref") ||
        url.searchParams.get("referral_code") ||
        ""
    );
  } catch {
    return "";
  }
}
function cleanUrl(value) {
  const text = cleanText(value, 1000);

  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return `${APP_URL}/checkout.html`;
    return url.toString();
  } catch {
    return `${APP_URL}/checkout.html`;
  }
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function now() {
  return new Date().toISOString();
}

function moneyToCents(value) {
  if (value == null || value === "") return 0;

  const number = Number(value);
  if (!Number.isFinite(number)) return 0;

  return Math.round(number * 100);
}

function maskEmail(email) {
  const clean = cleanEmail(email);
  if (!clean) return "—";

  const [name, domain] = clean.split("@");
  return `${name.slice(0, 2)}***@${domain}`;
}

function withDetails(message, details) {
  const error = new Error(message);
  error.details = details;
  return error;
}

async function syncPendingWhopPayments(store) {
  const pendingSessions = Object.values(store.checkout_sessions || {})
    .filter((session) => session?.payment_status !== "paid")
    .slice(0, 25);

  for (const session of pendingSessions) {
    await syncPaidWhopPaymentForSession(store, session);
  }
}

async function syncPaidWhopPaymentForSession(store, session) {
  if (!WHOP_API_KEY || !session?.id) return false;

  try {
    const params = new URLSearchParams({
      first: "50",
      company_id: WHOP_COMPANY_ID,
      direction: "desc",
      order: "created_at"
    });

    const payments = await whopFetch(`/payments?${params.toString()}`);
    const rows = Array.isArray(payments?.data) ? payments.data : [];

    console.log("WHOP PAYMENT SYNC DEBUG:", {
      local_session_id: session.id,
      email: session.email,
      whop_rows_found: rows.length,
first_payment: rows[0]
  ? {
      id: rows[0].id,
      status: rows[0].status,
      substatus: rows[0].substatus,
      checkout_configuration_id: rows[0].checkout_configuration_id,
      paid_at: rows[0].paid_at,
      user_email: rows[0].user?.email,
      metadata: rows[0].metadata
    }
  : null
    });

  const paidPayment = rows.find((payment) => {
  const metadata = payment.metadata || {};

  const paymentCheckoutId = cleanText(
    payment.checkout_configuration_id ||
      payment.checkoutConfigurationId ||
      metadata.checkout_configuration_id ||
      metadata.checkoutConfigurationId ||
      "",
    200
  );

  const paymentLocalSessionId = cleanText(
    metadata.local_session_id ||
      payment.local_session_id ||
      payment.localSessionId ||
      "",
    200
  );

  const paymentEmail = cleanEmail(
    metadata.email ||
      payment.customer?.email ||
      payment.user?.email ||
      payment.member?.email ||
      payment.email ||
      ""
  );

  const sessionEmail = cleanEmail(session.email);

  return (
    isSuccessfulWhopPayment("payment.succeeded", payment) &&
    (
      paymentCheckoutId === session.id ||
      paymentLocalSessionId === session.local_session_id ||
      paymentEmail === sessionEmail
    )
  );
});

    if (!paidPayment) return false;

    await handlePaymentSucceeded(store, {
      ...paidPayment,
      checkout_configuration_id:
        paidPayment.checkout_configuration_id ||
        paidPayment.checkoutConfigurationId ||
        session.id,
      metadata: {
        ...(session || {}),
        ...(paidPayment.metadata || {})
      }
    });

    return true;
  } catch (error) {
    console.warn("Could not sync Whop payment status yet:", error.message || error);
    return false;
  }
}


app.get("/auth/google/start", (req, res) => {
  try {
    requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);

    const state = crypto.randomBytes(24).toString("hex");
const checkoutSessionId = cleanText(req.query.checkout_session_id, 160);
    res.cookie("monaco_google_state", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: APP_URL.startsWith("https://"),
      maxAge: 1000 * 60 * 10
    });

    res.cookie("monaco_google_checkout_session", checkoutSessionId, {
  httpOnly: true,
  sameSite: "lax",
  secure: APP_URL.startsWith("https://"),
  maxAge: 1000 * 60 * 10
});

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");

    url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "select_account");

    res.redirect(url.toString());
  } catch (error) {
    console.error("google start failed:", error);
    res.redirect(`/thankyou-referral-dashboard.html?error=${encodeURIComponent(error.message || "Google login is not configured yet.")}`);
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);

    const code = cleanText(req.query.code, 2000);
    const state = cleanText(req.query.state, 200);
    const expectedState = cleanText(req.cookies?.monaco_google_state, 200);

    res.clearCookie("monaco_google_state");

    if (!code || !state || !expectedState || state !== expectedState) {
      return res.redirect("/thankyou-referral-dashboard.html?error=Google%20login%20expired.%20Please%20try%20again.");
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code"
      })
    });

    const tokens = await tokenResponse.json().catch(() => ({}));

    if (!tokenResponse.ok || !tokens.access_token) {
      throw withDetails("Google did not return a valid access token.", tokens);
    }

    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/json"
      }
    });

    const profile = await profileResponse.json().catch(() => ({}));

    if (!profileResponse.ok) {
      throw withDetails("Could not read your Google profile.", profile);
    }

    const googleEmail = cleanEmail(profile.email);

    if (!googleEmail || profile.email_verified === false) {
      return res.redirect("/thankyou-referral-dashboard.html?error=Your%20Google%20email%20could%20not%20be%20verified.");
    }

    const store = readStore();
    const currentCustomerEmail = sessionEmail(req);
const googleCheckoutSessionId = cleanText(req.cookies?.monaco_google_checkout_session, 160);
res.clearCookie("monaco_google_checkout_session");
    let customerEmail = "";

    // First activation: customer has just paid, so the existing checkout cookie
    // already identifies the paid customer. Link Google to that booking.
if (
  currentCustomerEmail &&
  store.customers[currentCustomerEmail]
) {
  const customer = store.customers[currentCustomerEmail];
  const session = store.checkout_sessions?.[customer.checkout_session_id];

  if (customer.status !== "paid" && session) {
    await syncPaidWhopPaymentForSession(store, session);
  }

  if (
    store.customers[currentCustomerEmail]?.status === "paid" ||
    store.checkout_sessions?.[customer.checkout_session_id]?.payment_status === "paid"
  ) {
    customerEmail = currentCustomerEmail;
  }
}
if (!customerEmail && googleCheckoutSessionId) {
  const session = store.checkout_sessions[googleCheckoutSessionId];

  if (session && session.payment_status !== "paid") {
    await syncPaidWhopPaymentForSession(store, session);
  }

  if (
    session?.email &&
    store.customers[cleanEmail(session.email)] &&
    (
      session.payment_status === "paid" ||
      store.customers[cleanEmail(session.email)]?.status === "paid"
    )
  ) {
    customerEmail = cleanEmail(session.email);
  }
}
    // Returning login: Google account has already been linked.
    if (!customerEmail && store.google_accounts[googleEmail]?.customer_email) {
      customerEmail = cleanEmail(store.google_accounts[googleEmail].customer_email);
    }

    // Simple fallback: Google email exactly matches a paid customer email.
    if (
      !customerEmail &&
      store.customers[googleEmail] &&
      store.customers[googleEmail] &&
(
  store.customers[googleEmail].status === "paid" ||
  store.checkout_sessions?.[store.customers[googleEmail].checkout_session_id]?.payment_status === "paid"
)
    ) {
      customerEmail = googleEmail;
    }

    if (!customerEmail || !store.customers[customerEmail]) {
      return res.redirect("/thankyou-referral-dashboard.html?error=We%20could%20not%20match%20this%20Google%20account%20to%20a%20paid%20Monaco%20booking.");
    }

    store.google_accounts[googleEmail] = {
      google_email: googleEmail,
      google_name: cleanText(profile.name, 120),
      customer_email: customerEmail,
      linked_at: store.google_accounts[googleEmail]?.linked_at || now(),
      updated_at: now()
    };

    writeStore(store);
    setSessionCookie(res, customerEmail);

    res.redirect("/thankyou-referral-dashboard.html");
  } catch (error) {
    console.error("google callback failed:", error);
    res.redirect(`/thankyou-referral-dashboard.html?error=${encodeURIComponent(error.message || "Google login failed.")}`);
  }
});

app.get("/api/admin/google-accounts", requireAdmin, (_req, res) => {
  const store = readStore();

  res.json({
    google_accounts: Object.values(store.google_accounts || {})
      .sort((a, b) => String(b.linked_at || "").localeCompare(String(a.linked_at || "")))
  });
});

async function sendPaidCustomerToAirtable({ payment, session, customer, metadata, sessionId, whopPaymentId }) {
  if (!GOOGLE_SCRIPT_URL) {
    console.warn("GOOGLE_SCRIPT_URL is not set. Skipping Airtable paid customer sync.");
    return;
  }

  const email = cleanEmail(
    metadata.email ||
    customer.email ||
    payment.user?.email ||
    payment.customer?.email ||
    payment.member?.email ||
    payment.email ||
    session?.email ||
    ""
  );

  if (!email) {
    console.warn("Could not send paid customer to Airtable because no email was found.", {
      payment_id: whopPaymentId,
      session_id: sessionId
    });
    return;
  }

  const payload = {
    event_type: "payment.succeeded",
    data: {
      id: whopPaymentId || payment.id || payment.payment_id || payment.paymentId || "",
      checkout_configuration_id:
        payment.checkout_configuration_id ||
        payment.checkoutConfigurationId ||
        payment.checkout_config_id ||
        payment.checkoutConfigId ||
        payment.checkout_session_id ||
        payment.checkoutSessionId ||
        sessionId ||
        session?.id ||
        "",

      membership_id:
        payment.membership_id ||
        payment.member_id ||
        payment.membershipId ||
        payment.membership ||
        "",

      total:
        payment.total ||
        payment.amount ||
        payment.amount_total ||
        payment.final_amount ||
        payment.price ||
        TICKET_PRICE_CENTS / 100,

      currency: String(payment.currency || CURRENCY || "EUR").toUpperCase(),

      paid_at:
        payment.paid_at ||
        payment.created_at ||
        new Date().toISOString(),

      status: "paid",

      metadata: {
        full_name:
          metadata.full_name ||
          customer.name ||
          payment.user?.name ||
          payment.customer?.name ||
          session?.full_name ||
          "",

        email,

        phone:
          metadata.phone ||
          customer.phone ||
          session?.phone ||
          "",

        company:
          metadata.company ||
          customer.company ||
          session?.company ||
          "",

        instagram:
          metadata.instagram ||
          session?.instagram ||
          "",

        lead_source:
          metadata.lead_source ||
          metadata.leadSource ||
          session?.lead_source ||
          "",

        referral_code:
          metadata.referral_code ||
          metadata.referred_by ||
          session?.referral_code ||
          session?.referred_by ||
          "",

        referred_by:
          metadata.referred_by ||
          metadata.referral_code ||
          session?.referred_by ||
          session?.referral_code ||
          "",

        source_url:
          metadata.source_url ||
          session?.source_url ||
          ""
      },

      customer: {
        email,
        name:
          customer.name ||
          metadata.full_name ||
          payment.user?.name ||
          payment.customer?.name ||
          session?.full_name ||
          "",

        phone:
          customer.phone ||
          metadata.phone ||
          session?.phone ||
          ""
      },

      user: {
        email,
        name:
          customer.name ||
          metadata.full_name ||
          payment.user?.name ||
          payment.customer?.name ||
          session?.full_name ||
          ""
      }
    }
  };

  try {
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();

    console.log("Airtable paid customer sync response:", {
      status: response.status,
      body: text
    });
  } catch (error) {
    console.error("Failed to send paid customer to Airtable:", error);
  }
}