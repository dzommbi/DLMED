const ALLOWED_METHODS = "POST, OPTIONS";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

async function hmacFingerprint(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = String(env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (!origin || !allowedOrigins.includes(origin)) {
      return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, origin);
    }

    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip || !env.IP_HASH_SECRET || !env.DB) {
      return jsonResponse({ error: "Counter is not configured" }, 503, origin);
    }

    try {
      const now = Date.now();
      const onlineCutoff = now - 90000;
      const onlineHash = await hmacFingerprint(env.IP_HASH_SECRET, "online:" + ip);

      await env.DB.batch([
        env.DB.prepare("INSERT INTO online_visitors (visitor_hash, last_seen) VALUES (?, ?) ON CONFLICT(visitor_hash) DO UPDATE SET last_seen = excluded.last_seen").bind(onlineHash, now),
        env.DB.prepare("DELETE FROM online_visitors WHERE last_seen < ?").bind(onlineCutoff)
      ]);

      const onlineRow = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM online_visitors WHERE last_seen >= ?"
      ).bind(onlineCutoff).first();

      return jsonResponse({ online: Number(onlineRow?.count || 0) }, 200, origin);
    } catch (_) {
      return jsonResponse({ error: "Counter temporarily unavailable" }, 503, origin);
    }
  }
};