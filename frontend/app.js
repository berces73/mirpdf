// Frontend for Hybrid SaaS
// - Drag & Drop
// - Job polling (expects V4 job endpoints in Worker)
// - Auth + Billing (calls /api/auth/* and /api/billing/checkout)

const API_BASE = ""; // same-origin preferred; or set to your Worker domain.
const $ = (id) => document.getElementById(id);

const drop = $("drop");
const fileInput = $("file");
const pickBtn = $("pickBtn");
const fileMeta = $("fileMeta");
const toolSel = $("toolSel");
const optBox = $("optBox");
const goBtn = $("go");
const pill = $("pill");
const progressWrap = $("progressWrap");
const progressFill = $("progressFill");
const progressText = $("progressText");
function setProgress(p){
  if(!progressWrap) return;
  progressWrap.hidden = false;
  const v = Math.max(0, Math.min(100, Math.round(p)));
  if(progressFill) progressFill.style.width = v + "%";
  if(progressText) progressText.textContent = v + "%";
  if(v>=100) setTimeout(()=>{ try{ progressWrap.hidden=true; }catch(e){} }, 800);
}
function hideProgress(){ if(progressWrap) progressWrap.hidden = true; }


const jobsEl = $("jobs");
const jobsHint = $("jobsHint");
const logEl = $("log");
$("clearLog").onclick = () => (logEl.textContent = "");


const themeBtn = $("toggleTheme");
function applyTheme(t){
  document.documentElement.dataset.theme = t;
  localStorage.setItem("theme", t);
  if(themeBtn) themeBtn.textContent = t==="light" ? "☀️" : "🌙";
}
try{
  const saved = localStorage.getItem("theme");
  if(saved) applyTheme(saved);
  else applyTheme(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}catch(e){}
if(themeBtn){
  themeBtn.onclick = ()=>{
    const cur = document.documentElement.dataset.theme || "dark";
    applyTheme(cur==="dark" ? "light" : "dark");
  };
}


const modal = $("modal");
const modalTitle = $("modalTitle");
const modalBody = $("modalBody");
$("closeModal").onclick = () => (modal.hidden = true);
$("openAuth").onclick = () => openAuth();
$("openPricing").onclick = () => openPricing();

let selectedFile = null;
const jobs = new Map(); // jobId -> {tool,status}
let token = localStorage.getItem("jwt") || "";

const toastsEl = $("toasts");
function toast(type, title, msg, ttl=3500){
  if(!toastsEl) return;
  const el = document.createElement("div");
  el.className = `toast ${type||"inf"}`;
  el.innerHTML = `
    <div class="ticon">${type==="ok"?"✅":type==="err"?"⚠️":"ℹ️"}</div>
    <div class="tmain">
      <div class="thead">${escapeHtml(title||"")}</div>
      <div class="tmsg">${escapeHtml(msg||"")}</div>
    </div>
    <button class="tclose" aria-label="Kapat">✕</button>
  `;
  el.querySelector(".tclose").onclick = ()=> el.remove();
  toastsEl.appendChild(el);
  setTimeout(()=>{ try{ el.remove(); }catch(e){} }, ttl);
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",""":"&quot;","'":"&#39;" }[c]));
}


function log(...a){ logEl.textContent += a.join(" ") + "\n"; logEl.scrollTop = logEl.scrollHeight; }
function setPill(t){ pill.textContent = t; }
function fmtSize(bytes){ const mb=bytes/1024/1024; return mb>=1?mb.toFixed(2)+" MB":(bytes/1024).toFixed(1)+" KB"; }

function endpointFor(tool){
  if (tool === "compress") return "/api/compress";
  if (tool === "pdf-to-word") return "/api/pdf-to-word";
  if (tool === "ocr") return "/api/ocr";
  throw new Error("unknown tool");
}

