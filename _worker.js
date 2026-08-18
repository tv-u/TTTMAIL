import { DurableObject } from "cloudflare:workers";

/* ============================================================
   TTTMAIL ENTERPRISE TEMP MAIL WORKER
   ------------------------------------------------------------
   Features:
   - Cloudflare KV inbox storage
   - D1 analytics/logging
   - Durable Object WebSocket hibernation
   - Real Cloudflare Email Handler
   - REST API
   - Rate limiting
   - Domain validation
   - Message size limits
   - Inbox/message limits
   - Token reuse
   - CORS
   - Security headers
   - Request validation
   - Automatic KV TTL
   - Real-time new-email events
   ============================================================ */

const DEFAULTS = {
  APP_NAME: "TTTMAIL",
  MAX_EMAIL_TTL: 86400,
  RATE_LIMIT_MAX: 5,
  RATE_LIMIT_WINDOW: 60,
  MAX_MESSAGES: 100,
  MAX_MESSAGE_BODY: 100000,
  MAX_HTML_BODY: 200000,
  MAX_REQUEST_BODY: 300000,
  EMAIL_LOCAL_LENGTH: 12
};

/* ============================================================
   DURABLE OBJECT
   ============================================================ */

export class EmailWebSocket extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;

    /*
      Restore WebSocket metadata after hibernation.
    */
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.deserializeAttachment();
      } catch {}
    }

    /*
      Application-level ping/pong.
      This avoids waking the Durable Object for simple pings.
    */
    try {
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("ping", "pong")
      );
    } catch {}
  }

  async fetch(request) {

    const url = new URL(request.url);

    const email = normalizeEmail(
      url.searchParams.get("email")
    );

    if (!email) {
      return new Response("Missing email", {
        status: 400
      });
    }

    if (
      request.headers.get("Upgrade")?.toLowerCase() !==
      "websocket"
    ) {
      return new Response("Expected WebSocket", {
        status: 426,
        headers: {
          "Upgrade": "websocket"
        }
      });
    }

    const pair = new WebSocketPair();

    const [client, server] = Object.values(pair);

    /*
      Hibernatable WebSocket.
    */
    this.ctx.acceptWebSocket(server, [
      `email:${email}`
    ]);

    /*
      Persist email identity across hibernation.
    */
    server.serializeAttachment({
      email,
      connectedAt: Date.now()
    });

    /*
      Send initial connection state.
    */
    try {

      const inbox = await loadInbox(
        this.env,
        email
      );

      const unread = inbox.messages.filter(
        message => !message.read
      ).length;

      server.send(
        JSON.stringify({
          type: "connected",
          email,
          unread,
          messages: inbox.messages.length,
          timestamp: Date.now()
        })
      );

    } catch {

      try {
        server.send(
          JSON.stringify({
            type: "connected",
            email,
            unread: 0,
            messages: 0,
            timestamp: Date.now()
          })
        );
      } catch {}
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async broadcast(email, payload) {

    const target = normalizeEmail(email);

    if (!target) return false;

    const message = JSON.stringify({
      type: "new_email",
      email: target,
      ...payload
    });

    const sockets = this.ctx.getWebSockets(
      `email:${target}`
    );

    for (const ws of sockets) {

      try {

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        }

      } catch {

        try {
          ws.close(1011, "Broadcast failed");
        } catch {}
      }
    }

    return true;
  }

  async webSocketMessage(ws, message) {

    try {

      const text =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);

      const data = JSON.parse(text);

      if (data?.type === "ping") {

        ws.send(
          JSON.stringify({
            type: "pong",
            timestamp: Date.now()
          })
        );

        return;
      }

      if (data?.type === "status") {

        const attachment =
          ws.deserializeAttachment() || {};

        ws.send(
          JSON.stringify({
            type: "status",
            email: attachment.email || null,
            timestamp: Date.now()
          })
        );

        return;
      }

      ws.send(
        JSON.stringify({
          type: "error",
          error: "Unsupported message type"
        })
      );

    } catch {

      try {

        ws.send(
          JSON.stringify({
            type: "error",
            error: "Invalid WebSocket message"
          })
        );

      } catch {}
    }
  }

  async webSocketClose(
    ws,
    code,
    reason,
    wasClean
  ) {

    /*
      No manual session Set is required.
      Cloudflare maintains hibernatable WebSocket sessions.
    */

    try {

      console.log(
        JSON.stringify({
          event: "websocket_close",
          code,
          reason,
          wasClean,
          timestamp: Date.now()
        })
      );

    } catch {}
  }

  async webSocketError(ws, error) {

    try {

      console.error(
        JSON.stringify({
          event: "websocket_error",
          error: String(error),
          timestamp: Date.now()
        })
      );

    } catch {}
  }
}

/* ============================================================
   MAIN WORKER
   ============================================================ */

