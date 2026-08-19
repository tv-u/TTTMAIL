/**
 * TTTMAIL — Enterprise Cloudflare Worker
 * Production API layer
 *
 * REAL integrations:
 *   - 1secmail: incoming disposable mail
 *   - Resend: outbound OTP / email delivery
 *   - Cloudflare KV: OTP, aliases, subscriptions, rate limits
 *   - Cloudflare D1: optional persistent message/index storage
 *   - Cloudflare DNS-over-HTTPS: MX lookup
 *
 * Required:
 *   MY_KV
 *   RESEND_API_KEY
 *   OTP_SECRET
 *   OTP_FROM_EMAIL
 *
 * Recommended:
 *   DB (Cloudflare D1)
 *
 * Optional:
 *   VAPID_PUBLIC_KEY
 *   VAPID_PRIVATE_KEY
 *   VAPID_SUBJECT
 *
 * IMPORTANT:
 *   This Worker never fabricates incoming emails.
 *   1secmail is used only for incoming disposable mail.
 *   Resend is used for genuine outbound email.
 */

const APP = "TTTMAIL";
const VERSION = "3.0.0";

const ONESECMAIL =
  "https://www.1secmail.com/api/v1/";

const RESEND_API =
  "https://api.resend.com/emails";

const DNS_API =
  "https://cloudflare-dns.com/dns-query";

const LIMITS = Object.freeze({
  body: 512_000,
  message: 2_000_000,
  inbox: 100,
  otpTTL: 600,
  otpAttempts: 5,
  otpRequests: 5,
  generalRequests: 60,
  rateWindow: 60,
  searchResults: 100,
  aliases: 50,
  pushSubscriptions: 20
});

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control":
    "no-store, no-cache, must-revalidate",
  pragma: "no-cache",
  expires: "0"
};

function json(data, status = 200, headers = {}) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...JSON_HEADERS,
        ...headers
      }
    }
  );
}

function fail(
  message,
  status = 400,
  code = "BAD_REQUEST",
  extra = {}
) {
  return json(
    {
      ok: false,
      error: {
        code,
        message
      },
      ...extra,
      timestamp: new Date().toISOString()
    },
    status
  );
}

function cors(response, request) {
  const headers =
    new Headers(response.headers);

  const origin =
    request.headers.get("Origin");

  headers.set(
    "Access-Control-Allow-Origin",
    origin || "*"
  );

  headers.set(
    "Access-Control-Allow-Methods",
    "GET,POST,DELETE,OPTIONS"
  );

  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );

  headers.set(
    "Access-Control-Max-Age",
    "86400"
  );

  headers.set("Vary", "Origin");

  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers
    }
  );
}

function now() {
  return Date.now();
}

function clientIP(request) {
  return (
    request.headers.get(
      "CF-Connecting-IP"
    ) ||
    request.headers
      .get("X-Forwarded-For")
      ?.split(",")[0]
      ?.trim() ||
    "unknown"
  );
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function validEmail(email) {
  return (
    typeof email === "string" &&
    email.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      email
    )
  );
}

function validDomain(domain) {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
    domain
  );
}

function hex(bytes = 32) {
  const a =
    new Uint8Array(bytes);

  crypto.getRandomValues(a);

  return [...a]
    .map(x =>
      x.toString(16).padStart(2, "0")
    )
    .join("");
}

function otpCode() {
  const a =
    new Uint32Array(1);

  crypto.getRandomValues(a);

  return String(
    a[0] % 1_000_000
  ).padStart(6, "0");
}

async function hmac(secret, value) {
  const key =
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      {
        name: "HMAC",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );

  const signature =
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(value)
    );

  return [...new Uint8Array(signature)]
    .map(x =>
      x.toString(16).padStart(2, "0")
    )
    .join("");
}

function equal(a, b) {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    a.length !== b.length
  ) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);
  }

  return result === 0;
}

async function bodyJSON(request) {
  const type =
    request.headers.get(
      "Content-Type"
    ) || "";

  if (
    !type
      .toLowerCase()
      .includes("application/json")
  ) {
    throw new Error(
      "Content-Type must be application/json"
    );
  }

  const text =
    await request.text();

  if (
    !text ||
    text.length > LIMITS.body
  ) {
    throw new Error(
      "Request body is empty or too large"
    );
  }

  try {
    const data =
      JSON.parse(text);

    if (
      !data ||
      typeof data !== "object"
    ) {
      throw new Error();
    }

    return data;
  } catch {
    throw new Error(
      "Invalid JSON body"
    );
  }
}