function renderOptions(){
  const tool = toolSel.value;
  if (tool === "ocr"){
    optBox.innerHTML = `<label>Dil</label><input id="lang" value="tur+eng" />`;
  } else if (tool === "pdf-to-word"){
    optBox.innerHTML = `<label>Format</label><input id="format" value="docx" />`;
  } else {
    optBox.innerHTML = `<label>Level</label>
      <select id="level"><option value="recommended">recommended</option><option value="low">low</option><option value="extreme">extreme</option></select>`;
  }
}
toolSel.onchange = renderOptions;
if (window.__DEFAULT_TOOL__){ try{ toolSel.value = window.__DEFAULT_TOOL__; }catch(e){} }
renderOptions();

function setFile(file){
  selectedFile = file;
  if (!file){ fileMeta.hidden=true; fileMeta.innerHTML=""; return; }
  fileMeta.hidden=false;
  fileMeta.innerHTML = `<div class="name">${file.name}</div><div class="size">${fmtSize(file.size)}</div>`;
}

// Drag & drop
drop.addEventListener("dragover", (e)=>{ e.preventDefault(); drop.classList.add("drag"); });
drop.addEventListener("dragleave", ()=> drop.classList.remove("drag"));
drop.addEventListener("drop", (e)=>{
  e.preventDefault(); drop.classList.remove("drag");
  const f = e.dataTransfer.files?.[0];
  if (!f) return;
  if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) { toast("err","Dosya tipi","Sadece PDF yükleyebilirsin."); return; }
  setFile(f);
});
drop.addEventListener("click", ()=> fileInput.click());
pickBtn.addEventListener("click", (e)=>{ e.preventDefault(); fileInput.click(); });
fileInput.addEventListener("change", ()=> setFile(fileInput.files?.[0] || null));

function badgeClass(status){
  if (status === "done") return "ok";
  if (status === "failed") return "fail";
  if (status === "running") return "run";
  return "pend";
}
function renderJobs(){
  const arr = Array.from(jobs.entries()).reverse();
  jobsHint.textContent = arr.length ? `${arr.length} iş` : "Henüz iş yok";
  jobsEl.innerHTML = "";
  for (const [jobId, j] of arr){
    const div=document.createElement("div");
    div.className="job";
    div.innerHTML = `
      <div class="left">
        <div class="id">${jobId}</div>
        <div class="sub">${j.tool}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="badge ${badgeClass(j.status)}">${j.status}</span>
        <a class="dl" id="dl-${jobId}" href="#" target="_blank" style="display:none">İndir</a>
      </div>`;
    jobsEl.appendChild(div);
  }
}


