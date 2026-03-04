
import { json, err } from "./http.js";

function formEncode(obj) {
  return Object.entries(obj)
    .flatMap(([k,v]) => Array.isArray(v) ? v.map(x => [k, x]) : [[k,v]])
    .map(([k,v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v)))
    .join("&");
}

/**
 * Plan naming (frontend -> worker):
 * One-time credit packs (mode=payment):
 *   - credits100
 *   - credits500
 * Subscriptions (mode=subscription):
 *   - sub_basic
 *   - sub_pro
 *
 * Env vars (recommended):
 *   STRIPE_PRICE_CREDITS100, STRIPE_PRICE_CREDITS500
 *   STRIPE_SUB_PRICE_BASIC,  STRIPE_SUB_PRICE_PRO
 */
function planConfig(env, planRaw) {
  const plan = String(planRaw || "").toLowerCase();

  // One-time packs
  if (plan === "credits500") return { mode: "payment", price: env.STRIPE_PRICE_CREDITS500, grantType: "pack", packCredits: 500 };
  if (plan === "credits100") return { mode: "payment", price: env.STRIPE_PRICE_CREDITS100, grantType: "pack", packCredits: 100 };

  // Subscriptions
  if (plan === "sub_pro")   return { mode: "subscription", price: env.STRIPE_SUB_PRICE_PRO,   grantType: "subscription", role: "pro",   monthlyCredits: Number(env.SUB_PRO_MONTHLY_CREDITS || "5000") };
  if (plan === "sub_basic") return { mode: "subscription", price: env.STRIPE_SUB_PRICE_BASIC, grantType: "subscription", role: "basic", monthlyCredits: Number(env.SUB_BASIC_MONTHLY_CREDITS || "1000") };

  // Back-compat: "basic"/"pro" mean one-time packs (100/500)
  if (plan === "pro")   return { mode: "payment", price: env.STRIPE_PRICE_CREDITS500 || env.STRIPE_PRICE_PRO, grantType: "pack", packCredits: 500 };
  if (plan === "basic") return { mode: "payment", price: env.STRIPE_PRICE_CREDITS100 || env.STRIPE_PRICE_BASIC, grantType: "pack", packCredits: 100 };

  // Fallback
  return { mode: "payment", price: env.STRIPE_PRICE_CREDITS100 || env.STRIPE_PRICE_BASIC, grantType: "pack", packCredits: 100 };
}

