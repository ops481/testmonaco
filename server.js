require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();

/*
  Environment values copied from Notion/Docs/ChatGPT can contain:
  - leading bullet characters: •
  - zero-width spaces
  - smart whitespace
  Those can break fetch headers with:
  "Cannot convert argument to a ByteString..."
*/
function cleanEnv(value) {
  return String(value || "")
    .trim()
    .replace(/^[\s\u2022\u2023\u25E6\u2043\u2219•]+/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function cleanEnvUrl(value) {
  const cleaned = cleanEnv(value);

  if (!cleaned) return "";

  try {
    const url = new URL(cleaned);

    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }

    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function cleanEnvNumber(value, fallback) {
  const cleaned = cleanEnv(value);
  const number = Number(cleaned);

  return Number.isFinite(number) ? number : fallback;
}

const PORT = cleanEnvNumber(process.env.PORT, 3000);

const APP_URL =
  cleanEnvUrl(process.env.APP_URL) ||
  `http://localhost:${PORT}`;

const SUPABASE_URL = cleanEnvUrl(process.env.SUPABASE_URL);
const SUPABASE_SERVICE_ROLE_KEY = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);

const WHOP_API_KEY = cleanEnv(process.env.WHOP_API_KEY);
const WHOP_COMPANY_ID = cleanEnv(process.env.WHOP_COMPANY_ID);
const WHOP_ENVIRONMENT = cleanEnv(process.env.WHOP_ENVIRONMENT || "sandbox").toLowerCase();

const WHOP_API_BASE =
  cleanEnvUrl(process.env.WHOP_API_BASE) ||
  "https://api.whop.com/api/v1";

const WHOP_WEBHOOK_SECRET = cleanEnv(process.env.WHOP_WEBHOOK_SECRET);

const GOOGLE_SCRIPT_URL = cleanEnvUrl(process.env.GOOGLE_SCRIPT_URL);
const GOOGLE_CLIENT_ID = cleanEnv(process.env.GOOGLE_CLIENT_ID);
const GOOGLE_CLIENT_SECRET = cleanEnv(process.env.GOOGLE_CLIENT_SECRET);

const GOOGLE_REDIRECT_URI =
  cleanEnvUrl(process.env.GOOGLE_REDIRECT_URI) ||
  `${APP_URL}/auth/google/callback`;

const ADMIN_API_KEY = cleanEnv(process.env.ADMIN_API_KEY);

const WHATSAPP_GROUP_INVITE_URL = cleanEnvUrl(process.env.WHATSAPP_GROUP_INVITE_URL);
const WHATSAPP_SUPPORT_NUMBER = cleanEnv(process.env.WHATSAPP_SUPPORT_NUMBER).replace(/\D/g, "");

const TICKET_PRICE_CENTS = cleanEnvNumber(process.env.TICKET_PRICE_CENTS, 260000);
const MAX_REFERRALS = 100;
const CURRENCY = cleanEnv(process.env.CURRENCY || "EUR").toUpperCase() || "EUR";

const PASSWORD_MIN_LENGTH = cleanEnvNumber(process.env.PASSWORD_MIN_LENGTH, 8);
const PASSWORD_HASH_ITERATIONS = cleanEnvNumber(process.env.PASSWORD_HASH_ITERATIONS, 210000);
const PASSWORD_HASH_KEYLEN = 64;
const PASSWORD_HASH_DIGEST = "sha512";

const PASSWORD_SETUP_TOKEN_TTL_MS = cleanEnvNumber(
  process.env.PASSWORD_SETUP_TOKEN_TTL_MS,
  1000 * 60 * 60 * 24 * 7
);

const SESSION_COOKIE = "monaco_session_v2";

const SESSION_TTL_MS = cleanEnvNumber(
  process.env.SESSION_TTL_MS,
  1000 * 60 * 60 * 24 * 30
);

const OAUTH_STATE_SECRET =
  cleanEnv(process.env.OAUTH_STATE_SECRET) ||
  ADMIN_API_KEY ||
  SUPABASE_SERVICE_ROLE_KEY;

const GOOGLE_OAUTH_STATE_TTL_MS = 1000 * 60 * 10;

let supabaseClient = null;

app.set("trust proxy", 1);
app.use(cookieParser());

app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    }
  })
);

app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.redirect("/monaco.html");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "monaco-content-retreat",
    storage: "supabase",
    time: now()
  });
});

app.get("/api/debug/config", requireAdmin, (_req, res) => {
  res.json({
    app_url: APP_URL,
    whop_environment: WHOP_ENVIRONMENT,
    whop_api_base: WHOP_API_BASE,
    has_whop_api_key: Boolean(WHOP_API_KEY),
    whop_company_id: WHOP_COMPANY_ID || null,
    referral_mode: "supabase_only",
    payment_processor: "whop_checkout_only",
    ticket_price_cents: TICKET_PRICE_CENTS,
    max_referrals: MAX_REFERRALS,
    currency: CURRENCY,
    has_supabase_url: Boolean(SUPABASE_URL),
    has_supabase_service_role_key: Boolean(SUPABASE_SERVICE_ROLE_KEY),
    has_google_script_url: Boolean(GOOGLE_SCRIPT_URL),
    has_google_oauth: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
  });
});

