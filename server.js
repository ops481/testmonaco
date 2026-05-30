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
const PASSWORD_MIN_LENGTH = Number(process.env.PASSWORD_MIN_LENGTH || 8);
const PASSWORD_HASH_ITERATIONS = Number(process.env.PASSWORD_HASH_ITERATIONS || 210000);
const PASSWORD_HASH_KEYLEN = 64;
const PASSWORD_HASH_DIGEST = "sha512";
const DATA_FILE = path.join("/tmp", "referrals.json");
const PASSWORD_SETUP_TOKEN_TTL_MS = Number(
  process.env.PASSWORD_SETUP_TOKEN_TTL_MS || 1000 * 60 * 60 * 24 * 7
);
// Optional Supabase mirror.
// This keeps the existing referrals.json flow working,
// but also copies the whole store into Supabase.
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const SUPABASE_STORE_TABLE = String(process.env.SUPABASE_STORE_TABLE || "monaco_json_store").trim();
const SUPABASE_STORE_KEY = String(process.env.SUPABASE_STORE_KEY || "referrals").trim();

let supabaseClient = null;
let supabaseWriteTimer = null;

app.use(cookieParser());

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

const storeReady = ensureStore();


// Do not serve referral/admin requests until optional Supabase hydrate has finished.
app.use(async (_req, res, next) => {
  try {
    await storeReady;
    next();
  } catch (error) {
    console.error("Store initialisation failed:", error);
    res.status(500).json({ error: "Store initialisation failed." });
  }
});


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
app.post("/api/referrals/password-login", (req, res) => {
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (!email) {
    return res.status(400).json({
      error: "Enter the email you used to book the Monaco Content Retreat."
    });
  }

  if (!password) {
    return res.status(400).json({ error: "Enter your password." });
  }

  const store = readStore();
  const customer = store.customers[email];

  if (!customer) {
    return res.status(404).json({
      error: "No paid Monaco booking was found for this email. Use the exact email you used at checkout."
    });
  }

  if (!isPaidCustomer(store, email)) {
    return res.status(403).json({
      error: "This email is not connected to a paid Monaco booking yet."
    });
  }

  if (!customer.password_hash) {
    const sessionCustomerEmail = sessionEmail(req);

    return res.status(409).json({
      code: "PASSWORD_NOT_SET",
      requires_password_setup: true,
      can_set_password_now: sessionCustomerEmail === email,
      email,
      error: sessionCustomerEmail === email
        ? "No password has been set yet. Create your dashboard password now."
        : "No dashboard password has been created for this paid email yet. Use your password setup link, or continue with Google using the same email you paid with."
    });
  }

  if (!verifyPassword(password, customer.password_hash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  customer.last_password_login_at = now();
  customer.updated_at = now();
  store.customers[email] = customer;
  writeStore(store);

  setSessionCookie(res, email);

  res.json({
    ok: true,
    dashboard: {
      ...buildDashboard(store, email),
      google_connected: Object.values(store.google_accounts || {}).some(
        (row) => cleanEmail(row.customer_email) === email
      )
    }
  });
});

app.post("/api/referrals/password-set", (req, res) => {
  const sessionCustomerEmail = sessionEmail(req);
  const email = cleanEmail(req.body?.email || sessionCustomerEmail);
  const password = String(req.body?.password || "");
  const currentPassword = String(req.body?.current_password || "");

  if (!sessionCustomerEmail) {
    return res.status(401).json({
      error: "Please use your checkout session, Google login, or a secure password setup link first."
    });
  }

  if (!email || email !== sessionCustomerEmail) {
    return res.status(403).json({
      error: "You can only set a password for the email currently logged in."
    });
  }

  const result = setCustomerPassword(readStore(), {
    email,
    password,
    currentPassword,
    requireCurrentPasswordIfAlreadySet: true
  });

  if (!result.ok) {
    return res.status(result.status || 400).json({ error: result.error });
  }

  setSessionCookie(res, email);

  res.json({
    ok: true,
    dashboard: {
      ...buildDashboard(result.store, email),
      google_connected: Object.values(result.store.google_accounts || {}).some(
        (row) => cleanEmail(row.customer_email) === email
      )
    }
  });
});
app.get("/api/referrals/password-setup-token", (req, res) => {
  const token = cleanText(req.query?.token || req.body?.token || "", 120);

  if (!token) {
    return res.status(400).json({ error: "Missing password setup token." });
  }

  const store = readStore();
  const row = store.password_tokens[token];

  if (!row || row.expires_at < Date.now()) {
    if (row) {
      delete store.password_tokens[token];
      writeStore(store);
    }

    return res.status(401).json({
      error: "This password setup link has expired. Please request a new one."
    });
  }

  const email = cleanEmail(row.email);

  if (!email || !store.customers[email]) {
    return res.status(400).json({
      error: "This password setup link is invalid or has already been used."
    });
  }

  if (!isPaidCustomer(store, email)) {
    return res.status(403).json({
      error: "This setup link is not connected to a paid Monaco booking."
    });
  }

  res.json({
    ok: true,
    email,
    expires_at: row.expires_at
  });
});
app.post("/api/referrals/password-set-with-token", (req, res) => {
  const token = cleanText(req.body?.token || req.body?.setup_token, 120);
  const password = String(req.body?.password || "");

  if (!token) {
    return res.status(400).json({ error: "Missing password setup token." });
  }

  const store = readStore();
  const row = store.password_tokens[token];

  if (!row || row.expires_at < Date.now()) {
    if (row) {
      delete store.password_tokens[token];
      writeStore(store);
    }

    return res.status(401).json({
      error: "This password setup link has expired. Please request a new one."
    });
  }

  const email = cleanEmail(row.email);

  if (!email) {
    delete store.password_tokens[token];
    writeStore(store);
    return res.status(400).json({
      error: "This password setup link is invalid or has already been used."
    });
  }

  const result = setCustomerPassword(store, {
    email,
    password,
    currentPassword: "",
    requireCurrentPasswordIfAlreadySet: false
  });

  if (!result.ok) {
    return res.status(result.status || 400).json({ error: result.error });
  }

  delete result.store.password_tokens[token];
  writeStore(result.store);

  setSessionCookie(res, email);

  res.json({
    ok: true,
    dashboard: {
      ...buildDashboard(result.store, email),
      google_connected: Object.values(result.store.google_accounts || {}).some(
        (row) => cleanEmail(row.customer_email) === email
      )
    }
  });
});

app.post("/api/admin/referrals/password-setup-link", requireAdmin, (req, res) => {
  try {
    const email = cleanEmail(req.body?.email || req.query.email);
    const fullName = cleanText(
      req.body?.full_name || req.body?.fullName || req.body?.name || "Founder",
      120
    );

    const whopPaymentId = cleanText(
      req.body?.whop_payment_id || req.body?.payment_id || "",
      160
    );

    const whopMemberId = cleanText(
      req.body?.whop_member_id || req.body?.member_id || "",
      160
    );

    if (!email) {
      return res.status(400).json({ error: "Enter a valid customer email." });
    }

    const store = readStore();

    // Create the customer if missing, or update them if already present.
    const customer = upsertCustomer(store, {
      email,
      name: fullName,
      whop_payment_id: whopPaymentId,
      status: "paid",
      paid_at: now(),
      currency: CURRENCY,
      ticket_price_cents: TICKET_PRICE_CENTS
    });

    // Optional: store the Whop member ID too.
    if (whopMemberId) {
      customer.whop_member_id = whopMemberId;
      customer.updated_at = now();
      store.customers[email] = customer;
    }

    const token = createPasswordSetupToken(store, email);

    writeStore(store);

    res.json({
      ok: true,
      email,
      setup_url: passwordSetupUrl(token),
      expires_in_hours: Math.round(PASSWORD_SETUP_TOKEN_TTL_MS / (1000 * 60 * 60))
    });
  } catch (error) {
    console.error("password-setup-link failed:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "Could not create password setup link."
    });
  }
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

  const status = String(
    object.status ||
      object.payment_status ||
      object.checkout_status ||
      object.substatus ||
      ""
  ).toLowerCase();

  return (
    Boolean(object.paid_at) ||
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

async function ensureStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

  const localStore = fs.existsSync(DATA_FILE) ? readStore() : emptyStore();
  let finalStore = normaliseStore(localStore);

  const remoteStore = await readStoreFromSupabase();

  if (remoteStore) {
    // Merge keeps anything already in Supabase and anything still in local JSON.
    // Local values win on duplicate IDs/emails, which makes first migration safer.
    finalStore = mergeStores(remoteStore, finalStore);
  }

  writeStore(finalStore);
}

function emptyStore() {
  return {
    checkout_sessions: {},
    customers: {},
    referrals: {},
    login_tokens: {},
    password_tokens: {},
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
    password_tokens: store?.password_tokens || {},
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
  const normalised = normaliseStore(store);

  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(normalised, null, 2)}\n`);

  queueSupabaseWrite(normalised);
}
function mergeStores(baseStore, overrideStore) {
  return normaliseStore({
    ...emptyStore(),
    ...(baseStore || {}),
    ...(overrideStore || {}),
    checkout_sessions: {
      ...(baseStore?.checkout_sessions || {}),
      ...(overrideStore?.checkout_sessions || {})
    },
    customers: {
      ...(baseStore?.customers || {}),
      ...(overrideStore?.customers || {})
    },
    referrals: {
      ...(baseStore?.referrals || {}),
      ...(overrideStore?.referrals || {})
    },
login_tokens: {
  ...(baseStore?.login_tokens || {}),
  ...(overrideStore?.login_tokens || {})
},
password_tokens: {
  ...(baseStore?.password_tokens || {}),
  ...(overrideStore?.password_tokens || {})
},
google_accounts: {
  ...(baseStore?.google_accounts || {}),
  ...(overrideStore?.google_accounts || {})
}
  });
}

function getSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  if (supabaseClient) return supabaseClient;

  let createClient;

  try {
    ({ createClient } = require("@supabase/supabase-js"));
  } catch (error) {
    console.warn("Supabase env vars are set, but @supabase/supabase-js is not installed. Using local referrals.json only.");
    return null;
  }

  supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  return supabaseClient;
}

async function readStoreFromSupabase() {
  const client = getSupabaseClient();
  if (!client) return null;

  const { data, error } = await client
    .from(SUPABASE_STORE_TABLE)
    .select("store")
    .eq("store_key", SUPABASE_STORE_KEY)
    .maybeSingle();

  if (error) {
    console.warn("Could not read referral store from Supabase. Local JSON fallback will be used:", error.message);
    return null;
  }

  return data?.store ? normaliseStore(data.store) : null;
}

function queueSupabaseWrite(store) {
  if (!getSupabaseClient()) return;

  const snapshot = normaliseStore(store);

  clearTimeout(supabaseWriteTimer);
  supabaseWriteTimer = setTimeout(() => {
    writeStoreToSupabase(snapshot).catch((error) => {
      console.error("Could not mirror referral store to Supabase:", error);
    });
  }, 100);
}

async function writeStoreToSupabase(store) {
  const client = getSupabaseClient();
  if (!client) return;

  const { error } = await client
    .from(SUPABASE_STORE_TABLE)
    .upsert(
      {
        store_key: SUPABASE_STORE_KEY,
        store: normaliseStore(store),
        updated_at: now()
      },
      { onConflict: "store_key" }
    );

  if (error) throw new Error(error.message || "Supabase write failed.");
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
function createPasswordSetupToken(store, email) {
  const clean = cleanEmail(email);

  if (!clean) {
    throw new Error("A valid customer email is required.");
  }

  const token = crypto.randomBytes(32).toString("hex");

  store.password_tokens[token] = {
    email: clean,
    created_at: now(),
    expires_at: Date.now() + PASSWORD_SETUP_TOKEN_TTL_MS
  };

  return token;
}

function passwordSetupUrl(token) {
  return `${APP_URL}/thankyou-referral-dashboard.html?set_password_token=${encodeURIComponent(token)}`;
}

function setCustomerPassword(store, options = {}) {
  const email = cleanEmail(options.email);
  const password = String(options.password || "");
  const currentPassword = String(options.currentPassword || "");
  const requireCurrentPasswordIfAlreadySet = options.requireCurrentPasswordIfAlreadySet !== false;

  if (!email) {
    return { ok: false, status: 400, error: "Enter a valid email." };
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
    };
  }

  const customer = store.customers?.[email];

  if (!customer) {
    return { ok: false, status: 404, error: "No Monaco booking was found for this email." };
  }

  if (!isPaidCustomer(store, email)) {
    return {
      ok: false,
      status: 403,
      error: "This email is not connected to a paid Monaco booking yet."
    };
  }

  if (
    requireCurrentPasswordIfAlreadySet &&
    customer.password_hash &&
    !verifyPassword(currentPassword, customer.password_hash)
  ) {
    return {
      ok: false,
      status: 401,
      error: "Enter your current password before changing it."
    };
  }

  customer.password_hash = hashPassword(password);
  customer.password_set_at = customer.password_set_at || now();
  customer.password_updated_at = now();
  customer.updated_at = now();

  store.customers[email] = customer;
  writeStore(store);

  return { ok: true, store, customer };
}
function isPaidCustomer(store, email) {
  const clean = cleanEmail(email);
  const customer = store.customers?.[clean];

  if (!customer) return false;

  if (customer.status === "paid") return true;

  const session = store.checkout_sessions?.[customer.checkout_session_id];

  return session?.payment_status === "paid" || session?.status === "paid";
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const hash = crypto
    .pbkdf2Sync(
      String(password),
      salt,
      PASSWORD_HASH_ITERATIONS,
      PASSWORD_HASH_KEYLEN,
      PASSWORD_HASH_DIGEST
    )
    .toString("hex");

  return [
    "pbkdf2",
    PASSWORD_HASH_DIGEST,
    PASSWORD_HASH_ITERATIONS,
    salt,
    hash
  ].join("$");
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");

  if (parts.length !== 5) return false;

  const [method, digest, iterationsRaw, salt, expectedHash] = parts;

  if (method !== "pbkdf2") return false;

  const iterations = Number(iterationsRaw);

  if (!iterations || !salt || !expectedHash) return false;

  const actualHash = crypto
    .pbkdf2Sync(
      String(password),
      salt,
      iterations,
      Buffer.from(expectedHash, "hex").length,
      digest
    )
    .toString("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(actualHash, "hex"),
      Buffer.from(expectedHash, "hex")
    );
  } catch {
    return false;
  }
}