export default {

  async fetch(request, env, ctx) {

    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    const requestId =
      request.headers.get("CF-Ray") ||
      crypto.randomUUID();

    const corsHeaders =
      buildCorsHeaders(request);

    if (request.method === "OPTIONS") {

      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {

      /*
        Basic request-size protection.
      */
      const contentLength =
        Number(
          request.headers.get("content-length") || 0
        );

      if (
        contentLength >
        getNumber(
          env.MAX_REQUEST_BODY,
          DEFAULTS.MAX_REQUEST_BODY
        )
      ) {

        return json(
          {
            error: "Request too large",
            requestId
          },
          413,
          corsHeaders
        );
      }

      /* ======================================================
         HEALTH
         ====================================================== */

      if (
        path === "/api/health" &&
        request.method === "GET"
      ) {

        return json(
          {
            status: "ok",
            app:
              env.APP_NAME ||
              DEFAULTS.APP_NAME,
            timestamp: Date.now(),
            requestId
          },
          200,
          corsHeaders
        );
      }

      /* ======================================================
         CREATE EMAIL
         ====================================================== */

      if (
        path === "/api/newemail" &&
        request.method === "POST"
      ) {

        return await createEmail(
          request,
          env,
          requestId,
          corsHeaders
        );
      }

      /* ======================================================
         GET INBOX
         ====================================================== */

      if (
        path === "/api/inbox" &&
        request.method === "GET"
      ) {

        return await getInbox(
          request,
          env,
          requestId,
          corsHeaders
        );
      }

      /* ======================================================
         GET MESSAGE
         ====================================================== */

      if (
        path === "/api/message" &&
        request.method === "GET"
      ) {

        return await getMessage(
          request,
          env,
          requestId,
          corsHeaders
        );
      }

      /* ======================================================
         DELETE MESSAGE
         ====================================================== */

      if (
        path === "/api/message" &&
        request.method === "DELETE"
      ) {

        return await deleteMessage(
          request,
          env,
          requestId,
          corsHeaders
        );
      }

      /* ======================================================
         MARK MESSAGE READ
         ====================================================== */

      if (
        path === "/api/message/read" &&
        request.method === "POST"
      ) {

        return await markMessageRead(
          request,
          env,
          requestId,
          corsHeaders
        );
      }

      /* ======================================================
         REUSE TOKEN
         ====================================================== */

      if (
        path === "/api/reuse" &&
        request.method === "POST"
      ) {

        return await reuseEmail(
          request,
          env,
          requestId,
          corsHeaders
        );
      }

      /* ======================================================
         MANUAL RECEIVE WEBHOOK
         ====================================================== */

      if (
        path === "/api/receive" &&
        request.method === "POST"
      ) {

        return await receiveWebhook(
          request,
          env,
          ctx,
          requestId,
          corsHeaders
        );
      }

      /* ======================================================
         WEBSOCKET
         ====================================================== */

      if (
        path === "/ws" &&
        request.method === "GET"
      ) {

        return await websocketEndpoint(
          request,
          env
        );
      }

      /* ======================================================
         API INFO
         ====================================================== */

      if (
        path === "/api" &&
        request.method === "GET"
      ) {

        return json(
          {
            app:
              env.APP_NAME ||
              DEFAULTS.APP_NAME,

            version: "enterprise-2.0",

            endpoints: {
              health: "GET /api/health",
              newEmail: "POST /api/newemail",
              inbox: "GET /api/inbox?email=",
              message: "GET /api/message?email=&id=",
              deleteMessage:
                "DELETE /api/message?email=&id=",
              markRead:
                "POST /api/message/read",
              reuse: "POST /api/reuse",
              receive:
                "POST /api/receive",
              websocket:
                "GET /ws?email="
            },

            timestamp: Date.now()
          },
          200,
          corsHeaders
        );
      }

      return json(
        {
          error: "Not found",
          requestId
        },
        404,
        corsHeaders
      );

    } catch (error) {

      console.error(
        "Worker request error:",
        error
      );

      return json(
        {
          error: "Internal server error",
          requestId
        },
        500,
        corsHeaders
      );
    }
  },

  /* ==========================================================
     CLOUDFLARE EMAIL HANDLER
     ========================================================== */

  async email(message, env, ctx) {

    const to =
      normalizeEmail(
        message.to
      );

    const from =
      normalizeSender(
        message.from
      );

    const subject =
      sanitizeText(
        message.headers.get("subject") ||
        "(no subject)",
        500
      );

    if (!to) {

      try {
        await message.reject(
          "Invalid recipient"
        );
      } catch {}

      return;
    }

    /*
      Only store email if the inbox actually exists.
      This prevents arbitrary mailbox creation by incoming mail.
    */
    const existing =
      await env.MY_KV.get(
        `email:${to}`
      );

    if (!existing) {

      try {
        await message.reject(
          "Mailbox does not exist"
        );
      } catch {}

      return;
    }

    try {

      /*
        Convert the incoming email to text.
      */
      const raw =
        await new Response(
          message.raw
        ).text();

      const parsed =
        parseRawEmail(
          raw
        );

      const finalSubject =
        parsed.subject ||
        subject;

      const body =
        parsed.text ||
        raw.slice(
          0,
          getNumber(
            env.MAX_MESSAGE_BODY,
            DEFAULTS.MAX_MESSAGE_BODY
          )
        );

      const html =
        parsed.html ||
        "";

      await storeIncomingMessage(
        env,
        ctx,
        {
          to,
          from,
          subject: finalSubject,
          body,
          html
        }
      );

    } catch (error) {

      console.error(
        "Email handler error:",
        error
      );

      /*
        Do not silently create fake success.
      */
      try {
        await message.reject(
          "Temporary processing error"
        );
      } catch {}
    }
  }
};

/* ============================================================
   CREATE EMAIL
   ============================================================ */

async function createEmail(
  request,
  env,
  requestId,
  corsHeaders
) {

  const body =
    await parseJSON(request);

  const domain =
    normalizeDomain(
      body?.domain
    );

  if (!domain) {

    return json(
      {
        error: "Invalid or missing domain",
        requestId
      },
      400,
      corsHeaders
    );
  }

  /*
    Optional allow-list.

    If ALLOWED_DOMAINS is configured:
    only those domains are accepted.

    If not configured:
    the requested domain is accepted.
  */
  if (
    env.ALLOWED_DOMAINS &&
    !isAllowedDomain(
      domain,
      env.ALLOWED_DOMAINS
    )
  ) {

    return json(
      {
        error:
          "Domain is not allowed",
        requestId
      },
      403,
      corsHeaders
    );
  }

  const ip =
    request.headers.get(
      "CF-Connecting-IP"
    ) || "unknown";

  const rate =
    await checkRateLimit(
      env,
      ip
    );

  if (!rate.allowed) {

    return json(
      {
        error:
          "Too many requests. Please try again later.",
        retryAfter:
          rate.retryAfter,
        requestId
      },
      429,
      {
        ...corsHeaders,
        "Retry-After":
          String(rate.retryAfter)
      }
    );
  }

  const maxAttempts = 12;

  let email = null;

  for (
    let attempt = 0;
    attempt < maxAttempts;
    attempt++
  ) {

    const local =
      generateLocalPart(
        getNumber(
          env.EMAIL_LOCAL_LENGTH,
          DEFAULTS.EMAIL_LOCAL_LENGTH
        )
      );

    const candidate =
      `${local}@${domain}`;

    const exists =
      await env.MY_KV.get(
        `email:${candidate}`
      );

    if (!exists) {

      email = candidate;
      break;
    }
  }

  if (!email) {

    return json(
      {
        error:
          "Unable to allocate mailbox. Try again.",
        requestId
      },
      503,
      corsHeaders
    );
  }

  const inbox = {
    version: 1,
    email,
    domain,
    created: Date.now(),
    messages: []
  };

  await env.MY_KV.put(
    `email:${email}`,
    JSON.stringify(inbox),
    {
      expirationTtl:
        getNumber(
          env.MAX_EMAIL_TTL,
          DEFAULTS.MAX_EMAIL_TTL
        )
    }
  );

  const token =
    encodeToken(email);

  /*
    D1 is analytics.
    KV remains the mailbox source of truth.
  */
  if (env.D1_DB) {

    try {

      await env.D1_DB
        .prepare(
          `
          INSERT INTO email_logs
          (
            email,
            domain,
            ip,
            created_at
          )
          VALUES (?, ?, ?, ?)
          `
        )
        .bind(
          email,
          domain,
          ip,
          new Date().toISOString()
        )
        .run();

    } catch (error) {

      console.warn(
        "D1 email log failed:",
        error
      );
    }
  }

  return json(
    {
      success: true,
      email,
      token,
      ws:
        `/ws?email=${encodeURIComponent(email)}`,
      expiresIn:
        getNumber(
          env.MAX_EMAIL_TTL,
          DEFAULTS.MAX_EMAIL_TTL
        ),
      requestId
    },
    201,
    corsHeaders
  );
}

/* ============================================================
   GET INBOX
   ============================================================ */

async function getInbox(
  request,
  env,
  requestId,
  corsHeaders
) {

  const url =
    new URL(request.url);

  const email =
    normalizeEmail(
      url.searchParams.get("email")
    );

  if (!email) {

    return json(
      {
        error:
          "Missing email",
        requestId
      },
      400,
      corsHeaders
    );
  }

  const raw =
    await env.MY_KV.get(
      `email:${email}`
    );

  if (!raw) {

    return json(
      {
        error:
          "Inbox not found",
        requestId
      },
      404,
      corsHeaders
    );
  }

  const inbox =
    safeParseInbox(raw);

  inbox.messages.sort(
    (a, b) =>
      b.timestamp -
      a.timestamp
  );

  return json(
    {
      success: true,
      email,
      messages:
        inbox.messages,
      unread:
        inbox.messages.filter(
          message =>
            !message.read
        ).length,
      requestId
    },
    200,
    corsHeaders
  );
}

/* ============================================================
   GET SINGLE MESSAGE
   ============================================================ */

async function getMessage(
  request,
  env,
  requestId,
  corsHeaders
) {

  const url =
    new URL(request.url);

  const email =
    normalizeEmail(
      url.searchParams.get("email")
    );

  const id =
    sanitizeId(
      url.searchParams.get("id")
    );

  if (!email || !id) {

    return json(
      {
        error:
          "Missing parameters",
        requestId
      },
      400,
      corsHeaders
    );
  }

  const inbox =
    await loadInbox(
      env,
      email
    );

  const message =
    inbox.messages.find(
      item => item.id === id
    );

  if (!message) {

    return json(
      {
        error:
          "Message not found",
        requestId
      },
      404,
      corsHeaders
    );
  }

  return json(
    {
      success: true,
      message,
      requestId
    },
    200,
    corsHeaders
  );
}

/* ============================================================
   DELETE MESSAGE
   ============================================================ */

async function deleteMessage(
  request,
  env,
  requestId,
  corsHeaders
) {

  const url =
    new URL(request.url);

  const email =
    normalizeEmail(
      url.searchParams.get("email")
    );

  const id =
    sanitizeId(
      url.searchParams.get("id")
    );

  if (!email || !id) {

    return json(
      {
        error:
          "Missing parameters",
        requestId
      },
      400,
      corsHeaders
    );
  }

  const inbox =
    await loadInbox(
      env,
      email
    );

  const before =
    inbox.messages.length;

  inbox.messages =
    inbox.messages.filter(
      message =>
        message.id !== id
    );

  if (
    before ===
    inbox.messages.length
  ) {

    return json(
      {
        error:
          "Message not found",
        requestId
      },
      404,
      corsHeaders
    );
  }

  await saveInbox(
    env,
    email,
    inbox
  );

  return json(
    {
      success: true,
      deleted: true,
      requestId
    },
    200,
    corsHeaders
  );
}

/* ============================================================
   MARK READ
   ============================================================ */

async function markMessageRead(
  request,
  env,
  requestId,
  corsHeaders
) {

  const body =
    await parseJSON(request);

  const email =
    normalizeEmail(
      body?.email
    );

  const id =
    sanitizeId(
      body?.id
    );

  if (!email || !id) {

    return json(
      {
        error:
          "Missing email or message id",
        requestId
      },
      400,
      corsHeaders
    );
  }

  const inbox =
    await loadInbox(
      env,
      email
    );

  const message =
    inbox.messages.find(
      item =>
        item.id === id
    );

  if (!message) {

    return json(
      {
        error:
          "Message not found",
        requestId
      },
      404,
      corsHeaders
    );
  }

  message.read = true;

  await saveInbox(
    env,
    email,
    inbox
  );

  return json(
    {
      success: true,
      messageId: id,
      requestId
    },
    200,
    corsHeaders
  );
}

/* ============================================================
   REUSE EMAIL TOKEN
   ============================================================ */

async function reuseEmail(
  request,
  env,
  requestId,
  corsHeaders
) {

  const body =
    await parseJSON(request);

  const token =
    typeof body?.token === "string"
      ? body.token.trim()
      : "";

  if (!token) {

    return json(
      {
        error:
          "Missing token",
        requestId
      },
      400,
      corsHeaders
    );
  }

  let email;

  try {

    email =
      decodeToken(
        token
      );

  } catch {

    return json(
      {
        error:
          "Invalid token",
        requestId
      },
      400,
      corsHeaders
    );
  }

  const exists =
    await env.MY_KV.get(
      `email:${email}`
    );

  if (!exists) {

    return json(
      {
        error:
          "Mailbox expired or does not exist",
        requestId
      },
      404,
      corsHeaders
    );
  }

  return json(
    {
      success: true,
      email,
      ws:
        `/ws?email=${encodeURIComponent(email)}`,
      requestId
    },
    200,
    corsHeaders
  );
}

/* ============================================================
   MANUAL RECEIVE WEBHOOK
   ============================================================ */

async function receiveWebhook(
  request,
  env,
  ctx,
  requestId,
  corsHeaders
) {

  /*
    IMPORTANT:
    This endpoint should be protected with RECEIVE_SECRET
    if you expose it publicly.
  */

  if (env.RECEIVE_SECRET) {

    const supplied =
      request.headers.get(
        "Authorization"
      );

    if (
      supplied !==
      `Bearer ${env.RECEIVE_SECRET}`
    ) {

      return json(
        {
          error:
            "Unauthorized",
          requestId
        },
        401,
        corsHeaders
      );
    }
  }

  const payload =
    await parseJSON(request);

  if (
    !payload?.to ||
    !payload?.from
  ) {

    return json(
      {
        error:
          "Invalid payload",
        requestId
      },
      400,
      corsHeaders
    );
  }

  const email =
    normalizeEmail(
      payload.to
    );

  const from =
    normalizeSender(
      payload.from
    );

  if (!email || !from) {

    return json(
      {
        error:
          "Invalid email payload",
        requestId
      },
      400,
      corsHeaders
    );
  }

  const existing =
    await env.MY_KV.get(
      `email:${email}`
    );

  if (!existing) {

    return json(
      {
        error:
          "Mailbox not found",
        requestId
      },
      404,
      corsHeaders
    );
  }

  const result =
    await storeIncomingMessage(
      env,
      ctx,
      {
        to: email,
        from,
        subject:
          payload.subject ||
          "(no subject)",
        body:
          payload.body ||
          "",
        html:
          payload.html ||
          ""
      }
    );

  return json(
    {
      success: true,
      messageId:
        result.id,
      requestId
    },
    201,
    corsHeaders
  );
}

/* ============================================================
   WEBSOCKET ENDPOINT
   ============================================================ */

async function websocketEndpoint(
  request,
  env
) {

  if (
    request.headers.get(
      "Upgrade"
    )?.toLowerCase() !==
    "websocket"
  ) {

    return new Response(
      "Expected WebSocket",
      {
        status: 426,
        headers: {
          "Upgrade": "websocket"
        }
      }
    );
  }

  const url =
    new URL(request.url);

  const email =
    normalizeEmail(
      url.searchParams.get(
        "email"
      )
    );

  if (!email) {

    return new Response(
      "Missing email",
      {
        status: 400
      }
    );
  }

  const exists =
    await env.MY_KV.get(
      `email:${email}`
    );

  if (!exists) {

    return new Response(
      "Mailbox not found",
      {
        status: 404
      }
    );
  }

  const id =
    env.EMAIL_WS.idFromName(
      email
    );

  const stub =
    env.EMAIL_WS.get(id);

  return stub.fetch(
    request
  );
}

/* ============================================================
   STORE INCOMING MESSAGE
   ============================================================ */

async function storeIncomingMessage(
  env,
  ctx,
  data
) {

  const email =
    normalizeEmail(
      data.to
    );

  const inbox =
    await loadInbox(
      env,
      email
    );

  const maxMessages =
    getNumber(
      env.MAX_MESSAGES,
      DEFAULTS.MAX_MESSAGES
    );

  const maxBody =
    getNumber(
      env.MAX_MESSAGE_BODY,
      DEFAULTS.MAX_MESSAGE_BODY
    );

  const maxHtml =
    getNumber(
      env.MAX_HTML_BODY,
      DEFAULTS.MAX_HTML_BODY
    );

  const message = {

    id:
      generateId(),

    from:
      normalizeSender(
        data.from
      ),

    subject:
      sanitizeText(
        data.subject ||
        "(no subject)",
        500
      ),

    body:
      String(
        data.body || ""
      ).slice(
        0,
        maxBody
      ),

    html:
      String(
        data.html || ""
      ).slice(
        0,
        maxHtml
      ),

    timestamp:
      Date.now(),

    read:
      false
  };

  /*
    Prevent unlimited KV growth.
  */
  inbox.messages.push(
    message
  );

  inbox.messages.sort(
    (a, b) =>
      b.timestamp -
      a.timestamp
  );

  if (
    inbox.messages.length >
    maxMessages
  ) {

    inbox.messages =
      inbox.messages.slice(
        0,
        maxMessages
      );
  }

  await saveInbox(
    env,
    email,
    inbox
  );

  /*
    Real-time WebSocket notification.
  */
  ctx.waitUntil(
    broadcastNewEmail(
      env,
      email,
      message
    )
  );

  /*
    D1 analytics.
  */
  if (env.D1_DB) {

    ctx.waitUntil(
      logMessageToD1(
        env,
        email,
        message
      )
    );
  }

  return message;
}

/* ============================================================
   BROADCAST
   ============================================================ */

async function broadcastNewEmail(
  env,
  email,
  message
) {

  try {

    const id =
      env.EMAIL_WS.idFromName(
        email
      );

    const stub =
      env.EMAIL_WS.get(id);

    await stub.broadcast(
      email,
      {
        id:
          message.id,

        from:
          message.from,

        subject:
          message.subject,

        timestamp:
          message.timestamp
      }
    );

  } catch (error) {

    console.warn(
      "WebSocket broadcast failed:",
      error
    );
  }
}

/* ============================================================
   D1 MESSAGE LOG
   ============================================================ */

async function logMessageToD1(
  env,
  email,
  message
) {

  try {

    await env.D1_DB
      .prepare(
        `
        INSERT INTO messages
        (
          email,
          message_id,
          from_addr,
          subject,
          received_at
        )
        VALUES (?, ?, ?, ?, ?)
        `
      )
      .bind(
        email,
        message.id,
        message.from,
        message.subject,
        new Date().toISOString()
      )
      .run();

  } catch (error) {

    console.warn(
      "D1 message log failed:",
      error
    );
  }
}

/* ============================================================
   LOAD INBOX
   ============================================================ */

async function loadInbox(
  env,
  email
) {

  const normalized =
    normalizeEmail(
      email
    );

  if (!normalized) {

    return {
      version: 1,
      email: "",
      created: Date.now(),
      messages: []
    };
  }

  const raw =
    await env.MY_KV.get(
      `email:${normalized}`
    );

  if (!raw) {

    return {
      version: 1,
      email: normalized,
      created: Date.now(),
      messages: []
    };
  }

  return safeParseInbox(
    raw
  );
}

/* ============================================================
   SAVE INBOX
   ============================================================ */

async function saveInbox(
  env,
  email,
  inbox
) {

  const normalized =
    normalizeEmail(
      email
    );

  if (!normalized) {
    throw new Error(
      "Invalid email"
    );
  }

  const ttl =
    getNumber(
      env.MAX_EMAIL_TTL,
      DEFAULTS.MAX_EMAIL_TTL
    );

  await env.MY_KV.put(
    `email:${normalized}`,
    JSON.stringify(
      inbox
    ),
    {
      expirationTtl:
        ttl
    }
  );
}

/* ============================================================
   RATE LIMIT
   ============================================================ */

async function checkRateLimit(
  env,
  ip
) {

  const max =
    getNumber(
      env.RATE_LIMIT_MAX,
      DEFAULTS.RATE_LIMIT_MAX
    );

  const window =
    getNumber(
      env.RATE_LIMIT_WINDOW,
      DEFAULTS.RATE_LIMIT_WINDOW
    );

  const key =
    `rate:${hashKey(ip)}`;

  const current =
    Number(
      await env.MY_KV.get(
        key
      ) || 0
    );

  if (
    current >= max
  ) {

    return {
      allowed: false,
      retryAfter: window
    };
  }

  await env.MY_KV.put(
    key,
    String(
      current + 1
    ),
    {
      expirationTtl:
        window
    }
  );

  return {
    allowed: true,
    retryAfter: 0
  };
}

/* ============================================================
   DOMAIN VALIDATION
   ============================================================ */

function normalizeDomain(
  value
) {

  if (
    typeof value !==
    "string"
  ) {
    return null;
  }

  const domain =
    value
      .trim()
      .toLowerCase();

  if (
    domain.length < 3 ||
    domain.length > 253
  ) {
    return null;
  }

  if (
    domain.includes("@") ||
    domain.includes("/") ||
    domain.includes("\\") ||
    domain.includes(" ")
  ) {
    return null;
  }

  const labels =
    domain.split(".");

  if (
    labels.length < 2
  ) {
    return null;
  }

  for (
    const label of labels
  ) {

    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
        .test(label)
    ) {
      return null;
    }
  }

  return domain;
}