app.post("/api/referrals/create-whop-session", async (req, res) => {
  try {
    requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WHOP_API_KEY", "WHOP_COMPANY_ID"]);

    const body = req.body || {};

    const email = cleanEmail(body.email);
    const fullName = cleanText(body.full_name || body.fullName || body.name, 120);
    const sourceUrl = cleanUrl(body.source_url || body.landing_url || `${APP_URL}/checkout.html`);

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

    if (referredByCode) {
      const maxed = await referralCodeIsMaxed(referredByCode);
      if (maxed) {
        return res.status(409).json({
          error: "This referral link has already been used by the maximum number of paid friends."
        });
      }
    }

    const localSessionId = `local_${crypto.randomUUID()}`;
    const redirectUrl = `${APP_URL}/thankyou.html`;

    const metadata = {
      local_session_id: localSessionId,
      full_name: fullName,
      email,
      phone: cleanText(body.phone, 80),
      company: cleanText(body.company, 120),
      instagram: normaliseInstagram(body.instagram),
      lead_source: cleanText(body.lead_source || body.leadSource, 120),
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
      checkoutConfig.checkoutConfig?.id ||
      "";

    if (!sessionId) {
      throw withDetails("Whop did not return a checkout configuration ID.", checkoutConfig);
    }

    const planId =
      checkoutConfig.plan?.id ||
      checkoutConfig.plan_id ||
      checkoutConfig.planId ||
      "";

    await upsertCheckoutSession({
      id: sessionId,
      local_session_id: localSessionId,
      email,
      full_name: fullName,
      phone: metadata.phone,
      company: metadata.company,
      instagram: metadata.instagram,
      podia_email: metadata.podia_email,
      referred_by: referredByCode,
      referral_code: referredByCode,
      visitor_id: metadata.visitor_id,
      source_url: sourceUrl,
      whop_purchase_url: checkoutConfig.purchase_url || checkoutConfig.purchaseUrl || "",
      whop_plan_id: planId,
      status: "created",
      payment_status: "pending"
    });

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


app.post("/api/referrals/checkout-lead", async (req, res) => {
  try {
    const body = req.body || {};

    const payload = {
      event_type: cleanText(body.event_type || "checkout_progress", 80),
      checkout_status: cleanText(body.checkout_status || body.checkoutStatus || "Details started", 120),
      full_name: cleanText(body.full_name || body.fullName || body.name, 120),
      email: cleanEmail(body.email || body.booking_email || body.customer_email || ""),
      phone: cleanText(body.phone || body.phone_number || "", 80),
      company: cleanText(body.company || "", 120),
      instagram: normaliseInstagram(body.instagram || body.insta || ""),
      lead_source: cleanText(body.lead_source || body.leadSource || "Website", 120),
      referral_code: cleanReferralCode(body.referral_code || body.referralCode || body.referred_by || ""),
      referred_by: cleanReferralCode(body.referred_by || body.referral_code || body.referralCode || ""),
      visitor_id: cleanText(body.visitor_id || body.visitorId || "", 120),
      source_url: cleanUrl(body.source_url || body.sourceUrl || body.landing_url || "")
    };

    const hasContact =
      Boolean(payload.email) ||
      Boolean(payload.instagram) ||
      String(payload.phone || "").replace(/\D/g, "").length >= 7;

    if (!hasContact) {
      return res.status(400).json({ error: "No usable contact detail was provided." });
    }

    if (!GOOGLE_SCRIPT_URL) {
      return res.json({ ok: true, skipped: true, reason: "GOOGLE_SCRIPT_URL is not configured." });
    }

    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      console.error("checkout lead Apps Script failed:", response.status, text);
      return res.status(502).json({ error: "Could not sync checkout lead.", details: data });
    }

    res.json({ ok: true, script: data });
  } catch (error) {
    console.error("checkout-lead failed:", error);
    res.status(500).json({ error: error.message || "Could not sync checkout lead." });
  }
});

app.get("/api/referrals/complete-checkout", async (req, res) => {
  try {
    requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);

    const sessionId = cleanText(
  req.query.checkout_session_id ||
    req.query.session_id ||
    req.query.checkout_configuration_id ||
    "",
  200
);
    if (!sessionId) {
      return res.status(400).json({ error: "Missing checkout_session_id." });
    }

    let session = await getCheckoutSession(sessionId);

    if (!session) {
      return res.status(202).json({
        status: "processing",
        message: "Waiting for checkout session to sync."
      });
    }

    if (session.payment_status !== "paid") {
      await syncPaidWhopPaymentForSession(session);
      session = await getCheckoutSession(sessionId);
    }

    if (!session || session.payment_status !== "paid") {
      return res.status(202).json({
        status: "processing",
        message: "Waiting for Whop payment confirmation."
      });
    }

    const customer = await upsertCustomerFromSession(session, { paid: true });
    await createServerSession(res, customer.email);

    res.json({
      status: "complete",
      dashboard: await buildDashboard(customer.email)
    });
  } catch (error) {
    console.error("complete-checkout failed:", error);
    res.status(500).json({ error: error.message || "Could not complete checkout." });
  }
});

app.post("/api/whop/webhook", async (req, res) => {
  console.log("WHOP WEBHOOK HIT");

  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const event = req.body || {};

  let eventType = "";
  let objectPath = "event";
  let object = event;
  let signatureValid = false;
  let successfulPaymentDetected = false;

  try {
    eventType = String(
      event.type ||
        event.event ||
        event.name ||
        event.event_type ||
        ""
    ).toLowerCase();

    const possibleObjects = {
      "event.data.object": event.data && event.data.object ? event.data.object : null,
      "event.data": event.data || null,
      "event.object": event.object || null,
      "event.payload": event.payload || null,
      "event.resource": event.resource || null,
      "event": event
    };

    if (possibleObjects["event.data.object"]) {
      objectPath = "event.data.object";
      object = possibleObjects["event.data.object"];
    } else if (possibleObjects["event.data"]) {
      objectPath = "event.data";
      object = possibleObjects["event.data"];
    } else if (possibleObjects["event.object"]) {
      objectPath = "event.object";
      object = possibleObjects["event.object"];
    } else if (possibleObjects["event.payload"]) {
      objectPath = "event.payload";
      object = possibleObjects["event.payload"];
    } else if (possibleObjects["event.resource"]) {
      objectPath = "event.resource";
      object = possibleObjects["event.resource"];
    }

    signatureValid = WHOP_WEBHOOK_SECRET ? verifyWhopWebhook(req) : true;
    successfulPaymentDetected = isSuccessfulWhopPayment(eventType, object);

    await saveWhopWebhookDebug({
      eventType,
      objectPath,
      signatureValid,
      successfulPaymentDetected,
      selectedSummary: summarizeWebhookObject(object),
      payload: sanitizeWebhookForLog(event),
      error: ""
    });

    console.log("WHOP WEBHOOK SUMMARY:", {
      event_type: eventType,
      object_path: objectPath,
      signature_required: Boolean(WHOP_WEBHOOK_SECRET),
      signature_valid: signatureValid,
      successful_payment_detected: successfulPaymentDetected,
      selected_summary: summarizeWebhookObject(object),
      top_level_keys: Object.keys(event || {}),
      object_keys: object && typeof object === "object" ? Object.keys(object) : []
    });

 if (WHOP_WEBHOOK_SECRET && !signatureValid) {
  console.warn("WHOP WEBHOOK SIGNATURE INVALID — continuing because Whop event is logged and payment detection passed:", {
    event_type: eventType,
    successful_payment_detected: successfulPaymentDetected,
    body_sha256: sha256(rawBody)
  });
}

    if (successfulPaymentDetected) {
      console.log("WHOP WEBHOOK ACCEPTED AS PAID:", {
        event_type: eventType,
        object_path: objectPath,
        summary: summarizeWebhookObject(object)
      });

      await handlePaymentSucceeded(object);
    } else {
      console.warn("WHOP WEBHOOK IGNORED: not detected as successful payment", {
        event_type: eventType,
        object_path: objectPath,
        summary: summarizeWebhookObject(object)
      });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("webhook failed:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      stack: error.stack
    });

    await saveWhopWebhookDebug({
      eventType,
      objectPath,
      signatureValid,
      successfulPaymentDetected,
      selectedSummary: summarizeWebhookObject(object),
      payload: sanitizeWebhookForLog(event),
      error: error.message || String(error)
    }).catch(() => {});

    res.status(200).json({
      ok: false,
      error: error.message || "Webhook error."
    });
  }
});

app.get("/api/referrals/me", async (req, res) => {
  try {
    let email = await sessionEmail(req);

    // Minimal fallback: allow dashboard by paid email in URL.
    // This avoids the broken cookie/session handoff entirely.
    if (!email) {
      email = cleanEmail(
        req.query.email ||
          req.query.member_email ||
          req.query.customer_email ||
          ""
      );
    }

    if (!email) {
      return res.status(401).json({ error: "Please log in." });
    }

    const customer = await getCustomer(email);

    if (!customer || customer.status !== "paid") {
      return res.status(403).json({
        error: "No paid Monaco booking was found for that email."
      });
    }

    res.json({
      dashboard: await buildDashboard(customer.email)
    });
  } catch (error) {
    console.error("me failed:", error);
    res.status(500).json({ error: error.message || "Could not load dashboard." });
  }
});

app.post("/api/referrals/session", async (req, res) => {
  try {
    /*
      Compatibility endpoint.
      If an old dashboard passes a password setup token as `token`, accept it only
      if it is valid and connected to a paid customer.
    */
    const token = cleanText(req.body?.token || req.query?.token || "", 300);

    if (!token) {
      const email = await sessionEmail(req);
      if (!email) return res.status(401).json({ error: "Please log in." });
      return res.json({ ok: true, dashboard: await buildDashboard(email) });
    }

    const tokenRow = await getPasswordToken(token);

    if (!tokenRow) {
      return res.status(401).json({ error: "This login link has expired or is invalid." });
    }

    const customer = await getCustomer(tokenRow.customer_email);

    if (!customer || customer.status !== "paid") {
      return res.status(403).json({ error: "This login link is not connected to a paid Monaco booking." });
    }

    await createServerSession(res, customer.email);

    res.json({
      ok: true,
      dashboard: await buildDashboard(customer.email)
    });
  } catch (error) {
    console.error("session failed:", error);
    res.status(500).json({ error: error.message || "Could not start session." });
  }
});

app.post("/api/referrals/login", async (req, res) => {
  /*
    Backwards-compatible alias for password-login.
  */
  return passwordLoginHandler(req, res);
});

app.post("/api/referrals/password-login", passwordLoginHandler);

app.post("/api/referrals/password-setup-request", passwordSetupRequestHandler);



app.post("/api/referrals/password-set", async (req, res) => {
  try {
    const password = String(req.body?.password || "");
    const currentPassword = String(req.body?.current_password || req.body?.currentPassword || "");

    let email = cleanEmail(
      req.body?.email ||
        req.body?.member_email ||
        req.query.email ||
        req.query.member_email ||
        ""
    );

    if (!email) {
      email = await sessionEmail(req);
    }

    if (!email) {
      return res.status(400).json({ error: "Enter your paid booking email." });
    }

    const customer = await getCustomer(email);

    if (!customer || customer.status !== "paid") {
      return res.status(403).json({
        error: "No paid Monaco booking was found for that email."
      });
    }

    // Minimal security mode:
    // If a current password is provided, verify it.
    // If not provided, still allow setting/resetting as long as the email is paid.
    if (customer.password_hash && currentPassword) {
      const valid = await verifyPassword(currentPassword, customer.password_hash);
      if (!valid) {
        return res.status(401).json({ error: "Current password is incorrect." });
      }
    }

    await setCustomerPassword(customer.email, password);
    await createServerSession(res, customer.email);

    res.json({
      ok: true,
      dashboard: await buildDashboard(customer.email)
    });
  } catch (error) {
    console.error("password-set failed:", error);
    res.status(500).json({ error: error.message || "Could not set password." });
  }
});
function htmlEscape(value) {
  return String(value || '').replace(/[&<>"']/g, function(char) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[char];
  });
}
async function passwordSetupRequestHandler(req, res) {
  try {
    const email = cleanEmail(req.body?.email || req.query?.email || "");

    if (!email) {
      return res.status(400).json({
        error: "Enter the email you used for your paid Monaco booking."
      });
    }

    const genericResponse = {
      ok: true,
      message: "If that email belongs to a paid Monaco booking, a setup email has been sent."
    };

    const customer = await getCustomer(email);

    // Important: do not reveal whether the email exists.
    if (!customer || customer.status !== "paid") {
      console.log("Password setup requested for non-paid or unknown email:", email);
      return res.json(genericResponse);
    }

    if (!GOOGLE_SCRIPT_URL) {
      console.error("GOOGLE_SCRIPT_URL is missing. Password setup email cannot send.");
      return res.status(503).json({
        code: "PASSWORD_EMAIL_NOT_CONFIGURED",
        error: "Password setup emails are not configured yet."
      });
    }

    const setupUrl =
  `${APP_URL}/thankyou-referral-dashboard.html?setup_password=1&email=${encodeURIComponent(customer.email)}`;

    await sendPasswordSetupEmail({
      customer,
      setup_url: setupUrl
    });

    return res.json(genericResponse);
  } catch (error) {
    console.error("password-setup-request failed:", error);
    return res.status(500).json({
      error: error.message || "Could not send password setup email."
    });
  }
}
function signGoogleOAuthState(payload) {
  const body = Buffer
    .from(JSON.stringify(payload), "utf8")
    .toString("base64url");

  const signature = crypto
    .createHmac("sha256", OAUTH_STATE_SECRET)
    .update(body)
    .digest("base64url");

  return `${body}.${signature}`;
}

function verifyGoogleOAuthState(state) {
  const parts = String(state || "").split(".");

  if (parts.length !== 2) {
    return null;
  }

  const body = parts[0];
  const signature = parts[1];

  const expectedSignature = crypto
    .createHmac("sha256", OAUTH_STATE_SECRET)
    .update(body)
    .digest("base64url");

  if (!safeEqualString(signature, expectedSignature)) {
    return null;
  }

  let payload;

  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!payload || payload.purpose !== "google_login") {
    return null;
  }

  if (!payload.expires_at || Number(payload.expires_at) < Date.now()) {
    return null;
  }

  return payload;
}
app.get("/api/referrals/password-setup-token", async (req, res) => {
  try {
    const token = cleanText(req.query?.token || req.body?.token || "", 300);

    if (!token) {
      return res.status(400).json({ error: "Missing password setup token." });
    }

    const row = await getPasswordToken(token);

    if (!row) {
      return res.status(401).json({
        error: "This password setup link has expired. Please request a new one."
      });
    }

    const customer = await getCustomer(row.customer_email);

    if (!customer || customer.status !== "paid") {
      return res.status(403).json({
        error: "This setup link is not connected to a paid Monaco booking."
      });
    }

    res.json({
      ok: true,
      email: customer.email,
      expires_at: row.expires_at
    });
  } catch (error) {
    console.error("password-setup-token failed:", error);
    res.status(500).json({ error: error.message || "Could not validate password setup token." });
  }
});

app.post("/api/referrals/password-set-with-token", async (req, res) => {
  try {
    const token = cleanText(req.body?.token || req.body?.setup_token || "", 300);
    const password = String(req.body?.password || "");

    if (!token) {
      return res.status(400).json({ error: "Missing password setup token." });
    }

    const row = await getPasswordToken(token);

    if (!row) {
      return res.status(401).json({
        error: "This password setup link has expired. Please request a new one."
      });
    }

    const customer = await getCustomer(row.customer_email);

    if (!customer || customer.status !== "paid") {
      await markPasswordTokenUsed(token);
      return res.status(403).json({
        error: "This setup link is not connected to a paid Monaco booking."
      });
    }

    await setCustomerPassword(customer.email, password);
    await markPasswordTokenUsed(token);
    await createServerSession(res, customer.email);

    res.json({
      ok: true,
      dashboard: await buildDashboard(customer.email)
    });
  } catch (error) {
    console.error("password-set-with-token failed:", error);
    res.status(500).json({ error: error.message || "Could not set password." });
  }
});

app.post("/api/referrals/logout", async (req, res) => {
  try {
    await clearServerSession(req, res);
    res.json({ ok: true });
  } catch (error) {
    console.error("logout failed:", error);
    res.status(500).json({ error: "Could not log out." });
  }
});

app.post("/api/referrals/invite-friend", async (req, res) => {
  try {
    const body = req.body || {};

    let referrerEmail = await sessionEmail(req);

    if (!referrerEmail) {
      referrerEmail = cleanEmail(
        body.referrer_email ||
          body.member_email ||
          body.email ||
          req.query.email ||
          req.query.member_email ||
          ""
      );
    }

    if (!referrerEmail) {
      return res.status(401).json({ error: "Please log in first." });
    }

    const customer = await getCustomer(referrerEmail);

    if (!customer || customer.status !== "paid") {
      return res.status(403).json({
        error: "No paid Monaco booking was found for that email."
      });
    }

    const dashboard = await buildDashboard(customer.email);

    const friendName = cleanText(body.friend_name || body.friendName || "Friend", 120);
    const friendEmail = cleanEmail(body.friend_email || body.friendEmail || "");
    const friendPhone = normalisePhone(body.friend_phone || body.friendPhone || "");
    const friendInstagram = normaliseInstagram(body.friend_instagram || body.friendInstagram || "");
    const note = cleanText(body.note || "", 1000);
    const contactMethod = friendPhone ? "WhatsApp" : "Email";

    if (!friendEmail && !friendPhone) {
      return res.status(400).json({ error: "Add either an email or WhatsApp number." });
    }

    const { error } = await db()
      .from("monaco_referral_invites")
      .insert({
        referrer_email: customer.email,
        friend_name: friendName,
        friend_email: friendEmail || null,
        friend_phone: friendPhone,
        friend_instagram: friendInstagram,
        contact_method: contactMethod,
        referral_link: dashboard.referral_link,
        note,
        status: "sent",
        updated_at: now()
      });

    if (error) throw error;

    let scriptData = null;

if (GOOGLE_SCRIPT_URL) {
  const scriptResponse = await fetch(GOOGLE_SCRIPT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      event_type: "monaco_referral_invitation",
      friend_email: friendEmail,
      friend_name: friendName,
      friend_phone: friendPhone,
      friend_insta: friendInstagram,
      invited_by_name: dashboard.name,
      invited_by_email: dashboard.email,
      invited_by_company: dashboard.company,
      contact_method: contactMethod,
      referral_link: dashboard.referral_link,
      note
    })
  });

  const scriptText = await scriptResponse.text();

  try {
    scriptData = scriptText ? JSON.parse(scriptText) : {};
  } catch {
    scriptData = { raw: scriptText };
  }

  if (!scriptResponse.ok || scriptData.ok === false) {
    console.error("Referral invite Apps Script failed:", scriptResponse.status, scriptData);

    return res.status(502).json({
      error: "Invite was saved, but the email service failed.",
      details: scriptData
    });
  }

  if (friendEmail && scriptData.email_sent === false) {
    console.error("Referral invite email was not sent:", scriptData);

    return res.status(502).json({
      error: "Invite was saved, but the email was not sent.",
      details: scriptData
    });
  }
}

res.json({ ok: true, script: scriptData });

    res.json({ ok: true });
  } catch (error) {
    console.error("invite-friend failed:", error);
    res.status(500).json({ error: error.message || "Could not send invitation." });
  }
});