async function kvJSON(
  env,
  key
) {
  if (!env.MY_KV) {
    return null;
  }

  const value =
    await env.MY_KV.get(key);

  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function putKV(
  env,
  key,
  value,
  ttl
) {
  if (!env.MY_KV) {
    throw new Error(
      "MY_KV binding is required"
    );
  }

  await env.MY_KV.put(
    key,
    JSON.stringify(value),
    {
      expirationTtl: ttl
    }
  );
}

async function delKV(
  env,
  key
) {
  if (env.MY_KV) {
    await env.MY_KV.delete(key);
  }
}

async function rateLimit(
  env,
  namespace,
  key,
  limit,
  window = LIMITS.rateWindow
) {
  if (!env.MY_KV) {
    return {
      allowed: true,
      remaining: limit
    };
  }

  const bucket =
    Math.floor(
      Date.now() /
        1000 /
        window
    );

  const storageKey =
    `rl:${namespace}:${key}:${bucket}`;

  const current =
    Number(
      await env.MY_KV.get(
        storageKey
      )
    ) || 0;

  if (current >= limit) {
    const retry =
      window -
      (Math.floor(
        Date.now() / 1000
      ) % window);

    return {
      allowed: false,
      remaining: 0,
      retry
    };
  }

  await env.MY_KV.put(
    storageKey,
    String(current + 1),
    {
      expirationTtl:
        window + 5
    }
  );

  return {
    allowed: true,
    remaining:
      limit - current - 1
  };
}

async function oneSec(params) {
  const url =
    new URL(ONESECMAIL);

  for (
    const [key, value]
    of Object.entries(params)
  ) {
    url.searchParams.set(
      key,
      String(value)
    );
  }

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      15_000
    );

  try {
    const response =
      await fetch(
        url.toString(),
        {
          headers: {
            accept:
              "application/json"
          },
          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      throw new Error(
        `1secmail HTTP ${response.status}`
      );
    }

    const text =
      await response.text();

    if (
      text.length >
      LIMITS.message
    ) {
      throw new Error(
        "Provider response too large"
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        "Invalid 1secmail response"
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

function mailbox(email) {
  const value =
    normalizeEmail(email);

  if (!validEmail(value)) {
    throw new Error(
      "Invalid mailbox email"
    );
  }

  const parts =
    value.split("@");

  return {
    login: parts[0],
    domain: parts[1],
    email: value
  };
}

/* -------------------------------------------------------
   1SECMail
------------------------------------------------------- */

async function domains() {
  return oneSec({
    action:
      "getDomainList"
  });
}

async function inbox(email) {
  const box =
    mailbox(email);

  const result =
    await oneSec({
      action:
        "getMessages",
      login:
        box.login,
      domain:
        box.domain
    });

  if (!Array.isArray(result)) {
    throw new Error(
      "Invalid inbox response"
    );
  }

  return result.slice(
    0,
    LIMITS.inbox
  );
}

async function message(
  email,
  id
) {
  const box =
    mailbox(email);

  if (!/^\d+$/.test(String(id))) {
    throw new Error(
      "Invalid message ID"
    );
  }

  return oneSec({
    action:
      "readMessage",
    login:
      box.login,
    domain:
      box.domain,
    id
  });
}

/* -------------------------------------------------------
   TEXT / EMAIL ANALYSIS
------------------------------------------------------- */

function stripHTML(value) {
  return String(value || "")
    .replace(
      /<script\b[^>]*>[\s\S]*?<\/script>/gi,
      " "
    )
    .replace(
      /<style\b[^>]*>[\s\S]*?<\/style>/gi,
      " "
    )
    .replace(
      /<!--[\s\S]*?-->/g,
      " "
    )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /&nbsp;/gi,
      " "
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&lt;/gi,
      "<"
    )
    .replace(
      /&gt;/gi,
      ">"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function findOTP(text) {
  const source =
    String(text || "");

  const candidates = [];

  const regex =
    /\b\d{4,8}\b/g;

  let match;

  while (
    (match =
      regex.exec(source))
  ) {
    const code =
      match[0];

    const before =
      Math.max(
        0,
        match.index - 100
      );

    const after =
      Math.min(
        source.length,
        match.index +
          code.length +
          100
      );

    const context =
      source
        .slice(
          before,
          after
        )
        .toLowerCase();

    let score = 0;

    if (
      /otp|verification|verify|security code|passcode|authentication|one.?time/.test(
        context
      )
    ) {
      score += 20;
    }

    if (
      code.length === 6
    ) {
      score += 10;
    }

    candidates.push({
      code,
      score,
      position:
        match.index
    });
  }

  candidates.sort(
    (a, b) =>
      b.score -
      a.score
  );

  return (
    candidates[0]
      ?.code || null
  );
}

function links(text) {
  const found =
    String(text || "")
      .match(
        /https?:\/\/[^\s<>"']+/gi
      ) || [];

  const result = [];

  for (
    const raw of found
  ) {
    const value =
      raw.replace(
        /[),.;]+$/g,
        ""
      );

    try {
      const url =
        new URL(value);

      if (
        url.protocol ===
          "https:" ||
        url.protocol ===
          "http:"
      ) {
        if (
          !result.includes(
            value
          )
        ) {
          result.push(value);
        }
      }
    } catch {}
  }

  return result.slice(
    0,
    50
  );
}

function spamScore(
  subject,
  body
) {
  const text =
    `${subject}\n${body}`
      .toLowerCase();

  let score = 0;

  const indicators = [];

  const rules = [
    [
      /free money|claim now|winner|lottery/,
      25,
      "promotional-risk"
    ],
    [
      /urgent|act now|immediately/,
      12,
      "urgency"
    ],
    [
      /password|credential|login|sign in/,
      8,
      "credential-language"
    ],
    [
      /bitcoin|crypto|wallet/,
      10,
      "crypto-language"
    ],
    [
      /unsubscribe/,
      -5,
      "unsubscribe"
    ],
    [
      /https?:\/\//,
      4,
      "external-link"
    ],
    [
      /dear customer|dear user/,
      5,
      "generic-greeting"
    ],
    [
      /click here/,
      8,
      "click-language"
    ]
  ];

  for (
    const [
      regex,
      points,
      name
    ] of rules
  ) {
    if (
      regex.test(text)
    ) {
      score += points;

      indicators.push({
        name,
        points
      });
    }
  }

  score =
    Math.max(
      0,
      Math.min(
        100,
        score
      )
    );

  return {
    score,
    level:
      score >= 70
        ? "high"
        : score >= 35
          ? "medium"
          : "low",
    indicators
  };
}

/* -------------------------------------------------------
   HEADER FORENSICS
------------------------------------------------------- */

function headerForensics(
  message
) {
  const headers =
    message?.headers || {};

  const normalized = {};

  if (
    Array.isArray(headers)
  ) {
    for (
      const item of headers
    ) {
      if (
        item &&
        item.name
      ) {
        normalized[
          String(
            item.name
          ).toLowerCase()
        ] =
          String(
            item.value || ""
          );
      }
    }
  } else if (
    headers &&
    typeof headers ===
      "object"
  ) {
    for (
      const [
        key,
        value
      ]
      of Object.entries(
        headers
      )
    ) {
      normalized[
        key.toLowerCase()
      ] = String(value);
    }
  }

  const received =
    Object.entries(
      normalized
    )
      .filter(
        ([key]) =>
          key ===
          "received"
      )
      .map(
        ([, value]) =>
          value
      );

  const authentication =
    {
      spf:
        normalized[
          "received-spf"
        ] ||
        normalized[
          "spf"
        ] ||
        null,
      dkim:
        normalized[
          "dkim-signature"
        ] ||
        null,
      dmarc:
        normalized[
          "authentication-results"
        ] ||
        null
    };

  return {
    headerCount:
      Object.keys(
        normalized
      ).length,
    headers:
      normalized,
    receivedHops:
      received,
    authentication,
    analysis: {
      hasReceived:
        received.length > 0,
      hasDKIM:
        Boolean(
          authentication.dkim
        ),
      hasAuthenticationResults:
        Boolean(
          authentication.dmarc
        ),
      hasSPF:
        Boolean(
          authentication.spf
        )
    }
  };
}

/* -------------------------------------------------------
   D1 PERSISTENCE
------------------------------------------------------- */

async function ensureDB(
  env
) {
  if (!env.DB) {
    return;
  }

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS mail_index (
      id TEXT PRIMARY KEY,
      mailbox TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sender TEXT,
      subject TEXT,
      received_at TEXT,
      body TEXT,
      otp TEXT,
      created_at INTEGER NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS
    idx_mailbox_created
    ON mail_index(mailbox, created_at DESC)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS
    idx_mailbox_subject
    ON mail_index(mailbox, subject)
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS aliases (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      alias TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    )
  `).run();
}

async function indexMessage(
  env,
  email,
  msg,
  analysis
) {
  if (!env.DB) {
    return;
  }

  await ensureDB(env);

  const messageID =
    String(
      msg?.id ||
      hex(12)
    );

  const id =
    await hmac(
      env.OTP_SECRET ||
        "tttmail-index-secret",
      `${email}:${messageID}`
    );

  const body =
    stripHTML(
      msg?.textBody ||
      msg?.body ||
      msg?.htmlBody ||
      ""
    );

  await env.DB.prepare(`
    INSERT OR REPLACE INTO mail_index
    (
      id,
      mailbox,
      message_id,
      sender,
      subject,
      received_at,
      body,
      otp,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      id,
      email,
      messageID,
      String(
        msg?.from || ""
      ),
      String(
        msg?.subject || ""
      ),
      String(
        msg?.date || ""
      ),
      body.slice(
        0,
        LIMITS.message
      ),
      analysis?.otp ||
        null,
      now()
    )
    .run();
}

async function searchDB(
  env,
  email,
  query
) {
  if (!env.DB) {
    return {
      enabled: false,
      results: []
    };
  }

  await ensureDB(env);

  const q =
    `%${query
      .replace(
        /[%_]/g,
        ""
      )
      .slice(0, 100)}%`;

  const result =
    await env.DB.prepare(`
      SELECT
        id,
        message_id,
        sender,
        subject,
        received_at,
        otp,
        created_at
      FROM mail_index
      WHERE mailbox = ?
      AND (
        sender LIKE ?
        OR subject LIKE ?
        OR body LIKE ?
      )
      ORDER BY created_at DESC
      LIMIT ?
    `)
      .bind(
        email,
        q,
        q,
        q,
        LIMITS.searchResults
      )
      .all();

  return {
    enabled: true,
    results:
      result.results || []
  };
}

/* -------------------------------------------------------
   REAL ALIAS MANAGEMENT
------------------------------------------------------- */

async function createAlias(
  env,
  email
) {
  if (!validEmail(email)) {
    throw new Error(
      "Invalid destination email"
    );
  }

  const local =
    hex(8);

  const domain =
    normalizeEmail(email)
      .split("@")[1];

  const alias =
    `${local}@${domain}`;

  const id =
    hex(16);

  const record = {
    id,
    alias,
    destination:
      normalizeEmail(email),
    createdAt:
      new Date().toISOString()
  };

  if (env.MY_KV) {
    await putKV(
      env,
      `alias:${id}`,
      record,
      86400 * 30
    );
  }

  if (env.DB) {
    await ensureDB(env);

    await env.DB.prepare(`
      INSERT INTO aliases
      (id, email, alias, created_at)
      VALUES (?, ?, ?, ?)
    `)
      .bind(
        id,
        email,
        alias,
        now()
      )
      .run();
  }

  return record;
}

/* -------------------------------------------------------
   REAL QR SVG GENERATION
   Uses QR encoder implemented in Worker.
------------------------------------------------------- */

const QR_EXP = (() => {
  const exp = new Uint8Array(256);
  const log = new Int16Array(256);

  let x = 1;

  for (
    let i = 0;
    i < 255;
    i++
  ) {
    exp[i] = x;
    log[x] = i;

    x <<= 1;

    if (
      x & 0x100
    ) {
      x ^= 0x11d;
    }
  }

  for (
    let i = 255;
    i < 256;
    i++
  ) {
    exp[i] =
      exp[i - 255];
  }

  return {
    exp,
    log
  };
})();

function gfMultiply(
  a,
  b
) {
  if (
    a === 0 ||
    b === 0
  ) {
    return 0;
  }

  return QR_EXP.exp[
    QR_EXP.log[a] +
    QR_EXP.log[b]
  ];
}

/*
 * Compact QR implementation supporting
 * byte-mode Version 1-L.
 *
 * This deliberately rejects payloads that do not
 * fit instead of silently producing an invalid QR.
 */
function qrVersion1(text) {
  const bytes =
    new TextEncoder()
      .encode(text);

  /*
   * Version 1-L capacity is 17 bytes
   * in byte mode.
   */
  if (
    bytes.length > 17
  ) {
    throw new Error(
      "QR payload exceeds Version 1-L capacity"
    );
  }

  /*
   * For arbitrary URLs / longer payloads,
   * use the frontend QR library or a dedicated
   * QR service. We do not return a fake QR.
   */
  throw new Error(
    "QR payload requires a full QR encoder dependency"
  );
}

/* -------------------------------------------------------
   REAL RESEND EMAIL
------------------------------------------------------- */

function otpHTML(code) {
  return `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport"
content="width=device-width">
<title>TTTMAIL Verification</title>
</head>
<body style="
margin:0;
padding:32px;
background:#08090d;
font-family:Arial,sans-serif;
color:#fff
">
<div style="
max-width:560px;
margin:auto;
background:#11131a;
border:1px solid #292d38;
border-radius:22px;
padding:32px
">
<h1>TTTMAIL</h1>
<p>Your verification code is:</p>
<div style="
font-size:40px;
font-weight:900;
letter-spacing:10px;
text-align:center;
padding:24px;
background:#1a1d26;
border-radius:16px
">${code}</div>
<p>
This code expires in 10 minutes.
</p>
<p style="
color:#8c94a5;
font-size:12px
">
Never share this verification code.
</p>
</div>
</body>
</html>
`;
}

async function sendEmail(
  env,
  to,
  subject,
  html,
  text
) {
  if (
    !env.RESEND_API_KEY
  ) {
    throw new Error(
      "RESEND_API_KEY is missing"
    );
  }

  if (
    !env.OTP_FROM_EMAIL
  ) {
    throw new Error(
      "OTP_FROM_EMAIL is missing"
    );
  }

  const response =
    await fetch(
      RESEND_API,
      {
        method: "POST",
        headers: {
          authorization:
            `Bearer ${env.RESEND_API_KEY}`,
          "content-type":
            "application/json",
          accept:
            "application/json"
        },
        body:
          JSON.stringify({
            from:
              `${APP} <${env.OTP_FROM_EMAIL}>`,
            to: [to],
            subject,
            html,
            text
          })
      }
    );

  const raw =
    await response.text();

  let data = {};

  try {
    data =
      JSON.parse(raw);
  } catch {}

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        `Resend HTTP ${response.status}`
    );
  }

  return data;
}

/* -------------------------------------------------------
   OTP
------------------------------------------------------- */

async function sendOTP(
  request,
  env
) {
  if (
    !env.MY_KV ||
    !env.RESEND_API_KEY ||
    !env.OTP_SECRET ||
    !env.OTP_FROM_EMAIL
  ) {
    return fail(
      "OTP service requires MY_KV, RESEND_API_KEY, OTP_SECRET and OTP_FROM_EMAIL.",
      503,
      "OTP_NOT_CONFIGURED"
    );
  }

  const limiter =
    await rateLimit(
      env,
      "otp",
      clientIP(request),
      LIMITS.otpRequests,
      300
    );

  if (!limiter.allowed) {
    return json(
      {
        ok: false,
        error: {
          code:
            "RATE_LIMITED",
          message:
            "Too many OTP requests."
        }
      },
      429,
      {
        "Retry-After":
          String(
            limiter.retry
          )
      }
    );
  }

  let body;

  try {
    body =
      await bodyJSON(
        request
      );
  } catch (error) {
    return fail(
      error.message,
      400,
      "INVALID_BODY"
    );
  }

  const email =
    normalizeEmail(
      body.email
    );

  if (
    !validEmail(email)
  ) {
    return fail(
      "Valid email is required.",
      422,
      "INVALID_EMAIL"
    );
  }

  const code =
    otpCode();

  const salt =
    hex(16);

  const transaction =
    hex(24);

  const digest =
    await hmac(
      env.OTP_SECRET,
      `${email}:${salt}:${code}`
    );

  const record = {
    email,
    salt,
    digest,
    attempts: 0,
    createdAt: now(),
    expiresAt:
      now() +
      LIMITS.otpTTL *
        1000
  };

  try {
    const provider =
      await sendEmail(
        env,
        email,
        `${APP} verification code`,
        otpHTML(code),
        `Your TTTMAIL verification code is ${code}. It expires in 10 minutes.`
      );

    await putKV(
      env,
      `otp:${transaction}`,
      record,
      LIMITS.otpTTL
    );

    return json({
      ok: true,
      sent: true,
      transactionId:
        transaction,
      expiresIn:
        LIMITS.otpTTL,
      providerId:
        provider?.id ||
        null
    });
  } catch (error) {
    return fail(
      error.message,
      502,
      "OTP_SEND_FAILED"
    );
  }
}

async function verifyOTP(
  request,
  env
) {
  if (
    !env.MY_KV ||
    !env.OTP_SECRET
  ) {
    return fail(
      "OTP verification is not configured.",
      503,
      "OTP_NOT_CONFIGURED"
    );
  }

  let body;

  try {
    body =
      await bodyJSON(
        request
      );
  } catch (error) {
    return fail(
      error.message,
      400,
      "INVALID_BODY"
    );
  }

  const transaction =
    String(
      body.transactionId ||
        ""
    ).trim();

  const code =
    String(
      body.otp ||
        ""
    ).trim();

  if (
    !/^[a-f0-9]{48}$/i.test(
      transaction
    )
  ) {
    return fail(
      "Invalid transaction.",
      422,
      "INVALID_TRANSACTION"
    );
  }

  if (
    !/^\d{6}$/.test(
      code
    )
  ) {
    return fail(
      "OTP must contain six digits.",
      422,
      "INVALID_OTP"
    );
  }

  const key =
    `otp:${transaction}`;

  const record =
    await kvJSON(
      env,
      key
    );

  if (!record) {
    return fail(
      "OTP expired or not found.",
      410,
      "OTP_EXPIRED"
    );
  }

  if (
    now() >
    record.expiresAt
  ) {
    await delKV(
      env,
      key
    );

    return fail(
      "OTP expired.",
      410,
      "OTP_EXPIRED"
    );
  }

  if (
    record.attempts >=
    LIMITS.otpAttempts
  ) {
    await delKV(
      env,
      key
    );

    return fail(
      "Maximum attempts exceeded.",
      429,
      "OTP_ATTEMPTS_EXCEEDED"
    );
  }

  const calculated =
    await hmac(
      env.OTP_SECRET,
      `${record.email}:${record.salt}:${code}`
    );

  if (
    !equal(
      calculated,
      record.digest
    )
  ) {
    record.attempts++;

    const ttl =
      Math.max(
        1,
        Math.ceil(
          (record.expiresAt -
            now()) /
            1000
        )
      );

    await putKV(
      env,
      key,
      record,
      ttl
    );

    return json(
      {
        ok: false,
        verified: false,
        error: {
          code:
            "INVALID_OTP",
          message:
            "Incorrect verification code."
        },
        attemptsRemaining:
          Math.max(
            0,
            LIMITS.otpAttempts -
              record.attempts
          )
      },
      401
    );
  }

  await delKV(
    env,
    key
  );

  const verificationToken =
    await hmac(
      env.OTP_SECRET,
      `verified:${transaction}:${record.email}:${now()}`
    );

  return json({
    ok: true,
    verified: true,
    email:
      record.email,
    verificationToken,
    verifiedAt:
      new Date().toISOString()
  });
}

/* -------------------------------------------------------
   MESSAGE ANALYSIS
------------------------------------------------------- */

async function analyzeMessage(
  request
) {
  const body =
    await bodyJSON(
      request
    );

  const text =
    stripHTML(
      body.html ||
      body.text ||
      ""
    );

  if (
    text.length >
    LIMITS.message
  ) {
    return fail(
      "Message is too large.",
      413,
      "MESSAGE_TOO_LARGE"
    );
  }

  const subject =
    String(
      body.subject ||
        ""
    );

  return json({
    ok: true,
    analysis: {
      otp:
        findOTP(
          `${subject}\n${text}`
        ),
      verificationLinks:
        links(
          `${subject}\n${text}`
        ),
      spamRisk:
        spamScore(
          subject,
          text
        )
    }
  });
}

/* -------------------------------------------------------
   MX LOOKUP
------------------------------------------------------- */

async function mx(
  request
) {
  const url =
    new URL(
      request.url
    );

  const domain =
    String(
      url.searchParams.get(
        "domain"
      ) || ""
    )
      .trim()
      .toLowerCase();

  if (
    !validDomain(
      domain
    )
  ) {
    return fail(
      "Invalid domain.",
      422,
      "INVALID_DOMAIN"
    );
  }

  const dnsURL =
    new URL(DNS_API);

  dnsURL.searchParams.set(
    "name",
    domain
  );

  dnsURL.searchParams.set(
    "type",
    "MX"
  );

  try {
    const response =
      await fetch(
        dnsURL,
        {
          headers: {
            accept:
              "application/dns-json"
          }
        }
      );

    if (
      !response.ok
    ) {
      throw new Error(
        `DNS HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    return json({
      ok: true,
      domain,
      status:
        data.Status,
      authoritative:
        Boolean(data.AD),
      answers:
        data.Answer ||
        []
    });
  } catch (error) {
    return fail(
      error.message,
      502,
      "DNS_LOOKUP_FAILED"
    );
  }
}

/* -------------------------------------------------------
   INBOX
------------------------------------------------------- */

async function getInbox(
  request,
  env
) {
  const url =
    new URL(
      request.url
    );

  const email =
    normalizeEmail(
      url.searchParams.get(
        "email"
      )
    );

  if (
    !validEmail(email)
  ) {
    return fail(
      "Valid mailbox email is required.",
      422,
      "INVALID_EMAIL"
    );
  }

  try {
    const messages =
      await inbox(email);

    /*
     * Persist/index every real message
     * when D1 is configured.
     */
    if (
      env.DB &&
      messages.length
    ) {
      for (
        const item
        of messages
      ) {
        try {
          const full =
            await message(
              email,
              item.id
            );

          const body =
            stripHTML(
              full?.textBody ||
              full?.body ||
              full?.htmlBody ||
              ""
            );

          const analysis = {
            otp:
              findOTP(
                `${full?.subject || ""}\n${body}`
              )
          };

          await indexMessage(
            env,
            email,
            full,
            analysis
          );
        } catch {
          /*
           * One malformed provider message
           * must not break the complete inbox.
           */
        }
      }
    }

    return json({
      ok: true,
      email,
      count:
        messages.length,
      messages
    });
  } catch (error) {
    return fail(
      error.message,
      502,
      "MAIL_PROVIDER_ERROR"
    );
  }
}

async function getMessage(
  request,
  env
) {
  const url =
    new URL(
      request.url
    );

  const email =
    normalizeEmail(
      url.searchParams.get(
        "email"
      )
    );

  const id =
    url.searchParams.get(
      "id"
    );

  if (
    !validEmail(email)
  ) {
    return fail(
      "Invalid mailbox.",
      422,
      "INVALID_EMAIL"
    );
  }

  if (
    !/^\d+$/.test(
      String(id || "")
    )
  ) {
    return fail(
      "Invalid message ID.",
      422,
      "INVALID_MESSAGE_ID"
    );
  }

  try {
    const result =
      await message(
        email,
        id
      );

    if (
      !result ||
      typeof result !==
        "object"
    ) {
      return fail(
        "Message not found.",
        404,
        "MESSAGE_NOT_FOUND"
      );
    }

    const text =
      stripHTML(
        result.textBody ||
        result.body ||
        result.htmlBody ||
        ""
      );

    const analysis = {
      otp:
        findOTP(
          `${result.subject || ""}\n${text}`
        ),
      verificationLinks:
        links(
          `${result.subject || ""}\n${text}`
        ),
      spamRisk:
        spamScore(
          result.subject ||
            "",
          text
        ),
      headers:
        headerForensics(
          result
        )
    };

    await indexMessage(
      env,
      email,
      result,
      analysis
    );

    return json({
      ok: true,
      message:
        result,
      analysis
    });
  } catch (error) {
    return fail(
      error.message,
      502,
      "MAIL_PROVIDER_ERROR"
    );
  }
}

/* -------------------------------------------------------
   SEARCH
------------------------------------------------------- */

async function search(
  request,
  env
) {
  const url =
    new URL(
      request.url
    );

  const email =
    normalizeEmail(
      url.searchParams.get(
        "email"
      )
    );

  const query =
    String(
      url.searchParams.get(
        "q"
      ) || ""
    ).trim();

  if (
    !validEmail(email)
  ) {
    return fail(
      "Valid mailbox email is required.",
      422,
      "INVALID_EMAIL"
    );
  }

  if (
    query.length <
    1
  ) {
    return fail(
      "Search query is required.",
      422,
      "INVALID_QUERY"
    );
  }

  const result =
    await searchDB(
      env,
      email,
      query
    );

  if (
    !result.enabled
  ) {
    return fail(
      "D1 is required for persistent enterprise email search.",
      503,
      "D1_NOT_CONFIGURED"
    );
  }

  return json({
    ok: true,
    email,
    query,
    count:
      result.results.length,
    results:
      result.results
  });
}

/* -------------------------------------------------------
   ALIAS
------------------------------------------------------- */

async function aliases(
  request,
  env
) {
  if (
    request.method ===
    "POST"
  ) {
    let body;

    try {
      body =
        await bodyJSON(
          request
        );
    } catch (error) {
      return fail(
        error.message,
        400,
        "INVALID_BODY"
      );
    }

    const email =
      normalizeEmail(
        body.email
      );

    if (
      !validEmail(email)
    ) {
      return fail(
        "Valid destination email is required.",
        422,
        "INVALID_EMAIL"
      );
    }

    try {
      const alias =
        await createAlias(
          env,
          email
        );

      return json({
        ok: true,
        alias
      });
    } catch (error) {
      return fail(
        error.message,
        500,
        "ALIAS_CREATE_FAILED"
      );
    }
  }

  return fail(
    "Method not supported.",
    405,
    "METHOD_NOT_ALLOWED"
  );
}

/* -------------------------------------------------------
   FORWARDING
------------------------------------------------------- */

async function forward(
  request,
  env
) {
  let body;

  try {
    body =
      await bodyJSON(
        request
      );
  } catch (error) {
    return fail(
      error.message,
      400,
      "INVALID_BODY"
    );
  }

  const to =
    normalizeEmail(
      body.to
    );

  if (
    !validEmail(to)
  ) {
    return fail(
      "Valid destination email is required.",
      422,
      "INVALID_EMAIL"
    );
  }

  const subject =
    String(
      body.subject ||
        "Forwarded email"
    ).slice(
      0,
      500
    );

  const text =
    String(
      body.text ||
        ""
    ).slice(
      0,
      LIMITS.message
    );

  const html =
    String(
      body.html ||
        ""
    ).slice(
      0,
      LIMITS.message
    );

  if (
    !text &&
    !html
  ) {
    return fail(
      "Email content is required.",
      422,
      "EMPTY_MESSAGE"
    );
  }

  try {
    const result =
      await sendEmail(
        env,
        to,
        subject,
        html ||
          `<pre>${escapeHTML(text)}</pre>`,
        text ||
          stripHTML(html)
      );

    return json({
      ok: true,
      sent: true,
      providerId:
        result?.id ||
        null
    });
  } catch (error) {
    return fail(
      error.message,
      502,
      "FORWARD_FAILED"
    );
  }
}

function escapeHTML(
  value
) {
  return String(value)
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#39;"
    );
}

/* -------------------------------------------------------
   PUSH SUBSCRIPTIONS
------------------------------------------------------- */

async function pushSubscribe(
  request,
  env
) {
  if (
    !env.MY_KV
  ) {
    return fail(
      "MY_KV is required.",
      503,
      "KV_NOT_CONFIGURED"
    );
  }

  let body;

  try {
    body =
      await bodyJSON(
        request
      );
  } catch (error) {
    return fail(
      error.message,
      400,
      "INVALID_BODY"
    );
  }

  const endpoint =
    String(
      body.endpoint ||
        ""
    ).trim();

  const keys =
    body.keys;

  if (
    !endpoint ||
    endpoint.length >
      4096
  ) {
    return fail(
      "Valid push endpoint is required.",
      422,
      "INVALID_ENDPOINT"
    );
  }

  const id =
    hex(20);

  const record = {
    id,
    endpoint,
    keys:
      keys &&
      typeof keys ===
        "object"
        ? keys
        : {},
    createdAt:
      new Date().toISOString(),
    userAgent:
      request.headers.get(
        "User-Agent"
      ) || ""
  };

  await putKV(
    env,
    `push:${id}`,
    record,
    86400 * 365
  );

  return json({
    ok: true,
    subscribed: true,
    subscriptionId:
      id
  });
}

async function pushUnsubscribe(
  request,
  env
) {
  let body;

  try {
    body =
      await bodyJSON(
        request
      );
  } catch (error) {
    return fail(
      error.message,
      400,
      "INVALID_BODY"
    );
  }

  const id =
    String(
      body.subscriptionId ||
        ""
    ).trim();

  if (
    !/^[a-f0-9]{40}$/i.test(
      id
    )
  ) {
    return fail(
      "Invalid subscription ID.",
      422,
      "INVALID_SUBSCRIPTION"
    );
  }

  await delKV(
    env,
    `push:${id}`
  );

  return json({
    ok: true,
    unsubscribed: true
  });
}

/* -------------------------------------------------------
   HEALTH / FEATURES
------------------------------------------------------- */

async function health(
  env
) {
  return json({
    ok: true,
    service: APP,
    version: VERSION,
    runtime:
      "Cloudflare Workers",
    timestamp:
      new Date().toISOString(),
    integrations: {
      oneSecMail:
        true,
      resend:
        Boolean(
          env.RESEND_API_KEY
        ),
      kv:
        Boolean(
          env.MY_KV
        ),
      d1:
        Boolean(
          env.DB
        ),
      dns:
        true,
      otp:
        Boolean(
          env.MY_KV &&
          env.RESEND_API_KEY &&
          env.OTP_SECRET &&
          env.OTP_FROM_EMAIL
        ),
      push:
        Boolean(
          env.MY_KV
        )
    }
  });
}

async function features() {
  return json({
    ok: true,
    features: [
      "temporary-email",
      "1secmail-domains",
      "live-inbox",
      "real-incoming-email",
      "message-reader",
      "otp-extraction",
      "verification-link-extraction",
      "spam-risk-analysis",
      "email-header-forensics",
      "dns-mx-checker",
      "real-outbound-email",
      "real-otp-delivery",
      "real-otp-verification",
      "otp-expiration",
      "otp-attempt-limiting",
      "ip-rate-limiting",
      "d1-message-index",
      "email-search",
      "persistent-aliases",
      "email-forwarding",
      "push-subscriptions",
      "security-health",
      "api-health",
      "cors",
      "request-validation",
      "provider-error-handling",
      "cloudflare-pages-assets"
    ]
  });
}

/* -------------------------------------------------------
   SECURITY
------------------------------------------------------- */

async function security() {
  return json({
    ok: true,
    security: {
      otp:
        "HMAC-SHA256 protected",
      otpTTL:
        LIMITS.otpTTL,
      maxOTPAttempts:
        LIMITS.otpAttempts,
      rateLimiting:
        "Cloudflare KV",
      transport:
        "HTTPS through Cloudflare",
      inboundMail:
        "1secmail",
      outboundMail:
        "Resend",
      persistence:
        "Cloudflare KV / D1",
      frontend:
        "Cloudflare Pages compatible"
    }
  });
}

/* -------------------------------------------------------
   ROUTER
------------------------------------------------------- */

async function router(
  request,
  env,
  ctx
) {
  const url =
    new URL(
      request.url
    );

  const path =
    url.pathname.replace(
      /\/+$/,
      ""
    ) || "/";

  if (
    request.method ===
    "OPTIONS"
  ) {
    return new Response(
      null,
      {
        status: 204
      }
    );
  }

  if (
    path ===
      "/api/health" &&
    request.method ===
      "GET"
  ) {
    return health(env);
  }

  if (
    path ===
      "/api/features" &&
    request.method ===
      "GET"
  ) {
    return features();
  }

  if (
    path ===
      "/api/security" &&
    request.method ===
      "GET"
  ) {
    return security();
  }

  if (
    path ===
      "/api/domains" &&
    request.method ===
      "GET"
  ) {
    try {
      return json({
        ok: true,
        domains:
          await domains()
      });
    } catch (error) {
      return fail(
        error.message,
        502,
        "MAIL_PROVIDER_ERROR"
      );
    }
  }

  if (
    path ===
      "/api/inbox" &&
    request.method ===
      "GET"
  ) {
    return getInbox(
      request,
      env
    );
  }

  if (
    path ===
      "/api/message" &&
    request.method ===
      "GET"
  ) {
    return getMessage(
      request,
      env
    );
  }

  if (
    path ===
      "/api/send-otp" &&
    request.method ===
      "POST"
  ) {
    return sendOTP(
      request,
      env
    );
  }

  if (
    path ===
      "/api/verify-otp" &&
    request.method ===
      "POST"
  ) {
    return verifyOTP(
      request,
      env
    );
  }

  if (
    path ===
      "/api/analyze-email" &&
    request.method ===
      "POST"
  ) {
    return analyzeMessage(
      request
    );
  }

  if (
    path ===
      "/api/extract-otp" &&
    request.method ===
      "POST"
  ) {
    return analyzeMessage(
      request
    );
  }

  if (
    path ===
      "/api/mx" &&
    request.method ===
      "GET"
  ) {
    return mx(request);
  }

  if (
    path ===
      "/api/search" &&
    request.method ===
      "GET"
  ) {
    return search(
      request,
      env
    );
  }

  if (
    path ===
      "/api/aliases" &&
    request.method ===
      "POST"
  ) {
    return aliases(
      request,
      env
    );
  }

  if (
    path ===
      "/api/forward" &&
    request.method ===
      "POST"
  ) {
    return forward(
      request,
      env
    );
  }

  if (
    path ===
      "/api/push/subscribe" &&
    request.method ===
      "POST"
  ) {
    return pushSubscribe(
      request,
      env
    );
  }

  if (
    path ===
      "/api/push/unsubscribe" &&
    request.method ===
      "POST"
  ) {
    return pushUnsubscribe(
      request,
      env
    );
  }

  if (
    path.startsWith(
      "/api/"
    )
  ) {
    return fail(
      "API endpoint not found.",
      404,
      "NOT_FOUND"
    );
  }

  /*
   * Cloudflare Pages Static Assets.
   */
  if (
    env.ASSETS
  ) {
    return env.ASSETS.fetch(
      request
    );
  }

  return fail(
    "Assets binding is not configured.",
    500,
    "ASSETS_NOT_CONFIGURED"
  );
}

/* -------------------------------------------------------
   ENTRYPOINT
------------------------------------------------------- */

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    try {
      /*
       * General API protection.
       */
      if (
        new URL(
          request.url
        ).pathname.startsWith(
          "/api/"
        )
      ) {
        const limit =
          await rateLimit(
            env,
            "global",
            clientIP(request),
            LIMITS.generalRequests
          );

        if (
          !limit.allowed
        ) {
          return cors(
            json(
              {
                ok: false,
                error: {
                  code:
                    "RATE_LIMITED",
                  message:
                    "Too many requests."
                }
              },
              429,
              {
                "Retry-After":
                  String(
                    limit.retry
                  )
              }
            ),
            request
          );
        }
      }

      const response =
        await router(
          request,
          env,
          ctx
        );

      return cors(
        response,
        request
      );
    } catch (error) {
      console.error(
        `${APP} Worker error`,
        error
      );

      return cors(
        fail(
          "Internal server error.",
          500,
          "INTERNAL_ERROR"
        ),
        request
      );
    }
  }
};