/* ============================================================
   ALLOWED DOMAINS
   ============================================================ */

function isAllowedDomain(
  domain,
  configured
) {

  const allowed =
    String(
      configured || ""
    )
      .split(",")
      .map(
        item =>
          normalizeDomain(
            item
          )
      )
      .filter(Boolean);

  return allowed.includes(
    domain
  );
}

/* ============================================================
   EMAIL NORMALIZATION
   ============================================================ */

function normalizeEmail(
  value
) {

  if (
    typeof value !==
    "string"
  ) {
    return null;
  }

  const email =
    value
      .trim()
      .toLowerCase();

  if (
    email.length < 5 ||
    email.length > 320
  ) {
    return null;
  }

  const match =
    /^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/
      .exec(email);

  if (!match) {
    return null;
  }

  return email;
}

/* ============================================================
   SENDER NORMALIZATION
   ============================================================ */

function normalizeSender(
  value
) {

  if (
    typeof value !==
    "string"
  ) {
    return "";
  }

  return value
    .trim()
    .slice(
      0,
      320
    );
}

/* ============================================================
   JSON PARSER
   ============================================================ */

async function parseJSON(
  request
) {

  try {

    return await request.json();

  } catch {

    return null;
  }
}

/* ============================================================
   SAFE INBOX PARSER
   ============================================================ */