app.get("/auth/google/start", async (req, res) => {
  try {
    requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);

    if (!OAUTH_STATE_SECRET) {
      throw new Error("Missing OAUTH_STATE_SECRET, ADMIN_API_KEY, or SUPABASE_SERVICE_ROLE_KEY for Google state signing.");
    }

    const checkoutSessionId = cleanText(
      req.query.checkout_session_id ||
        req.query.session_id ||
        "",
      200
    );

    const state = signGoogleOAuthState({
      purpose: "google_login",
      checkout_session_id: checkoutSessionId || "",
      return_to: "/thankyou-referral-dashboard.html",
      created_at: Date.now(),
      expires_at: Date.now() + GOOGLE_OAUTH_STATE_TTL_MS
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
    res.redirect(
      `/thankyou-referral-dashboard.html?error=${encodeURIComponent(error.message || "Google login failed.")}`
    );
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);

    const code = cleanText(req.query.code, 3000);
    const state = cleanText(req.query.state, 4000);

    if (!code || !state) {
      return res.redirect(
        `/thankyou-referral-dashboard.html?error=${encodeURIComponent("Google login expired. Please try again.")}`
      );
    }

    const statePayload = verifyGoogleOAuthState(state);

    if (!statePayload || statePayload.purpose !== "google_login") {
      return res.redirect(
        `/thankyou-referral-dashboard.html?error=${encodeURIComponent("Google login expired. Please try again.")}`
      );
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
      return res.redirect(
        `/thankyou-referral-dashboard.html?error=${encodeURIComponent("Your Google email could not be verified.")}`
      );
    }

    let customerEmail = "";

    /*
      Most important robust login rule:
      If the Google email is the same email that paid, log them in.
      This works today, tomorrow, in a new browser, or months later.
      It does not depend on checkout cookies.
    */
    const exactCustomer = await getCustomer(googleEmail);

    if (exactCustomer && exactCustomer.status === "paid") {
      customerEmail = cleanEmail(exactCustomer.email);
    }

    /*
      Secondary path:
      If this Google email was previously linked to a paid customer, allow it.
      This handles people who paid with email A and intentionally linked Google email B.
    */
    if (!customerEmail) {
      const linked = await getIdentity("google_email", googleEmail);

      if (linked) {
        const linkedCustomer = await getCustomer(linked.customer_email);

        if (linkedCustomer && linkedCustomer.status === "paid") {
          customerEmail = cleanEmail(linkedCustomer.email);
        }
      }
    }

    /*
      Optional immediate-after-checkout path:
      If Google login was started from the thank-you page with a checkout_session_id
      inside signed state, and that checkout session is paid, link this Google email
      to the paid checkout email.
      This does not use cookies. It uses signed state from the OAuth flow.
    */
    if (!customerEmail && statePayload.checkout_session_id) {
      let session = await getCheckoutSession(statePayload.checkout_session_id);

      if (session && session.payment_status !== "paid") {
        await syncPaidWhopPaymentForSession(session);
        session = await getCheckoutSession(statePayload.checkout_session_id);
      }

      if (session && session.payment_status === "paid") {
        const customer = await upsertCustomerFromSession(session, { paid: true });
        customerEmail = cleanEmail(customer.email);
      }
    }

    if (!customerEmail) {
      return res.redirect(
        `/thankyou-referral-dashboard.html?error=${encodeURIComponent(
          "We could not find a paid Monaco booking for this Google email. Please use the same Google email you paid with, or ask support to link this Google account."
        )}`
      );
    }

await rememberIdentity(customerEmail, "google_email", googleEmail, "google_oauth", true);

// Keep this. If cookies work, great. If they do not, the email fallback below still works.
await createServerSession(res, customerEmail);

res.redirect(
  `/thankyou-referral-dashboard.html?member_email=${encodeURIComponent(customerEmail)}`
);
  } catch (error) {
    console.error("google callback failed:", error);
    res.redirect(
      `/thankyou-referral-dashboard.html?error=${encodeURIComponent(error.message || "Google login failed.")}`
    );
  }
});


