// ============================================================
// TTTMAIL — ENTERPRISE CLOUDFLARE WORKER
// Version: 5.0.0
// KV Binding: MY_KV
//
// REAL MAIL FLOW:
//
// Browser
//   ↓
// Cloudflare Worker /api/mail
//   ↓
// 1secmail API
//   ↓
// Real inbox/message
//   ↓
// Browser OTP + verification extraction
//
// IMPORTANT:
// No OTP is fabricated. OTPs are extracted only from real
// messages returned by the upstream temporary-mail provider.
// ============================================================

const APP = Object.freeze({
  NAME: "TTTMAIL",
  VERSION: "5.0.0",

  KV_HTML: "html_main",
  KV_AD_TOP: "ad_top",
  KV_AD_MIDDLE: "ad_middle",
  KV_AD_BOTTOM: "ad_bottom",

  MAIL_API: "https://www.1secmail.com/api/v1/",

  DEFAULT_DOMAIN: "1secmail.com",
  DEFAULT_POLL: 5000,

  MAX_MESSAGES: 50,
  PROVIDER_TIMEOUT: 12000,
  PROVIDER_RETRIES: 3,

  RATE_WINDOW: 60,
  RATE_LIMIT: 60
});

const ALLOWED_DOMAINS = new Set([
  "1secmail.com",
  "1secmail.org",
  "1secmail.net",
  "esiix.com",
  "wwjmp.com"
]);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security":
    "max-age=31536000; includeSubDomains"
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      ...SECURITY_HEADERS,
      ...extra
    }
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS
    }
  });
}

function getClientIP(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown"
  );
}

function validLogin(login) {
  return (
    typeof login === "string" &&
    /^[a-zA-Z0-9._-]{1,64}$/.test(login)
  );
}

function validDomain(domain) {
  return (
    typeof domain === "string" &&
    /^[a-zA-Z0-9.-]{1,100}$/.test(domain) &&
    ALLOWED_DOMAINS.has(domain.toLowerCase())
  );
}

function validMessageID(id) {
  return typeof id === "string" && /^\d{1,20}$/.test(id);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// RATE LIMIT
// ============================================================

async function rateLimit(request, env) {
  if (!env.MY_KV) return true;

  const ip = getClientIP(request);

  const bucket =
    Math.floor(Date.now() / (APP.RATE_WINDOW * 1000));

  const key = `rate:${bucket}:${ip}`;

  try {
    const current = Number(await env.MY_KV.get(key) || 0);

    if (current >= APP.RATE_LIMIT) {
      return false;
    }

    await env.MY_KV.put(
      key,
      String(current + 1),
      {
        expirationTtl: APP.RATE_WINDOW + 10
      }
    );

    return true;
  } catch {
    return true;
  }
}

// ============================================================
// UPSTREAM MAIL REQUEST
// ============================================================

async function providerRequest(params) {
  let lastError = null;

  for (let attempt = 0; attempt < APP.PROVIDER_RETRIES; attempt++) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      APP.PROVIDER_TIMEOUT
    );

    try {
      const endpoint = new URL(APP.MAIL_API);

      for (const [key, value] of Object.entries(params)) {
        endpoint.searchParams.set(key, String(value));
      }

      const response = await fetch(endpoint.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent":
            "TTTMAIL/5.0 Cloudflare-Worker"
        },
        cf: {
          cacheEverything: false,
          cacheTtl: 0
        },
        signal: controller.signal
      });

      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `Mail provider HTTP ${response.status}`
        );
      }

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(
          "Mail provider returned invalid JSON"
        );
      }

      return {
        ok: true,
        data
      };
    } catch (error) {
      lastError = error;

      if (attempt < APP.PROVIDER_RETRIES - 1) {
        await sleep(350 * Math.pow(2, attempt));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    ok: false,
    error:
      lastError?.message ||
      "Mail provider unavailable"
  };
}

// ============================================================
// MAIL API
// ============================================================

async function handleMailAPI(request) {
  const url = new URL(request.url);

  const action = url.searchParams.get("action");
  const login = url.searchParams.get("login");
  const domain = url.searchParams.get("domain");
  const id = url.searchParams.get("id");

  if (!login || !validLogin(login)) {
    return json(
      {
        ok: false,
        error: "Invalid mailbox login."
      },
      400
    );
  }

  if (!domain || !validDomain(domain)) {
    return json(
      {
        ok: false,
        error: "Unsupported mailbox domain."
      },
      400
    );
  }

  // ----------------------------------------------------------
  // GET MESSAGES
  // ----------------------------------------------------------

  if (action === "getMessages") {
    const result = await providerRequest({
      action: "getMessages",
      login,
      domain
    });

    if (!result.ok) {
      return json(
        {
          ok: false,
          error:
            "MAIL_PROVIDER_UNAVAILABLE",
          message:
            "Temporary mail provider could not be reached.",
          detail: result.error
        },
        502
      );
    }

    if (!Array.isArray(result.data)) {
      return json(
        {
          ok: false,
          error:
            "INVALID_PROVIDER_RESPONSE"
        },
        502
      );
    }

    const messages = result.data
      .filter(
        item =>
          item &&
          item.id !== undefined &&
          item.id !== null
      )
      .slice(0, APP.MAX_MESSAGES)
      .map(item => ({
        id: String(item.id),
        from:
          typeof item.from === "string"
            ? item.from
            : "",
        subject:
          typeof item.subject === "string"
            ? item.subject
            : "",
        date:
          typeof item.date === "string"
            ? item.date
            : ""
      }));

    return json({
      ok: true,
      messages,
      count: messages.length
    });
  }

  // ----------------------------------------------------------
  // READ MESSAGE
  // ----------------------------------------------------------

  if (action === "readMessage") {
    if (!validMessageID(id)) {
      return json(
        {
          ok: false,
          error: "Invalid message ID."
        },
        400
      );
    }

    const result = await providerRequest({
      action: "readMessage",
      login,
      domain,
      id
    });

    if (!result.ok) {
      return json(
        {
          ok: false,
          error:
            "MESSAGE_PROVIDER_UNAVAILABLE",
          message:
            "The real email message could not be loaded.",
          detail: result.error
        },
        502
      );
    }

    const message =
      result.data &&
      typeof result.data === "object"
        ? result.data
        : {};

    return json({
      ok: true,
      message: {
        id:
          message.id !== undefined
            ? String(message.id)
            : id,

        from:
          typeof message.from === "string"
            ? message.from
            : "",

        subject:
          typeof message.subject === "string"
            ? message.subject
            : "",

        date:
          typeof message.date === "string"
            ? message.date
            : "",

        textBody:
          typeof message.textBody === "string"
            ? message.textBody
            : "",

        htmlBody:
          typeof message.htmlBody === "string"
            ? message.htmlBody
            : "",

        body:
          typeof message.body === "string"
            ? message.body
            : ""
      }
    });
  }

  return json(
    {
      ok: false,
      error: "Unsupported mail action."
    },
    400
  );
}

// ============================================================
// ADS
// ============================================================

async function handleAds(env) {
  if (!env.MY_KV) {
    return json({
      ok: true,
      top: null,
      middle: null,
      bottom: null
    });
  }

  try {
    const [
      top,
      middle,
      bottom
    ] = await Promise.all([
      env.MY_KV.get(APP.KV_AD_TOP),
      env.MY_KV.get(APP.KV_AD_MIDDLE),
      env.MY_KV.get(APP.KV_AD_BOTTOM)
    ]);

    return json({
      ok: true,
      top: top || null,
      middle: middle || null,
      bottom: bottom || null
    });
  } catch {
    return json({
      ok: true,
      top: null,
      middle: null,
      bottom: null
    });
  }
}

// ============================================================
// DEFAULT HTML
// ============================================================

function getDefaultHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1,viewport-fit=cover"
>

<meta
  name="theme-color"
  content="#08080a"
>

<meta
  name="color-scheme"
  content="dark"
>

<meta
  name="robots"
  content="index,follow,max-image-preview:large"
>

<title>
TTTMAIL — Free Temporary Email & Real OTP Inbox
</title>

<meta
  name="description"
  content="TTTMAIL provides a temporary mailbox for receiving real incoming emails, verification messages and OTP codes."
>

<link
  rel="manifest"
  href="/manifest.webmanifest"
>

<style>

