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
  (WHOP_ENVIRONMENT === "sandbox"
    ? "https://sandbox-api.whop.com/api/v1"
    : "https://api.whop.com/api/v1");

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
const MAX_REFERRALS = cleanEnvNumber(process.env.MAX_REFERRALS, 2);
const CURRENCY = cleanEnv(process.env.CURRENCY || "EUR").toUpperCase() || "EUR";

const PASSWORD_MIN_LENGTH = cleanEnvNumber(process.env.PASSWORD_MIN_LENGTH, 8);
const PASSWORD_HASH_ITERATIONS = cleanEnvNumber(process.env.PASSWORD_HASH_ITERATIONS, 210000);
const PASSWORD_HASH_KEYLEN = 64;
const PASSWORD_HASH_DIGEST = "sha512";

const PASSWORD_SETUP_TOKEN_TTL_MS = cleanEnvNumber(
  process.env.PASSWORD_SETUP_TOKEN_TTL_MS,
  1000 * 60 * 60 * 24 * 7
);

const SESSION_COOKIE = "monaco_session";

const SESSION_TTL_MS = cleanEnvNumber(
  process.env.SESSION_TTL_MS,
  1000 * 60 * 60 * 24 * 30
);

const GOOGLE_STATE_COOKIE = "monaco_google_state";
const GOOGLE_CHECKOUT_COOKIE = "monaco_google_checkout_session";

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

    const sessionId = cleanText(req.query.checkout_session_id || req.query.session_id, 200);

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
  try {
    if (WHOP_WEBHOOK_SECRET && !verifyWhopWebhook(req)) {
      return res.status(401).json({ error: "Invalid webhook signature." });
    }

    const event = req.body || {};
    const eventType = String(event.type || event.event || event.name || "").toLowerCase();
    const object = event.data?.object || event.data || event.object || event;

    if (isSuccessfulWhopPayment(eventType, object)) {
      await handlePaymentSucceeded(object);
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

    /*
      Return 200 so Whop does not endlessly retry a permanently malformed event.
      We still log the error and include ok:false for diagnostics.
    */
    res.status(200).json({
      ok: false,
      error: error.message || "Webhook error."
    });
  }
});