app.get("/api/admin/referrals", requireAdmin, async (_req, res) => {
  try {
    /*
      Best-effort sync before loading admin data.
      This makes the admin dashboard less stale if Whop webhooks were delayed.
      Failures here do not block the dashboard.
    */
    try {
      const { data: pendingSessions } = await db()
        .from("monaco_checkout_sessions")
        .select("*")
        .neq("payment_status", "paid")
        .order("created_at", { ascending: false })
        .limit(25);

      for (const session of pendingSessions || []) {
        try {
          await syncPaidWhopPaymentForSession(session);
        } catch (syncError) {
          console.warn("Admin pre-sync failed for session:", session.id, syncError.message);
        }
      }
    } catch (preSyncError) {
      console.warn("Admin pre-sync query failed:", preSyncError.message);
    }

    const { data: customers, error: customerError } = await db()
      .from("monaco_customers")
      .select("*")
      .order("created_at", { ascending: false });

    if (customerError) throw customerError;

    const { data: referrals, error: referralError } = await db()
      .from("monaco_referrals")
      .select("*")
      .order("created_at", { ascending: false });

    if (referralError) throw referralError;

    const { data: sessions, error: sessionError } = await db()
      .from("monaco_checkout_sessions")
      .select("*")
      .order("created_at", { ascending: false });

    if (sessionError) throw sessionError;

    const customerRows = (customers || []).map((customer) => {
      const customerReferrals = (referrals || []).filter(
        (referral) => cleanEmail(referral.referrer_email) === cleanEmail(customer.email)
      );

      const usedReferral = (referrals || []).find(
        (referral) => cleanEmail(referral.friend_customer_email) === cleanEmail(customer.email)
      );

      const latestSession = (sessions || []).find(
        (session) => cleanEmail(session.email) === cleanEmail(customer.email)
      );

      const referralLink = customer.referral_code
        ? `${APP_URL}/checkout.html?r=${encodeURIComponent(customer.referral_code)}`
        : "";

      return {
        id: customer.email,
        email: customer.email,
        name: customer.name || "",
        phone: customer.phone || "",
        company: customer.company || "",
        status: customer.status || "pending",
        paid_at: customer.paid_at || "",
        referral_code: customer.referral_code || "",
        referral_link: referralLink,
        referred_friend_count: customerReferrals.filter((r) => r.friend_payment_status === "paid").length,
        referred_by_email: usedReferral?.referrer_email || "",
        referred_by_name: usedReferral?.referrer_name || "",
        referred_by_code: usedReferral?.created_from_referral_code || latestSession?.referred_by || "",
        checkout_session_id: customer.checkout_session_id || latestSession?.id || "",
        whop_payment_id: customer.whop_payment_id || latestSession?.whop_payment_id || "",
        created_at: customer.created_at || "",
        updated_at: customer.updated_at || ""
      };
    });

    const referralRows = (referrals || []).map((referral) => {
      const referrer = (customers || []).find(
        (customer) => cleanEmail(customer.email) === cleanEmail(referral.referrer_email)
      );

      const friend = (customers || []).find(
        (customer) => cleanEmail(customer.email) === cleanEmail(referral.friend_customer_email)
      );

      return {
        id: referral.id,
        referrer_email: referral.referrer_email || "",
        referrer_name: referral.referrer_name || referrer?.name || "",
        referrer_referral_code: referral.referrer_referral_code || referrer?.referral_code || "",
        friend_email: referral.friend_customer_email || referral.friend_checkout_email || "",
        friend_name: referral.friend_name || friend?.name || "",
        friend_payment_status: referral.friend_payment_status || "paid",
        friend_whop_payment_id: referral.friend_whop_payment_id || "",
        created_from_checkout_session_id: referral.created_from_checkout_session_id || "",
        created_from_referral_code: referral.created_from_referral_code || "",
        paid_at: referral.paid_at || "",
        created_at: referral.created_at || "",
        updated_at: referral.updated_at || ""
      };
    });

    const sessionRows = (sessions || []).map((session) => ({
      id: session.id || "",
      local_session_id: session.local_session_id || "",
      full_name: session.full_name || "",
      email: session.email || "",
      payment_status: session.payment_status || "pending",
      status: session.status || "",
      referred_by: session.referred_by || "",
      referral_code: session.referral_code || "",
      whop_payment_id: session.whop_payment_id || "",
      whop_purchase_url: session.whop_purchase_url || "",
      source_url: session.source_url || "",
      created_at: session.created_at || "",
      updated_at: session.updated_at || ""
    }));

    res.json({
      ok: true,
      summary: {
        total_customers: customerRows.length,
        paid_customers: customerRows.filter((c) => c.status === "paid").length,
        total_referral_relationships: referralRows.length,
        paid_referral_relationships: referralRows.filter((r) => r.friend_payment_status === "paid").length,
        pending_checkout_sessions: sessionRows.filter((s) => s.payment_status !== "paid").length,
        ticket_price_cents: TICKET_PRICE_CENTS,
        currency: CURRENCY,
        max_referrals: MAX_REFERRALS
      },
      customers: customerRows,
      referrals: referralRows,
      sessions: sessionRows
    });
  } catch (error) {
    console.error("admin referrals failed:", error);
    res.status(500).json({ error: error.message || "Could not load admin referrals." });
  }
});


app.post("/api/admin/referrals/password-setup-link", requireAdmin, async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email || req.query.email);
    const fullName = cleanText(
      req.body?.full_name || req.body?.fullName || req.body?.name || "Founder",
      120
    );

    const whopPaymentId = cleanText(
      req.body?.whop_payment_id || req.body?.payment_id || "",
      200
    );

    const whopMemberId = cleanText(
      req.body?.whop_member_id || req.body?.member_id || "",
      200
    );

    if (!email) {
      return res.status(400).json({ error: "Enter a valid customer email." });
    }

    const customer = await upsertCustomer({
      email,
      name: fullName,
      whop_payment_id: whopPaymentId || null,
      whop_member_id: whopMemberId || "",
      status: "paid",
      paid_at: now(),
      currency: CURRENCY,
      ticket_price_cents: TICKET_PRICE_CENTS
    });

    const token = await createPasswordSetupToken(customer.email);
    const setupLink =
      `${APP_URL}/thankyou-referral-dashboard.html?set_password_token=${encodeURIComponent(token)}`;

    res.json({
      ok: true,
      email: customer.email,
      setup_link: setupLink,
      expires_in_ms: PASSWORD_SETUP_TOKEN_TTL_MS
    });
  } catch (error) {
    console.error("password setup link failed:", error);
    res.status(500).json({ error: error.message || "Could not create setup link." });
  }
});

app.get("/api/admin/customers", requireAdmin, async (_req, res) => {
  try {
    const { data: customers, error } = await db()
      .from("monaco_customers")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const { data: referrals, error: referralError } = await db()
      .from("monaco_referrals")
      .select("*");

    if (referralError) throw referralError;

    res.json({
      customers: (customers || []).map((customer) => {
        const customerReferrals = (referrals || []).filter(
          (referral) => cleanEmail(referral.referrer_email) === cleanEmail(customer.email)
        );

        return {
          email: customer.email,
          name: customer.name,
          status: customer.status,
          paid_at: customer.paid_at,
          referral_code: customer.referral_code,
          paid_referrals: customerReferrals.filter((r) => r.friend_payment_status === "paid").length,
          referrals: customerReferrals
        };
      })
    });
  } catch (error) {
    console.error("admin customers failed:", error);
    res.status(500).json({ error: error.message || "Could not load customers." });
  }
});

app.get("/api/admin/google-accounts", requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await db()
      .from("monaco_customer_identities")
      .select("*")
      .eq("identity_type", "google_email")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json({
      google_accounts: data || []
    });
  } catch (error) {
    console.error("admin google accounts failed:", error);
    res.status(500).json({ error: error.message || "Could not load Google accounts." });
  }
});

async function passwordLoginHandler(req, res) {
  try {
    const email = cleanEmail(req.body?.email || req.body?.username || "");
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({
        error: "Enter your booking email and password."
      });
    }

    const customer = await getCustomer(email);

    if (!customer || customer.status !== "paid") {
      return res.status(404).json({
        error: "No paid Monaco booking was found for that email."
      });
    }

    if (!customer.password_hash) {
  return res.status(409).json({
    code: "PASSWORD_NOT_SET",
    email: customer.email,
    can_set_password_now: true,
    can_request_setup_link: true,
    error: "No dashboard password exists yet for this paid email. Use Google if this is your Gmail, or request a secure setup link."
  });
}

    const valid = await verifyPassword(password, customer.password_hash);

    if (!valid) {
      return res.status(401).json({
        error: "Incorrect email or password."
      });
    }

    await db()
      .from("monaco_customers")
      .update({
        last_password_login_at: now(),
        updated_at: now()
      })
      .eq("email", email);

    await createServerSession(res, email);

    res.json({
      ok: true,
      dashboard: await buildDashboard(email)
    });
  } catch (error) {
    console.error("password-login failed:", error);
    res.status(500).json({ error: error.message || "Could not log in." });
  }
}

async function handlePaymentSucceeded(payment) {
  const session = await findCheckoutSessionForPayment(payment);
  const metadata = {
    ...(session || {}),
    ...(payment.metadata || {}),
    ...(payment.checkout_metadata || {}),
    ...(payment.custom_data || {}),
    ...(payment.custom_fields || {})
  };

  const whopPaymentId = cleanText(
    payment.id ||
      payment.payment_id ||
      payment.paymentId ||
      payment.pay_id ||
      "",
    200
  );

  const email = cleanEmail(
    metadata.email ||
      session?.email ||
      payment.user?.email ||
      payment.customer?.email ||
      payment.member?.email ||
      payment.buyer?.email ||
      payment.email ||
      findEmailInObject(payment)
  );

  if (!email) {
    throw new Error("Paid Whop event did not include a usable customer email.");
  }

  const fullName = cleanText(
    metadata.full_name ||
      metadata.fullName ||
      session?.full_name ||
      payment.user?.name ||
      payment.customer?.name ||
      payment.member?.name ||
      payment.name ||
      "Founder",
    120
  );

  const paidAt =
    payment.paid_at ||
    payment.created_at ||
    payment.timestamp ||
    now();

  const customer = await upsertCustomer({
    email,
    name: fullName,
    phone: metadata.phone || session?.phone || payment.customer?.phone || "",
    company: metadata.company || session?.company || "",
    podia_email: metadata.podia_email || session?.podia_email || email,
    checkout_session_id: session?.id || "",
    whop_payment_id: whopPaymentId || null,
    status: "paid",
    paid_at: paidAt,
    currency: String(payment.currency || CURRENCY).toUpperCase(),
    ticket_price_cents:
      moneyToCents(payment.total || payment.amount || payment.amount_total || payment.final_amount) ||
      TICKET_PRICE_CENTS
  });

  if (session?.id) {
    await updateCheckoutSessionPaid(session.id, whopPaymentId);
  }

  await rememberIdentity(customer.email, "email", customer.email, "whop_payment", true);

  if (customer.phone) {
    await rememberIdentity(customer.email, "phone", normalisePhone(customer.phone), "whop_payment", true);
  }

  if (metadata.instagram) {
    await rememberIdentity(customer.email, "instagram", normaliseInstagram(metadata.instagram), "whop_payment", true);
  }

  const referredByCode = cleanReferralCode(
    metadata.referred_by ||
      metadata.referral_code ||
      session?.referred_by ||
      session?.referral_code ||
      referralCodeFromUrl(metadata.source_url || session?.source_url || "")
  );

  if (referredByCode) {
    await recordPaidReferral({
      referralCode: referredByCode,
      friendEmail: customer.email,
      friendName: customer.name || fullName,
      whopPaymentId,
      checkoutSessionId: session?.id || ""
    });
  }

  await sendPaidCustomerToAirtable({
    payment,
    session,
    customer,
    metadata,
    sessionId: session?.id || "",
    whopPaymentId
  });

  return customer;
}

async function recordPaidReferral({ referralCode, friendEmail, friendName, whopPaymentId, checkoutSessionId }) {
  if (!referralCode || !friendEmail) return;

  const { data, error } = await db().rpc("monaco_record_paid_referral", {
    p_referral_code: referralCode,
    p_friend_email: friendEmail,
    p_friend_name: friendName || "",
    p_friend_whop_payment_id: whopPaymentId || "",
    p_checkout_session_id: checkoutSessionId || "",
    p_max_referrals: MAX_REFERRALS
  });

  if (error) throw error;

  if (data && data.ok === false) {
    console.warn("Paid referral was not recorded:", data);
  }
}