:root{
  --pink:#ff0080;
  --pink2:#c70062;
  --green:#00ff88;
  --green2:#00a85a;
  --yellow:#ffdd00;
  --red:#ff4567;
  --bg:#08080a;
  --surface:#111116;
  --surface2:#18181f;
  --surface3:#20202a;
  --border:#2c2c37;
  --text:#fff;
  --muted:#9d9daa;
  --radius:18px;
  --pill:999px;
  --shadow:0 20px 70px rgba(0,0,0,.45);
}

*{
  box-sizing:border-box;
  margin:0;
  padding:0;
}

html{
  scroll-behavior:smooth;
  background:var(--bg);
}

body{
  min-height:100vh;
  color:var(--text);
  background:
    radial-gradient(
      circle at 10% 0%,
      rgba(255,0,128,.10),
      transparent 30rem
    ),
    radial-gradient(
      circle at 90% 15%,
      rgba(0,255,136,.06),
      transparent 30rem
    ),
    var(--bg);
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  overflow-x:hidden;
}

button,
input,
select{
  font:inherit;
}

button{
  cursor:pointer;
}

a{
  color:inherit;
  text-decoration:none;
}

::selection{
  background:var(--pink);
  color:#fff;
}

::-webkit-scrollbar{
  width:6px;
}

::-webkit-scrollbar-thumb{
  background:#34343e;
  border-radius:999px;
}

.gradient{
  background:
    linear-gradient(
      135deg,
      var(--pink),
      var(--yellow),
      var(--green)
    );
  -webkit-background-clip:text;
  background-clip:text;
  color:transparent;
}

.header{
  position:sticky;
  top:0;
  z-index:1000;
  min-height:64px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:14px;
  padding:10px 14px;
  background:rgba(8,8,10,.90);
  border-bottom:1px solid rgba(255,255,255,.08);
  backdrop-filter:blur(18px);
  -webkit-backdrop-filter:blur(18px);
}

.brand{
  display:flex;
  align-items:center;
  gap:9px;
  font-weight:900;
}

.logo{
  width:37px;
  height:37px;
  border-radius:12px;
  display:grid;
  place-items:center;
  background:
    linear-gradient(
      135deg,
      var(--pink),
      #860044
    );
  box-shadow:
    0 10px 35px rgba(255,0,128,.25);
}

.nav{
  display:none;
  gap:22px;
}

.nav a{
  color:var(--muted);
  font-size:.82rem;
  font-weight:800;
}

.nav a:hover{
  color:#fff;
}

.header-actions{
  display:flex;
  align-items:center;
  gap:7px;
}

.icon{
  width:38px;
  height:38px;
  border:1px solid var(--border);
  border-radius:50%;
  display:grid;
  place-items:center;
  background:var(--surface);
  color:#fff;
}

.container{
  width:min(920px,100%);
  margin:auto;
  padding:20px 14px 0;
}

.hero{
  text-align:center;
  padding:25px 0 20px;
}

.badge{
  display:inline-flex;
  padding:8px 13px;
  border:1px solid var(--border);
  border-radius:999px;
  background:var(--surface);
  color:var(--muted);
  font-size:.70rem;
  font-weight:900;
  margin-bottom:14px;
}

.badge b{
  color:var(--green);
}

h1{
  font-size:clamp(2rem,8vw,3.5rem);
  line-height:1.03;
  letter-spacing:-1.8px;
}

.hero p{
  max-width:690px;
  margin:15px auto 0;
  color:var(--muted);
  line-height:1.65;
  font-size:.90rem;
}

.card{
  margin-bottom:18px;
  padding:18px;
  border:1px solid var(--border);
  border-radius:var(--radius);
  background:rgba(17,17,22,.94);
  box-shadow:var(--shadow);
}

.card-head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  padding-bottom:13px;
  margin-bottom:15px;
  border-bottom:1px solid var(--border);
}

.title{
  font-size:.96rem;
  font-weight:900;
}

.status{
  color:var(--green);
  font-size:.68rem;
  font-weight:900;
}

.status-dot{
  display:inline-block;
  width:7px;
  height:7px;
  margin-right:5px;
  border-radius:50%;
  background:var(--green);
  box-shadow:0 0 12px var(--green);
}

.label{
  display:block;
  color:var(--muted);
  font-size:.68rem;
  font-weight:900;
  text-transform:uppercase;
  letter-spacing:.5px;
  margin-bottom:7px;
}

.email-row{
  display:grid;
  grid-template-columns:1fr;
  gap:9px;
}

.input,
select{
  width:100%;
  min-height:48px;
  padding:12px 14px;
  border:1px solid var(--border);
  border-radius:12px;
  outline:none;
  background:#0d0d12;
  color:#fff;
  font-weight:750;
}

.input:focus,
select:focus{
  border-color:var(--pink);
  box-shadow:0 0 0 3px rgba(255,0,128,.12);
}

.actions{
  display:grid;
  grid-template-columns:1fr;
  gap:9px;
  margin-top:9px;
}

