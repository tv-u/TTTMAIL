// ============================================================
// TTTMAIL — ENTERPRISE CLOUDFLARE WORKER
// Version: 5.0.0
// Runtime: Cloudflare Workers
// KV Binding: MY_KV
//
// Required KV keys:
//   html_main
//   ad_top
//   ad_middle
//   ad_bottom
//
// API routes:
//   GET /api/health
//   GET /api/ads
//   GET /api/inbox?login=...&domain=...
//   GET /api/message?login=...&domain=...&id=...
//
// External provider:
//   1secmail API
//
// IMPORTANT:
// - No simulated emails.
// - No simulated OTPs.
// - OTP extraction is performed only against received messages.
// - Verification URLs are extracted only from received messages.
// ============================================================

const VERSION = "5.0.0";

const CONFIG = Object.freeze({
  KV_HTML_KEY: "html_main",

  MAIL_API: "https://www.1secmail.com/api/v1/",

  REQUEST_TIMEOUT_MS: 12000,

  MAX_LOGIN_LENGTH: 64,
  MAX_DOMAIN_LENGTH: 128,
  MAX_MESSAGE_ID_LENGTH: 64,

  HTML_CACHE_SECONDS: 60,
  API_CACHE_SECONDS: 0,

  ALLOWED_METHODS: ["GET", "HEAD", "OPTIONS"],

  ALLOWED_DOMAINS: new Set([
    "1secmail.com",
    "1secmail.org",
    "1secmail.net",
    "esiix.com",
    "wwjmp.com"
  ])
});

// ============================================================
// SECURITY HEADERS
// ============================================================

function securityHeaders(extra = {}) {
  return {
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data: https:",
      "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
      "connect-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "upgrade-insecure-requests"
    ].join("; "),

    "Referrer-Policy": "strict-origin-when-cross-origin",

    "X-Content-Type-Options": "nosniff",

    "X-Frame-Options": "DENY",

    "Permissions-Policy": [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "bluetooth=()"
    ].join(", "),

    "Cross-Origin-Opener-Policy": "same-origin",

    "Cross-Origin-Resource-Policy": "same-origin",

    "Strict-Transport-Security":
      "max-age=31536000; includeSubDomains",

    ...extra
  };
}

// ============================================================
// RESPONSE HELPERS
// ============================================================

function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: securityHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra
    })
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: securityHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control":
        `public, max-age=${CONFIG.HTML_CACHE_SECONDS}, must-revalidate`
    })
  });
}

function errorResponse(status, code, message) {
  return jsonResponse(
    {
      ok: false,
      error: code,
      message,
      version: VERSION
    },
    status
  );
}

// ============================================================
// INPUT VALIDATION
// ============================================================

function isValidLogin(login) {
  if (
    typeof login !== "string" ||
    !login ||
    login.length > CONFIG.MAX_LOGIN_LENGTH
  ) {
    return false;
  }

  return /^[a-zA-Z0-9._-]+$/.test(login);
}

function isValidDomain(domain) {
  if (
    typeof domain !== "string" ||
    !domain ||
    domain.length > CONFIG.MAX_DOMAIN_LENGTH
  ) {
    return false;
  }

  return CONFIG.ALLOWED_DOMAINS.has(domain.toLowerCase());
}

function isValidMessageId(id) {
  if (
    typeof id !== "string" ||
    !id ||
    id.length > CONFIG.MAX_MESSAGE_ID_LENGTH
  ) {
    return false;
  }

  return /^\d+$/.test(id);
}

// ============================================================
// TIMEOUT / UPSTREAM FETCH
// ============================================================

async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort("upstream-timeout");
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 1SECMAIL UPSTREAM REQUEST
// ============================================================