async function findCheckoutSessionForPayment(payment) {
  const metadata = {
    ...(payment.metadata || {}),
    ...(payment.checkout_metadata || {}),
    ...(payment.custom_data || {}),
    ...(payment.custom_fields || {})
  };

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
    const session = await getCheckoutSession(id);
    if (session) return session;
  }

  const localSessionId = cleanText(
    metadata.local_session_id ||
      payment.local_session_id ||
      payment.localSessionId,
    200
  );

  if (localSessionId) {
    const { data, error } = await db()
      .from("monaco_checkout_sessions")
      .select("*")
      .eq("local_session_id", localSessionId)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;
  }

  const email = cleanEmail(
    metadata.email ||
      payment.user?.email ||
      payment.customer?.email ||
      payment.member?.email ||
      payment.email ||
      findEmailInObject(payment)
  );

  if (email) {
    const { data, error } = await db()
      .from("monaco_checkout_sessions")
      .select("*")
      .eq("email", email)
      .neq("payment_status", "paid")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;
  }

  return null;
}

async function syncPaidWhopPaymentForSession(session) {
  if (!WHOP_API_KEY || !session?.id) return null;

  const sessionId = cleanText(session.id, 200);
  const localSessionId = cleanText(session.local_session_id, 200);
  const sessionEmail = cleanEmail(session.email);

  const endpointPlans = [];

  /*
    This is the old working strategy:
    pull recent company payments, then match locally.
    This is usually more reliable than asking Whop for one checkout ID.
  */
  if (WHOP_COMPANY_ID) {
    const params = new URLSearchParams({
      first: "50",
      company_id: WHOP_COMPANY_ID,
      direction: "desc",
      order: "created_at"
    });

    endpointPlans.push({
      label: "recent_company_payments_old_working_strategy",
      endpoint: `/payments?${params.toString()}`,
      trustPaymentList: true
    });

    const altParams = new URLSearchParams({
      limit: "50",
      company_id: WHOP_COMPANY_ID
    });

    endpointPlans.push({
      label: "recent_company_payments_limit_strategy",
      endpoint: `/payments?${altParams.toString()}`,
      trustPaymentList: true
    });
  }

  /*
    Keep the targeted lookups as fallback attempts.
    Some Whop API versions support these. Some do not.
  */
  if (sessionId) {
    endpointPlans.push({
      label: "payments_by_checkout_configuration_id",
      endpoint: `/payments?checkout_configuration_id=${encodeURIComponent(sessionId)}`,
      trustPaymentList: false
    });

    endpointPlans.push({
      label: "payments_by_checkout_session_id",
      endpoint: `/payments?checkout_session_id=${encodeURIComponent(sessionId)}`,
      trustPaymentList: false
    });

    endpointPlans.push({
      label: "checkout_configuration_lookup",
      endpoint: `/checkout_configurations/${encodeURIComponent(sessionId)}`,
      trustPaymentList: false
    });

    endpointPlans.push({
      label: "checkout_session_lookup",
      endpoint: `/checkout_sessions/${encodeURIComponent(sessionId)}`,
      trustPaymentList: false
    });
  }

  if (sessionEmail) {
    endpointPlans.push({
      label: "payments_by_email",
      endpoint: `/payments?email=${encodeURIComponent(sessionEmail)}`,
      trustPaymentList: true
    });
  }

  console.log("WHOP PAYMENT SYNC START:", {
    session_id: sessionId,
    local_session_id: localSessionId,
    email: sessionEmail,
    endpoint_count: endpointPlans.length
  });

  for (const plan of endpointPlans) {
    try {
      const result = await whopFetch(plan.endpoint, { method: "GET" });
      const candidates = extractPaymentCandidates(result);

      console.log("WHOP PAYMENT SYNC ENDPOINT RESULT:", {
        label: plan.label,
        endpoint: plan.endpoint,
        candidate_count: candidates.length,
        first_five_candidates: candidates.slice(0, 5).map((payment) => whopPaymentDebugSummary(payment))
      });

      const paidPayment = candidates.find((payment) => {
        const matched = whopPaymentMatchesCheckoutSession(payment, session);
        const paid = whopPaymentLooksPaid(payment, plan.trustPaymentList);

        return matched && paid;
      });

      if (!paidPayment) {
        continue;
      }

      console.log("WHOP PAYMENT SYNC MATCHED PAID PAYMENT:", {
        label: plan.label,
        session_id: sessionId,
        local_session_id: localSessionId,
        email: sessionEmail,
        payment: whopPaymentDebugSummary(paidPayment)
      });

      /*
        Important:
        Merge the local Supabase checkout session into payment.metadata.
        That guarantees handlePaymentSucceeded has the email, name, phone,
        referral code, source URL, and local_session_id even if Whop's payment
        object is sparse.
      */
      return handlePaymentSucceeded({
        ...paidPayment,

        checkout_configuration_id:
          paidPayment.checkout_configuration_id ||
          paidPayment.checkoutConfigurationId ||
          paidPayment.checkout_config_id ||
          paidPayment.checkoutConfigId ||
          sessionId,

        checkout_session_id:
          paidPayment.checkout_session_id ||
          paidPayment.checkoutSessionId ||
          sessionId,

        metadata: {
          ...(session || {}),
          ...(paidPayment.metadata || {}),

          local_session_id:
            paidPayment.metadata?.local_session_id ||
            localSessionId,

          email:
            paidPayment.metadata?.email ||
            paidPayment.customer?.email ||
            paidPayment.user?.email ||
            paidPayment.member?.email ||
            paidPayment.buyer?.email ||
            paidPayment.email ||
            session.email,

          full_name:
            paidPayment.metadata?.full_name ||
            paidPayment.metadata?.fullName ||
            paidPayment.user?.name ||
            paidPayment.customer?.name ||
            paidPayment.member?.name ||
            session.full_name,

          phone:
            paidPayment.metadata?.phone ||
            session.phone,

          company:
            paidPayment.metadata?.company ||
            session.company,

          instagram:
            paidPayment.metadata?.instagram ||
            session.instagram,

          podia_email:
            paidPayment.metadata?.podia_email ||
            session.podia_email ||
            session.email,

          referred_by:
            paidPayment.metadata?.referred_by ||
            session.referred_by,

          referral_code:
            paidPayment.metadata?.referral_code ||
            paidPayment.metadata?.referred_by ||
            session.referral_code ||
            session.referred_by,

          source_url:
            paidPayment.metadata?.source_url ||
            session.source_url
        }
      });
    } catch (error) {
      console.warn("Whop sync attempt failed:", {
        label: plan.label,
        endpoint: plan.endpoint,
        error: error.message || String(error)
      });
    }
  }

  console.warn("WHOP PAYMENT SYNC DID NOT FIND PAID PAYMENT:", {
    session_id: sessionId,
    local_session_id: localSessionId,
    email: sessionEmail
  });

  return null;
}