.btn{
  min-height:45px;
  padding:10px 15px;
  border:1px solid rgba(255,255,255,.12);
  border-radius:999px;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:7px;
  color:#fff;
  background:linear-gradient(135deg,#292933,#15151c);
  font-size:.76rem;
  font-weight:900;
}

.btn-pink{
  background:
    linear-gradient(
      135deg,
      var(--pink),
      var(--pink2)
    );
}

.btn-green{
  color:#03130c;
  background:
    linear-gradient(
      135deg,
      var(--green),
      var(--green2)
    );
}

.btn-yellow{
  color:#090909;
  background:
    linear-gradient(
      135deg,
      #ffe900,
      #d8b800
    );
}

.btn:active{
  transform:scale(.98);
}

.ad{
  min-height:60px;
  margin-bottom:18px;
  padding:12px;
  display:flex;
  align-items:center;
  justify-content:center;
  text-align:center;
  border:1px dashed rgba(255,0,128,.6);
  border-radius:13px;
  background:
    linear-gradient(
      135deg,
      rgba(255,0,128,.07),
      rgba(0,255,136,.04)
    );
}

.inbox{
  min-height:190px;
  max-height:460px;
  overflow:auto;
}

.empty{
  min-height:190px;
  display:grid;
  place-items:center;
  text-align:center;
  color:var(--muted);
}

.empty-icon{
  font-size:2rem;
  margin-bottom:10px;
  opacity:.5;
}

.message{
  display:grid;
  grid-template-columns:1fr auto;
  gap:10px;
  padding:14px 10px;
  border-bottom:1px solid var(--border);
  cursor:pointer;
}

.message:hover{
  background:rgba(255,255,255,.025);
}

.from{
  font-size:.80rem;
  font-weight:850;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.subject{
  margin-top:4px;
  color:var(--muted);
  font-size:.75rem;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.date{
  color:var(--muted);
  font-size:.65rem;
}

.features{
  display:grid;
  grid-template-columns:1fr;
  gap:10px;
}

.feature{
  padding:14px;
  border:1px solid var(--border);
  border-radius:13px;
  background:rgba(255,255,255,.015);
}

.feature strong{
  display:block;
  margin-bottom:4px;
  font-size:.79rem;
}

.feature span{
  color:var(--muted);
  font-size:.71rem;
  line-height:1.5;
}

.footer{
  width:min(920px,100%);
  margin:auto;
  padding:20px 14px 40px;
  color:var(--muted);
  font-size:.68rem;
  display:flex;
  justify-content:space-between;
  gap:12px;
  flex-wrap:wrap;
}

.modal{
  position:fixed;
  inset:0;
  z-index:3000;
  display:none;
  align-items:center;
  justify-content:center;
  padding:14px;
  background:rgba(0,0,0,.84);
  backdrop-filter:blur(8px);
}

.modal.show{
  display:flex;
}

.modal-box{
  position:relative;
  width:min(650px,100%);
  max-height:90dvh;
  overflow:auto;
  padding:21px;
  border:1px solid var(--border);
  border-radius:20px;
  background:#15151b;
  box-shadow:0 30px 90px rgba(0,0,0,.75);
}

.close{
  position:absolute;
  top:12px;
  right:12px;
  width:34px;
  height:34px;
  border:1px solid var(--border);
  border-radius:50%;
  background:var(--surface);
  color:#fff;
}

.modal h2{
  padding-right:45px;
  margin-bottom:14px;
  font-size:1.08rem;
}

.meta{
  color:var(--muted);
  font-size:.72rem;
  margin-bottom:13px;
}

.body{
  padding:14px;
  border:1px solid var(--border);
  border-radius:12px;
  background:#0c0c10;
  color:#d0d0da;
  font-size:.78rem;
  line-height:1.65;
  white-space:pre-wrap;
  word-break:break-word;
}

.otp{
  margin:13px 0;
  padding:17px;
  text-align:center;
  border:1px solid rgba(0,255,136,.35);
  border-radius:14px;
  background:rgba(0,255,136,.05);
}

.otp-code{
  margin:8px 0;
  color:var(--green);
  font-size:2rem;
  font-weight:950;
  letter-spacing:5px;
  word-break:break-all;
}

.links{
  display:grid;
  gap:8px;
  margin:13px 0;
}

.link{
  display:block;
  padding:11px;
  border:1px solid var(--border);
  border-radius:10px;
  color:#8fcfff;
  background:var(--surface);
  font-size:.72rem;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.toast-wrap{
  position:fixed;
  right:14px;
  bottom:14px;
  z-index:5000;
  width:min(390px,calc(100vw - 28px));
  display:grid;
  gap:8px;
}

.toast{
  padding:13px;
  border:1px solid var(--border);
  border-radius:13px;
  background:#15151b;
  box-shadow:var(--shadow);
  color:#fff;
  font-size:.74rem;
}

.poll{
  display:none;
  color:var(--muted);
  font-size:.67rem;
  font-weight:800;
}

@media(min-width:640px){

  .email-row{
    grid-template-columns:1fr auto;
  }

  .actions{
    grid-template-columns:1fr 1fr;
  }

  .features{
    grid-template-columns:repeat(3,1fr);
  }

  .poll{
    display:block;
  }
}

@media(min-width:900px){

  .nav{
    display:flex;
  }

  .menu{
    display:none;
  }

  .header{
    padding-left:28px;
    padding-right:28px;
  }

  .container{
    padding-top:32px;
  }

  .card{
    padding:24px;
  }
}

@media(prefers-reduced-motion:reduce){

  *{
    scroll-behavior:auto!important;
    transition:none!important;
    animation:none!important;
  }
}

</style>
</head>

<body>

<header class="header">

<a class="brand" href="/">
  <span class="logo">T</span>
  <span class="gradient">TTTMAIL</span>
</a>

<nav class="nav">
  <a href="#mailbox">Temp Mail</a>
  <a href="#inbox">Inbox</a>
  <a href="#features">Features</a>
</nav>

<div class="header-actions">

<span class="poll" id="pollText">
  Next check: 5s
</span>

<button
  class="icon menu"
  onclick="openModal('helpModal')"
  aria-label="Help"
>
?
</button>

<button
  class="icon"
  onclick="requestNotifications()"
  aria-label="Notifications"
>
🔔
</button>

<button
  class="icon"
  onclick="openModal('settingsModal')"
  aria-label="Settings"
>
⚙
</button>

</div>

</header>

<main class="container">

<section class="hero">

<div class="badge">
  <b>● LIVE</b>
  &nbsp; REAL EMAIL • REAL OTP • REAL VERIFICATION
</div>

<h1>
Free
<span class="gradient">
Temporary Email
</span>
</h1>

<p>
Create a disposable mailbox and receive actual incoming
verification emails, OTP messages and activation links
through the configured temporary-mail provider.
</p>

</section>

<div id="adTop" class="ad">
  <span>Advertisement</span>
</div>

<section id="mailbox" class="card">

<div class="card-head">

<div class="title">
  ✉ Active Temporary Mailbox
</div>

<div class="status">
  <span class="status-dot"></span>
  LIVE
</div>

</div>

<label class="label">
  Mailbox Domain
</label>

<select id="domainSelector">
  <option value="1secmail.com">
    1secmail.com
  </option>
  <option value="1secmail.org">
    1secmail.org
  </option>
  <option value="1secmail.net">
    1secmail.net
  </option>
  <option value="esiix.com">
    esiix.com
  </option>
  <option value="wwjmp.com">
    wwjmp.com
  </option>
</select>

<div style="height:10px"></div>

<div class="email-row">

<input
  id="emailInput"
  class="input"
  readonly
  value="Creating mailbox..."
>

<button
  class="btn btn-pink"
  onclick="copyEmail()"
>
Copy
</button>

</div>

<div class="actions">

<button
  id="newEmailButton"
  class="btn"
  onclick="generateNewEmail()"
>
New Email
</button>

<button
  class="btn btn-green"
  onclick="fetchInbox(true)"
>
Check Inbox
</button>

</div>

<div class="actions">

<button
  class="btn btn-yellow"
  onclick="requestNotifications()"
>
Enable Notifications
</button>

<button
  class="btn"
  onclick="openModal('verificationModal')"
>
Verification Guide
</button>

</div>

</section>

<div id="adMiddle" class="ad">
  <span>Advertisement</span>
</div>

<section id="inbox" class="card">

<div class="card-head">

<div class="title">
  ✉ Real Live Inbox
  <span id="inboxCount">(0)</span>
</div>

<button
  class="btn"
  style="min-height:36px"
  onclick="fetchInbox(true)"
>
Refresh
</button>

</div>

<div id="inboxContainer" class="inbox">

<div class="empty">
  <div>
    <div class="empty-icon">✉</div>
    Waiting for incoming email...
  </div>
</div>

</div>

</section>

<section id="features" class="card">

<div class="card-head">
  <div class="title">⚡ Active Features</div>
</div>

<div class="features">

<div class="feature">
<strong>Real Incoming Emails</strong>
<span>
Messages are retrieved from the configured
temporary-mail provider.
</span>
</div>

<div class="feature">
<strong>Real OTP Extraction</strong>
<span>
OTP detection operates against actual received
email content.
</span>
</div>

<div class="feature">
<strong>Verification Links</strong>
<span>
Verification and activation URLs found in
received messages are displayed.
</span>
</div>

<div class="feature">
<strong>Automatic Polling</strong>
<span>
The active mailbox is checked automatically.
</span>
</div>

<div class="feature">
<strong>Browser Notifications</strong>
<span>
Supported browsers can notify you about new mail.
</span>
</div>

<div class="feature">
<strong>One-Tap Copy</strong>
<span>
Copy your mailbox address and detected OTP quickly.
</span>
</div>

</div>

</section>

<section class="card">

<div class="card-head">
  <div class="title">Temporary Email FAQ</div>
</div>

<details>
<summary>Is the OTP real?</summary>
<p style="color:var(--muted);padding-top:9px">
Yes. TTTMAIL does not generate fake OTPs. The
displayed OTP is extracted from a real message
returned by the upstream mailbox provider.
</p>
</details>

<details>
<summary>Why might an OTP not arrive?</summary>
<p style="color:var(--muted);padding-top:9px">
The originating website may block disposable
email domains, delay delivery, or reject the
temporary address.
</p>
</details>

<details>
<summary>Can verification links be opened?</summary>
<p style="color:var(--muted);padding-top:9px">
When a real email contains a recognizable
verification or activation URL, TTTMAIL displays it.
</p>
</details>

</section>

<div id="adBottom" class="ad">
  <span>Advertisement</span>
</div>

</main>

<footer class="footer">

<span>
© 2026 TTTMAIL
</span>

<span>
Real temporary mailbox interface
</span>

</footer>

<!-- ========================================================
     SETTINGS
========================================================= -->

<div id="settingsModal" class="modal">

<div class="modal-box">

<button
  class="close"
  onclick="closeModal('settingsModal')"
>
×
</button>

<h2>Mailbox Settings</h2>

<label class="label">
Automatic Polling
</label>

<select id="pollSetting">

<option value="5000">5 seconds</option>
<option value="7000">7 seconds</option>
<option value="10000">10 seconds</option>
<option value="15000">15 seconds</option>
<option value="30000">30 seconds</option>

</select>

<div style="height:10px"></div>

<button
  class="btn btn-pink"
  style="width:100%"
  onclick="saveSettings()"
>
Save Settings
</button>

</div>

</div>

<!-- ========================================================
     MESSAGE
========================================================= -->

<div id="messageModal" class="modal">

<div class="modal-box">

<button
  class="close"
  onclick="closeModal('messageModal')"
>
×
</button>

<h2 id="messageTitle">
Email
</h2>

<div id="messageMeta" class="meta"></div>

<div id="otpResult"></div>

<div id="verificationLinks"></div>

<div id="messageBody" class="body">
Loading...
</div>

</div>

</div>

<!-- ========================================================
     HELP
========================================================= -->

<div id="helpModal" class="modal">

<div class="modal-box">

<button
  class="close"
  onclick="closeModal('helpModal')"
>
×
</button>

<h2>Help & FAQ</h2>

<p style="color:var(--muted);line-height:1.7;font-size:.8rem">

Generate a mailbox, copy the address and use it
on a service that accepts temporary email.
TTTMAIL polls the real mailbox automatically.

If a service blocks disposable domains, the email
cannot be delivered and TTTMAIL cannot bypass that
third-party policy.

</p>

</div>

</div>

<!-- ========================================================
     VERIFICATION
========================================================= -->

<div id="verificationModal" class="modal">

<div class="modal-box">

<button
  class="close"
  onclick="closeModal('verificationModal')"
>
×
</button>

<h2>Real Email Verification</h2>

<ol
  style="
    color:var(--muted);
    line-height:1.8;
    padding-left:20px;
    font-size:.8rem
  "
>

<li>Create a temporary mailbox.</li>
<li>Copy the mailbox address.</li>
<li>Enter it on the supported website.</li>
<li>Wait for the real email.</li>
<li>TTTMAIL automatically polls the inbox.</li>
<li>Open the received email.</li>
<li>Real OTPs are detected from the message.</li>
<li>Real verification links are extracted.</li>

</ol>

</div>

</div>

<div id="toastWrap" class="toast-wrap"></div>

<script>

"use strict";

/* ============================================================
   CLIENT CONFIG
============================================================ */

const APP = Object.freeze({

  version:"5.0.0",

  endpoint:"/api/mail",

  defaultDomain:"1secmail.com",

  defaultPoll:5000,

  storage:"tttmail_state_v5",

  maxMessages:50

});

const state = {

  login:"",

  domain:APP.defaultDomain,

  email:"",

  pollMs:APP.defaultPoll,

  pollTimer:null,

  countdownTimer:null,

  countdown:5,

  messages:[],

  messageIds:new Set(),

  loading:false,

  currentMessage:null

};

const $ = id =>
  document.getElementById(id);

/* ============================================================
   RANDOM MAILBOX
============================================================ */

const FIRST = [
  "alex","david","sarah","michael","jessica",
  "robert","emily","daniel","olivia","william",
  "sophia","james","charlotte","benjamin","mia",
  "lucas","harper","henry","evelyn","mason",
  "ethan","amelia","noah","ava","logan",
  "ella","liam","grace","jack","chloe"
];

const LAST = [
  "turner","miller","smith","johnson","williams",
  "brown","jones","garcia","davis","rodriguez",
  "martinez","hernandez","lopez","gonzalez",
  "wilson","anderson","thomas","taylor","moore",
  "jackson","white","harris","martin","thompson"
];

function randomInt(min,max){

  return Math.floor(
    Math.random() * (max-min+1)
  ) + min;

}

function generateLogin(){

  const first =
    FIRST[randomInt(0,FIRST.length-1)];

  const last =
    LAST[randomInt(0,LAST.length-1)];

  const number =
    randomInt(100,999);

  return (
    first +
    "." +
    last +
    "." +
    number
  ).toLowerCase();

}

/* ============================================================
   STORAGE
============================================================ */

function saveState(){

  try{

    localStorage.setItem(
      APP.storage,
      JSON.stringify({
        login:state.login,
        domain:state.domain,
        pollMs:state.pollMs
      })
    );

  }catch{}

}

function restoreState(){

  try{

    const raw =
      localStorage.getItem(APP.storage);

    if(!raw) return false;

    const saved =
      JSON.parse(raw);

    if(
      !saved ||
      !validClientLogin(saved.login) ||
      !validClientDomain(saved.domain)
    ){
      return false;
    }

    state.login =
      saved.login;

    state.domain =
      saved.domain;

    if(
      [5000,7000,10000,15000,30000]
      .includes(Number(saved.pollMs))
    ){

      state.pollMs =
        Number(saved.pollMs);

    }

    return true;

  }catch{

    return false;

  }

}

function validClientLogin(value){

  return(
    typeof value === "string" &&
    /^[a-zA-Z0-9._-]{1,64}$/.test(value)
  );

}

function validClientDomain(value){

  return [
    "1secmail.com",
    "1secmail.org",
    "1secmail.net",
    "esiix.com",
    "wwjmp.com"
  ].includes(value);

}

/* ============================================================
   MAILBOX
============================================================ */

function buildEmail(){

  return (
    state.login +
    "@" +
    state.domain
  );

}

function updateEmailUI(){

  state.email =
    buildEmail();

  $("emailInput").value =
    state.email;

  $("domainSelector").value =
    state.domain;

}

function resetMessages(){

  state.messages = [];

  state.messageIds =
    new Set();

  renderInbox();

}

function setMailbox(login,domain){

  state.login =
    login;

  state.domain =
    domain;

  state.email =
    buildEmail();

  saveState();

  resetMessages();

  updateEmailUI();

  restartPolling();

  fetchInbox(false);

}

function generateNewEmail(){

  setMailbox(
    generateLogin(),
    state.domain
  );

  showToast(
    "New temporary mailbox created."
  );

}

function changeDomain(domain){

  if(!validClientDomain(domain))
    return;

  setMailbox(
    generateLogin(),
    domain
  );

  showToast(
    "New mailbox created."
  );

}

/* ============================================================
   REAL WORKER API
============================================================ */

async function apiRequest(params){

  const url =
    new URL(
      APP.endpoint,
      location.origin
    );

  for(
    const [key,value]
    of Object.entries(params)
  ){

    if(
      value !== undefined &&
      value !== null &&
      value !== ""
    ){

      url.searchParams.set(
        key,
        String(value)
      );

    }

  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      15000
    );

  try{

    const response =
      await fetch(
        url.toString(),
        {
          method:"GET",
          cache:"no-store",
          credentials:"same-origin",
          headers:{
            "Accept":
              "application/json"
          },
          signal:
            controller.signal
        }
      );

    let data = null;

    try{

      data =
        await response.json();

    }catch{

      throw new Error(
        "Invalid Worker response"
      );

    }

    if(!response.ok){

      throw new Error(
        data?.message ||
        data?.error ||
        "Mail request failed"
      );

    }

    if(data?.ok === false){

      throw new Error(
        data?.message ||
        data?.error ||
        "Mail request failed"
      );

    }

    return data;

  }finally{

    clearTimeout(timeout);

  }

}

/* ============================================================
   INBOX
============================================================ */

async function fetchInbox(manual=false){

  if(
    !state.login ||
    !state.domain ||
    state.loading
  ){

    return;

  }

  state.loading = true;

  try{

    const response =
      await apiRequest({
        action:"getMessages",
        login:state.login,
        domain:state.domain
      });

    const messages =
      Array.isArray(response.messages)
        ? response.messages
        : [];

    const previous =
      new Set(state.messageIds);

    const normalized =
      messages
      .filter(item =>
        item &&
        item.id
      )
      .slice(
        0,
        APP.maxMessages
      );

    state.messages =
      normalized;

    state.messageIds =
      new Set(
        normalized.map(
          item => String(item.id)
        )
      );

    renderInbox();

    const newMessages =
      normalized.filter(
        item =>
          !previous.has(
            String(item.id)
          )
      );

    if(
      previous.size > 0 &&
      newMessages.length > 0
    ){

      const newest =
        newMessages[0];

      notifyNewEmail(
        newest.subject ||
        "New email received",
        newest.from ||
        "TTTMAIL"
      );

      showToast(
        "New real email received."
      );

    }

    if(manual){

      showToast(
        normalized.length
          ? normalized.length +
            " email(s) found."
          : "Inbox checked — no email yet."
      );

    }

  }catch(error){

    console.error(
      "TTTMAIL inbox error:",
      error
    );

    if(manual){

      showToast(
        "Inbox request failed. Retrying automatically."
      );

    }

  }finally{

    state.loading = false;

    state.countdown =
      Math.ceil(
        state.pollMs / 1000
      );

  }

}

/* ============================================================
   MESSAGE
============================================================ */

async function openMessage(message){

  if(
    !message ||
    !message.id
  ){

    return;

  }

  showToast(
    "Loading real email..."
  );

  try{

    const response =
      await apiRequest({
        action:"readMessage",
        login:state.login,
        domain:state.domain,
        id:message.id
      });

    const detail =
      response.message || {};

    state.currentMessage = {
      ...message,
      ...detail
    };

    renderMessage(
      state.currentMessage
    );

    openModal(
      "messageModal"
    );

  }catch(error){

    console.error(
      "Message error:",
      error
    );

    showToast(
      "Real email could not be loaded."
    );

  }

}

/* ============================================================
   OTP EXTRACTION
============================================================ */

function extractOtp(text){

  if(!text)
    return null;

  const source =
    String(text)
      .replace(/\r/g," ")
      .replace(/\n/g," ")
      .replace(/\s+/g," ");

  const strongPatterns = [

    /\b(?:otp|one[\s-]?time\s+(?:password|code)|verification\s+code|security\s+code|confirmation\s+code|login\s+code|auth(?:entication)?\s+code)\D{0,60}(\d{4,8})\b/i,

    /\b(?:code|pin)\D{0,20}(\d{4,8})\b/i

  ];

  for(
    const regex
    of strongPatterns
  ){

    const match =
      source.match(regex);

    if(
      match &&
      match[1]
    ){

      const code =
        match[1];

      if(
        !/^(\d)\1+$/.test(code) &&
        !/^(1234|12345|123456|1234567|12345678)$/.test(code)
      ){

        return code;

      }

    }

  }

  // Fallback for standalone numeric OTPs.
  const standalone =
    source.match(
      /\b\d{6}\b|\b\d{5}\b|\b\d{4}\b/
    );

  if(standalone){

    const code =
      standalone[0];

    if(
      !/^(\d)\1+$/.test(code) &&
      !/^(1234|12345|123456)$/.test(code)
    ){

      return code;

    }

  }

  return null;

}

/* ============================================================
   VERIFICATION LINKS
============================================================ */

function extractVerificationLinks(text){

  if(!text)
    return [];

  const urls =
    String(text)
      .match(
        /https?:\/\/[^\s<>"')]+/gi
      ) || [];

  const unique =
    [...new Set(
      urls.map(
        url =>
          url.replace(
            /[),.;]+$/,
            ""
          )
      )
    )];

  const keywords = [
    "verify",
    "verification",
    "confirm",
    "confirmation",
    "activate",
    "activation",
    "validate",
    "validation"
  ];

  return unique
    .filter(url => {

      const lower =
        url.toLowerCase();

      return keywords.some(
        keyword =>
          lower.includes(keyword)
      );

    })
    .slice(0,10);

}

/* ============================================================
   HTML STRIPPING
============================================================ */

function stripHtml(html){

  if(!html)
    return "";

  const temp =
    document.createElement("div");

  temp.innerHTML =
    html;

  return (
    temp.textContent ||
    temp.innerText ||
    ""
  );

}

/* ============================================================
   ESCAPING
============================================================ */

function escapeHtml(value){

  return String(
    value ?? ""
  )
  .replace(/&/g,"&amp;")
  .replace(/</g,"&lt;")
  .replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;")
  .replace(/'/g,"&#039;");

}

/* ============================================================
   INBOX RENDER
============================================================ */

function renderInbox(){

  const container =
    $("inboxContainer");

  $("inboxCount").textContent =
    "(" +
    state.messages.length +
    ")";

  if(!state.messages.length){

    container.innerHTML = `
      <div class="empty">
        <div>
          <div class="empty-icon">✉</div>
          No email received yet.
        </div>
      </div>
    `;

    return;

  }

  container.innerHTML =
    state.messages
      .map(message => {

        const id =
          escapeHtml(
            String(message.id)
          );

        const from =
          escapeHtml(
            message.from ||
            "Unknown sender"
          );

        const subject =
          escapeHtml(
            message.subject ||
            "(No subject)"
          );

        const date =
          escapeHtml(
            message.date ||
            ""
          );

        return `
          <article
            class="message"
            tabindex="0"
            data-id="${id}"
          >
            <div>
              <div class="from">
                ${from}
              </div>

              <div class="subject">
                ${subject}
              </div>
            </div>

            <time class="date">
              ${date}
            </time>
          </article>
        `;

      })
      .join("");

  container
    .querySelectorAll(".message")
    .forEach(element => {

      const id =
        element.dataset.id;

      element.addEventListener(
        "click",
        () => {

          const message =
            state.messages.find(
              item =>
                String(item.id) ===
                String(id)
            );

          if(message)
            openMessage(message);

        }
      );

      element.addEventListener(
        "keydown",
        event => {

          if(
            event.key ===
            "Enter"
          ){

            element.click();

          }

        }
      );

    });

}

/* ============================================================
   MESSAGE RENDER
============================================================ */

function renderMessage(message){

  const subject =
    message.subject ||
    "(No subject)";

  const from =
    message.from ||
    "Unknown sender";

  const textBody =
    message.textBody ||
    message.body ||
    stripHtml(
      message.htmlBody ||
      ""
    );

  const completeText =
    [
      subject,
      textBody,
      message.htmlBody || ""
    ].join("\n");

  const otp =
    extractOtp(
      completeText
    );

  const links =
    extractVerificationLinks(
      completeText
    );

  $("messageTitle").textContent =
    subject;

  $("messageMeta").textContent =
    "From: " +
    from +
    (
      message.date
        ? " • " + message.date
        : ""
    );

  if(otp){

    $("otpResult").innerHTML = `
      <div class="otp">

        <div
          style="
            color:var(--muted);
            font-size:.68rem;
            font-weight:900
          "
        >
          REAL OTP DETECTED
        </div>

        <div class="otp-code">
          ${escapeHtml(otp)}
        </div>

        <button
          class="btn btn-green"
          style="width:100%"
          id="copyOtpButton"
        >
          Copy OTP
        </button>

      </div>
    `;

    $("copyOtpButton")
      .addEventListener(
        "click",
        () => copyOtp(otp)
      );

  }else{

    $("otpResult").innerHTML = `
      <div
        style="
          padding:13px;
          border:1px solid var(--border);
          border-radius:12px;
          color:var(--muted);
          font-size:.74rem
        "
      >
        No recognizable OTP was detected
        in this real email.
      </div>
    `;

  }

  if(links.length){

    $("verificationLinks").innerHTML = `
      <div
        style="
          color:var(--yellow);
          font-size:.72rem;
          font-weight:900;
          margin-top:12px
        "
      >
        REAL VERIFICATION / ACTIVATION LINKS
      </div>

      <div class="links">

        ${links.map(url => `

          <a
            class="link"
            href="${escapeHtml(url)}"
            target="_blank"
            rel="noopener noreferrer nofollow"
          >
            ${escapeHtml(url)}
          </a>

        `).join("")}

      </div>
    `;

  }else{

    $("verificationLinks")
      .innerHTML = "";

  }

  $("messageBody").textContent =
    textBody ||
    "No readable text body was returned.";

}

/* ============================================================
   COPY
============================================================ */

async function copyEmail(){

  if(!state.email)
    return;

  try{

    await navigator.clipboard.writeText(
      state.email
    );

    showToast(
      "Temporary email copied."
    );

  }catch{

    const input =
      $("emailInput");

    input.select();

    document.execCommand(
      "copy"
    );

    showToast(
      "Temporary email copied."
    );

  }

}

async function copyOtp(otp){

  try{

    await navigator.clipboard.writeText(
      otp
    );

    showToast(
      "Real OTP copied."
    );

  }catch{

    showToast(
      "Copy failed."
    );

  }

}

/* ============================================================
   NOTIFICATIONS
============================================================ */

async function requestNotifications(){

  if(
    !("Notification" in window)
  ){

    showToast(
      "Browser notifications are not supported."
    );

    return;

  }

  try{

    const permission =
      await Notification.requestPermission();

    if(
      permission === "granted"
    ){

      showToast(
        "Notifications enabled."
      );

      new Notification(
        "TTTMAIL",
        {
          body:
            "New email notifications are enabled."
        }
      );

    }else{

      showToast(
        "Notification permission was not granted."
      );

    }

  }catch{

    showToast(
      "Notification request failed."
    );

  }

}

function notifyNewEmail(
  subject,
  from
){

  if(
    !("Notification" in window) ||
    Notification.permission !==
      "granted"
  ){

    return;

  }

  try{

    new Notification(
      "TTTMAIL — New Email",
      {
        body:
          from +
          ": " +
          subject,
        tag:
          "tttmail-new-email"
      }
    );

  }catch{}

}

/* ============================================================
   POLLING
============================================================ */

function updateCountdown(){

  $("pollText").textContent =
    "Next check: " +
    Math.max(
      0,
      state.countdown
    ) +
    "s";

}

function restartPolling(){

  clearInterval(
    state.pollTimer
  );

  clearInterval(
    state.countdownTimer
  );

  state.countdown =
    Math.ceil(
      state.pollMs / 1000
    );

  updateCountdown();

  state.pollTimer =
    setInterval(
      () => {

        fetchInbox(false);

        state.countdown =
          Math.ceil(
            state.pollMs / 1000
          );

      },
      state.pollMs
    );

  state.countdownTimer =
    setInterval(
      () => {

        if(
          state.countdown > 0
        ){

          state.countdown--;

        }

        updateCountdown();

      },
      1000
    );

}

function saveSettings(){

  const value =
    Number(
      $("pollSetting").value
    );

  if(
    ![
      5000,
      7000,
      10000,
      15000,
      30000
    ].includes(value)
  ){

    return;

  }

  state.pollMs =
    value;

  saveState();

  restartPolling();

  closeModal(
    "settingsModal"
  );

  showToast(
    "Polling updated."
  );

}

/* ============================================================
   MODALS
============================================================ */

function openModal(id){

  const modal =
    $(id);

  if(!modal)
    return;

  modal.classList.add(
    "show"
  );

  document.body.style.overflow =
    "hidden";

}

function closeModal(id){

  const modal =
    $(id);

  if(!modal)
    return;

  modal.classList.remove(
    "show"
  );

  if(
    !document.querySelector(
      ".modal.show"
    )
  ){

    document.body.style.overflow =
      "";

  }

}

document
  .querySelectorAll(".modal")
  .forEach(modal => {

    modal.addEventListener(
      "click",
      event => {

        if(
          event.target ===
          modal
        ){

          closeModal(
            modal.id
          );

        }

      }
    );

  });

document.addEventListener(
  "keydown",
  event => {

    if(
      event.key ===
      "Escape"
    ){

      document
        .querySelectorAll(
          ".modal.show"
        )
        .forEach(
          modal =>
            closeModal(
              modal.id
            )
        );

    }

  }
);

/* ============================================================
   TOAST
============================================================ */

function showToast(message){

  const wrap =
    $("toastWrap");

  const toast =
    document.createElement(
      "div"
    );

  toast.className =
    "toast";

  toast.textContent =
    message;

  wrap.appendChild(
    toast
  );

  setTimeout(
    () => toast.remove(),
    3500
  );

}

/* ============================================================
   ADS
============================================================ */

async function loadAds(){

  try{

    const response =
      await fetch(
        "/api/ads",
        {
          cache:"no-store"
        }
      );

    if(!response.ok)
      return;

    const ads =
      await response.json();

    const mapping = {
      adTop:ads.top,
      adMiddle:ads.middle,
      adBottom:ads.bottom
    };

    for(
      const [id,content]
      of Object.entries(mapping)
    ){

      const element =
        $(id);

      if(!element)
        continue;

      if(
        typeof content ===
        "string" &&
        content.trim()
      ){

        /*
         * Admin-controlled ad HTML.
         * Only place trusted ad-provider code here.
         */
        element.innerHTML =
          content;

      }else{

        element.innerHTML =
          "<span>Advertisement</span>";

      }

    }

  }catch{

    // Ads must never break mailbox functionality.

  }

}

/* ============================================================
   DOMAIN
============================================================ */

$("domainSelector")
  .addEventListener(
    "change",
    event =>
      changeDomain(
        event.target.value
      )
  );

/* ============================================================
   VISIBILITY
============================================================ */

document.addEventListener(
  "visibilitychange",
  () => {

    if(document.hidden){

      clearInterval(
        state.pollTimer
      );

      clearInterval(
        state.countdownTimer
      );

    }else{

      restartPolling();

      fetchInbox(false);

    }

  }
);

/* ============================================================
   INIT
============================================================ */

(function init(){

  const restored =
    restoreState();

  if(!restored){

    state.login =
      generateLogin();

    state.domain =
      APP.defaultDomain;

    saveState();

  }

  state.email =
    buildEmail();

  $("pollSetting").value =
    String(state.pollMs);

  updateEmailUI();

  renderInbox();

  loadAds();

  restartPolling();

  fetchInbox(false);

})();

</script>

</body>
</html>`;
}

// ============================================================
// WORKER
// ============================================================

export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);

    // --------------------------------------------------------
    // OPTIONS
    // --------------------------------------------------------

    if(request.method === "OPTIONS"){

      return new Response(null,{
        status:204,
        headers:{
          ...SECURITY_HEADERS,
          "Access-Control-Allow-Origin":
            url.origin,
          "Access-Control-Allow-Methods":
            "GET, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Accept",
          "Access-Control-Max-Age":
            "86400"
        }
      });

    }

    // --------------------------------------------------------
    // RATE LIMIT
    // --------------------------------------------------------

    if(
      url.pathname.startsWith("/api/")
    ){

      const allowed =
        await rateLimit(
          request,
          env
        );

      if(!allowed){

        return json(
          {
            ok:false,
            error:"RATE_LIMITED",
            message:
              "Too many requests. Please try again shortly."
          },
          429,
          {
            "Retry-After":"60"
          }
        );

      }

    }

    // --------------------------------------------------------
    // ADS
    // --------------------------------------------------------

    if(
      url.pathname ===
      "/api/ads"
    ){

      return handleAds(env);

    }

    // --------------------------------------------------------
    // REAL MAIL PROXY
    // --------------------------------------------------------

    if(
      url.pathname ===
      "/api/mail"
    ){

      if(
        request.method !==
        "GET"
      ){

        return json(
          {
            ok:false,
            error:"METHOD_NOT_ALLOWED"
          },
          405
        );

      }

      return handleMailAPI(
        request
      );

    }

    // --------------------------------------------------------
    // MANIFEST
    // --------------------------------------------------------

    if(
      url.pathname ===
      "/manifest.webmanifest"
    ){

      return new Response(
        JSON.stringify({
          name:"TTTMAIL",
          short_name:"TTTMAIL",
          start_url:"/",
          display:"standalone",
          background_color:"#08080a",
          theme_color:"#ff0080",
          description:
            "Temporary email inbox"
        }),
        {
          headers:{
            "Content-Type":
              "application/manifest+json",
            ...SECURITY_HEADERS
          }
        }
      );

    }

    // --------------------------------------------------------
    // KV HTML
    // --------------------------------------------------------

    if(env.MY_KV){

      try{

        const stored =
          await env.MY_KV.get(
            APP.KV_HTML
          );

        if(stored){

          return htmlResponse(
            stored
          );

        }

      }catch{

        // Fall through to embedded HTML.

      }

    }

    // --------------------------------------------------------
    // EMBEDDED FALLBACK
    // --------------------------------------------------------

    return htmlResponse(
      getDefaultHTML()
    );

  }

};
<!-- =========================================================
 UNIVERSAL SAFE WEBSITE + ADSTERRA SMARTLINK MASTER
 COMPLETE END-OF-FILE EDITION
 VERSION 50.0.0

 This block can be pasted once at the end of index.html.

 It automatically creates one clearly labeled sponsored card.
 SmartLinks open only after an explicit user click.
 No automatic popup.
 No automatic redirect.
 No hidden ad zone.
 No fake keyword injection.
========================================================= -->

<script>
(() => {
  "use strict";

  if (window.__UAM_V50_LOADED__) return;
  window.__UAM_V50_LOADED__ = true;

  const CONFIG = {
    version: "50.0.0",

    smartlink: {
      enabled: true,
      openInNewTab: true,
      rotateLinks: true,

      pageLimit: 2,
      sessionLimit: 8,
      cooldownMs: 15000,

      links: [
        "https://www.effectivecpmnetwork.com/x0wcj4zk?key=c2b46070b44982014166acafd6074c3d",
        "https://www.effectivecpmnetwork.com/sa8mca36sv?key=3711015d24018cf89ccb362976c4a2e0"
      ]
    },

    sponsoredCard: {
      enabled: true,
      id: "uam-v50-sponsored-card",
      insertPosition: "after-main"
    },

    seo: {
      enabled: true,
      preserveExisting: true
    },

    accessibility: true,
    performance: true,
    security: true,
    offlineNotice: true,
    diagnostics: true,

    /*
      Do not enable these unless these files really exist.
    */
    pwa: {
      manifest: false,
      serviceWorker: false,
      manifestPath: "/manifest.webmanifest",
      serviceWorkerPath: "/sw.js"
    },

    /*
      Optional visible keyword suggestion.
      This is NOT automatically inserted into page content.
      Replace only after checking real search demand.
    */
    keywordSuggestion: {
      enabled: false,
      value: ""
    }
  };

  const STATE = {
    initialized: false,
    destroyed: false,
    linkIndex: 0,
    pageOpens: 0,
    lastOpen: 0,
    syncTimer: null,
    syncing: false,
    observer: null,
    errors: [],
    zoneReady: false
  };

  function safe(fn, fallback = null) {
    try {
      return fn();
    } catch (error) {
      recordError(
        "internal",
        error?.message || String(error)
      );
      return fallback;
    }
  }

  function recordError(type, message) {
    if (!CONFIG.diagnostics) return;

    STATE.errors.push({
      type,
      message: String(message || "Unknown error"),
      time: new Date().toISOString()
    });

    if (STATE.errors.length > 100) {
      STATE.errors.splice(0, STATE.errors.length - 100);
    }
  }

  function qs(selector, root = document) {
    return safe(
      () => root.querySelector(selector),
      null
    );
  }

  function qsa(selector, root = document) {
    return safe(
      () => Array.from(root.querySelectorAll(selector)),
      []
    );
  }

  function getHead() {
    if (document.head) return document.head;

    const head = document.createElement("head");

    document.documentElement.insertBefore(
      head,
      document.documentElement.firstChild
    );

    return head;
  }

  function isReady() {
    return Boolean(
      document.documentElement &&
      document.head &&
      document.body
    );
  }

  function getPageUrl() {
    return safe(() => {
      const url = new URL(window.location.href);
      url.hash = "";
      return url.toString();
    }, window.location.href);
  }

  function getTitle() {
    return (
      document.title.trim() ||
      (qs("h1")?.textContent || "")
        .replace(/s+/g, " ")
        .trim() ||
      window.location.hostname ||
      "Website"
    );
  }

  function getDescription() {
    const existing = qs('meta[name="description"]')
      ?.getAttribute("content")
      ?.trim();

    if (existing) return existing;

    const text = qsa("main p, article p, section p")
      .map((item) => item.textContent || "")
      .join(" ")
      .replace(/s+/g, " ")
      .trim();

    return (
      text.slice(0, 160) ||
      "Useful web tools and information for modern users."
    );
  }

  function hasMeta(attribute, value) {
    return Boolean(
      qs(`meta[${attribute}="${value}"]`, getHead())
    );
  }

  function addMeta(attribute, value, content) {
    if (!content || hasMeta(attribute, value)) return;

    safe(() => {
      const meta = document.createElement("meta");

      meta.setAttribute(attribute, value);
      meta.setAttribute("content", String(content));

      getHead().appendChild(meta);
    });
  }

  function hasLink(rel) {
    return Boolean(
      qs(`link[rel="${rel}"]`, getHead())
    );
  }

  function addLink(rel, href) {
    if (!rel || !href || hasLink(rel)) return;

    safe(() => {
      const link = document.createElement("link");

      link.setAttribute("rel", rel);
      link.setAttribute("href", href);

      getHead().appendChild(link);
    });
  }

  function setupBasicDocument() {
    if (!isReady()) return;

    if (!document.documentElement.lang) {
      document.documentElement.lang =
        navigator.language?.split("-")[0] || "en";
    }

    if (!qs("meta[charset]", getHead())) {
      const charset = document.createElement("meta");

      charset.setAttribute("charset", "UTF-8");

      getHead().insertBefore(
        charset,
        getHead().firstChild
      );
    }

    addMeta(
      "name",
      "viewport",
      "width=device-width, initial-scale=1, viewport-fit=cover"
    );

    addMeta(
      "name",
      "referrer",
      "strict-origin-when-cross-origin"
    );
  }

  function setupSEO() {
    if (!CONFIG.seo.enabled) return;

    const title = getTitle();
    const description = getDescription();
    const canonical = getPageUrl();

    addMeta("name", "description", description);

    addMeta(
      "name",
      "robots",
      "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
    );

    addMeta("name", "theme-color", "#0b1020");

    addLink("canonical", canonical);

    addMeta("property", "og:type", "website");
    addMeta("property", "og:title", title);
    addMeta("property", "og:description", description);
    addMeta("property", "og:url", canonical);

    addMeta("name", "twitter:card", "summary_large_image");
    addMeta("name", "twitter:title", title);
    addMeta("name", "twitter:description", description);
  }

  function setupAccessibility() {
    if (!CONFIG.accessibility) return;

    qsa("img").forEach((image) => {
      if (!image.hasAttribute("alt")) {
        image.setAttribute("alt", "");
      }
    });

    qsa("iframe").forEach((iframe) => {
      if (!iframe.hasAttribute("title")) {
        iframe.setAttribute("title", "Embedded content");
      }
    });

    qsa("a[target='_blank']").forEach((link) => {
      const rel = new Set(
        (link.getAttribute("rel") || "")
          .split(/s+/)
          .filter(Boolean)
      );

      rel.add("noopener");
      rel.add("noreferrer");

      link.setAttribute("rel", [...rel].join(" "));
    });
  }

  function setupPerformance() {
    if (!CONFIG.performance) return;

    qsa("img").forEach((image, index) => {
      if (!image.hasAttribute("loading")) {
        image.setAttribute(
          "loading",
          index < 2 ? "eager" : "lazy"
        );
      }

      if (!image.hasAttribute("decoding")) {
        image.setAttribute("decoding", "async");
      }
    });

    qsa("iframe").forEach((iframe) => {
      if (!iframe.hasAttribute("loading")) {
        iframe.setAttribute("loading", "lazy");
      }
    });
  }

  function setupCSS() {
    if (qs("#uam-v50-css")) return;

    const style = document.createElement("style");
    style.id = "uam-v50-css";

    style.textContent = `
      #uam-v50-sponsored-card {
        box-sizing: border-box;
        width: min(100% - 32px, 720px);
        margin: 24px auto;
        padding: 16px;
        border: 1px solid rgba(127, 127, 127, .25);
        border-radius: 14px;
        background: rgba(127, 127, 127, .08);
        color: inherit;
        font: inherit;
        text-align: center;
      }

      #uam-v50-sponsored-card * {
        box-sizing: border-box;
      }

      #uam-v50-sponsored-card .uam-v50-label {
        display: block;
        margin-bottom: 8px;
        opacity: .7;
        font-size: 12px;
      }

      #uam-v50-sponsored-card button {
        display: inline-block;
        min-height: 42px;
        padding: 10px 18px;
        border: 0;
        border-radius: 9px;
        cursor: pointer;
        color: #fff;
        background: #075985;
        font: inherit;
        font-weight: 700;
      }

      #uam-v50-sponsored-card button:hover {
        filter: brightness(1.12);
      }

      #uam-v50-sponsored-card button:focus-visible {
        outline: 2px solid currentColor;
        outline-offset: 3px;
      }

      #uam-v50-offline,
      #uam-v50-notice {
        position: fixed;
        left: 50%;
        bottom: 18px;
        z-index: 2147483647;
        max-width: calc(100% - 32px);
        padding: 10px 14px;
        border-radius: 10px;
        color: #fff;
        font: 600 13px/1.4 system-ui, sans-serif;
        text-align: center;
        box-shadow: 0 12px 30px rgba(0,0,0,.3);
        opacity: 0;
        pointer-events: none;
        transform: translate(-50%, 12px);
        transition: opacity .2s ease, transform .2s ease;
      }

      #uam-v50-offline {
        background: #b91c1c;
      }

      #uam-v50-notice {
        background: #075985;
      }

      @media (prefers-reduced-motion: reduce) {
        *,
        *::before,
        *::after {
          animation-duration: .01ms !important;
          transition-duration: .01ms !important;
          scroll-behavior: auto !important;
        }
      }
    `;

    getHead().appendChild(style);
  }

  function showNotice(message, isError = false) {
    let element = qs("#uam-v50-notice");

    if (!element) {
      element = document.createElement("div");
      element.id = "uam-v50-notice";
      element.setAttribute("role", "status");
      element.setAttribute("aria-live", "polite");
      document.body.appendChild(element);
    }

    element.style.background = isError
      ? "#991b1b"
      : "#075985";

    element.textContent = message;
    element.style.opacity = "1";
    element.style.transform = "translate(-50%, 0)";

    clearTimeout(element.__uamTimer);

    element.__uamTimer = setTimeout(() => {
      element.style.opacity = "0";
      element.style.transform = "translate(-50%, 12px)";
    }, 3500);
  }

  function isValidSmartLink(value) {
    return safe(() => {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();

      return (
        url.protocol === "https:" &&
        (
          host === "effectivecpmnetwork.com" ||
          host === "www.effectivecpmnetwork.com"
        ) &&
        url.pathname.length > 1 &&
        url.searchParams.has("key")
      );
    }, false);
  }

  function getValidLinks() {
    return CONFIG.smartlink.links.filter(isValidSmartLink);
  }

  function getNextLink() {
    const links = getValidLinks();

    if (!links.length) return null;
    if (!CONFIG.smartlink.rotateLinks) return links[0];

    const link = links[
      STATE.linkIndex % links.length
    ];

    STATE.linkIndex += 1;

    return link;
  }

  function getSessionOpens() {
    return safe(
      () =>
        Number(
          sessionStorage.getItem(
            "uam-v50-session-opens"
          ) || 0
        ),
      0
    );
  }

  function setSessionOpens(value) {
    safe(() => {
      sessionStorage.setItem(
        "uam-v50-session-opens",
        String(value)
      );
    });
  }

  function openSmartLink() {
    if (!CONFIG.smartlink.enabled) return false;

    if (
      STATE.pageOpens >=
      CONFIG.smartlink.pageLimit
    ) {
      showNotice("Sponsored-link page limit reached.");
      return false;
    }

    const sessionOpens = getSessionOpens();

    if (
      sessionOpens >=
      CONFIG.smartlink.sessionLimit
    ) {
      showNotice("Sponsored-link session limit reached.");
      return false;
    }

    const now = Date.now();

    if (
      STATE.lastOpen &&
      now - STATE.lastOpen <
      CONFIG.smartlink.cooldownMs
    ) {
      showNotice(
        "Please wait before opening another sponsored link."
      );
      return false;
    }

    const link = getNextLink();

    if (!link) {
      recordError(
        "smartlink",
        "No valid SmartLink configured."
      );

      showNotice(
        "SmartLink is unavailable. Check Adsterra status.",
        true
      );

      return false;
    }

    let opened = false;

    if (CONFIG.smartlink.openInNewTab) {
      opened = safe(() => {
        const tab = window.open(
          link,
          "_blank",
          "noopener,noreferrer"
        );

        if (!tab) return false;

        try {
          tab.opener = null;
        } catch {}

        return true;
      }, false);
    } else {
      safe(() => {
        window.location.assign(link);
      });

      opened = true;
    }

    if (!opened) {
      showNotice(
        "Browser blocked the sponsored tab.",
        true
      );

      return false;
    }

    STATE.pageOpens += 1;
    STATE.lastOpen = now;
    setSessionOpens(sessionOpens + 1);

    return true;
  }

  function createSponsoredCard() {
    if (!CONFIG.sponsoredCard.enabled) return;

    if (qs(`#${CONFIG.sponsoredCard.id}`)) {
      STATE.zoneReady = true;
      return;
    }

    const card = document.createElement("section");
    card.id = CONFIG.sponsoredCard.id;
    card.setAttribute("aria-label", "Sponsored content");

    const label = document.createElement("span");
    label.className = "uam-v50-label";
    label.textContent = "Sponsored";

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "View sponsored content";
    button.setAttribute("data-adsterra-zone", "");
    button.setAttribute(
      "aria-label",
      "View sponsored content"
    );

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openSmartLink();
    });

    card.appendChild(label);
    card.appendChild(button);

    const main = qs("main");

    if (main && main.parentNode) {
      main.parentNode.insertBefore(
        card,
        main.nextSibling
      );
    } else {
      document.body.appendChild(card);
    }

    STATE.zoneReady = true;
  }

  function initializeOfflineNotice() {
    if (!CONFIG.offlineNotice) return;

    let element = qs("#uam-v50-offline");

    if (!element) {
      element = document.createElement("div");
      element.id = "uam-v50-offline";
      element.textContent = "You are offline";
      element.setAttribute("role", "status");
      element.setAttribute("aria-live", "polite");
      document.body.appendChild(element);
    }

    const update = () => {
      const offline = navigator.onLine === false;

      element.style.opacity = offline ? "1" : "0";
      element.style.transform = offline
        ? "translate(-50%, 0)"
        : "translate(-50%, 12px)";
    };

    window.addEventListener("online", update);
    window.addEventListener("offline", update);

    update();
  }

  function initializeDiagnostics() {
    if (!CONFIG.diagnostics) return;

    window.addEventListener("error", (event) => {
      recordError(
        "runtime",
        event.message || "Runtime error"
      );
    });

    window.addEventListener(
      "unhandledrejection",
      (event) => {
        recordError(
          "promise",
          event.reason?.message ||
            String(
              event.reason ||
              "Unhandled promise rejection"
            )
        );
      }
    );
  }

  function setupObserver() {
    if (
      STATE.observer ||
      !window.MutationObserver ||
      !document.body
    ) {
      return;
    }

    STATE.observer = new MutationObserver(
      (mutations) => {
        const addedNodes = mutations.some(
          (mutation) =>
            mutation.addedNodes &&
            mutation.addedNodes.length > 0
        );

        if (addedNodes) {
          queueSync();
        }
      }
    );

    STATE.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function queueSync() {
    if (
      STATE.destroyed ||
      STATE.syncTimer
    ) {
      return;
    }

    STATE.syncTimer = setTimeout(() => {
      STATE.syncTimer = null;
      synchronize();
    }, 400);
  }

  function synchronize() {
    if (
      STATE.destroyed ||
      STATE.syncing ||
      !isReady()
    ) {
      return;
    }

    STATE.syncing = true;

    try {
      setupBasicDocument();
      setupSEO();
      setupAccessibility();
      setupPerformance();
      setupCSS();
      initializeOfflineNotice();
      createSponsoredCard();
    } catch (error) {
      recordError(
        "sync",
        error?.message || String(error)
      );
    } finally {
      STATE.syncing = false;
    }
  }

  function setupPWA() {
    if (!CONFIG.pwa.enabled) return;

    if (CONFIG.pwa.manifestPath) {
      addLink(
        "manifest",
        CONFIG.pwa.manifestPath
      );
    }

    if (
      CONFIG.pwa.serviceWorker &&
      "serviceWorker" in navigator &&
      window.isSecureContext
    ) {
      navigator.serviceWorker
        .register(
          CONFIG.pwa.serviceWorkerPath,
          { scope: "/" }
        )
        .catch((error) => {
          recordError(
            "service-worker",
            error?.message || String(error)
          );
        });
    }
  }

  function initialize() {
    if (STATE.initialized || !isReady()) return;

    STATE.initialized = true;

    initializeDiagnostics();
    setupObserver();
    setupPWA();
    synchronize();
  }

  window.UniversalWebsiteMaster = {
    version: CONFIG.version,

    sync: synchronize,

    queueSync,

    openSponsored: openSmartLink,

    status() {
      return {
        version: CONFIG.version,
        initialized: STATE.initialized,
        secureContext: window.isSecureContext,
        online: navigator.onLine,
        configuredSmartLinks:
          CONFIG.smartlink.links.length,
        validSmartLinks:
          getValidLinks().length,
        sponsoredCard:
          Boolean(
            qs(`#${CONFIG.sponsoredCard.id}`)
          ),
        pageOpens: STATE.pageOpens,
        sessionOpens: getSessionOpens(),
        pageLimit: CONFIG.smartlink.pageLimit,
        sessionLimit:
          CONFIG.smartlink.sessionLimit,
        errors: STATE.errors.length
      };
    },

    errors() {
      return [...STATE.errors];
    },

    clearErrors() {
      STATE.errors.length = 0;
      return true;
    },

    destroy() {
      STATE.destroyed = true;

      clearTimeout(STATE.syncTimer);

      if (STATE.observer) {
        STATE.observer.disconnect();
        STATE.observer = null;
      }

      return true;
    }
  };

  if (isReady()) {
    initialize();
  } else {
    document.addEventListener(
      "DOMContentLoaded",
      initialize,
      { once: true }
    );
  }
})();
</script>