async function mailApiRequest(params) {
  const url = new URL(CONFIG.MAIL_API);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetchWithTimeout(
    url.toString(),
    {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "TTTMAIL-Cloudflare-Worker/5.0"
      },
      cf: {
        cacheTtl: 0,
        cacheEverything: false
      }
    }
  );

  if (!response.ok) {
    throw new Error(`MAIL_PROVIDER_HTTP_${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.toLowerCase().includes("json")) {
    throw new Error("MAIL_PROVIDER_INVALID_CONTENT_TYPE");
  }

  const data = await response.json();

  return data;
}

// ============================================================
// NORMALIZE INBOX
// ============================================================

function normalizeInbox(data) {
  if (!Array.isArray(data)) {
    throw new Error("INVALID_INBOX_RESPONSE");
  }

  return data
    .filter(item => item && item.id != null)
    .slice(0, 50)
    .map(item => ({
      id: String(item.id),
      from: typeof item.from === "string" ? item.from.slice(0, 500) : "",
      subject:
        typeof item.subject === "string"
          ? item.subject.slice(0, 1000)
          : "",
      date:
        typeof item.date === "string"
          ? item.date.slice(0, 200)
          : ""
    }));
}

// ============================================================
// NORMALIZE MESSAGE
// ============================================================

function normalizeMessage(data) {
  if (!data || typeof data !== "object") {
    throw new Error("INVALID_MESSAGE_RESPONSE");
  }

  return {
    id: data.id != null ? String(data.id) : "",
    from:
      typeof data.from === "string"
        ? data.from.slice(0, 1000)
        : "",
    subject:
      typeof data.subject === "string"
        ? data.subject.slice(0, 2000)
        : "",
    date:
      typeof data.date === "string"
        ? data.date.slice(0, 300)
        : "",
    textBody:
      typeof data.textBody === "string"
        ? data.textBody.slice(0, 200000)
        : "",
    body:
      typeof data.body === "string"
        ? data.body.slice(0, 200000)
        : "",
    htmlBody:
      typeof data.htmlBody === "string"
        ? data.htmlBody.slice(0, 300000)
        : ""
  };
}

// ============================================================
// API ROUTE — HEALTH
// ============================================================

async function handleHealth(env) {
  let kvAvailable = false;

  try {
    if (env.MY_KV) {
      await env.MY_KV.get(CONFIG.KV_HTML_KEY, {
        type: "text"
      });
      kvAvailable = true;
    }
  } catch {
    kvAvailable = false;
  }

  return jsonResponse({
    ok: true,
    service: "TTTMAIL",
    version: VERSION,
    runtime: "Cloudflare Workers",
    kv: kvAvailable,
    timestamp: new Date().toISOString()
  });
}

// ============================================================
// API ROUTE — ADS
// ============================================================

async function handleAds(env) {
  if (!env.MY_KV) {
    return jsonResponse({
      ok: true,
      top: "",
      middle: "",
      bottom: ""
    });
  }

  try {
    const [top, middle, bottom] = await Promise.all([
      env.MY_KV.get("ad_top", { type: "text" }),
      env.MY_KV.get("ad_middle", { type: "text" }),
      env.MY_KV.get("ad_bottom", { type: "text" })
    ]);

    return jsonResponse(
      {
        ok: true,
        top: top || "",
        middle: middle || "",
        bottom: bottom || ""
      },
      200,
      {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300"
      }
    );
  } catch (error) {
    console.error("ADS_KV_ERROR", error);

    return jsonResponse(
      {
        ok: false,
        top: "",
        middle: "",
        bottom: "",
        error: "ADS_UNAVAILABLE"
      },
      200
    );
  }
}

// ============================================================
// API ROUTE — INBOX
// ============================================================

async function handleInbox(url) {
  const login = url.searchParams.get("login") || "";
  const domain = (url.searchParams.get("domain") || "").toLowerCase();

  if (!isValidLogin(login)) {
    return errorResponse(
      400,
      "INVALID_LOGIN",
      "The mailbox login is invalid."
    );
  }

  if (!isValidDomain(domain)) {
    return errorResponse(
      400,
      "INVALID_DOMAIN",
      "The requested mailbox domain is not supported."
    );
  }

  try {
    const result = await mailApiRequest({
      action: "getMessages",
      login,
      domain
    });

    const messages = normalizeInbox(result);

    return jsonResponse(
      {
        ok: true,
        login,
        domain,
        count: messages.length,
        messages
      },
      200,
      {
        "Cache-Control": "no-store"
      }
    );
  } catch (error) {
    console.error("INBOX_UPSTREAM_ERROR", error);

    return errorResponse(
      502,
      "MAIL_PROVIDER_UNAVAILABLE",
      "The temporary-mail provider could not be reached."
    );
  }
}

// ============================================================
// API ROUTE — MESSAGE
// ============================================================

async function handleMessage(url) {
  const login = url.searchParams.get("login") || "";
  const domain = (url.searchParams.get("domain") || "").toLowerCase();
  const id = url.searchParams.get("id") || "";

  if (!isValidLogin(login)) {
    return errorResponse(
      400,
      "INVALID_LOGIN",
      "The mailbox login is invalid."
    );
  }

  if (!isValidDomain(domain)) {
    return errorResponse(
      400,
      "INVALID_DOMAIN",
      "The requested mailbox domain is not supported."
    );
  }

  if (!isValidMessageId(id)) {
    return errorResponse(
      400,
      "INVALID_MESSAGE_ID",
      "The message ID is invalid."
    );
  }

  try {
    const result = await mailApiRequest({
      action: "readMessage",
      login,
      domain,
      id
    });

    return jsonResponse(
      {
        ok: true,
        message: normalizeMessage(result)
      },
      200,
      {
        "Cache-Control": "no-store"
      }
    );
  } catch (error) {
    console.error("MESSAGE_UPSTREAM_ERROR", error);

    return errorResponse(
      502,
      "MAIL_MESSAGE_UNAVAILABLE",
      "The requested email message could not be loaded."
    );
  }
}

// ============================================================
// FALLBACK HTML
// ============================================================

function getDefaultHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#08080a">
<meta name="color-scheme" content="dark">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta name="description" content="TTTMAIL — free temporary email with a real disposable inbox for receiving real verification emails and OTP messages.">
<link rel="canonical" href="/">
<link rel="manifest" href="/manifest.webmanifest">
<title>TTTMAIL — Free Temporary Email & Real Inbox</title>

<style>
:root{
  --pink:#ff0080;
  --pink2:#c80062;
  --green:#00ff88;
  --green2:#00a85a;
  --yellow:#ffdd00;
  --bg:#08080a;
  --surface:#111116;
  --surface2:#18181f;
  --border:#2b2b37;
  --text:#fff;
  --muted:#9b9baa;
  --danger:#ff4567;
  --radius:18px;
  --pill:999px;
  --shadow:0 15px 50px rgba(0,0,0,.45);
  --transition:180ms cubic-bezier(.2,.8,.2,1);
}

*{
  box-sizing:border-box;
  margin:0;
  padding:0;
}

html{
  background:var(--bg);
  scroll-behavior:smooth;
}

body{
  min-height:100vh;
  background:
    radial-gradient(circle at 10% 0%,rgba(255,0,128,.08),transparent 30rem),
    radial-gradient(circle at 90% 20%,rgba(0,255,136,.05),transparent 30rem),
    var(--bg);
  color:var(--text);
  font-family:
    Inter,
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

button,
a{
  -webkit-tap-highlight-color:transparent;
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

.sr-only{
  position:absolute!important;
  width:1px!important;
  height:1px!important;
  padding:0!important;
  margin:-1px!important;
  overflow:hidden!important;
  clip:rect(0,0,0,0)!important;
  white-space:nowrap!important;
  border:0!important;
}

.header{
  position:sticky;
  top:0;
  z-index:1000;
  min-height:64px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  padding:10px 14px;
  background:rgba(8,8,10,.9);
  border-bottom:1px solid rgba(255,255,255,.08);
  backdrop-filter:blur(18px);
  -webkit-backdrop-filter:blur(18px);
}

.brand{
  display:flex;
  align-items:center;
  gap:10px;
  font-size:1.1rem;
  font-weight:900;
}

.logo{
  width:37px;
  height:37px;
  border-radius:11px;
  display:grid;
  place-items:center;
  background:linear-gradient(135deg,var(--pink),#8d004a);
  box-shadow:0 10px 35px rgba(255,0,128,.25);
  font-weight:900;
}

.nav{
  display:none;
  align-items:center;
  gap:20px;
}

.nav a{
  color:var(--muted);
  font-size:.8rem;
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

.poll{
  display:none;
  padding:7px 11px;
  border:1px solid var(--border);
  border-radius:var(--pill);
  background:var(--surface);
  color:var(--muted);
  font-size:.7rem;
  font-weight:800;
}

.poll-dot{
  color:var(--green);
}

.icon{
  width:38px;
  height:38px;
  display:grid;
  place-items:center;
  border:1px solid var(--border);
  border-radius:50%;
  background:var(--surface);
  color:#fff;
}

.container{
  width:min(920px,100%);
  margin:auto;
  padding:20px 14px;
}

.hero{
  text-align:center;
  padding:28px 0 20px;
}

.badge{
  display:inline-flex;
  align-items:center;
  gap:7px;
  padding:7px 13px;
  border:1px solid var(--border);
  border-radius:var(--pill);
  background:rgba(24,24,31,.8);
  color:var(--muted);
  font-size:.7rem;
  font-weight:800;
  margin-bottom:14px;
}

.badge strong{
  color:var(--green);
}

h1{
  font-size:clamp(2rem,7vw,3.5rem);
  line-height:1.05;
  letter-spacing:-1.7px;
  font-weight:900;
}

.hero p{
  max-width:700px;
  margin:15px auto 0;
  color:var(--muted);
  line-height:1.65;
  font-size:.9rem;
}

.card{
  background:rgba(18,18,23,.94);
  border:1px solid var(--border);
  border-radius:var(--radius);
  box-shadow:var(--shadow);
  padding:18px;
  margin-bottom:18px;
}

.card-header{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  padding-bottom:13px;
  margin-bottom:15px;
  border-bottom:1px solid var(--border);
}

.card-title{
  font-size:.95rem;
  font-weight:900;
}

.status{
  color:var(--green);
  font-size:.7rem;
  font-weight:900;
}

.status-dot{
  display:inline-block;
  width:7px;
  height:7px;
  border-radius:50%;
  background:var(--green);
  box-shadow:0 0 12px var(--green);
  margin-right:5px;
}

.mailbox-top{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:10px;
  flex-wrap:wrap;
  margin-bottom:10px;
}

.label{
  color:var(--muted);
  font-size:.68rem;
  font-weight:900;
  text-transform:uppercase;
  letter-spacing:.6px;
}

.select,
.input{
  width:100%;
  min-height:47px;
  padding:11px 13px;
  border:1px solid var(--border);
  border-radius:12px;
  outline:none;
  color:#fff;
  background:#0d0d12;
}

.select{
  width:auto;
  min-width:150px;
}

.input:focus,
.select:focus{
  border-color:var(--pink);
  box-shadow:0 0 0 3px rgba(255,0,128,.12);
}

.email-row{
  display:grid;
  grid-template-columns:1fr;
  gap:9px;
}

.actions{
  display:grid;
  grid-template-columns:1fr;
  gap:9px;
  margin-top:10px;
}

.btn{
  min-height:46px;
  border:1px solid rgba(255,255,255,.12);
  border-radius:var(--pill);
  padding:10px 16px;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:8px;
  color:#fff;
  font-size:.76rem;
  font-weight:900;
  transition:var(--transition);
}

.btn:active{
  transform:scale(.975);
}

.pink{
  background:linear-gradient(135deg,var(--pink),var(--pink2));
  box-shadow:0 10px 35px rgba(255,0,128,.25);
}

.green{
  color:#06130d;
  background:linear-gradient(135deg,var(--green),var(--green2));
}

.yellow{
  color:#08080a;
  background:linear-gradient(135deg,#ffe900,#d8b800);
}

.dark{
  background:linear-gradient(135deg,#292933,#15151c);
}

.ad{
  min-height:60px;
  margin-bottom:18px;
  padding:12px;
  display:flex;
  align-items:center;
  justify-content:center;
  border:1px dashed rgba(255,0,128,.65);
  border-radius:13px;
  background:
    linear-gradient(
      135deg,
      rgba(255,0,128,.07),
      rgba(0,255,136,.04)
    );
  text-align:center;
  overflow:hidden;
}

.ad:empty{
  display:none;
}

.inbox{
  min-height:190px;
  max-height:450px;
  overflow:auto;
  border-radius:12px;
}

.empty{
  min-height:190px;
  display:grid;
  place-items:center;
  text-align:center;
  color:var(--muted);
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

.message-from{
  font-weight:900;
  font-size:.8rem;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.message-subject{
  margin-top:4px;
  color:var(--muted);
  font-size:.74rem;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.message-date{
  color:var(--muted);
  font-size:.64rem;
  white-space:nowrap;
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
  font-size:.8rem;
}

.feature span{
  color:var(--muted);
  font-size:.7rem;
  line-height:1.5;
}

.footer{
  width:min(920px,100%);
  margin:auto;
  padding:20px 14px 35px;
  display:flex;
  justify-content:space-between;
  flex-wrap:wrap;
  gap:12px;
  color:var(--muted);
  font-size:.68rem;
}

.footer-links{
  display:flex;
  gap:12px;
}

.modal{
  position:fixed;
  inset:0;
  z-index:5000;
  display:none;
  align-items:center;
  justify-content:center;
  padding:15px;
  background:rgba(0,0,0,.82);
  backdrop-filter:blur(8px);
}

.modal.show{
  display:flex;
}

.modal-box{
  width:min(650px,100%);
  max-height:88dvh;
  overflow:auto;
  padding:22px;
  position:relative;
  background:#15151b;
  border:1px solid var(--border);
  border-radius:20px;
  box-shadow:0 25px 80px rgba(0,0,0,.75);
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

.otp{
  margin:15px 0;
  padding:18px;
  border:1px solid rgba(0,255,136,.35);
  border-radius:14px;
  background:rgba(0,255,136,.05);
  text-align:center;
}

.otp-code{
  margin:8px 0;
  color:var(--green);
  font-size:2rem;
  font-weight:900;
  letter-spacing:5px;
}

.link{
  display:block;
  margin-top:8px;
  padding:11px;
  border:1px solid var(--border);
  border-radius:10px;
  background:var(--surface);
  color:#8fcfff;
  font-size:.72rem;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.toast-container{
  position:fixed;
  right:15px;
  bottom:15px;
  z-index:9000;
  width:min(390px,calc(100vw - 30px));
  display:grid;
  gap:8px;
}

.toast{
  padding:13px 15px;
  border:1px solid var(--border);
  border-radius:13px;
  background:rgba(20,20,27,.98);
  box-shadow:var(--shadow);
  font-size:.74rem;
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

  .card{
    padding:24px;
  }
}

@media(prefers-reduced-motion:reduce){
  *,
  *::before,
  *::after{
    scroll-behavior:auto!important;
    transition:none!important;
    animation:none!important;
  }
}
</style>
</head>

<body>

<header class="header">
  <a class="brand" href="/" aria-label="TTTMAIL home">
    <span class="logo">T</span>
    <span class="gradient">TTTMAIL</span>
  </a>

  <nav class="nav" aria-label="Primary navigation">
    <a href="#mailbox">Temp Mail</a>
    <a href="#inbox">Inbox</a>
    <a href="#features">Features</a>
  </nav>

  <div class="header-actions">
    <div class="poll">
      <span class="poll-dot">●</span>
      <span id="pollText">Next check: 4s</span>
    </div>

    <button class="icon menu" id="notificationButton" type="button" aria-label="Enable notifications">
      🔔
    </button>
  </div>
</header>

<main class="container">

<section class="hero">
  <div class="badge">
    <strong>●</strong>
    REAL INBOX • REAL EMAILS • REAL OTP EXTRACTION
  </div>

  <h1>
    Free
    <span class="gradient">Temporary Email</span>
    & Real Inbox
  </h1>

  <p>
    Generate a disposable mailbox and receive real incoming messages
    through the configured temporary-mail provider.
  </p>
</section>

<div id="adTop" class="ad"></div>

<section id="mailbox" class="card">

  <div class="card-header">
    <div class="card-title">✉ Active Temporary Mailbox</div>
    <div class="status">
      <span class="status-dot"></span>
      LIVE
    </div>
  </div>

  <div class="mailbox-top">
    <span class="label">Disposable Email Address</span>

    <select id="domainSelector" class="select" aria-label="Mailbox domain">
      <option value="1secmail.com">1secmail.com</option>
      <option value="1secmail.org">1secmail.org</option>
      <option value="1secmail.net">1secmail.net</option>
      <option value="esiix.com">esiix.com</option>
      <option value="wwjmp.com">wwjmp.com</option>
    </select>
  </div>

  <div class="email-row">
    <input
      id="emailInput"
      class="input"
      type="text"
      readonly
      aria-label="Temporary email address"
      value="Creating mailbox..."
    >

    <button id="copyButton" class="btn pink" type="button">
      Copy
    </button>
  </div>

  <div class="actions">
    <button id="newEmailButton" class="btn dark" type="button">
      New Email
    </button>

    <button id="refreshButton" class="btn green" type="button">
      Check Inbox
    </button>
  </div>

  <div class="actions">
    <button id="notifyButton" class="btn yellow" type="button">
      Enable Notifications
    </button>

    <button id="clearButton" class="btn dark" type="button">
      Clear Local State
    </button>
  </div>

</section>

<div id="adMiddle" class="ad"></div>

<section id="inbox" class="card">

  <div class="card-header">
    <div class="card-title">
      Real Live Inbox
      <span id="inboxCount">(0)</span>
    </div>

    <button id="refreshButton2" class="btn dark" type="button">
      Refresh
    </button>
  </div>

  <div id="inboxContainer" class="inbox">
    <div class="empty">
      Waiting for incoming email...
    </div>
  </div>

</section>

<section id="features" class="card">

  <div class="card-header">
    <div class="card-title">Active Features</div>
  </div>

  <div class="features">

    <div class="feature">
      <strong>Real Incoming Emails</strong>
      <span>
        Messages are retrieved from the configured temporary-mail provider.
      </span>
    </div>

    <div class="feature">
      <strong>Real OTP Extraction</strong>
      <span>
        OTP detection operates only against received message content.
      </span>
    </div>

    <div class="feature">
      <strong>Verification Links</strong>
      <span>
        Recognizable verification URLs can be extracted from received emails.
      </span>
    </div>

    <div class="feature">
      <strong>Automatic Polling</strong>
      <span>
        The active mailbox is periodically checked automatically.
      </span>
    </div>

    <div class="feature">
      <strong>Browser Notifications</strong>
      <span>
        Supported browsers can notify you about newly received messages.
      </span>
    </div>

    <div class="feature">
      <strong>Cloudflare API Gateway</strong>
      <span>
        Browser requests use same-origin Worker endpoints instead of directly
        calling the external mailbox API.
      </span>
    </div>

  </div>

</section>

<div id="adBottom" class="ad"></div>

</main>

<footer class="footer">
  <span>© 2026 TTTMAIL</span>

  <div class="footer-links">
    <a href="#mailbox">Mailbox</a>
    <a href="#inbox">Inbox</a>
    <a href="#features">Features</a>
  </div>
</footer>

<div id="messageModal" class="modal" role="dialog" aria-modal="true">
  <div class="modal-box">

    <button id="closeModal" class="close" type="button">
      ×
    </button>

    <h2 id="messageTitle">Email</h2>

    <div
      id="messageMeta"
      style="color:var(--muted);font-size:.72rem;margin-top:8px"
    ></div>

    <div id="otpResult"></div>

    <div id="verificationLinks"></div>

    <div
      id="messageBody"
      style="
        margin-top:14px;
        padding:14px;
        border:1px solid var(--border);
        border-radius:12px;
        background:#0c0c10;
        white-space:pre-wrap;
        word-break:break-word;
        color:#c7c7d2;
        font-size:.78rem;
        line-height:1.65;
      "
    ></div>

  </div>
</div>

<div id="toastContainer" class="toast-container"></div>

<script>
"use strict";

/* ==========================================================
   TTTMAIL FRONTEND ENGINE 5.0
========================================================== */

const APP = Object.freeze({
  version: "5.0.0",
  storageKey: "tttmail_state_v5",
  defaultDomain: "1secmail.com",
  defaultPoll: 4000,
  maxMessages: 50,
  allowedPolls: Object.freeze([
    4000,
    6000,
    8000,
    15000,
    30000
  ])
});

const state = {
  login: "",
  domain: APP.defaultDomain,
  email: "",
  pollMs: APP.defaultPoll,
  messages: [],
  messageIds: new Set(),
  pollTimer: null,
  countdownTimer: null,
  countdown: 4,
  loading: false,
  initialized: false
};

const $ = id => document.getElementById(id);

/* ==========================================================
   SAFE RANDOM MAILBOX NAME
========================================================== */

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

const PREFIX = [
  "secure","verify","account","support","client",
  "portal","cloud","dev","mail","auth",
  "gateway","service","business","connect","access"
];

function randomInt(min,max){
  return Math.floor(
    Math.random() * (max - min + 1)
  ) + min;
}

function generateLogin(){
  const first =
    FIRST[randomInt(0,FIRST.length - 1)];

  const last =
    LAST[randomInt(0,LAST.length - 1)];

  const prefix =
    PREFIX[randomInt(0,PREFIX.length - 1)];

  const number =
    randomInt(100000,999999);

  return (
    prefix +
    "." +
    first +
    "." +
    last +
    number
  )
  .toLowerCase()
  .replace(/[^a-z0-9._-]/g,"")
  .slice(0,60);
}

/* ==========================================================
   MAILBOX STATE
========================================================== */

function buildEmail(){
  return state.login + "@" + state.domain;
}

function saveState(){
  try{
    localStorage.setItem(
      APP.storageKey,
      JSON.stringify({
        login:state.login,
        domain:state.domain,
        pollMs:state.pollMs
      })
    );
  }catch(error){
    console.warn("State save failed",error);
  }
}

function restoreState(){

  try{

    const raw =
      localStorage.getItem(APP.storageKey);

    if(!raw) return false;

    const saved =
      JSON.parse(raw);

    if(
      typeof saved.login !== "string" ||
      !/^[a-zA-Z0-9._-]+$/.test(saved.login) ||
      saved.login.length > 64
    ){
      return false;
    }

    const domains = [
      "1secmail.com",
      "1secmail.org",
      "1secmail.net",
      "esiix.com",
      "wwjmp.com"
    ];

    if(
      typeof saved.domain !== "string" ||
      !domains.includes(saved.domain)
    ){
      return false;
    }

    state.login = saved.login;
    state.domain = saved.domain;

    if(
      APP.allowedPolls.includes(
        Number(saved.pollMs)
      )
    ){
      state.pollMs = Number(saved.pollMs);
    }

    state.email = buildEmail();

    return true;

  }catch{
    return false;
  }
}

function updateEmailUI(){

  const input = $("emailInput");

  if(input){
    input.value = state.email;
  }

  const selector =
    $("domainSelector");

  if(selector){
    selector.value = state.domain;
  }
}

function resetMessages(){

  state.messages = [];
  state.messageIds = new Set();

  renderInbox();
}

function setMailbox(login,domain){

  state.login = login;
  state.domain = domain;
  state.email = buildEmail();

  resetMessages();

  saveState();
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

/* ==========================================================
   CLIPBOARD
========================================================== */

async function copyText(text){

  if(!text) return false;

  try{

    if(
      navigator.clipboard &&
      window.isSecureContext
    ){
      await navigator.clipboard.writeText(text);
      return true;
    }

    const textarea =
      document.createElement("textarea");

    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";

    document.body.appendChild(textarea);

    textarea.focus();
    textarea.select();

    const ok =
      document.execCommand("copy");

    textarea.remove();

    return ok;

  }catch{
    return false;
  }
}

async function copyEmail(){

  const ok =
    await copyText(state.email);

  showToast(
    ok
      ? "Temporary email copied."
      : "Unable to copy the email address."
  );
}

/* ==========================================================
   SAME-ORIGIN WORKER API
========================================================== */

async function apiRequest(path,params={}){

  const url =
    new URL(
      path,
      window.location.origin
    );

  for(
    const [key,value]
    of Object.entries(params)
  ){
    url.searchParams.set(
      key,
      String(value)
    );
  }

  const controller =
    new AbortController();

  const timer =
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
            "Accept":"application/json"
          },
          signal:controller.signal
        }
      );

    let data = null;

    try{
      data = await response.json();
    }catch{
      throw new Error(
        "INVALID_SERVER_RESPONSE"
      );
    }

    if(!response.ok || data?.ok === false){

      const error =
        new Error(
          data?.message ||
          "API request failed."
        );

      error.code =
        data?.error ||
        "API_ERROR";

      error.status =
        response.status;

      throw error;
    }

    return data;

  }finally{

    clearTimeout(timer);
  }
}

/* ==========================================================
   FETCH INBOX
========================================================== */

async function fetchInbox(manual=false){

  if(
    state.loading ||
    !state.login ||
    !state.domain
  ){
    return;
  }

  state.loading = true;

  try{

    const data =
      await apiRequest(
        "/api/inbox",
        {
          login:state.login,
          domain:state.domain
        }
      );

    const messages =
      Array.isArray(data.messages)
        ? data.messages
        : [];

    const oldIds =
      new Set(state.messageIds);

    const normalized =
      messages
        .filter(
          item =>
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
          !oldIds.has(
            String(item.id)
          )
      );

    if(
      oldIds.size > 0 &&
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
        "New email received."
      );
    }

    if(manual){

      showToast(
        normalized.length
          ? normalized.length +
            " email(s) found."
          : "Inbox checked — no messages yet."
      );
    }

  }catch(error){

    console.error(
      "TTTMAIL inbox error:",
      error
    );

    if(manual){

      if(
        error.code ===
        "MAIL_PROVIDER_UNAVAILABLE"
      ){
        showToast(
          "Mail provider is temporarily unavailable."
        );
      }else{
        showToast(
          "Unable to check the inbox."
        );
      }
    }

  }finally{

    state.loading = false;

    state.countdown =
      Math.ceil(
        state.pollMs / 1000
      );

    updateCountdown();
  }
}

/* ==========================================================
   OPEN MESSAGE
========================================================== */

async function openMessage(message){

  if(
    !message ||
    !message.id
  ){
    return;
  }

  showToast(
    "Loading email..."
  );

  try{

    const data =
      await apiRequest(
        "/api/message",
        {
          login:state.login,
          domain:state.domain,
          id:message.id
        }
      );

    if(!data.message){
      throw new Error(
        "EMPTY_MESSAGE"
      );
    }

    renderMessage(
      {
        ...message,
        ...data.message
      }
    );

    openModal();

  }catch(error){

    console.error(
      "Message loading error:",
      error
    );

    showToast(
      "Unable to load this email."
    );
  }
}

/* ==========================================================
   OTP EXTRACTION
========================================================== */

function extractOtp(text){

  if(!text) return null;

  const normalized =
    String(text)
      .replace(/\r/g," ")
      .replace(/\n/g," ")
      .replace(/\s+/g," ");

  const patterns = [

    /\b(?:OTP|one[-\s]?time password|verification code|security code|confirmation code|login code|authentication code|auth code)\D{0,50}(\d{4,8})\b/i,

    /\b(?:code|pin)\D{0,20}(\d{4,8})\b/i,

    /\b(\d{6})\b/,

    /\b(\d{5})\b/,

    /\b(\d{4})\b/
  ];

  for(
    const regex of patterns
  ){

    const match =
      normalized.match(regex);

    if(
      match &&
      match[1] &&
      /^\d{4,8}$/.test(match[1])
    ){

      return match[1];
    }
  }

  return null;
}

/* ==========================================================
   VERIFICATION LINK EXTRACTION
========================================================== */

function extractVerificationLinks(text){

  if(!text) return [];

  const matches =
    String(text)
      .match(
        /https?:\/\/[^\s<>"')]+/gi
      ) || [];

  const unique =
    [...new Set(
      matches.map(
        url =>
          url.replace(
            /[),.;]+$/,
            ""
          )
      )
    )];

  return unique
    .filter(url => {

      try{

        const parsed =
          new URL(url);

        if(
          parsed.protocol !==
          "https:" &&
          parsed.protocol !==
          "http:"
        ){
          return false;
        }

        const value =
          url.toLowerCase();

        return (
          value.includes("verify") ||
          value.includes("confirm") ||
          value.includes("activate") ||
          value.includes("validation") ||
          value.includes("authentication") ||
          value.includes("auth") ||
          value.includes("token") ||
          value.includes("account")
        );

      }catch{

        return false;
      }
    })
    .slice(0,10);
}

/* ==========================================================
   HTML STRIPPER
========================================================== */

function stripHtml(html){

  if(!html) return "";

  const temp =
    document.createElement("div");

  temp.innerHTML = html;

  return (
    temp.textContent ||
    temp.innerText ||
    ""
  );
}

/* ==========================================================
   SAFE HTML ESCAPING
========================================================== */

function escapeHtml(value){

  return String(value ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

/* ==========================================================
   INBOX RENDER
========================================================== */

function renderInbox(){

  const container =
    $("inboxContainer");

  const count =
    $("inboxCount");

  if(!container) return;

  if(count){
    count.textContent =
      "(" +
      state.messages.length +
      ")";
  }

  if(!state.messages.length){

    container.innerHTML =
      '<div class="empty">No email received yet.</div>';

    return;
  }

  container.innerHTML =
    state.messages
      .map(message => {

        const id =
          String(message.id);

        return (
          '<article class="message" ' +
          'role="button" tabindex="0" ' +
          'data-message-id="' +
          escapeHtml(id) +
          '">' +

          '<div>' +

          '<div class="message-from">' +
          escapeHtml(
            message.from ||
            "Unknown sender"
          ) +
          '</div>' +

          '<div class="message-subject">' +
          escapeHtml(
            message.subject ||
            "(No subject)"
          ) +
          '</div>' +

          '</div>' +

          '<time class="message-date">' +
          escapeHtml(
            message.date ||
            ""
          ) +
          '</time>' +

          '</article>'
        );
      })
      .join("");

  container
    .querySelectorAll(".message")
    .forEach(element => {

      const id =
        element.dataset.messageId;

      element.addEventListener(
        "click",
        () => {

          const message =
            state.messages.find(
              item =>
                String(item.id) === id
            );

          if(message){
            openMessage(message);
          }
        }
      );

      element.addEventListener(
        "keydown",
        event => {

          if(
            event.key === "Enter" ||
            event.key === " "
          ){

            event.preventDefault();

            const message =
              state.messages.find(
                item =>
                  String(item.id) === id
              );

            if(message){
              openMessage(message);
            }
          }
        }
      );
    });
}

/* ==========================================================
   MESSAGE RENDER
========================================================== */

function renderMessage(message){

  const subject =
    message.subject ||
    "(No subject)";

  const from =
    message.from ||
    "Unknown sender";

  const body =
    message.textBody ||
    message.body ||
    stripHtml(
      message.htmlBody ||
      ""
    ) ||
    "";

  const fullText =
    subject +
    "\n" +
    body;

  const otp =
    extractOtp(fullText);

  const links =
    extractVerificationLinks(
      body +
      "\n" +
      (message.htmlBody || "")
    );

  $("messageTitle")
    .textContent =
      subject;

  $("messageMeta")
    .textContent =
      "From: " +
      from +
      (
        message.date
          ? " • " + message.date
          : ""
      );

  if(otp){

    $("otpResult").innerHTML =
      '<div class="otp">' +

      '<div style="color:var(--muted);font-size:.68rem;font-weight:900">' +
      'OTP DETECTED FROM RECEIVED EMAIL' +
      '</div>' +

      '<div class="otp-code">' +
      escapeHtml(otp) +
      '</div>' +

      '<button id="copyOtpButton" class="btn green" style="width:100%" type="button">' +
      'Copy OTP' +
      '</button>' +

      '</div>';

    $("copyOtpButton")
      .addEventListener(
        "click",
        async () => {

          const ok =
            await copyText(otp);

          showToast(
            ok
              ? "OTP copied."
              : "Unable to copy OTP."
          );
        }
      );

  }else{

    $("otpResult").innerHTML =
      '<div style="margin-top:15px;padding:13px;border:1px solid var(--border);border-radius:12px;color:var(--muted);font-size:.75rem">' +
      'No recognizable OTP code was detected in this email.' +
      '</div>';
  }

  if(links.length){

    $("verificationLinks").innerHTML =
      '<div style="margin-top:14px;color:var(--yellow);font-size:.7rem;font-weight:900">' +
      'VERIFICATION / ACTIVATION LINKS' +
      '</div>' +

      links
        .map(url =>
          '<a class="link" href="' +
          escapeHtml(url) +
          '" target="_blank" rel="noopener noreferrer nofollow">' +
          escapeHtml(url) +
          '</a>'
        )
        .join("");

  }else{

    $("verificationLinks").innerHTML = "";
  }

  $("messageBody")
    .textContent =
      body ||
      "No readable text body was returned by the mailbox provider.";
}

/* ==========================================================
   NOTIFICATIONS
========================================================== */

async function requestNotifications(){

  if(
    !("Notification" in window)
  ){

    showToast(
      "This browser does not support notifications."
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
        "Browser notifications enabled."
      );

      new Notification(
        "TTTMAIL",
        {
          body:
            "Notifications are enabled for new inbox messages.",
          tag:
            "tttmail-enabled"
        }
      );

    }else{

      showToast(
        "Notification permission was not granted."
      );
    }

  }catch(error){

    console.error(
      "Notification error:",
      error
    );

    showToast(
      "Notification permission could not be requested."
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
          String(from) +
          ": " +
          String(subject),
        tag:
          "tttmail-new-email"
      }
    );

  }catch{}
}

/* ==========================================================
   POLLING
========================================================== */

function updateCountdown(){

  const element =
    $("pollText");

  if(!element) return;

  element.textContent =
    "Next check: " +
    Math.max(
      0,
      state.countdown
    ) +
    "s";
}

function restartPolling(){

  if(state.pollTimer){
    clearInterval(
      state.pollTimer
    );
  }

  if(state.countdownTimer){
    clearInterval(
      state.countdownTimer
    );
  }

  state.countdown =
    Math.ceil(
      state.pollMs / 1000
    );

  updateCountdown();

  state.pollTimer =
    setInterval(
      () => {

        state.countdown =
          Math.ceil(
            state.pollMs / 1000
          );

        fetchInbox(false);

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

/* ==========================================================
   DOMAIN CHANGE
========================================================== */

$("domainSelector")
  .addEventListener(
    "change",
    event => {

      const domain =
        event.target.value;

      if(!domain) return;

      setMailbox(
        generateLogin(),
        domain
      );

      showToast(
        "New mailbox created."
      );
    }
  );

/* ==========================================================
   MODAL
========================================================== */

function openModal(){

  $("messageModal")
    .classList.add("show");

  document.body.style.overflow =
    "hidden";
}

function closeModal(){

  $("messageModal")
    .classList.remove("show");

  document.body.style.overflow =
    "";
}

$("closeModal")
  .addEventListener(
    "click",
    closeModal
  );

$("messageModal")
  .addEventListener(
    "click",
    event => {

      if(
        event.target ===
        $("messageModal")
      ){
        closeModal();
      }
    }
  );

document.addEventListener(
  "keydown",
  event => {

    if(
      event.key === "Escape"
    ){
      closeModal();
    }
  }
);

/* ==========================================================
   TOAST
========================================================== */

function showToast(message){

  const container =
    $("toastContainer");

  const toast =
    document.createElement("div");

  toast.className =
    "toast";

  toast.textContent =
    String(message);

  container.appendChild(
    toast
  );

  setTimeout(
    () => toast.remove(),
    3500
  );
}

/* ==========================================================
   ADS
========================================================== */

async function loadAds(){

  try{

    const data =
      await apiRequest(
        "/api/ads"
      );

    const map = {
      adTop:data.top,
      adMiddle:data.middle,
      adBottom:data.bottom
    };

    for(
      const [id,html]
      of Object.entries(map)
    ){

      const element =
        $(id);

      if(!element) continue;

      if(
        typeof html === "string" &&
        html.trim()
      ){

        /*
         * KV ad content must only contain trusted
         * publisher-provided Adsterra markup.
         */
        element.innerHTML =
          html;
      }else{

        element.replaceChildren();
      }
    }

  }catch(error){

    console.warn(
      "Advertisement loading failed:",
      error
    );

    [
      "adTop",
      "adMiddle",
      "adBottom"
    ].forEach(id => {

      const element = $(id);

      if(element){
        element.replaceChildren();
      }
    });
  }
}

/* ==========================================================
   CLEAR LOCAL STATE
========================================================== */

$("clearButton")
  .addEventListener(
    "click",
    () => {

      try{
        localStorage.removeItem(
          APP.storageKey
        );
      }catch{}

      setMailbox(
        generateLogin(),
        APP.defaultDomain
      );

      showToast(
        "Local mailbox state cleared."
      );
    }
  );

/* ==========================================================
   BUTTON EVENTS
========================================================== */

$("copyButton")
  .addEventListener(
    "click",
    copyEmail
  );

$("newEmailButton")
  .addEventListener(
    "click",
    generateNewEmail
  );

$("refreshButton")
  .addEventListener(
    "click",
    () => fetchInbox(true)
  );

$("refreshButton2")
  .addEventListener(
    "click",
    () => fetchInbox(true)
  );

$("notifyButton")
  .addEventListener(
    "click",
    requestNotifications
  );

$("notificationButton")
  .addEventListener(
    "click",
    requestNotifications
  );

/* ==========================================================
   VISIBILITY
========================================================== */

document.addEventListener(
  "visibilitychange",
  () => {

    if(
      document.hidden
    ){

      if(state.pollTimer){
        clearInterval(
          state.pollTimer
        );
        state.pollTimer = null;
      }

      if(state.countdownTimer){
        clearInterval(
          state.countdownTimer
        );
        state.countdownTimer = null;
      }

    }else{

      restartPolling();

      fetchInbox(false);
    }
  }
);

/* ==========================================================
   HASH NAVIGATION
========================================================== */

window.addEventListener(
  "hashchange",
  () => {

    const hash =
      location.hash;

    if(hash === "#inbox"){

      $("inbox")
        .scrollIntoView({
          behavior:"smooth"
        });

    }else if(
      hash === "#features"
    ){

      $("features")
        .scrollIntoView({
          behavior:"smooth"
        });

    }else if(
      hash === "#mailbox"
    ){

      $("mailbox")
        .scrollIntoView({
          behavior:"smooth"
        });
    }
  }
);

/* ==========================================================
   BEFORE UNLOAD
========================================================== */

window.addEventListener(
  "beforeunload",
  () => {

    if(state.pollTimer){
      clearInterval(
        state.pollTimer
      );
    }

    if(state.countdownTimer){
      clearInterval(
        state.countdownTimer
      );
    }
  }
);

/* ==========================================================
   SERVICE WORKER
========================================================== */

if(
  "serviceWorker" in navigator
){

  window.addEventListener(
    "load",
    () => {

      navigator.serviceWorker
        .register(
          "/sw.js",
          {
            scope:"/"
          }
        )
        .catch(
          error =>
            console.warn(
              "Service worker registration failed:",
              error
            )
        );
    }
  );
}

/* ==========================================================
   INITIALIZATION
========================================================== */

async function init(){

  const restored =
    restoreState();

  if(!restored){

    state.login =
      generateLogin();

    state.domain =
      APP.defaultDomain;

    state.email =
      buildEmail();

    saveState();
  }

  state.email =
    buildEmail();

  updateEmailUI();

  renderInbox();

  restartPolling();

  state.initialized =
    true;

  /*
   * Run independently so a failure in ads
   * never breaks mailbox initialization.
   */
  loadAds();

  await fetchInbox(false);
}

init();

</script>

</body>
</html>`;
}

// ============================================================
// ROOT HANDLER
// ============================================================

async function handleRoot(request, env) {

  let html = null;

  try {

    if (env.MY_KV) {

      html = await env.MY_KV.get(
        CONFIG.KV_HTML_KEY,
        {
          type: "text"
        }
      );
    }

  } catch (error) {

    console.error(
      "HTML_KV_READ_ERROR",
      error
    );
  }

  if (
    typeof html !== "string" ||
    !html.trim()
  ) {

    html =
      getDefaultHTML();
  }

  return htmlResponse(html);
}

// ============================================================
// OPTIONS
// ============================================================

function handleOptions() {

  return new Response(null, {
    status: 204,
    headers: securityHeaders({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":
        CONFIG.ALLOWED_METHODS.join(", "),
      "Access-Control-Allow-Headers":
        "Content-Type, Accept",
      "Access-Control-Max-Age":
        "86400"
    })
  });
}

// ============================================================
// 404
// ============================================================

function notFound() {

  return errorResponse(
    404,
    "NOT_FOUND",
    "The requested route does not exist."
  );
}

// ============================================================
// METHOD GUARD
// ============================================================

function methodAllowed(method) {

  return CONFIG.ALLOWED_METHODS
    .includes(method);
}

// ============================================================
// MAIN WORKER
// ============================================================

export default {

  async fetch(request, env, ctx) {

    try {

      const method =
        request.method.toUpperCase();

      if(
        !methodAllowed(method)
      ){

        return errorResponse(
          405,
          "METHOD_NOT_ALLOWED",
          "This HTTP method is not supported."
        );
      }

      if(
        method === "OPTIONS"
      ){

        return handleOptions();
      }

      const url =
        new URL(request.url);

      const pathname =
        url.pathname;

      if(
        pathname === "/api/health"
      ){

        return handleHealth(env);
      }

      if(
        pathname === "/api/ads"
      ){

        return handleAds(env);
      }

      if(
        pathname === "/api/inbox"
      ){

        return handleInbox(url);
      }

      if(
        pathname === "/api/message"
      ){

        return handleMessage(url);
      }

      if(
        pathname === "/" ||
        pathname === "/index.html"
      ){

        return handleRoot(
          request,
          env
        );
      }

      return notFound();

    } catch (error) {

      console.error(
        "TTTMAIL_WORKER_FATAL",
        error
      );

      return errorResponse(
        500,
        "INTERNAL_SERVER_ERROR",
        "An unexpected server error occurred."
      );
    }
  }
};