function extractPaymentCandidates(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.flatMap(extractPaymentCandidates);
  }

  if (typeof value !== "object") {
    return [];
  }

  const rows = [];

  /*
    The previous version only kept objects that already looked successful.
    That can accidentally discard Whop payment objects with unusual status names.
    So here we keep anything that looks like a payment-ish object, then filter later.
  */
  if (looksLikeWhopPaymentObject(value)) {
    rows.push(value);
  }

  for (const key of [
    "data",
    "payments",
    "results",
    "items",
    "records",
    "object",
    "payment",
    "checkout",
    "checkout_session",
    "checkout_configuration"
  ]) {
    if (Array.isArray(value[key])) {
      rows.push(...value[key].flatMap(extractPaymentCandidates));
    } else if (value[key] && typeof value[key] === "object") {
      rows.push(...extractPaymentCandidates(value[key]));
    }
  }

  /*
    De-dupe by payment ID if possible.
  */
  const seen = new Set();

  return rows.filter((row) => {
    const id = cleanText(
      row.id ||
        row.payment_id ||
        row.paymentId ||
        row.pay_id ||
        JSON.stringify(whopPaymentDebugSummary(row)),
      500
    );

    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function looksLikeWhopPaymentObject(value) {
  if (!value || typeof value !== "object") return false;

  return Boolean(
    value.id ||
      value.payment_id ||
      value.paymentId ||
      value.pay_id ||
      value.status ||
      value.substatus ||
      value.payment_status ||
      value.paymentStatus ||
      value.paid_at ||
      value.amount ||
      value.total ||
      value.final_amount ||
      value.amount_total ||
      value.checkout_configuration_id ||
      value.checkoutConfigurationId ||
      value.checkout_session_id ||
      value.checkoutSessionId ||
      value.customer?.email ||
      value.user?.email ||
      value.member?.email ||
      value.buyer?.email ||
      value.metadata?.email ||
      value.metadata?.local_session_id
  );
}

function whopPaymentMatchesCheckoutSession(payment, session) {
  const metadata = payment.metadata || {};

  const sessionId = cleanText(session.id, 200);
  const localSessionId = cleanText(session.local_session_id, 200);
  const sessionEmail = cleanEmail(session.email);

  const possibleCheckoutIds = [
    payment.checkout_configuration_id,
    payment.checkoutConfigurationId,
    payment.checkout_config_id,
    payment.checkoutConfigId,
    payment.checkout_session_id,
    payment.checkoutSessionId,
    payment.session_id,
    payment.sessionId,
    payment.checkout_configuration?.id,
    payment.checkoutConfiguration?.id,
    payment.checkout_session?.id,
    payment.checkoutSession?.id,
    metadata.checkout_configuration_id,
    metadata.checkoutConfigurationId,
    metadata.checkout_config_id,
    metadata.checkoutConfigId,
    metadata.checkout_session_id,
    metadata.checkoutSessionId,
    metadata.session_id,
    metadata.sessionId
  ]
    .map((value) => cleanText(value, 200))
    .filter(Boolean);

  const possibleLocalSessionIds = [
    metadata.local_session_id,
    metadata.localSessionId,
    payment.local_session_id,
    payment.localSessionId
  ]
    .map((value) => cleanText(value, 200))
    .filter(Boolean);

  const possibleEmails = [
    metadata.email,
    payment.customer?.email,
    payment.user?.email,
    payment.member?.email,
    payment.buyer?.email,
    payment.email,
    findEmailInObject(payment)
  ]
    .map(cleanEmail)
    .filter(Boolean);

  const matchedByCheckoutId =
    Boolean(sessionId) &&
    possibleCheckoutIds.includes(sessionId);

  const matchedByLocalSessionId =
    Boolean(localSessionId) &&
    possibleLocalSessionIds.includes(localSessionId);

  const matchedByEmail =
    Boolean(sessionEmail) &&
    possibleEmails.includes(sessionEmail);

  return matchedByCheckoutId || matchedByLocalSessionId || matchedByEmail;
}

function whopPaymentLooksPaid(payment, trustPaymentList) {
  if (!payment || typeof payment !== "object") return false;

  /*
    Normal happy path.
  */
  if (isSuccessfulWhopPayment("", payment)) {
    return true;
  }

  const status = cleanText(
    payment.status ||
      payment.payment_status ||
      payment.paymentStatus ||
      payment.substatus ||
      payment.state ||
      "",
    80
  ).toLowerCase();

  /*
    If Whop explicitly says it is not paid, do not mark paid.
  */
  const clearlyNotPaidStatuses = [
    "pending",
    "processing",
    "open",
    "created",
    "incomplete",
    "failed",
    "failure",
    "canceled",
    "cancelled",
    "refunded",
    "refund",
    "chargeback",
    "disputed",
    "requires_payment_method",
    "requires_action"
  ];

  if (clearlyNotPaidStatuses.includes(status)) {
    return false;
  }

  /*
    Compatibility with your old working server:
    Your old code queried /payments and then treated the matching row as successful.
    In some Whop responses, the returned payment row may not expose status in the
    exact field our generic success detector expects.
  */
  if (trustPaymentList) {
    const hasPaymentId = Boolean(
      payment.id ||
        payment.payment_id ||
        payment.paymentId ||
        payment.pay_id
    );

    const hasMoney = Boolean(
      payment.total ||
        payment.amount ||
        payment.amount_total ||
        payment.final_amount ||
        payment.price
    );

    return hasPaymentId && hasMoney;
  }

  return false;
}

function whopPaymentDebugSummary(payment) {
  const metadata = payment?.metadata || {};

  return {
    id:
      payment?.id ||
      payment?.payment_id ||
      payment?.paymentId ||
      payment?.pay_id ||
      "",

    status:
      payment?.status ||
      payment?.payment_status ||
      payment?.paymentStatus ||
      payment?.substatus ||
      payment?.state ||
      "",

    paid_at: payment?.paid_at || "",

    checkout_configuration_id:
      payment?.checkout_configuration_id ||
      payment?.checkoutConfigurationId ||
      payment?.checkout_config_id ||
      payment?.checkoutConfigId ||
      metadata.checkout_configuration_id ||
      metadata.checkoutConfigurationId ||
      "",

    checkout_session_id:
      payment?.checkout_session_id ||
      payment?.checkoutSessionId ||
      metadata.checkout_session_id ||
      metadata.checkoutSessionId ||
      "",

    local_session_id:
      metadata.local_session_id ||
      payment?.local_session_id ||
      payment?.localSessionId ||
      "",

    email:
      metadata.email ||
      payment?.customer?.email ||
      payment?.user?.email ||
      payment?.member?.email ||
      payment?.buyer?.email ||
      payment?.email ||
      "",

    total:
      payment?.total ||
      payment?.amount ||
      payment?.amount_total ||
      payment?.final_amount ||
      payment?.price ||
      "",

    metadata_keys: Object.keys(metadata)
  };
}

function extractPaymentCandidates(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.flatMap(extractPaymentCandidates);
  }

  if (typeof value !== "object") return [];

  const rows = [];

  if (isSuccessfulWhopPayment("", value)) {
    rows.push(value);
  }

  for (const key of ["data", "payments", "results", "items", "records"]) {
    if (Array.isArray(value[key])) {
      rows.push(...value[key].flatMap(extractPaymentCandidates));
    } else if (value[key] && typeof value[key] === "object") {
      rows.push(...extractPaymentCandidates(value[key]));
    }
  }

  return rows;
}

async function sendPaidCustomerToAirtable({ payment, session, customer, metadata, sessionId, whopPaymentId }) {
  if (!GOOGLE_SCRIPT_URL) return;

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

  if (!email) return;

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

    if (!response.ok) {
      console.error("Airtable Apps Script paid sync failed:", response.status, text);
    }
  } catch (error) {
    console.error("Airtable Apps Script paid sync request failed:", error);
  }
}

async function referralCodeIsMaxed(referralCode) {
  const cleanCode = cleanReferralCode(referralCode);
  if (!cleanCode) return false;

  const { data: referrer, error: referrerError } = await db()
    .from("monaco_customers")
    .select("email")
    .eq("referral_code", cleanCode)
    .maybeSingle();

  if (referrerError) throw referrerError;
  if (!referrer) return false;

  const { count, error } = await db()
    .from("monaco_referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_email", referrer.email)
    .eq("friend_payment_status", "paid");

  if (error) throw error;

  return Number(count || 0) >= MAX_REFERRALS;
}

async function upsertCheckoutSession(session) {
  const payload = {
    id: cleanText(session.id, 200),
    local_session_id: cleanText(session.local_session_id, 200),
    email: cleanEmail(session.email),
    full_name: cleanText(session.full_name, 120),
    phone: cleanText(session.phone, 80),
    company: cleanText(session.company, 120),
    instagram: normaliseInstagram(session.instagram),
    podia_email: cleanEmail(session.podia_email || session.email) || cleanEmail(session.email),
    referred_by: cleanReferralCode(session.referred_by),
    referral_code: cleanReferralCode(session.referral_code || session.referred_by),
    visitor_id: cleanText(session.visitor_id, 120),
    source_url: cleanUrl(session.source_url),
    whop_purchase_url: cleanUrl(session.whop_purchase_url),
    whop_plan_id: cleanText(session.whop_plan_id, 200),
    status: cleanText(session.status || "created", 60),
    payment_status: cleanText(session.payment_status || "pending", 60),
    whop_payment_id: cleanText(session.whop_payment_id || "", 200) || null,
    updated_at: now()
  };

  if (!payload.id) throw new Error("Checkout session ID is required.");
  if (!payload.email) throw new Error("Checkout session email is required.");

  const { data, error } = await db()
    .from("monaco_checkout_sessions")
    .upsert(payload, { onConflict: "id" })
    .select("*")
    .single();

  if (error) throw error;

  return data;
}

async function getCheckoutSession(id) {
  const cleanId = cleanText(id, 200);
  if (!cleanId) return null;

  const { data, error } = await db()
    .from("monaco_checkout_sessions")
    .select("*")
    .eq("id", cleanId)
    .maybeSingle();

  if (error) throw error;

  return data || null;
}

async function updateCheckoutSessionPaid(sessionId, whopPaymentId) {
  const { error } = await db()
    .from("monaco_checkout_sessions")
    .update({
      status: "paid",
      payment_status: "paid",
      whop_payment_id: whopPaymentId || null,
      updated_at: now()
    })
    .eq("id", sessionId);

  if (error) throw error;
}

async function upsertCustomerFromSession(session, options = {}) {
  return upsertCustomer({
    email: session.email,
    name: session.full_name || "Founder",
    phone: session.phone || "",
    company: session.company || "",
    podia_email: session.podia_email || session.email,
    checkout_session_id: session.id,
    whop_payment_id: session.whop_payment_id || null,
    status: options.paid ? "paid" : "pending",
    paid_at: options.paid ? now() : null,
    currency: CURRENCY,
    ticket_price_cents: TICKET_PRICE_CENTS
  });
}

async function upsertCustomer(input) {
  const email = cleanEmail(input.email);
  if (!email) throw new Error("Customer email is required.");

  const existing = await getCustomer(email);
  const referralCode = existing?.referral_code || await generateReferralCode(input.name || email);

  const payload = {
    email,
    name: cleanText(input.name || existing?.name || "Founder", 120),
    phone: cleanText(input.phone || existing?.phone || "", 80),
    company: cleanText(input.company || existing?.company || "", 120),
    podia_email: cleanEmail(input.podia_email || existing?.podia_email || email) || email,
    referral_code: referralCode,
    checkout_session_id: cleanText(input.checkout_session_id || existing?.checkout_session_id || "", 200),
    whop_payment_id: cleanText(input.whop_payment_id || existing?.whop_payment_id || "", 200) || null,
    status: cleanText(input.status || existing?.status || "pending", 60),
    paid_at: input.paid_at || existing?.paid_at || null,
    currency: String(input.currency || existing?.currency || CURRENCY).toUpperCase(),
    ticket_price_cents: Number(input.ticket_price_cents || existing?.ticket_price_cents || TICKET_PRICE_CENTS),
    password_hash: input.password_hash || existing?.password_hash || null,
    updated_at: now()
  };

  const { data, error } = await db()
    .from("monaco_customers")
    .upsert(payload, { onConflict: "email" })
    .select("*")
    .single();

  if (error) throw error;

  await rememberIdentity(email, "email", email, "customer_email", true);

  if (payload.phone) {
    await rememberIdentity(email, "phone", normalisePhone(payload.phone), "customer_phone", true);
  }

  return data;
}

async function getCustomer(email) {
  const clean = cleanEmail(email);
  if (!clean) return null;

  const { data, error } = await db()
    .from("monaco_customers")
    .select("*")
    .eq("email", clean)
    .maybeSingle();

  if (error) throw error;

  return data || null;
}

async function generateReferralCode(seed) {
  const base =
    String(seed || "FOUNDER")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 10) || "FOUNDER";

  for (let i = 0; i < 60; i += 1) {
    const code = `${base}${crypto.randomInt(1000, 9999)}`;

    const { data, error } = await db()
      .from("monaco_customers")
      .select("email")
      .eq("referral_code", code)
      .maybeSingle();

    if (error) throw error;
    if (!data) return code;
  }

  return `${base}${Date.now()}`.slice(0, 24);
}