function safeParseInbox(
  raw
) {

  try {

    const parsed =
      JSON.parse(
        raw
      );

    if (
      !parsed ||
      typeof parsed !==
      "object"
    ) {
      throw new Error(
        "Invalid inbox"
      );
    }

    if (
      !Array.isArray(
        parsed.messages
      )
    ) {

      parsed.messages =
        [];
    }

    return parsed;

  } catch {

    return {
      version: 1,
      created: Date.now(),
      messages: []
    };
  }
}

/* ============================================================
   TOKEN
   ============================================================ */

function encodeToken(
  email
) {

  const bytes =
    new TextEncoder().encode(
      email
    );

  let binary = "";

  for (
    const byte of bytes
  ) {

    binary +=
      String.fromCharCode(
        byte
      );
  }

  return btoa(
    binary
  )
    .replace(
      /\+/g,
      "-"
    )
    .replace(
      /\//g,
      "_"
    )
    .replace(
      /=+$/,
      ""
    );
}

function decodeToken(
  token
) {

  const normalized =
    token
      .replace(
        /-/g,
        "+"
      )
      .replace(
        /_/g,
        "/"
      );

  const padded =
    normalized +
    "=".repeat(
      (4 -
        normalized.length % 4) %
        4
    );

  const binary =
    atob(
      padded
    );

  const bytes =
    Uint8Array.from(
      binary,
      char =>
        char.charCodeAt(
          0
        )
    );

  const email =
    new TextDecoder().decode(
      bytes
    );

  const normalizedEmail =
    normalizeEmail(
      email
    );

  if (!normalizedEmail) {

    throw new Error(
      "Invalid token email"
    );
  }

  return normalizedEmail;
}