function uploadWithProgress(path, form, onProgress){
  return new Promise((resolve, reject)=>{
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}${path}`, true);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.withCredentials = true;

    xhr.upload.onprogress = (e)=>{
      if(e.lengthComputable && onProgress) onProgress((e.loaded/e.total)*100);
    };
    xhr.onerror = ()=> reject(new Error("NETWORK_ERROR"));
    xhr.onload = ()=>{
      let j=null;
      try{ j = JSON.parse(xhr.responseText); }catch(e){}
      resolve({ status: xhr.status, j });
    };
    xhr.send(form);
  });
}


async function api(path, { method="GET", jsonBody=null, form=null } = {}){
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let body = undefined;
  if (jsonBody){ headers["Content-Type"]="application/json"; body=JSON.stringify(jsonBody); }
  if (form) body=form;

  const resp = await fetch(`${API_BASE}${path}`, { method, headers, body, credentials:"include" });
  const j = await resp.json().catch(()=>null);
  return { resp, j };
}

async function poll(jobId){
  for (let i=0;i<80;i++){
    const { j } = await api(`/api/jobs/${jobId}/status`);
    if (!j?.ok){ log("STATUS_ERR", jobId, JSON.stringify(j||{})); break; }
    const st = j.data.status;
    const it = jobs.get(jobId); if (it) it.status=st;
    renderJobs();

    if (st==="done"){
      const a = document.getElementById(`dl-${jobId}`);
      if (a){ a.href = `${API_BASE}/api/jobs/${jobId}/result`; a.style.display="inline-block"; }
      setPill("Tamamlandı");
      break;
    }
    if (st==="failed"){ setPill("Hata"); log("FAILED", jobId, j.data.error_message||""); break; }
    setPill(st==="running"?"İşleniyor":"Beklemede");
    await new Promise(r=>setTimeout(r, 2500));
  }
}


goBtn.onclick = async ()=>{
  if (!selectedFile){ toast("err","Dosya seç","PDF seç veya sürükle-bırak."); return; }
  const tool = toolSel.value;

  // client-side validation (fast fail)
  const maxMb = tool==="ocr" ? 25 : tool==="pdf-to-word" ? 25 : 50;
  if (selectedFile.size > maxMb*1024*1024){
    toast("err","Dosya çok büyük", `Bu araç için max ~${maxMb}MB önerilir.`); 
    return;
  }

  const form = new FormData();
  form.append("file", selectedFile, selectedFile.name);
  if (tool==="ocr") form.append("lang", document.getElementById("lang").value);
  if (tool==="pdf-to-word") form.append("format", document.getElementById("format").value);
  if (tool==="compress") form.append("level", document.getElementById("level").value);

  goBtn.disabled=true; setPill("Yükleniyor"); setProgress(1);
  toast("inf","Yükleme","Dosya yükleniyor...");
  log("UPLOAD", tool, selectedFile.name);

  try{
    const { status, j } = await uploadWithProgress(endpointFor(tool), form, (p)=> setProgress(p*0.85));
    setProgress(90);

    goBtn.disabled=false;

    if (!j?.ok){
      setPill("Hata"); hideProgress();
      const code = j?.error || j?.code || "";
      const msg = j?.message || "İşlem başlatılamadı.";
      toast("err","Hata", msg);

      // Revenue trigger: paywall
      if (status===402 || code==="PAYMENT_REQUIRED" || code==="INSUFFICIENT_CREDITS"){
        openPricing();
      }
      // Email verify
      if (status===403 && (code==="EMAIL_NOT_VERIFIED")){
        openModal("Email doğrulama", `
          <div class="muted">Giriş yapabilmek için email doğrulaması gerekli.</div>
          <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
            <a class="primary" href="/account/verify.html">Doğrula</a>
            <a class="ghost" href="/account/forgot.html">Şifre sıfırla</a>
          </div>
        `);
      }
      return;
    }

    const jobId = j.data.jobId;
    jobs.set(jobId, { tool, status:"pending" });
    renderJobs();
    setPill("Beklemede");
    toast("ok","İş kuyruğa alındı", `Job: ${jobId.slice(0,8)}…`);
    setProgress(100);
    poll(jobId);
  } catch(e){
    goBtn.disabled=false;
    hideProgress();
    setPill("Hata");
    toast("err","Bağlantı", e.message || "Ağ hatası");
  }
};

function openModal(title, html){
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modal.hidden = false;
}

function openAuth(){
  openModal("Giriş / Kayıt", `
    <div class="muted" style="margin-bottom:8px">JWT token localStorage'da saklanır.</div>
    <label>Email</label><input id="a_email" placeholder="mail@domain.com" />
    <label style="margin-top:8px">Şifre</label><input id="a_pass" type="password" placeholder="en az 8 karakter" />
    <div style="display:flex;gap:10px;margin-top:12px">
      <button class="primary" id="btnLogin" style="flex:1">Giriş</button>
      <button class="ghost" id="btnReg" style="flex:1">Kayıt</button>
    </div>
    <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
      <a class="muted" href="/account/forgot.html">Şifremi unuttum</a>
      <a class="muted" href="/account/verify.html">Email doğrula</a>
    </div>
    <div class="muted" style="margin-top:10px" id="authInfo"></div>
  `);

  document.getElementById("btnLogin").onclick = async ()=>{
    const email = document.getElementById("a_email").value.trim();
    const password = document.getElementById("a_pass").value;
    const { j } = await api("/api/auth/login", { method:"POST", jsonBody:{ email, password } });
    document.getElementById("authInfo").textContent = j?.ok ? "Giriş başarılı" : (j?.message || "Hata");
    if (j?.ok){ token = j.data.token; localStorage.setItem("jwt", token); }
  };
  document.getElementById("btnReg").onclick = async ()=>{
    const email = document.getElementById("a_email").value.trim();
    const password = document.getElementById("a_pass").value;
    const { j } = await api("/api/auth/register", { method:"POST", jsonBody:{ email, password } });
    document.getElementById("authInfo").textContent = j?.ok ? "Kayıt başarılı" : (j?.message || "Hata");
    if (j?.ok){ token = j.data.token; localStorage.setItem("jwt", token); }
  };
}



let cachedPlans = null;
async function loadPlans(){
  if(cachedPlans) return cachedPlans;
  try{
    const { j } = await api("/api/billing/plans");
    if(j?.ok) cachedPlans = j.data.plans;
  }catch(e){}
  return cachedPlans || [];
}
function fmtCredits(n){
  if(!n && n!==0) return "";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function openPricing(){
  openModal("Premium / Kredi", `
    <div class="muted">Hız + limitsiz kullanım için Premium. Ücretsiz: günlük kredi sınırlı.</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:12px">
      <div class="card" style="padding:12px">
        <b>Free</b>
        <div class="muted">Günlük sınırlı kredi</div>
        <div style="margin-top:8px" class="muted">✅ Temel kullanım</div>
        <div class="muted">⛔ Yoğun kullanım yok</div>
      </div>
      <div class="card" style="padding:12px;border-color:rgba(124,92,255,.45)">
        <b>Pro</b>
        <div class="muted">Yüksek kredi + öncelik</div>
        <div style="margin-top:8px" class="muted">✅ Daha hızlı</div>
        <div class="muted">✅ Toplu işlem (yakında)</div>
      </div>
    </div>

    <div class="muted">Stripe Checkout: paket (tek seferlik) veya abonelik seç.</div>
    <div style="display:grid;gap:10px;margin-top:12px">
      <button class="primary" id="buy100">100 Kredi (Tek Sefer)</button>
      <button class="primary" id="buy500">500 Kredi (Tek Sefer)</button>
      <button class="ghost" id="subBasic">Abonelik Basic (Aylık)</button>
      <button class="ghost" id="subPro">Abonelik Pro (Aylık)</button>
    </div>
    <div class="muted" style="margin-top:10px" id="billInfo"></div>
  `);

  const buy = async (plan)=>{
    const attribution = (window.PDF3_ATTR && typeof window.PDF3_ATTR.get === "function") ? window.PDF3_ATTR.get() : null;
    const { j } = await api("/api/billing/checkout", { method:"POST", jsonBody:{ plan, attribution } });
    if (!j?.ok){ document.getElementById("billInfo").textContent = j?.message || "Hata"; return; }
    const url = j.data.url;
    document.getElementById("billInfo").textContent = "Yönlendiriliyor...";
    window.location.href = url;
  };
  document.getElementById("buy100").onclick = ()=>buy("credits100");
  document.getElementById("buy500").onclick = ()=>buy("credits500");
  document.getElementById("subBasic").onclick = ()=>buy("sub_basic");
  document.getElementById("subPro").onclick = ()=>buy("sub_pro");
}


function ensureVerifyBanner(){
  const el = document.getElementById("verifyBanner");
  if(!el) return;
  api("/api/me").then(({j})=>{
    if(j?.ok && j?.data){
      if(j.data.email_verified){ el.hidden = true; return; }
      el.hidden = false;
      el.innerHTML = `
        <div class="bannerInner">
          <b>Email doğrulanmadı.</b>
          <span class="muted">Bazı özellikler kısıtlı olabilir.</span>
          <a class="ghost" href="/account/verify.html">Doğrula</a>
          <a class="ghost" href="/account/forgot.html">Şifre Sıfırla</a>
        </div>
      `;
    }
  }).catch(()=>{});
}


try{ ensureVerifyBanner(); }catch(e){}