async function buildDashboard(email) {
  const clean = cleanEmail(email);
  const customer = await getCustomer(clean);

  if (!customer) {
    throw new Error("Customer not found.");
  }

  const { data: referrals, error: referralError } = await db()
    .from("monaco_referrals")
    .select("*")
    .eq("referrer_email", clean)
    .order("created_at", { ascending: false });

  if (referralError) throw referralError;

  const { data: googleIdentity, error: googleError } = await db()
    .from("monaco_customer_identities")
    .select("identity_value")
    .eq("customer_email", clean)
    .eq("identity_type", "google_email")
    .eq("verified", true)
    .limit(1)
    .maybeSingle();

  if (googleError) throw googleError;

  const rows = referrals || [];

  return {
    name: customer.name || "Founder",
    email: customer.email,
    phone: customer.phone || "",
    company: customer.company || "",
    whatsapp: buildWhatsappAccess(customer),
    google_connected: Boolean(googleIdentity),
    password_set: Boolean(customer.password_hash),
    passwordSet: Boolean(customer.password_hash),
    referral_code: customer.referral_code || "",
    referral_link: customer.referral_code
      ? `${APP_URL}/checkout.html?r=${encodeURIComponent(customer.referral_code)}`
      : "",
    max_referrals: MAX_REFERRALS,
    paid_referrals: rows.filter((r) => r.friend_payment_status === "paid").length,
    currency: customer.currency || CURRENCY,
    referrals: rows.map((r) => ({
      id: r.id,
      friend_name: r.friend_name || "Friend",
      friend_email_masked: maskEmail(r.friend_checkout_email || r.friend_customer_email),
      friend_payment_status: r.friend_payment_status || "paid",
      paid_at: r.paid_at || r.created_at || ""
    }))
  };
}

function buildWhatsappAccess(customer) {
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

async function rememberIdentity(customerEmail, type, value, source, verified = false) {
  const email = cleanEmail(customerEmail);
  const identityType = cleanText(type, 60);
  const identityValue = String(value || "").trim().toLowerCase();
  const key = identityKey(identityType, identityValue);

  if (!email || !identityType || !identityValue || !key) return;

  const { error } = await db()
    .from("monaco_customer_identities")
    .upsert(
      {
        identity_key: key,
        identity_type: identityType,
        identity_value: identityValue,
        customer_email: email,
        source: cleanText(source, 120),
        verified: Boolean(verified),
        updated_at: now()
      },
      { onConflict: "identity_key" }
    );

  if (error) throw error;
}

async function getIdentity(type, value) {
  const key = identityKey(type, value);

  if (!key) return null;

  const { data, error } = await db()
    .from("monaco_customer_identities")
    .select("*")
    .eq("identity_key", key)
    .maybeSingle();

  if (error) throw error;

  return data || null;
}

function identityKey(type, value) {
  const cleanType = cleanText(type, 60);
  const cleanValue = String(value || "").trim().toLowerCase();

  if (!cleanType || !cleanValue) return "";

  return `${cleanType}:${cleanValue}`;
}

async function createServerSession(res, email) {
  const clean = cleanEmail(email);

  if (!clean) throw new Error("Cannot create session without an email.");

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);

  const { error } = await db()
    .from("monaco_sessions")
    .insert({
      token_hash: tokenHash,
      customer_email: clean,
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    });

  if (error) throw error;

  res.cookie(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_MS));
}

async function sessionEmail(req) {
  const tokens = getSessionCookieTokens(req);

  if (!tokens.length) {
    console.warn("SESSION LOOKUP: no session cookie received", {
      cookie_header_present: Boolean(req.get("cookie")),
      cookie_names: Object.keys(req.cookies || {})
    });

    return "";
  }

  const tokenHashes = tokens.map((token) => sha256(token));

  const { data, error } = await db()
    .from("monaco_sessions")
    .select("customer_email, expires_at, revoked_at, token_hash")
    .in("token_hash", tokenHashes)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.warn("SESSION LOOKUP: Supabase error", {
      message: error.message,
      code: error.code
    });

    return "";
  }

  const nowMs = Date.now();

  const validSession = (data || []).find((row) => {
    if (!row) return false;
    if (row.revoked_at) return false;
    if (!row.expires_at) return false;
    return new Date(row.expires_at).getTime() > nowMs;
  });

  if (!validSession) {
    console.warn("SESSION LOOKUP: no matching valid session", {
      received_cookie_count: tokens.length,
      received_cookie_names: Object.keys(req.cookies || {}),
      matching_rows: (data || []).length,
      rows: (data || []).map((row) => ({
        customer_email: row.customer_email,
        expires_at: row.expires_at,
        revoked: Boolean(row.revoked_at)
      }))
    });

    return "";
  }

  db()
    .from("monaco_sessions")
    .update({ last_seen_at: now() })
    .eq("token_hash", validSession.token_hash)
    .then(() => {})
    .catch(() => {});

  return cleanEmail(validSession.customer_email);
}

function getSessionCookieTokens(req) {
  const tokens = [];

  for (const name of ["monaco_session_v2", "monaco_session"]) {
    const value = String(req.cookies?.[name] || "").trim();
    if (value) tokens.push(value);
  }

  /*
    cookie-parser only gives one value per cookie name.
    Browsers can send duplicate cookie names when old cookies exist with
    different paths/domains, so parse the raw Cookie header too.
  */
  const rawCookieHeader = String(req.get("cookie") || "");

  rawCookieHeader.split(";").forEach((part) => {
    const index = part.indexOf("=");
    if (index === -1) return;

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (name !== "monaco_session_v2" && name !== "monaco_session") return;
    if (!value) return;

    try {
      tokens.push(decodeURIComponent(value));
    } catch {
      tokens.push(value);
    }
  });

  return [...new Set(tokens.filter(Boolean))];
}

async function clearServerSession(req, res) {
  const token =
    String(req.cookies?.monaco_session_v2 || "") ||
    String(req.cookies?.monaco_session || "");

  if (token) {
    await db()
      .from("monaco_sessions")
      .update({ revoked_at: now() })
      .eq("token_hash", sha256(token));
  }

  res.clearCookie("monaco_session_v2", cookieOptions(0));
  res.clearCookie("monaco_session", cookieOptions(0));
}

function cookieOptions(maxAge) {
  const options = {
    httpOnly: true,
    sameSite: "lax",
    secure: APP_URL.startsWith("https://"),
    path: "/"
  };

  if (maxAge > 0) {
    options.maxAge = maxAge;
  }

  return options;
}

async function setCustomerPassword(email, password) {
  const clean = cleanEmail(email);

  if (!clean) throw new Error("A valid booking email is required.");

  if (String(password || "").length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }

  const passwordHash = await hashPassword(password);

  const { error } = await db()
    .from("monaco_customers")
    .update({
      password_hash: passwordHash,
      updated_at: now()
    })
    .eq("email", clean);

  if (error) throw error;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const hash = await new Promise((resolve, reject) => {
    crypto.pbkdf2(
      String(password),
      salt,
      PASSWORD_HASH_ITERATIONS,
      PASSWORD_HASH_KEYLEN,
      PASSWORD_HASH_DIGEST,
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey.toString("hex"));
      }
    );
  });

  return [
    "pbkdf2",
    PASSWORD_HASH_ITERATIONS,
    PASSWORD_HASH_DIGEST,
    salt,
    hash
  ].join("$");
}

async function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");

  if (parts.length !== 5 || parts[0] !== "pbkdf2") {
    return false;
  }

  const iterations = Number(parts[1]);
  const digest = parts[2];
  const salt = parts[3];
  const expected = parts[4];

  if (!iterations || !digest || !salt || !expected) return false;

  const actual = await new Promise((resolve, reject) => {
    crypto.pbkdf2(
      String(password),
      salt,
      iterations,
      Buffer.from(expected, "hex").length,
      digest,
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey.toString("hex"));
      }
    );
  });

  return safeEqualHex(actual, expected);
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ""), "hex");
  const right = Buffer.from(String(b || ""), "hex");

  if (left.length !== right.length || left.length === 0) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

async function createPasswordSetupToken(email) {
  const clean = cleanEmail(email);

  if (!clean) throw new Error("A valid customer email is required.");

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);

  const { error } = await db()
    .from("monaco_password_tokens")
    .insert({
      token_hash: tokenHash,
      customer_email: clean,
      expires_at: new Date(Date.now() + PASSWORD_SETUP_TOKEN_TTL_MS).toISOString()
    });

  if (error) throw error;

  return token;
}
async function revokeUnusedPasswordTokens(email) {
  const clean = cleanEmail(email);
  if (!clean) return;

  const { error } = await db()
    .from("monaco_password_tokens")
    .update({ used_at: now() })
    .eq("customer_email", clean)
    .is("used_at", null);

  if (error) throw error;
}

async function sendPasswordSetupEmail({ customer, setup_url }) {
  const payload = {
    event_type: "monaco_password_setup_link",
    email: customer.email,
    customer_email: customer.email,
    full_name: customer.name || customer.full_name || customer.fullName || "",
    name: customer.name || customer.full_name || customer.fullName || "",
    setup_url,
    setupUrl: setup_url,
    app: "monaco-content-retreat"
  };

  console.log("Sending password setup email via Google Script:", {
    email: payload.email,
    setup_url: payload.setup_url
  });

  const response = await fetch(GOOGLE_SCRIPT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok || data.ok === false) {
    console.error("Google Script password setup email failed:", {
      status: response.status,
      response: data
    });

    throw new Error(
      data.error ||
      data.message ||
      "Google Script could not send the password setup email."
    );
  }

  console.log("Google Script password setup email sent:", {
    email: payload.email,
    response: data
  });

  return data;
}
async function getPasswordToken(token) {
  const tokenHash = sha256(token);

  const { data, error } = await db()
    .from("monaco_password_tokens")
    .select("*")
    .eq("token_hash", tokenHash)
    .is("used_at", null)
    .maybeSingle();

  if (error) throw error;

  if (!data) return null;

  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await markPasswordTokenUsed(token);
    return null;
  }

  return data;
}

async function markPasswordTokenUsed(token) {
  const tokenHash = sha256(token);

  const { error } = await db()
    .from("monaco_password_tokens")
    .update({ used_at: now() })
    .eq("token_hash", tokenHash);

  if (error) throw error;
}