/* ============================================================
   ID
   ============================================================ */

function generateId() {

  if (
    typeof crypto !==
      "undefined" &&
    typeof crypto.randomUUID ===
      "function"
  ) {

    return crypto.randomUUID();
  }

  return (
    Date.now().toString(36) +
    "-" +
    Math.random()
      .toString(36)
      .slice(2, 12)
  );
}

/* ============================================================
   LOCAL PART
   ============================================================ */

function generateLocalPart(
  length = 12
) {

  const chars =
    "abcdefghijklmnopqrstuvwxyz0123456789";

  const random =
    new Uint32Array(
      length
    );

  crypto.getRandomValues(
    random
  );

  let output = "";

  for (
    let i = 0;
    i < length;
    i++
  ) {

    output +=
      chars[
        random[i] %
          chars.length
      ];
  }

  return output;
}

/* ============================================================
   MESSAGE ID
   ============================================================ */

function sanitizeId(
  value
) {

  if (
    typeof value !==
    "string"
  ) {
    return null;
  }

  const id =
    value.trim();

  if (
    id.length < 3 ||
    id.length > 128
  ) {
    return null;
  }

  if (
    !/^[a-zA-Z0-9._:-]+$/.test(
      id
    )
  ) {
    return null;
  }

  return id;
}