async function recordRevenueEvent(env, ev) {
  try {
    const id = ev.id || crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO revenue_events (
        id, created_at, kind, user_id, stripe_object_id, attribution_id, plan, amount, currency,
        keyword, seo_slug, tool_name, utm_source, utm_campaign, utm_term
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
    `).bind(
      id,
      Number(ev.created_at || Date.now()),
      String(ev.kind || ''),
      ev.user_id ? String(ev.user_id) : null,
      ev.stripe_object_id ? String(ev.stripe_object_id) : null,
      ev.attribution_id ? String(ev.attribution_id) : null,
      ev.plan ? String(ev.plan) : null,
      Number(ev.amount || 0),
      ev.currency ? String(ev.currency).toLowerCase() : null,
      ev.keyword ? String(ev.keyword) : null,
      ev.seo_slug ? String(ev.seo_slug) : null,
      ev.tool_name ? String(ev.tool_name) : null,
      ev.utm_source ? String(ev.utm_source) : null,
      ev.utm_campaign ? String(ev.utm_campaign) : null,
      ev.utm_term ? String(ev.utm_term) : null,
    ).run();
  } catch (e) {
    // best-effort only
  }
}

import { upsertAttribution, normalizeAttribution } from "./attribution.js";

export async function createCheckoutSession(env, { userId, email, plan, origin, attribution }) {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY env eksik");
  const cfg = planConfig(env, plan);
  const attr = attribution ? normalizeAttribution(attribution) : null;
  if (attr && !attr.attribution_id) attr.attribution_id = null;
  if (attr && attr.attribution_id) {
    try { await upsertAttribution(env, attr); } catch (_) {}
  }
  if (!cfg.price) throw new Error("Stripe price env eksik (Price ID tanımla).");

  const success = `${origin}/billing/success.html`;
  const cancel  = `${origin}/billing/cancel.html`;

  const body = formEncode({
    mode: cfg.mode,
    "line_items[0][price]": cfg.price,
    "line_items[0][quantity]": 1,
    success_url: success + "?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: cancel,
    customer_email: email,
    "metadata[user_id]": userId,
    "metadata[plan]": String(plan || ""),
    ...(attr && attr.attribution_id ? {
      "metadata[attribution_id]": attr.attribution_id,
      "metadata[seo_slug]": attr.seo_slug || "",
      "metadata[keyword]": attr.keyword || "",
      "metadata[tool_name]": attr.tool_name || "",
      "metadata[utm_source]": attr.utm_source || "",
      "metadata[utm_campaign]": attr.utm_campaign || "",
      "metadata[utm_term]": attr.utm_term || "",
    } : {}),
    ...(cfg.mode === "subscription" ? {
      "subscription_data[metadata][user_id]": userId,
      "subscription_data[metadata][plan]": String(plan || ""),
      ...(attr && attr.attribution_id ? {
        "subscription_data[metadata][attribution_id]": attr.attribution_id,
        "subscription_data[metadata][seo_slug]": attr.seo_slug || "",
        "subscription_data[metadata][keyword]": attr.keyword || "",
        "subscription_data[metadata][tool_name]": attr.tool_name || "",
        "subscription_data[metadata][utm_source]": attr.utm_source || "",
        "subscription_data[metadata][utm_campaign]": attr.utm_campaign || "",
        "subscription_data[metadata][utm_term]": attr.utm_term || "",
      } : {}),
    } : {}),
  });

  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const j = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(j?.error?.message || `Stripe error ${resp.status}`);
  return { url: j.url, id: j.id };
}


async function stripeGet(env, path) {
  const resp = await fetch("https://api.stripe.com/v1" + path, {
    headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const j = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(j?.error?.message || `Stripe GET ${path} failed (${resp.status})`);
  return j;
}

async function verifyStripeSignature(request, env, rawBody) {
  // Stripe-Signature: t=timestamp,v1=hexsig[,v1=hexsig2...]
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET env eksik");
  const header = request.headers.get("Stripe-Signature") || "";
  if (!header) throw new Error("Stripe-Signature header eksik");

  const parts = header.split(",").map(s => s.trim());
  const tPart = parts.find(p => p.startsWith("t="));
  const v1Parts = parts.filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  if (!tPart || v1Parts.length === 0) throw new Error("Stripe-Signature format hatalı");

  const timestamp = Number(tPart.slice(2));
  if (!Number.isFinite(timestamp)) throw new Error("Stripe timestamp geçersiz");

  // Replay protection
  const tolerance = Number(env.STRIPE_WEBHOOK_TOLERANCE_SECONDS || "300");
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) throw new Error("Stripe webhook timestamp tolerans dışı");

  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const sigHex = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2,"0")).join("");

  const safeEq = (a,b) => {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i=0;i<a.length;i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    return diff === 0;
  };
  const ok = v1Parts.some(v1 => safeEq(v1, sigHex));
  if (!ok) throw new Error("Stripe webhook imza doğrulaması başarısız");
  return true;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(str)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}


async function grantCreditsBothStores(env, userId, amount) {
  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO credits (user_id, balance, updated_at) VALUES (?, 0, ?)")
    .bind(userId, now).run();
  await env.DB.prepare("UPDATE credits SET balance = balance + ?, updated_at = ? WHERE user_id = ?")
    .bind(amount, now, userId).run();

  try {
    const id = env.CREDIT_COUNTER.idFromName(userId);
    const d  = env.CREDIT_COUNTER.get(id);
    await d.fetch("https://do/grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount }),
    });
  } catch (_) {}
}

async function setRole(env, userId, role) {
  await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, userId).run();
}

export async function handleStripeWebhook(request, env) {
  const raw = await request.text();
  try {
    await verifyStripeSignature(request, env, raw);

    const event = JSON.parse(raw);

    // ------------------------------------------------------------
    // Idempotency / replay safety (Stripe may retry the same event)
    // ------------------------------------------------------------
    const eventId = event?.id ? String(event.id) : null;
    if (eventId) {
      try {
        await env.DB.prepare(
          `INSERT INTO processed_events (event_id, event_type, received_at, raw_sha256)
           VALUES (?1, ?2, ?3, ?4)`
        )
          .bind(eventId, String(event?.type || ""), Date.now(), await sha256Hex(raw))
          .run();
      } catch (e) {
        const msg = String(e?.message || e).toLowerCase();
        if (msg.includes("unique") || msg.includes("constraint") || msg.includes("primary")) {
          return json({ ok: true, replay: true }, 200, env, request);
        }
        throw e;
      }
    }
    const type = event?.type;

    // ---- 1) One-time purchase ----
    // checkout.session.completed fires for both payment + subscription checkout.
    if (type === "checkout.session.completed") {
      const s = event.data.object;
      const userId = s?.metadata?.user_id;
      const plan = (s?.metadata?.plan || "credits100").toLowerCase();
      const sessionId = s?.id;

      // Save Stripe customer id early (makes subscription linking faster)
      const customerId = s?.customer;
      if (userId && customerId) {
        try {
          await env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?")
            .bind(String(customerId), userId).run();
        } catch (_) {}
      }

      if (userId && sessionId) {
        const cfg = planConfig(env, plan);

        // If subscription checkout, we do NOT grant here (we grant on invoice.paid).
        if (cfg.mode === "payment") {
          const grant = Number(cfg.packCredits || 0);
          if (grant > 0) {
            await grantCreditsBothStores(env, userId, grant);
            await env.DB.prepare("INSERT INTO transactions (id, user_id, kind, amount, stripe_session_id, created_at) VALUES (?, ?, 'purchase', ?, ?, ?)")
              .bind(crypto.randomUUID(), userId, grant, sessionId, Date.now()).run();
          }
        }
      }
    }

    // ---- 2) Subscription: invoice paid -> monthly refill ----
    // This is the most reliable place to grant monthly credits.
    if (type === "invoice.paid") {
      const inv = event.data.object;
      let userId = inv?.lines?.data?.[0]?.metadata?.user_id || inv?.metadata?.user_id;
      let plan = (inv?.lines?.data?.[0]?.metadata?.plan || inv?.metadata?.plan || "sub_basic").toLowerCase();

      // If metadata did not propagate, fetch subscription/customer metadata from Stripe.
      try {
        if (!userId && inv?.subscription) {
          const sub = await stripeGet(env, `/subscriptions/${inv.subscription}`);
          userId = sub?.metadata?.user_id || userId;
          plan   = (sub?.metadata?.plan || plan);
          if (userId && sub?.customer) {
            await env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?")
              .bind(String(sub.customer), userId).run();
          }
        }
        if (!userId && inv?.customer) {
          const cust = await stripeGet(env, `/customers/${inv.customer}`);
          userId = cust?.metadata?.user_id || userId;
          plan   = (cust?.metadata?.plan || plan);
        }
      } catch (_) {}

      if (userId) {
        const cfg = planConfig(env, plan);
        if (cfg.mode === "subscription") {
          await setRole(env, userId, cfg.role || "basic");
          const grant = Number(cfg.monthlyCredits || 0);
          if (grant > 0) {
            await grantCreditsBothStores(env, userId, grant);
            await env.DB.prepare(
              "INSERT INTO transactions (id, user_id, kind, amount, stripe_session_id, created_at) VALUES (?, ?, 'purchase', ?, ?, ?)"
            ).bind(crypto.randomUUID(), userId, grant, String(inv.id || ""), Date.now()).run();
            await recordRevenueEvent(env, {
              kind: 'subscription_invoice', user_id: userId, stripe_object_id: String(inv.id || ''),
              attribution_id: inv?.metadata?.attribution_id || inv?.lines?.data?.[0]?.metadata?.attribution_id || null,
              plan,
              amount: Number(inv?.amount_paid || inv?.amount_due || 0),
              currency: inv?.currency ? String(inv.currency) : null,
              keyword: inv?.metadata?.keyword || inv?.lines?.data?.[0]?.metadata?.keyword || null,
              seo_slug: inv?.metadata?.seo_slug || inv?.lines?.data?.[0]?.metadata?.seo_slug || null,
              tool_name: inv?.metadata?.tool_name || inv?.lines?.data?.[0]?.metadata?.tool_name || null,
              utm_source: inv?.metadata?.utm_source || inv?.lines?.data?.[0]?.metadata?.utm_source || null,
              utm_campaign: inv?.metadata?.utm_campaign || inv?.lines?.data?.[0]?.metadata?.utm_campaign || null,
              utm_term: inv?.metadata?.utm_term || inv?.lines?.data?.[0]?.metadata?.utm_term || null,
            });
          }
        }
      }
    }

    // ---- 3) Subscription canceled -> downgrade role ----
    if (type === "customer.subscription.deleted") {
      const sub = event.data.object;
      let userId = sub?.metadata?.user_id;

      // fallback: find by customer id if present
      if (!userId && sub?.customer) {
        const row = await env.DB.prepare("SELECT id FROM users WHERE stripe_customer_id = ?")
          .bind(String(sub.customer))
          .first();
        userId = row?.id;
      }

      // fallback: fetch customer metadata
      if (!userId && sub?.customer) {
        try {
          const cust = await stripeGet(env, `/customers/${sub.customer}`);
          userId = cust?.metadata?.user_id || userId;
        } catch (_) {}
      }

      if (userId) await setRole(env, userId, "free");
    }

    return json({ ok: true }, 200, env, request);
  } catch (e) {
    // Monitoring: persist webhook failures for alerting
    try {
      const rawEventId = (() => {
        try { return JSON.parse(raw)?.id; } catch { return null; }
      })();
      const rawType = (() => {
        try { return JSON.parse(raw)?.type; } catch { return null; }
      })();
      await env.DB.prepare(
        `INSERT INTO webhook_failures (id, event_id, event_type, status, error, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      )
        .bind(
          crypto.randomUUID(),
          rawEventId,
          rawType,
          400,
          String(e?.message || e),
          new Date().toISOString()
        )
        .run();
    } catch (_) {}

    return err("WEBHOOK_ERROR", e.message || "Webhook error", 400, env, request);
  }
}
