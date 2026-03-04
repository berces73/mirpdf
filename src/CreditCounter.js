// ============================================================
// src/CreditCounter.js — Durable Object (Credits + opId lock)
// V4.1 Hardened:
// - Daily credit top-up (FREE_DAILY_CREDITS)
// - Server-side cost enforcement
// - Refund endpoint (dispatch failures)
// ============================================================
export class CreditCounter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  static COSTS = {
    merge: 1, compress: 1, split: 1, rotate: 1,
    extract: 1, reorder: 1, watermark: 1,
    convert: 2, protect: 2, unlock: 3,
    "pdf-to-word": 4,
    "ocr": 4,
    "compress-strong": 3,
  };

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/status" && request.method === "GET") {
      await this._ensureDailyCredits();
      return this._json({ ok: true, data: await this._getState() });
    }

    if (path === "/consume" && request.method === "POST") {
      await this._ensureDailyCredits();

      const body = await request.json().catch(() => ({}));
      const tool = String(body.tool || "");
      const opId = body.opId ? String(body.opId) : null;

      const trueCost = CreditCounter.COSTS[tool] ?? Number(body.cost || 1);

      if (opId) {
        const locked = await this._isOpLocked(opId);
        if (!locked) return this._json({ ok: false, error: "OP_NOT_LOCKED" }, 409);
      }

      const ok = await this._consume(trueCost);
      if (!ok) return this._json({ ok: false, error: "INSUFFICIENT_CREDITS" }, 402);
      return this._json({ ok: true, cost: trueCost });
    }

    if (path === "/refund" && request.method === "POST") {
      await this._ensureDailyCredits();
      const body = await request.json().catch(() => ({}));
      const tool = String(body.tool || "");
      // K5: Idempotency — one refund per jobId; prevents double-refund on retries
      const jobId = String(body.jobId || "").trim();
      if (jobId) {
        const refundKey = `refund:${jobId}`;
        const alreadyRefunded = await this.state.storage.get(refundKey);
        if (alreadyRefunded) {
          return this._json({ ok: true, refunded: 0, idempotent: true });
        }
        // TTL 48h — job TTL is 1h, generous buffer
        await this.state.storage.put(refundKey, true, { expirationTtl: 172800 });
      }
      const trueCost = CreditCounter.COSTS[tool] ?? Number(body.cost || 1);
      await this._add(trueCost);
      return this._json({ ok: true, refunded: trueCost });
    }


    if (path === "/grant" && request.method === "POST") {
      // Admin / billing credit grant (e.g., Stripe webhook)
      const body = await request.json().catch(() => ({}));
      const amount = Number(body.amount || 0);
      if (!Number.isFinite(amount) || amount <= 0) return this._json({ ok: false, error: "BAD_AMOUNT" }, 400);
      const maxGrant = Number(this.env.MAX_GRANT_CREDITS || "100000");
      if (amount > maxGrant) return this._json({ ok: false, error: "AMOUNT_TOO_LARGE" }, 400);
      await this._add(Math.floor(amount));
      return this._json({ ok: true, granted: Math.floor(amount) });
    }

    if (path === "/lock-op" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const opId = String(body.opId || "").trim();
      const ttlMs = Math.min(Math.max(Number(body.ttlMs || 600000), 10000), 3600000);
      if (!opId || opId.length > 128) return this._json({ ok: false, error: "BAD_OPID" }, 400);

      const key = `op:${opId}`;
      const now = Date.now();
      const existing = await this.state.storage.get(key);
      if (existing && existing.expiresAt && existing.expiresAt > now) {
        return this._json({ ok: false, error: "OP_ALREADY_LOCKED" }, 409);
      }
      await this.state.storage.put(key, { expiresAt: now + ttlMs });
      return this._json({ ok: true, ttlMs });
    }

    if (path === "/finalize-op" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const opId = String(body.opId || "").trim();
      if (!opId || opId.length > 128) return this._json({ ok: false, error: "BAD_OPID" }, 400);
      await this.state.storage.delete(`op:${opId}`);
      return this._json({ ok: true });
    }

    return this._json({ ok: false, error: "NOT_FOUND" }, 404);
  }

  async _ensureDailyCredits() {
    const day = new Date().toISOString().slice(0, 10);
    const daily = Number(this.env.FREE_DAILY_CREDITS || "5");
    await this.state.storage.transaction(async (tx) => {
      const lastDay = await tx.get("lastDay");
      if (lastDay === day) return;
      const cur = (await tx.get("credits")) ?? 0;
      await tx.put("credits", Math.max(cur, daily));
      await tx.put("lastDay", day);
    });
  }

  async _getState() {
    const credits = (await this.state.storage.get("credits")) ?? 0;
    const lastDay = (await this.state.storage.get("lastDay")) ?? null;
    return { credits, lastDay };
  }

  async _consume(cost) {
    return await this.state.storage.transaction(async (tx) => {
      const cur = (await tx.get("credits")) ?? 0;
      if (cur < cost) return false;
      await tx.put("credits", cur - cost);
      return true;
    });
  }

  async _add(amount) {
    await this.state.storage.transaction(async (tx) => {
      const cur = (await tx.get("credits")) ?? 0;
      await tx.put("credits", cur + amount);
    });
  }

  async _isOpLocked(opId) {
    const v = await this.state.storage.get(`op:${opId}`);
    if (!v || !v.expiresAt) return false;
    if (v.expiresAt <= Date.now()) {
      await this.state.storage.delete(`op:${opId}`);
      return false;
    }
    return true;
  }

  _json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