/* ============================================================
   TEXT SANITIZER
   ============================================================ */

function sanitizeText(
  value,
  maxLength
) {

  return String(
    value ?? ""
  )
    .replace(
      /\u0000/g,
      ""
    )
    .slice(
      0,
      maxLength
    )
    .trim();
}

/* ============================================================
   RAW EMAIL PARSER
   ------------------------------------------------------------
   Lightweight parser.
   Full MIME parsing is intentionally not attempted here.
   The raw message is still preserved in bounded text form.
   ============================================================ */

function parseRawEmail(
  raw
) {

  const normalized =
    String(
      raw || ""
    ).replace(
      /\r\n/g,
      "\n"
    );

  const separator =
    normalized.indexOf(
      "\n\n"
    );

  const headers =
    separator >= 0
      ? normalized.slice(
          0,
          separator
        )
      : normalized;

  const body =
    separator >= 0
      ? normalized.slice(
          separator + 2
        )
      : "";

  const subject =
    decodeMimeHeader(
      extractHeader(
        headers,
        "subject"
      )
    );

  const contentType =
    extractHeader(
      headers,
      "content-type"
    );

  /*
    For simple text/plain messages.
  */
  if (
    /text\/plain/i.test(
      contentType
    ) ||
    !contentType
  ) {

    return {
      subject,
      text:
        body.slice(
          0,
          DEFAULTS.MAX_MESSAGE_BODY
        ),
      html: ""
    };
  }

  /*
    For HTML messages, keep bounded body.
    Complex MIME multipart parsing should be handled
    by a dedicated MIME parser if full attachment support
    is required.
  */
  if (
    /text\/html/i.test(
      contentType
    )
  ) {

    return {
      subject,
      text: stripHtml(
        body
      ).slice(
        0,
        DEFAULTS.MAX_MESSAGE_BODY
      ),
      html:
        body.slice(
          0,
          DEFAULTS.MAX_HTML_BODY
        )
    };
  }

  return {
    subject,
    text:
      body.slice(
        0,
        DEFAULTS.MAX_MESSAGE_BODY
      ),
    html: ""
  };
}