app.get("/api/referrals/me", async (req, res) => {
  try {
    const email = await sessionEmail(req);

    if (!email) {
      return res.status(401).json({ error: "Please log in." });
    }

    res.json({
      dashboard: await buildDashboard(email)
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

app.post("/api/referrals/password-set", async (req, res) => {
  try {
    const password = String(req.body?.password || "");
    const currentPassword = String(req.body?.current_password || req.body?.currentPassword || "");

    let email = cleanEmail(req.body?.email || "");
    let sessionCustomerEmail = await sessionEmail(req);

    if (!email && sessionCustomerEmail) {
      email = sessionCustomerEmail;
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

    if (!sessionCustomerEmail) {
      const checkoutSessionId = cleanText(
        req.body?.checkout_session_id ||
          req.body?.session_id ||
          req.body?.checkout_configuration_id ||
          "",
        200
      );

      if (checkoutSessionId) {
        let checkoutSession = await getCheckoutSession(checkoutSessionId);

        if (checkoutSession && checkoutSession.payment_status !== "paid") {
          await syncPaidWhopPaymentForSession(checkoutSession);
          checkoutSession = await getCheckoutSession(checkoutSessionId);
        }

        if (
          checkoutSession &&
          checkoutSession.payment_status === "paid" &&
          cleanEmail(checkoutSession.email) === email
        ) {
          await createServerSession(res, email);
          sessionCustomerEmail = email;
        }
      }
    }

    if (!sessionCustomerEmail) {
      return res.status(401).json({
        error: "Please confirm your paid checkout, log in with Google, or use a secure setup link before setting a password."
      });
    }

    if (cleanEmail(sessionCustomerEmail) !== email) {
      return res.status(403).json({
        error: "You can only set a password for the email currently logged in."
      });
    }

    if (customer.password_hash && !currentPassword) {
      return res.status(400).json({
        error: "Enter your current password before changing it."
      });
    }

    if (customer.password_hash && currentPassword) {
      const valid = await verifyPassword(currentPassword, customer.password_hash);
      if (!valid) {
        return res.status(401).json({ error: "Current password is incorrect." });
      }
    }

    await setCustomerPassword(email, password);
    await createServerSession(res, email);

    res.json({
      ok: true,
      dashboard: await buildDashboard(email)
    });
  } catch (error) {
    console.error("password-set failed:", error);
    res.status(500).json({ error: error.message || "Could not set password." });
  }
});

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
    const referrerEmail = await sessionEmail(req);

    if (!referrerEmail) {
      return res.status(401).json({ error: "Please log in first." });
    }

    const dashboard = await buildDashboard(referrerEmail);
    const body = req.body || {};

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
        referrer_email: referrerEmail,
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

    /*
      Apps Script is optional and only sends/logs the invite.
      Supabase is already the source of truth before this call runs.
    */
    if (GOOGLE_SCRIPT_URL) {
      fetch(GOOGLE_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      }).catch((error) => {
        console.error("Referral invite Apps Script call failed:", error);
      });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("invite-friend failed:", error);
    res.status(500).json({ error: error.message || "Could not send invitation." });
  }
});

app.get("/auth/google/start", async (req, res) => {
  try {
    requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);

    const state = crypto.randomBytes(24).toString("hex");
    const checkoutSessionId = cleanText(req.query.checkout_session_id || req.query.session_id || "", 200);

    res.cookie(GOOGLE_STATE_COOKIE, state, cookieOptions(10 * 60 * 1000));

    if (checkoutSessionId) {
      res.cookie(GOOGLE_CHECKOUT_COOKIE, checkoutSessionId, cookieOptions(10 * 60 * 1000));
    }

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
    res.redirect(`/thankyou-referral-dashboard.html?error=${encodeURIComponent(error.message || "Google login failed.")}`);
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);

    const code = cleanText(req.query.code, 3000);
    const state = cleanText(req.query.state, 200);
    const expectedState = cleanText(req.cookies?.[GOOGLE_STATE_COOKIE], 200);
    const checkoutSessionId = cleanText(req.cookies?.[GOOGLE_CHECKOUT_COOKIE], 200);

    res.clearCookie(GOOGLE_STATE_COOKIE, cookieOptions(0));
    res.clearCookie(GOOGLE_CHECKOUT_COOKIE, cookieOptions(0));

    if (!code || !state || !expectedState || state !== expectedState) {
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
      Best case: user has just paid and clicked Google from thankyou page.
      We link whichever Google account they choose to the paid checkout email.
      This handles “paid with one email, signs in with another”.
    */
    if (checkoutSessionId) {
      let session = await getCheckoutSession(checkoutSessionId);

      if (session && session.payment_status !== "paid") {
        await syncPaidWhopPaymentForSession(session);
        session = await getCheckoutSession(checkoutSessionId);
      }

      if (session && session.payment_status === "paid") {
        const customer = await upsertCustomerFromSession(session, { paid: true });
        customerEmail = cleanEmail(customer.email);
      }
    }

    /*
      Otherwise, use existing verified Google identity.
    */
    if (!customerEmail) {
      const linked = await getIdentity("google_email", googleEmail);
      if (linked) customerEmail = cleanEmail(linked.customer_email);
    }

    /*
      Last fallback: exact email match to a paid booking.
    */
    if (!customerEmail) {
      const exactCustomer = await getCustomer(googleEmail);
      if (exactCustomer && exactCustomer.status === "paid") {
        customerEmail = cleanEmail(exactCustomer.email);
      }
    }

    if (!customerEmail) {
      return res.redirect(
        `/thankyou-referral-dashboard.html?error=${encodeURIComponent(
          "We could not match this Google account to a paid Monaco booking. Use the email you paid with, or ask support to link your Google email."
        )}`
      );
    }

    await rememberIdentity(customerEmail, "google_email", googleEmail, "google_oauth", true);
    await createServerSession(res, customerEmail);

    res.redirect("/thankyou-referral-dashboard.html");
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
        can_set_password_now: true,
        error: "No dashboard password exists yet for this paid email."
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
  if (!WHOP_API_KEY || !session) return null;

  const idsToTry = [
    session.id,
    session.local_session_id,
    session.whop_plan_id
  ].filter(Boolean);

  const endpoints = [];

  for (const id of idsToTry) {
    endpoints.push(`/checkout_configurations/${encodeURIComponent(id)}`);
    endpoints.push(`/checkout_sessions/${encodeURIComponent(id)}`);
    endpoints.push(`/payments?checkout_configuration_id=${encodeURIComponent(id)}`);
    endpoints.push(`/payments?checkout_session_id=${encodeURIComponent(id)}`);
  }

  endpoints.push(`/payments?email=${encodeURIComponent(session.email)}`);

  for (const endpoint of endpoints) {
    try {
      const result = await whopFetch(endpoint, { method: "GET" });
      const candidates = extractPaymentCandidates(result);

      for (const candidate of candidates) {
        const eventType = String(candidate.type || candidate.event || "").toLowerCase();

        if (isSuccessfulWhopPayment(eventType, candidate)) {
          return handlePaymentSucceeded(candidate);
        }
      }
    } catch (error) {
      console.warn("Whop sync attempt failed:", endpoint, error.message);
    }
  }

  return null;
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
  const token = String(req.cookies?.[SESSION_COOKIE] || "");

  if (!token) return "";

  const { data, error } = await db()
    .from("monaco_sessions")
    .select("customer_email, expires_at, revoked_at")
    .eq("token_hash", sha256(token))
    .maybeSingle();

  if (error || !data || data.revoked_at) return "";

  if (new Date(data.expires_at).getTime() <= Date.now()) {
    return "";
  }

  db()
    .from("monaco_sessions")
    .update({ last_seen_at: now() })
    .eq("token_hash", sha256(token))
    .then(() => {})
    .catch(() => {});

  return cleanEmail(data.customer_email);
}

async function clearServerSession(req, res) {
  const token = String(req.cookies?.[SESSION_COOKIE] || "");

  if (token) {
    await db()
      .from("monaco_sessions")
      .update({ revoked_at: now() })
      .eq("token_hash", sha256(token));
  }

  res.clearCookie(SESSION_COOKIE, cookieOptions(0));
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