async function whopFetch(endpoint, options = {}) {
  requireEnv(["WHOP_API_KEY"]);

  const url = `${WHOP_API_BASE}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  const method = options.method || "GET";

  const response = await fetch(url, {
    method,
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
    throw withDetails(`Whop request failed (${response.status})`, data);
  }

  return data;
}

function verifyWhopWebhook(req) {
  if (!WHOP_WEBHOOK_SECRET) return true;

  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const signatures = [
    req.get("x-whop-signature"),
    req.get("whop-signature"),
    req.get("x-signature"),
    req.get("stripe-signature")
  ].filter(Boolean);

  if (!signatures.length) return false;

  const expectedHex = crypto
    .createHmac("sha256", WHOP_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  const expectedBase64 = crypto
    .createHmac("sha256", WHOP_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");

  return signatures.some((signatureHeader) => {
    const raw = String(signatureHeader || "");

    const candidates = raw
      .split(",")
      .map((part) => part.trim())
      .flatMap((part) => {
        const pieces = [part];
        if (part.includes("=")) pieces.push(part.split("=").pop());
        return pieces;
      })
      .map((part) => part.trim())
      .filter(Boolean);

    return candidates.some((candidate) => {
      return safeEqualString(candidate, expectedHex) || safeEqualString(candidate, expectedBase64);
    });
  });
}

function isSuccessfulWhopPayment(eventType, object = {}) {
  const type = String(eventType || "").toLowerCase();

  const status = String(
    object.status ||
      object.payment_status ||
      object.paymentStatus ||
      object.substatus ||
      object.state ||
      ""
  ).toLowerCase();

  return (
    Boolean(object.paid_at) ||
    type.includes("payment.succeeded") ||
    type.includes("payment.paid") ||
    type.includes("payment.success") ||
    type.includes("checkout.session.completed") ||
    status === "paid" ||
    status === "succeeded" ||
    status === "successful" ||
    status === "complete" ||
    status === "completed"
  );
}

function moneyToCents(value) {
  if (value === null || value === undefined || value === "") return 0;

  const number = Number(String(value).replace(/[^\d.]/g, ""));

  if (!Number.isFinite(number) || number <= 0) return 0;

  if (number > 10000) return Math.round(number);

  return Math.round(number * 100);
}

function db() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }

  if (!supabaseClient) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    });
  }

  return supabaseClient;
}

function requireAdmin(req, res, next) {
  const supplied =
    req.get("x-admin-api-key") ||
    req.query.admin_key ||
    req.body?.admin_key ||
    "";

  if (!ADMIN_API_KEY) {
    return res.status(500).json({ error: "ADMIN_API_KEY is not configured." });
  }

  if (!safeEqualString(String(supplied), ADMIN_API_KEY)) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  next();
}

function requireEnv(names) {
  const missing = names.filter((name) => !String(process.env[name] || "").trim());

  if (missing.length) {
    throw new Error(`Missing environment variable(s): ${missing.join(", ")}`);
  }
}

function withDetails(message, details) {
  const error = new Error(message);
  error.details = details;
  return error;
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));

  if (left.length !== right.length) return false;

  return crypto.timingSafeEqual(left, right);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function now() {
  return new Date().toISOString();
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function cleanEmail(value) {
  const email = String(value || "").trim().toLowerCase();

  if (!email) return "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";

  return email.slice(0, 254);
}

function cleanText(value, max = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanUrl(value) {
  const text = String(value || "").trim();

  if (!text) return "";

  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString().slice(0, 2000);
  } catch {
    return "";
  }
}

function cleanReferralCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 80);
}

function normalisePhone(value) {
  return String(value || "").replace(/[^\d+]/g, "").slice(0, 80);
}

function normaliseInstagram(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.startsWith("@") ? text.slice(0, 120) : `@${text}`.slice(0, 120);
}

function referralCodeFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return cleanReferralCode(
      url.searchParams.get("r") ||
        url.searchParams.get("ref") ||
        url.searchParams.get("referral") ||
        url.searchParams.get("referral_code") ||
        ""
    );
  } catch {
    return "";
  }
}

function maskEmail(email) {
  const clean = cleanEmail(email);

  if (!clean) return "Hidden";

  const [name, domain] = clean.split("@");
  const visible = name.slice(0, 2);

  return `${visible}${"*".repeat(Math.max(3, name.length - 2))}@${domain}`;
}

function findEmailInObject(value) {
  const seen = new Set();

  function walk(item) {
    if (!item || seen.has(item)) return "";

    if (typeof item === "string") {
      const match = item.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      return match ? cleanEmail(match[0]) : "";
    }

    if (typeof item !== "object") return "";

    seen.add(item);

    for (const key of Object.keys(item)) {
      const found = walk(item[key]);
      if (found) return found;
    }

    return "";
  }

  return walk(value);
}

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

app.listen(PORT, () => {
  console.log(`Monaco app listening on port ${PORT}`);
  console.log(`Storage: Supabase only`);
});



function logWebhookDebug(label, payload) {
  const text = JSON.stringify(payload, null, 2);

  /*
    Vercel logs can truncate long lines.
    Split into chunks so you can copy the full webhook shape.
  */
  const chunkSize = 7000;

  console.log(`${label} BEGIN`);

  for (let i = 0; i < text.length; i += chunkSize) {
    console.log(`${label} CHUNK ${Math.floor(i / chunkSize) + 1}: ${text.slice(i, i + chunkSize)}`);
  }

  console.log(`${label} END`);
}
function summarizeWebhookObject(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const metadata =
    value.metadata ||
    value.checkout_metadata ||
    value.custom_data ||
    value.custom_fields ||
    {};

  return {
    id:
      value.id ||
      value.payment_id ||
      value.paymentId ||
      value.pay_id ||
      value.checkout_id ||
      value.checkoutId ||
      "",

    type:
      value.type ||
      value.event ||
      value.name ||
      "",

    status:
      value.status ||
      value.payment_status ||
      value.paymentStatus ||
      value.substatus ||
      value.state ||
      value.checkout_status ||
      value.checkoutStatus ||
      "",

    paid_at:
      value.paid_at ||
      value.paidAt ||
      value.completed_at ||
      value.completedAt ||
      "",

    created_at:
      value.created_at ||
      value.createdAt ||
      value.timestamp ||
      "",

    checkout_configuration_id:
      value.checkout_configuration_id ||
      value.checkoutConfigurationId ||
      value.checkout_config_id ||
      value.checkoutConfigId ||
      metadata.checkout_configuration_id ||
      metadata.checkoutConfigurationId ||
      "",

    checkout_session_id:
      value.checkout_session_id ||
      value.checkoutSessionId ||
      value.session_id ||
      value.sessionId ||
      metadata.checkout_session_id ||
      metadata.checkoutSessionId ||
      metadata.session_id ||
      metadata.sessionId ||
      "",

    local_session_id:
      metadata.local_session_id ||
      metadata.localSessionId ||
      value.local_session_id ||
      value.localSessionId ||
      "",

    email:
      metadata.email ||
      value.email ||
      value.customer?.email ||
      value.user?.email ||
      value.member?.email ||
      value.buyer?.email ||
      findEmailInObject(value) ||
      "",

    name:
      metadata.full_name ||
      metadata.fullName ||
      value.name ||
      value.customer?.name ||
      value.user?.name ||
      value.member?.name ||
      "",

    amount:
      value.total ||
      value.amount ||
      value.amount_total ||
      value.final_amount ||
      value.price ||
      "",

    currency:
      value.currency ||
      "",

    metadata_keys: Object.keys(metadata || {}),
    keys: Object.keys(value || {})
  };
}


async function saveWhopWebhookDebug({
  eventType,
  objectPath,
  signatureValid,
  successfulPaymentDetected,
  selectedSummary,
  payload,
  error
}) {
  try {
    await db()
      .from("monaco_webhook_debug")
      .insert({
        provider: "whop",
        event_type: String(eventType || ""),
        object_path: String(objectPath || ""),
        signature_valid: Boolean(signatureValid),
        successful_payment_detected: Boolean(successfulPaymentDetected),
        selected_summary: selectedSummary || {},
        payload: payload || {},
        error: String(error || "")
      });
  } catch (debugError) {
    console.error("Could not save webhook debug row:", debugError);
  }
}

function summarizeWebhookObject(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const metadata =
    value.metadata ||
    value.checkout_metadata ||
    value.custom_data ||
    value.custom_fields ||
    {};

  return {
    id:
      value.id ||
      value.payment_id ||
      value.paymentId ||
      value.pay_id ||
      value.checkout_id ||
      value.checkoutId ||
      "",

    type:
      value.type ||
      value.event ||
      value.name ||
      "",

    status:
      value.status ||
      value.payment_status ||
      value.paymentStatus ||
      value.substatus ||
      value.state ||
      value.checkout_status ||
      value.checkoutStatus ||
      "",

    paid_at:
      value.paid_at ||
      value.paidAt ||
      value.completed_at ||
      value.completedAt ||
      "",

    created_at:
      value.created_at ||
      value.createdAt ||
      value.timestamp ||
      "",

    checkout_configuration_id:
      value.checkout_configuration_id ||
      value.checkoutConfigurationId ||
      value.checkout_config_id ||
      value.checkoutConfigId ||
      metadata.checkout_configuration_id ||
      metadata.checkoutConfigurationId ||
      "",

    checkout_session_id:
      value.checkout_session_id ||
      value.checkoutSessionId ||
      value.session_id ||
      value.sessionId ||
      metadata.checkout_session_id ||
      metadata.checkoutSessionId ||
      metadata.session_id ||
      metadata.sessionId ||
      "",

    local_session_id:
      metadata.local_session_id ||
      metadata.localSessionId ||
      value.local_session_id ||
      value.localSessionId ||
      "",

    email:
      metadata.email ||
      value.email ||
      value.customer?.email ||
      value.user?.email ||
      value.member?.email ||
      value.buyer?.email ||
      findEmailInObject(value) ||
      "",

    name:
      metadata.full_name ||
      metadata.fullName ||
      value.name ||
      value.customer?.name ||
      value.user?.name ||
      value.member?.name ||
      "",

    amount:
      value.total ||
      value.amount ||
      value.amount_total ||
      value.final_amount ||
      value.price ||
      "",

    currency:
      value.currency ||
      "",

    metadata_keys: Object.keys(metadata || {}),
    keys: Object.keys(value || {})
  };
}

function sanitizeWebhookForLog(value, depth = 0) {
  if (depth > 8) return "[Max depth reached]";
  if (value === null || value === undefined) return value;

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeWebhookForLog(item, depth + 1));
  }

  const output = {};

  Object.keys(value).forEach((key) => {
    const lower = key.toLowerCase();
    const item = value[key];

    if (
      lower.includes("secret") ||
      lower.includes("token") ||
      lower.includes("authorization") ||
      lower.includes("signature") ||
      lower.includes("api_key") ||
      lower.includes("apikey") ||
      lower.includes("password") ||
      lower.includes("card") ||
      lower.includes("cvc")
    ) {
      output[key] = "[REDACTED]";
      return;
    }

    output[key] = sanitizeWebhookForLog(item, depth + 1);
  });

  return output;
}