/* ============================================================
   HEADER EXTRACTION
   ============================================================ */

function extractHeader(
  headers,
  name
) {

  const lines =
    headers.split(
      "\n"
    );

  let value = "";
  let collecting = false;

  for (
    const line of lines
  ) {

    if (
      /^[ \t]/.test(
        line
      ) &&
      collecting
    ) {

      value +=
        " " +
        line.trim();

      continue;
    }

    const index =
      line.indexOf(
        ":"
      );

    if (
      index === -1
    ) {

      collecting =
        false;

      continue;
    }

    const key =
      line
        .slice(
          0,
          index
        )
        .trim()
        .toLowerCase();

    if (
      key ===
      name.toLowerCase()
    ) {

      value =
        line
          .slice(
            index + 1
          )
          .trim();

      collecting =
        true;

    } else {

      collecting =
        false;
    }
  }

  return value;
}

/* ============================================================
   MIME HEADER DECODE
   ============================================================ */

function decodeMimeHeader(
  value
) {

  if (!value) {
    return "";
  }

  return value
    .replace(
      /=\?UTF-8\?B\?([^?]+)\?=/gi,
      (_, encoded) => {

        try {

          const binary =
            atob(
              encoded
            );

          const bytes =
            Uint8Array.from(
              binary,
              char =>
                char.charCodeAt(
                  0
                )
            );

          return new TextDecoder()
            .decode(
              bytes
            );

        } catch {

          return encoded;
        }
      }
    )
    .replace(
      /=\?UTF-8\?Q\?([^?]+)\?=/gi,
      (_, encoded) =>
        encoded
          .replace(
            /_/g,
            " "
          )
          .replace(
            /=([0-9A-F]{2})/gi,
            (_, hex) =>
              String.fromCharCode(
                parseInt(
                  hex,
                  16
                )
              )
          )
    );
}

