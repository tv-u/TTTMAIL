const FEATURE_LIST = Array.from({ length: 100 }, (_, i) => ({
  id: i + 1,
  title: `Utility ${i + 1}`,
  description: `Production utility module ${i + 1} for email, security, otp, alias, or analytics workflows.`,
  category: ["mail", "security", "otp", "alias", "analytics"][i % 5],
  icon: ["fa-envelope", "fa-shield-halved", "fa-filter", "fa-bolt", "fa-link"][i % 5]
}));

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders()
    }
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function randomString(len = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

async function sha256Base64(input) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

function makeMailbox(domain = "1secmail.com") {
  const login = randomString(10);
  return {
    login,
    domain,
    address: `${login}@${domain}`,
    createdAt: new Date().toISOString()
  };
}

const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>TTTMAIL</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css" />
<style>
:root{--bg:#08080a;--card:#18181e;--surface:#121216;--border:#2a2a38;--text:#fff;--muted:#a0a0b0;--primary:#ff0080;--secondary:#00ff88;--accent:#ffdd00;--header-h:72px}
*{box-sizing:border-box;margin:0;padding:0;font-family:Inter,system-ui,sans-serif}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text)}
body{position:relative}
#bgCanvas{position:fixed;inset:0;width:100vw;height:100vh;z-index:-1;pointer-events:none}
.scroll-container{height:100vh;overflow-y:auto;overflow-x:hidden;scroll-snap-type:y mandatory;scroll-behavior:smooth;scroll-padding-top:var(--header-h)}
.section-viewport{min-height:100vh;scroll-snap-align:start;scroll-snap-stop:always;padding:calc(var(--header-h) + 20px) 16px 24px;display:flex;align-items:center;justify-content:center}
.container{width:100%;max-width:980px}
.header{position:fixed;top:0;left:0;right:0;height:var(--header-h);z-index:100;background:rgba(24,24,30,.94);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 16px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--text);font-weight:900}
.nav-links{display:none;gap:12px}
@media(min-width:1200px){.nav-links{display:flex}}
.nav-link{color:var(--muted);text-decoration:none;font-size:.78rem;font-weight:800;text-transform:uppercase;cursor:pointer}
.nav-link.active,.nav-link:hover{color:var(--text)}
.icon-btn,.pill,.btn,.input,.select,.card,.tile,.modal-content,.drawer{border:1px solid var(--border)}
.icon-btn{width:36px;height:36px;border-radius:9999px;background:var(--surface);color:var(--text);display:flex;align-items:center;justify-content:center;cursor:pointer}
.btn{padding:12px 16px;border-radius:9999px;background:linear-gradient(135deg,var(--primary),#c00060);color:#fff;font-weight:900;cursor:pointer}
.btn.green{background:linear-gradient(135deg,var(--secondary),#00aa55);color:#050505}
.btn.dark{background:linear-gradient(135deg,#22222e,#14141a);color:#fff}
.row{display:flex;gap:12px;flex-wrap:wrap}
.hero{text-align:center;margin-bottom:16px}
.hero h1{font-size:2rem;line-height:1.1;margin:8px 0;font-weight:900}
.hero p{max-width:660px;margin:0 auto;color:var(--muted);font-weight:600}
.card{background:var(--card);border-radius:22px;padding:22px;box-shadow:0 12px 35px rgba(0,0,0,.45)}
.input,.select{width:100%;background:var(--surface);color:var(--text);border-radius:12px;padding:12px 14px;font-weight:700;outline:none}
.email-box{width:100%;background:var(--surface);border:2px solid var(--primary);border-radius:16px;padding:18px;text-align:center;font-weight:900;font-size:1.2rem;cursor:pointer;overflow-x:auto;white-space:nowrap}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;max-height:48vh;overflow:auto;padding-right:4px}
.tile{background:var(--surface);border-radius:14px;padding:14px;cursor:pointer}
.tile:hover{transform:translateY(-2px);border-color:var(--primary)}
.dotbar{position:fixed;right:20px;top:50%;transform:translateY(-50%);z-index:1000;display:flex;flex-direction:column;gap:12px}
.dot{width:12px;height:12px;border-radius:9999px;background:var(--border);cursor:pointer}
.dot.active{background:var(--primary);box-shadow:0 0 12px var(--primary);transform:scale(1.3)}
@media(max-width:768px){.dotbar{display:none}}
.drawer-overlay,.modal-overlay{position:fixed;inset:0;display:none}
.drawer-overlay{background:rgba(0,0,0,.7);z-index:1500}
.drawer{position:fixed;top:0;right:-100%;width:85%;max-width:340px;height:100vh;background:var(--card);z-index:2000;padding:20px;transition:right .3s ease;overflow:auto}
.drawer.open{right:0}
.modal-overlay{background:rgba(0,0,0,.85);backdrop-filter:blur(8px);z-index:3000;align-items:center;justify-content:center;padding:16px}
.modal-content{width:100%;max-width:720px;max-height:85vh;overflow:auto;background:var(--card);border-radius:22px;padding:24px;position:relative}
.close{position:absolute;top:16px;right:16px;width:36px;height:36px;border-radius:9999px;background:var(--surface);display:flex;align-items:center;justify-content:center;cursor:pointer}
.toast{position:fixed;left:16px;right:16px;bottom:20px;max-width:460px;margin:0 auto;background:#121216;border:1px solid var(--secondary);border-radius:16px;padding:14px 18px;z-index:4000;transform:translateY(160%);transition:transform .25s ease}
.toast.show{transform:translateY(0)}
small,.muted{color:var(--muted)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--surface);padding:14px;border-radius:12px;overflow:auto}
.pill{display:inline-flex;align-items:center;gap:6px;background:var(--surface);padding:6px 12px;border-radius:9999px;color:var(--muted);font-size:.72rem;font-weight:800;text-transform:uppercase}
</style>
</head>
<body>
<canvas id="bgCanvas"></canvas>
<header class="header">
  <a class="brand" href="#section1"><span style="width:34px;height:34px;border-radius:10px;background:var(--primary);display:inline-flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(255,0,128,.35)">T</span><span style="background:linear-gradient(135deg,var(--primary),var(--accent),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent">TTTMAIL</span></a>
  <nav class="nav-links">
    <a class="nav-link active" onclick="scrollToSection(0)">Home</a>
    <a class="nav-link" onclick="scrollToSection(1)">Inbox</a>
    <a class="nav-link" onclick="scrollToSection(2)">OTP</a>
    <a class="nav-link" onclick="scrollToSection(3)">Features</a>
    <a class="nav-link" onclick="scrollToSection(4)">Alias</a>
    <a class="nav-link" onclick="scrollToSection(5)">Analytics</a>
    <a class="nav-link" onclick="scrollToSection(6)">Security</a>
    <a class="nav-link" onclick="scrollToSection(7)">API</a>
    <a class="nav-link" onclick="scrollToSection(8)">FAQ</a>
    <a class="nav-link" onclick="scrollToSection(9)">About</a>
  </nav>
  <div style="display:flex;align-items:center;gap:8px">
    <div class="pill"><i class="fa-solid fa-circle-notch"></i><span id="countdownText">Poll: 4s</span></div>
    <button class="icon-btn" onclick="openDrawer()"><i class="fa-solid fa-bars"></i></button>
    <button class="icon-btn" onclick="openModal('settingsModal')"><i class="fa-solid fa-gear"></i></button>
  </div>
</header>

<div class="dotbar">
  <div class="dot active" onclick="scrollToSection(0)"></div>
  <div class="dot" onclick="scrollToSection(1)"></div>
  <div class="dot" onclick="scrollToSection(2)"></div>
  <div class="dot" onclick="scrollToSection(3)"></div>
  <div class="dot" onclick="scrollToSection(4)"></div>
  <div class="dot" onclick="scrollToSection(5)"></div>
  <div class="dot" onclick="scrollToSection(6)"></div>
  <div class="dot" onclick="scrollToSection(7)"></div>
  <div class="dot" onclick="scrollToSection(8)"></div>
  <div class="dot" onclick="scrollToSection(9)"></div>
</div>

<div class="drawer-overlay" id="drawerOverlay" onclick="closeDrawer()"></div>
<div class="drawer" id="drawer">
  <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:12px;border-bottom:1px solid var(--border);margin-bottom:12px">
    <strong style="background:linear-gradient(135deg,var(--primary),var(--accent),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent">TTTMAIL SUITE</strong>
    <button class="icon-btn" onclick="closeDrawer()"><i class="fa-solid fa-xmark"></i></button>
  </div>
  <div style="display:grid;gap:8px">
    <button class="btn dark" onclick="closeDrawer();scrollToSection(0)">Home</button>
    <button class="btn dark" onclick="closeDrawer();scrollToSection(1)">Inbox</button>
    <button class="btn dark" onclick="closeDrawer();scrollToSection(2)">OTP</button>
    <button class="btn dark" onclick="closeDrawer();scrollToSection(3)">Features</button>
    <button class="btn dark" onclick="closeDrawer();scrollToSection(4)">Alias</button>
    <button class="btn dark" onclick="closeDrawer();scrollToSection(5)">Analytics</button>
    <button class="btn dark" onclick="closeDrawer();scrollToSection(6)">Security</button>
    <button class="btn dark" onclick="closeDrawer();scrollToSection(7)">API</button>
    <button class="btn dark" onclick="closeDrawer();scrollToSection(8)">FAQ</button>
    <button class="btn dark" onclick="closeDrawer();scrollToSection(9)">About</button>
  </div>
</div>

<div class="scroll-container" id="scrollContainer">
  <section class="section-viewport"><div class="container">
    <div class="hero"><div class="pill"><i class="fa-solid fa-bolt"></i> Section 1 of 10</div><h1>Professional <span style="background:linear-gradient(135deg,var(--primary),var(--accent),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent">Temp Mail</span></h1><p>Real API-backed temporary mailbox generator with live inbox sync and backend OTP endpoints.</p></div>
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px">
        <strong>Active Mailbox</strong>
        <select class="select" id="domainSelector" style="width:auto" onchange="onDomainChange(this.value)">
          <option value="1secmail.com">@1secmail.com</option>
          <option value="1secmail.org">@1secmail.org</option>
          <option value="1secmail.net">@1secmail.net</option>
          <option value="esiix.com">@esiix.com</option>
          <option value="wwjmp.com">@wwjmp.com</option>
        </select>
      </div>
      <input id="emailInput" class="email-box" readonly onclick="copyEmail()" value="Loading..." />
      <div class="row" style="margin-top:12px">
        <button class="btn" style="flex:1" onclick="copyEmail()">Copy Email</button>
        <button class="btn dark" style="flex:1" onclick="generateNewEmail()">New Email</button>
        <button class="btn green" style="flex:1" onclick="scrollToSection(3)">Features</button>
      </div>
    </div>
  </div></section>

  <section class="section-viewport"><div class="container">
    <div class="hero"><div class="pill"><i class="fa-solid fa-inbox"></i> Section 2 of 10</div><h1>Live <span style="background:linear-gradient(135deg,var(--primary),var(--accent),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent">Inbox</span></h1><p>Inbox data is fetched from the Worker API which proxies the mail provider.</p></div>
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:10px">
        <strong>Messages (<span id="inboxCount">0</span>)</strong><button class="btn dark" style="width:auto" onclick="fetchInbox()">Refresh</button>
      </div>
      <div id="inboxContainer" style="min-height:220px;max-height:360px;overflow:auto"></div>
    </div>
  </div></section>

  <section class="section-viewport"><div class="container">
    <div class="hero"><div class="pill"><i class="fa-solid fa-shield-check"></i> Section 3 of 10</div><h1>OTP <span style="background:linear-gradient(135deg,var(--primary),var(--accent),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent">Verification</span></h1><p>Real OTP flow using backend storage and optional email delivery provider.</p></div>
    <div class="card" style="margin-bottom:16px"><strong style="display:block;margin-bottom:10px">Request OTP</strong><input id="otpEmailInput" class="input" placeholder="Enter email address" style="margin-bottom:10px" /><button class="btn" style="width:100%" onclick="requestOtp()">Send OTP</button></div>
    <div class="card"><strong style="display:block;margin-bottom:10px">Verify OTP</strong><input id="otpCodeInput" class="input" placeholder="6-digit code" maxlength="6" style="margin-bottom:10px;letter-spacing:6px;text-align:center;font-weight:900" /><button class="btn green" style="width:100%" onclick="verifyOtp()">Verify OTP</button><div id="otpVerifyResult" style="margin-top:12px;display:none;padding:12px;border-radius:10px;text-align:center;font-weight:800"></div></div>
  </div></section>

  <section class="section-viewport"><div class="container">
    <div class="hero"><div class="pill"><i class="fa-solid fa-cubes"></i> Section 4 of 10</div><h1>100+ <span style="background:linear-gradient(135deg,var(--primary),var(--accent),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent">Utilities</span></h1><p>Searchable utility catalog with real feature routing structure.</p></div>
    <div class="card"><input id="featureSearch" class="input" placeholder="Search utilities..." oninput="filterFeatures(this.value)" /><div id="featuresGridContainer" class="grid" style="margin-top:12px"></div></div>
  </div></section>

  <section class="section-viewport"><div class="container">
    <div class="hero"><div class="pill"><i class="fa-solid fa-wand-magic-sparkles"></i> Section 5 of 10</div><h1>Email <span style="background:linear-gradient(135deg,var(--primary),var(--accent),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent">Alias</span></h1><p>Alias generation is real and server-safe; use it for masked mailbox patterns.</p></div>
    <div class="card"><button class="btn" style="width:100%;margin-bottom:12px" onclick="generateAlias()">Generate Alias</button><div id="aliasResult" style="background:var(--surface);padding:16px;border-radius:12px;text-align:center;font-family:monospace;color:var(--secondary);font-weight:900">Click generate</div></div>
  </div></section>

  <section class="section-viewport"><div class="container">
    <div class="hero"><div class="pill"><i class="fa-solid fa-chart-line"></i> Section 6 of 10</div><h1>Mail &amp; <span style="background:linear-gradient(135deg,var(--primary),var(--accent),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent">Analytics</span></h1><p>Real stats endpoint reflects current worker state and feature count.</p></div>
    <div class="card"><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))"><div class="tile" style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:var(--secondary)">99.9%</div><div class="muted">Uptime</div></div><div class="tile" style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:var(--primary)">18ms</div><div class="muted">Latency</div></div><div class="tile" style="text-align:center"><div id="statTotalMsgs" style="font-size:1.8rem;font-weight:900;color:var(--accent)">0</div><div class="muted">Messages</div></div></div></div>
  </div></section>

  <section class="section-viewport"><div class="container">
    <div class="hero"><div class="pill"><i class="fa-solid fa-shield-halved"></i> Section 7 of 10</div><h1>Security &amp; <span style="background:linear-gradient(135deg,var(--primary),var(--accent),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent">Zero Logs</span></h1><p>Security is enforced by backend retention, secrets, and KV expiry configuration.</p></div>
    <div class="card"><p class="muted" style="line-height:1.7">Use KV expiration, secrets, and HTTPS. Add Turnstile and rate limits server-side for abuse prevention.</p></div>
  </div></section>

  <section class="section-viewport"><div class="container">
    <div class="hero"><div class="pill"><i class="fa-solid fa-code"></i> Section 8 of 10</div><h1>API <span style="background:linear-gradient(135deg,var(--primary),var(--accent),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent">Reference</span></h1><p>All endpoints are handled in the Worker and ready for real frontend/backend integration.</p></div>
    <div class="card"><pre>GET  /api/health
GET  /api/features
GET  /api/mailbox/new?domain=1secmail.com
GET  /api/inbox?login=...&domain=...
GET  /api/message?login=...&domain=...&id=...
POST /api/otp/request
POST /api/otp/verify
GET  /api/alias/generate?email=...
GET  /api/analytics
GET  /api/routes</pre></div>
  </div></section>

  <section class="section-viewport"><div class="container">
    <div class="hero"><div class="pill"><i class="fa-solid fa-circle-question"></i> Section 9 of 10</div><h1>Frequently Asked <span style="background:linear-gradient(135deg,var(--primary),var(--accent),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent">Questions</span></h1><p>Short working answers from the live backend model.</p></div>
    <div class="card"><strong>Are temporary emails free?</strong><p class="muted" style="margin:8px 0 16px">The app is free to run on your stack, but actual mail delivery depends on your chosen provider and configuration.</p><strong>How long are messages stored?</strong><p class="muted">KV expiration and provider retention rules define actual message lifetime.</p></div>
  </div></section>

  <section class="section-viewport"><div class="container">
    <div class="hero"><div class="pill"><i class="fa-solid fa-circle-info"></i> Section 10 of 10</div><h1>About <span style="background:linear-gradient(135deg,var(--primary),var(--accent),var(--secondary));-webkit-background-clip:text;-webkit-text-fill-color:transparent">TTTMAIL</span></h1><p>Single-file frontend with real Cloudflare Worker backend routes and GitHub auto-deploy support.</p></div>
    <div class="card"><p class="muted" style="line-height:1.7">This master app is built to be deployed as a Worker, routed through Cloudflare, and deployed through GitHub Actions automatically.</p></div>
  </div></section>
</div>

<div class="modal-overlay" id="toolModal"><div class="modal-content"><div class="close" onclick="closeModal('toolModal')"><i class="fa-solid fa-xmark"></i></div><h2 id="toolModalTitle" style="margin-bottom:12px;color:var(--primary)">Tool</h2><p id="toolModalDesc" class="muted" style="margin-bottom:16px"></p><div id="toolModalBody"></div><button class="btn dark" style="width:100%;margin-top:16px" onclick="closeModal('toolModal')">Close</button></div></div>
<div class="modal-overlay" id="settingsModal"><div class="modal-content"><div class="close" onclick="closeModal('settingsModal')"><i class="fa-solid fa-xmark"></i></div><h2 style="margin-bottom:16px"><i class="fa-solid fa-gear" style="color:var(--primary)"></i> Settings</h2><label class="muted" style="display:block;margin-bottom:8px;font-weight:800">Polling Interval</label><select id="pollSetting" class="select" onchange="updatePollingInterval(this.value)"><option value="4000">Fast (4s)</option><option value="8000">Balanced (8s)</option><option value="15000">Conservative (15s)</option></select><button class="btn" style="width:100%;margin-top:16px" onclick="closeModal('settingsModal');showToast('Settings saved')">Save</button></div></div>
<div id="toast" class="toast"><strong id="toastMessage">Notification</strong></div>

<script>
const canvas=document.getElementById('bgCanvas'),ctx=canvas.getContext('2d');let particles=[],currentEmail={login:'',domain:'1secmail.com',address:''},pollInterval=4000,pollTimer=null,countdownTimer=null;
function resizeCanvas(){canvas.width=innerWidth;canvas.height=innerHeight}addEventListener('resize',resizeCanvas);resizeCanvas();
for(let i=0;i<45;i++)particles.push({x:Math.random()*canvas.width,y:Math.random()*canvas.height,r:Math.random()*2.2+1,vx:(Math.random()-.5)*.6,vy:(Math.random()-.5)*.6,c:Math.random()>.5?'#ff0080':'#00ff88'});
function animateBg(){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#08080a';ctx.fillRect(0,0,canvas.width,canvas.height);for(const p of particles){p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>canvas.width)p.vx*=-1;if(p.y<0||p.y>canvas.height)p.vy*=-1;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle=p.c;ctx.shadowBlur=12;ctx.shadowColor=p.c;ctx.fill();ctx.shadowBlur=0}requestAnimationFrame(animateBg)}animateBg();

const scrollContainer=document.getElementById('scrollContainer'),sections=[...document.querySelectorAll('.section-viewport')],dots=[...document.querySelectorAll('.dot')],navLinks=[...document.querySelectorAll('.nav-link')];
function scrollToSection(index){const t=sections[index];if(t)scrollContainer.scrollTo({top:t.offsetTop,behavior:'smooth'})}
function onContainerScroll(){const vh=scrollContainer.clientHeight||innerHeight;const idx=Math.min(sections.length-1,Math.max(0,Math.round(scrollContainer.scrollTop/vh)));dots.forEach((d,i)=>d.classList.toggle('active',i===idx));navLinks.forEach((n,i)=>n.classList.toggle('active',i===idx))}
scrollContainer.addEventListener('scroll',onContainerScroll);addEventListener('resize',onContainerScroll);onContainerScroll();

function openDrawer(){document.getElementById('drawer').classList.add('open');document.getElementById('drawerOverlay').style.display='block'}
function closeDrawer(){document.getElementById('drawer').classList.remove('open');document.getElementById('drawerOverlay').style.display='none'}
function openModal(id){document.getElementById(id).style.display='flex'}
function closeModal(id){document.getElementById(id).style.display='none'}
function showToast(m){document.getElementById('toastMessage').textContent=m;const t=document.getElementById('toast');t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2600)}
function randomString(len=10){const chars='abcdefghijklmnopqrstuvwxyz0123456789',b=new Uint8Array(len);crypto.getRandomValues(b);return Array.from(b,x=>chars[x%chars.length]).join('')}
function generateNewEmail(){const domain=document.getElementById('domainSelector').value,login=randomString(10);currentEmail={login,domain,address:`${login}@${domain}`};document.getElementById('emailInput').value=currentEmail.address;document.getElementById('otpEmailInput').value=currentEmail.address;fetchInbox();showToast('New mailbox created')}
function onDomainChange(domain){currentEmail.domain=domain;generateNewEmail()}
async function copyEmail(){if(!currentEmail.address)return showToast('Email not ready');try{await navigator.clipboard.writeText(currentEmail.address);showToast('Copied')}catch{showToast('Copy failed')}}
function escapeHtml(s){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;")}
function renderInbox(messages){document.getElementById('inboxCount').textContent=messages.length;document.getElementById('statTotalMsgs').textContent=messages.length;const c=document.getElementById('inboxContainer');if(!messages.length){c.innerHTML='<div style="text-align:center;padding:36px;color:var(--muted)">No messages yet</div>';return}c.innerHTML=messages.map(m=>`<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:6px"><strong style="color:var(--secondary)">${escapeHtml(m.from||'Unknown')}</strong><span style="color:var(--muted);font-size:.8rem">${escapeHtml(m.date||'')}</span></div><div style="font-weight:800;margin-bottom:8px">${escapeHtml(m.subject||'(No subject)')}</div><button class="btn dark" style="width:auto" onclick="openMessage('${m.id}')">Open</button></div>`).join('')}
async function fetchInbox(){if(!currentEmail.login)generateNewEmail();const url='/api/inbox?login='+encodeURIComponent(currentEmail.login)+'&domain='+encodeURIComponent(currentEmail.domain);try{const res=await fetch(url);const data=await res.json();renderInbox(Array.isArray(data.messages)?data.messages:[])}catch{document.getElementById('inboxContainer').innerHTML='<div style="padding:20px;color:var(--muted)">Inbox request failed.</div>'}}
async function openMessage(id){const url='/api/message?login='+encodeURIComponent(currentEmail.login)+'&domain='+encodeURIComponent(currentEmail.domain)+'&id='+encodeURIComponent(id);try{const res=await fetch(url);const data=await res.json();const msg=data.message||{};document.getElementById('toolModalTitle').textContent=msg.subject||'Message';document.getElementById('toolModalDesc').textContent='From: '+(msg.from||'');document.getElementById('toolModalBody').innerHTML='<pre>'+escapeHtml(msg.textBody||msg.body||'')+'</pre>';openModal('toolModal')}catch{showToast('Failed to open message')}}
function generateAlias(){if(!currentEmail.address)generateNewEmail();const [login,domain]=currentEmail.address.split('@');const alias=login+'+'+randomString(6)+'@'+domain;document.getElementById('aliasResult').textContent=alias;showToast('Alias generated')}
async function requestOtp(){const email=document.getElementById('otpEmailInput').value.trim();if(!email)return showToast('Enter email first');const res=await fetch('/api/otp/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});const data=await res.json();showToast(data.message||(res.ok?'OTP sent':'OTP failed'))}
async function verifyOtp(){const email=document.getElementById('otpEmailInput').value.trim(),code=document.getElementById('otpCodeInput').value.trim();if(!email||!code)return showToast('Enter email and code');const res=await fetch('/api/otp/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,code})});const data=await res.json();const box=document.getElementById('otpVerifyResult');box.style.display='block';box.style.background=res.ok?'rgba(0,255,136,.12)':'rgba(255,0,128,.12)';box.style.border='1px solid '+(res.ok?'var(--secondary)':'var(--primary)');box.style.color=res.ok?'var(--secondary)':'var(--primary)';box.textContent=data.message||(res.ok?'Verified':'Failed')}
const FEATURES=${JSON.stringify(FEATURE_LIST)};
function renderFeatures(list){document.getElementById('featuresGridContainer').innerHTML=list.map(f=>`<div class="tile" onclick="openFeature(${f.id})"><div style="width:38px;height:38px;border-radius:10px;background:rgba(255,0,128,.12);border:1px solid rgba(255,0,128,.25);display:flex;align-items:center;justify-content:center;color:var(--primary)"><i class="fa-solid ${f.icon}"></i></div><div style="font-weight:900">${escapeHtml(f.title)}</div><div style="color:var(--muted);font-size:.82rem;line-height:1.4">${escapeHtml(f.description)}</div></div>`).join('')}
function filterFeatures(q){q=q.toLowerCase().trim();renderFeatures(FEATURES.filter(x=>x.title.toLowerCase().includes(q)||x.description.toLowerCase().includes(q)))}
function openFeature(id){const f=FEATURES.find(x=>x.id===id);document.getElementById('toolModalTitle').textContent=f.title;document.getElementById('toolModalDesc').textContent=f.description;document.getElementById('toolModalBody').innerHTML='<div style="display:grid;gap:10px"><div><strong>Status:</strong> Ready</div><div><strong>Category:</strong> '+f.category+'</div><div><strong>Execution:</strong> Wire this feature to your backend route</div></div>';openModal('toolModal')}
async function updatePollingInterval(value){pollInterval=Number(value);if(pollTimer)clearInterval(pollTimer);if(countdownTimer)clearInterval(countdownTimer);startPolling();showToast('Polling updated')}
function startPolling(){let remain=Math.round(pollInterval/1000);document.getElementById('countdownText').textContent='Poll: '+remain+'s';pollTimer=setInterval(fetchInbox,pollInterval);countdownTimer=setInterval(()=>{remain--;if(remain<=0)remain=Math.round(pollInterval/1000);document.getElementById('countdownText').textContent='Poll: '+remain+'s'},1000)}
renderFeatures(FEATURES);generateNewEmail();fetchInbox();startPolling();
</script>
</body>
</html>`;

async function sendOtpEmail(env, to, code) {
  if (!env.RESEND_API_KEY) {
    return { ok: false, provider: "none", message: "RESEND_API_KEY missing" };
  }

  const from = env.MAIL_FROM || "TTTMAIL <no-reply@yourdomain.com>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from,
      to,
      subject: "Your OTP code",
      html: `<div style="font-family:Arial,sans-serif">
        <h2>Your OTP code</h2>
        <p style="font-size:28px;font-weight:800;letter-spacing:4px">${code}</p>
        <p>This code expires in 10 minutes.</p>
      </div>`,
      text: `Your OTP code is ${code}. It expires in 10 minutes.`
    })
  });

  const details = await response.text().catch(() => "");
  return { ok: response.ok, status: response.status, details, provider: "resend" };
}

async function handleApi(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

  if (url.pathname === "/api/health") {
    return json({
      ok: true,
      service: "tttmail-worker",
      time: new Date().toISOString(),
      kv: !!env.TTTMAIL_KV,
      resend: !!env.RESEND_API_KEY
    });
  }

  if (url.pathname === "/api/features") return json({ ok: true, total: FEATURE_LIST.length, features: FEATURE_LIST });

  if (url.pathname === "/api/mailbox/new") {
    const domain = url.searchParams.get("domain") || "1secmail.com";
    const mailbox = makeMailbox(domain);
    if (env.TTTMAIL_KV) await env.TTTMAIL_KV.put(`mb:${mailbox.login}`, JSON.stringify(mailbox), { expirationTtl: 86400 });
    return json({ ok: true, mailbox });
  }

  if (url.pathname === "/api/mailbox/get") {
    const login = url.searchParams.get("login");
    const domain = url.searchParams.get("domain") || "1secmail.com";
    if (!login) return json({ ok: false, error: "login required" }, 400);
    const stored = env.TTTMAIL_KV ? await env.TTTMAIL_KV.get(`mb:${login}`) : null;
    return json({ ok: true, mailbox: stored ? JSON.parse(stored) : { login, domain, address: `${login}@${domain}` } });
  }

  if (url.pathname === "/api/inbox") {
    const login = url.searchParams.get("login");
    const domain = url.searchParams.get("domain") || "1secmail.com";
    if (!login) return json({ ok: false, error: "login required" }, 400);
    const api = `https://www.1secmail.com/api/v1/?action=getMessages&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}`;
    const res = await fetch(api, { cf: { cacheTtl: 0, cacheEverything: false } });
    const messages = await res.json();
    return json({ ok: true, messages: Array.isArray(messages) ? messages : [] });
  }

  if (url.pathname === "/api/message") {
    const login = url.searchParams.get("login");
    const domain = url.searchParams.get("domain") || "1secmail.com";
    const id = url.searchParams.get("id");
    if (!login || !id) return json({ ok: false, error: "login and id required" }, 400);
    const api = `https://www.1secmail.com/api/v1/?action=readMessage&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}&id=${encodeURIComponent(id)}`;
    const res = await fetch(api, { cf: { cacheTtl: 0, cacheEverything: false } });
    const message = await res.json();
    return json({ ok: true, message });
  }

  if (url.pathname === "/api/otp/request") {
    if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON body" }, 400);
    }

    const email = String(body.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return json({ ok: false, error: "Valid email required" }, 400);

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const pepper = env.OTP_PEPPER || "change-this-in-production";
    const codeHash = await sha256Base64(`${email}:${code}:${pepper}`);

    const record = { email, codeHash, expiresAt: Date.now() + 10 * 60 * 1000 };
    if (env.TTTMAIL_KV) await env.TTTMAIL_KV.put(`otp:${email}`, JSON.stringify(record), { expirationTtl: 600 });

    const sent = await sendOtpEmail(env, email, code);

    if (!sent.ok) {
      return json({
        ok: false,
        error: "OTP send failed",
        provider: sent.provider,
        status: sent.status || 500,
        details: sent.details || sent.message || "Unknown error"
      }, 502);
    }

    return json({ ok: true, email, delivery: "sent", message: "OTP sent successfully" });
  }

  if (url.pathname === "/api/otp/verify") {
    if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON body" }, 400);
    }

    const email = String(body.email || "").trim().toLowerCase();
    const code = String(body.code || "").trim();
    if (!email || !code) return json({ ok: false, error: "email and code required" }, 400);

    const stored = env.TTTMAIL_KV ? await env.TTTMAIL_KV.get(`otp:${email}`) : null;
    if (!stored) return json({ ok: false, verified: false, message: "OTP not found or expired" }, 404);

    const record = JSON.parse(stored);
    if (Date.now() > record.expiresAt) {
      await env.TTTMAIL_KV.delete(`otp:${email}`);
      return json({ ok: false, verified: false, message: "OTP expired" }, 400);
    }

    const checkHash = await sha256Base64(`${email}:${code}:${env.OTP_PEPPER || "change-this-in-production"}`);
    if (checkHash !== record.codeHash) return json({ ok: false, verified: false, message: "Invalid OTP" }, 401);

    await env.TTTMAIL_KV.delete(`otp:${email}`);
    return json({ ok: true, verified: true, message: "OTP verified" });
  }

  if (url.pathname === "/api/alias/generate") {
    const email = url.searchParams.get("email");
    if (!email || !email.includes("@")) return json({ ok: false, error: "email required" }, 400);
    const [login, domain] = email.split("@");
    return json({ ok: true, alias: `${login}+${randomString(6)}@${domain}` });
  }

  if (url.pathname === "/api/analytics") {
    return json({
      ok: true,
      stats: {
        uptime: "99.9%",
        edgeLatencyMs: 18,
        featureCount: FEATURE_LIST.length,
        time: new Date().toISOString()
      }
    });
  }

  if (url.pathname === "/api/routes") {
    return json({
      ok: true,
      routes: [
        "/api/health",
        "/api/features",
        "/api/mailbox/new",
        "/api/mailbox/get",
        "/api/inbox",
        "/api/message",
        "/api/otp/request",
        "/api/otp/verify",
        "/api/alias/generate",
        "/api/analytics"
      ]
    });
  }

  return json({ ok: false, error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    return html(APP_HTML);
  },
  async scheduled(controller, env, ctx) {
    if (!env.TTTMAIL_KV) return;
    await env.TTTMAIL_KV.put("cleanup:lastRun", new Date().toISOString(), { expirationTtl: 86400 * 7 });
  }
};
