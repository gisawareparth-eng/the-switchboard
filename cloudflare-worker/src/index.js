const TARGET_ORIGIN = "https://asn-transaction-outlined-intersection.trycloudflare.com";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Bridge-Key, bypass-tunnel-reminder",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    const targetUrl = new URL(url.pathname + url.search, TARGET_ORIGIN);

    // Build forwarded headers
    const newHeaders = new Headers(request.headers);
    newHeaders.set("Host", new URL(TARGET_ORIGIN).host);
    newHeaders.set("X-Forwarded-Host", url.host);
    newHeaders.set("X-Forwarded-Proto", "https");

    try {
      const forwardReq = new Request(targetUrl.toString(), {
        method: request.method,
        headers: newHeaders,
        body: (request.method !== "GET" && request.method !== "HEAD") ? request.body : undefined,
        redirect: "follow",
        cf: {
          cacheTtl: 0,
          cacheEverything: false
        }
      });

      const backendRes = await fetch(forwardReq);

      const resHeaders = new Headers(backendRes.headers);
      resHeaders.set("Access-Control-Allow-Origin", "*");
      resHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      resHeaders.set("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Key, bypass-tunnel-reminder");

      if (url.pathname.startsWith('/api/')) {
        resHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
        resHeaders.set("Pragma", "no-cache");
        resHeaders.set("Expires", "0");
      }

      if (backendRes.headers.get("content-type")?.includes("text/event-stream")) {
        resHeaders.set("Cache-Control", "no-cache, no-transform");
        resHeaders.set("Connection", "keep-alive");
        resHeaders.set("X-Accel-Buffering", "no");
        resHeaders.delete("content-length");
      }

      return new Response(backendRes.body, {
        status: backendRes.status,
        statusText: backendRes.statusText,
        headers: resHeaders
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error: "Switchboard origin connection error",
        message: err.message,
        target: TARGET_ORIGIN,
        timestamp: new Date().toISOString()
      }), {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }
};