/* ============================================================
   HTML STRIPPER
   ============================================================ */

function stripHtml(
  html
) {

  return String(
    html || ""
  )
    .replace(
      /<script[\s\S]*?<\/script>/gi,
      " "
    )
    .replace(
      /<style[\s\S]*?<\/style>/gi,
      " "
    )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

/* ============================================================
   HASH KEY
   ============================================================ */

async function sha256(
  value
) {

  const data =
    new TextEncoder().encode(
      value
    );

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );

  return Array.from(
    new Uint8Array(
      digest
    )
  )
    .map(
      byte =>
        byte
          .toString(16)
          .padStart(
            2,
            "0"
          )
    )
    .join("");
}

function hashKey(
  value
) {

  /*
    Deterministic short key.
    This is not cryptographic protection.
    It is only used to avoid putting raw IP strings
    directly into KV keys.
  */

  let hash = 2166136261;

  for (
    let i = 0;
    i < value.length;
    i++
  ) {

    hash ^=
      value.charCodeAt(
        i
      );

    hash =
      Math.imul(
        hash,
        16777619
      );
  }

  return (
    hash >>> 0
  ).toString(36);
}

/* ============================================================
   NUMBER CONFIG
   ============================================================ */

function getNumber(
  value,
  fallback
) {

  const number =
    Number(
      value
    );

  if (
    !Number.isFinite(
      number
    ) ||
    number <= 0
  ) {

    return fallback;
  }

  return Math.floor(
    number
  );
}

/* ============================================================
   PATH
   ============================================================ */

function normalizePath(
  pathname
) {

  if (
    typeof pathname !==
    "string"
  ) {

    return "/";
  }

  if (
    pathname.length > 1 &&
    pathname.endsWith("/")
  ) {

    return pathname.slice(
      0,
      -1
    );
  }

  return pathname;
}

/* ============================================================
   CORS
   ============================================================ */

function buildCorsHeaders(
  request
) {

  const origin =
    request.headers.get(
      "Origin"
    );

  /*
    For production, set ALLOWED_ORIGIN in environment
    instead of permanently using *.
  */

  const allowedOrigin =
    request.cf?.colo
      ? origin || "*"
      : origin || "*";

  return {

    "Access-Control-Allow-Origin":
      allowedOrigin,

    "Access-Control-Allow-Methods":
      "GET,POST,DELETE,OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",

    "Access-Control-Max-Age":
      "86400",

    "Vary":
      "Origin",

    "X-Content-Type-Options":
      "nosniff",

    "Referrer-Policy":
      "strict-origin-when-cross-origin",

    "Cache-Control":
      "no-store"
  };
}

/* ============================================================
   JSON RESPONSE
   ============================================================ */

function json(
  data,
  status,
  headers
) {

  return new Response(
    JSON.stringify(
      data
    ),
    {
      status,
      headers: {
        ...headers,
        "Content-Type":
          "application/json; charset=UTF-8"
      }
    }
  );
}
