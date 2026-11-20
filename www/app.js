const STORAGE_KEY = "talani_accounts_ledger_v1";
const SECRETS_KEY = "talani_accounts_secrets_v1";
const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash"];

// ================= CHART OF ACCOUNTS (1000s - 6000s) =================
const COA = [
  // 1000s Assets (Normal DR)
  { code: "1010", name: "M-Pesa Treasury", type: "ASSET", normal: "DR", isCash: true },
  { code: "1020", name: "Bank Account", type: "ASSET", normal: "DR", isCash: true },
  { code: "1030", name: "Trail Float / Petty Cash", type: "ASSET", normal: "DR", isCash: true },
  { code: "1100", name: "Accounts Receivable (Clients)", type: "ASSET", normal: "DR" },
  { code: "1200", name: "Merchandise Inventory", type: "ASSET", normal: "DR" },
  { code: "1500", name: "Fixed Assets / Equipment", type: "ASSET", normal: "DR" },
  // 2000s Liabilities (Normal CR)
  { code: "2010", name: "Deferred Client Deposits", type: "LIABILITY", normal: "CR", restricted: true },
  { code: "2020", name: "Accounts Payable (Suppliers)", type: "LIABILITY", normal: "CR", restricted: true },
  { code: "2030", name: "Due to Partners (Reimbursements)", type: "LIABILITY", normal: "CR", restricted: true },
  { code: "2040", name: "Taxes Payable (KRA/VAT/WHT)", type: "LIABILITY", normal: "CR", restricted: true },
  { code: "2100", name: "Loans Payable", type: "LIABILITY", normal: "CR" },
  // 3000s Equity (Normal CR, Draws DR)
  { code: "3010", name: "Partner Capital", type: "EQUITY", normal: "CR" },
  { code: "3020", name: "Retained Earnings", type: "EQUITY", normal: "CR" },
  { code: "3030", name: "Partner Draws / Distributions", type: "EQUITY", normal: "DR" },
  // 4000s Revenue (Normal CR, Discounts DR)
  { code: "4010", name: "Earned Trip Revenue", type: "REVENUE", normal: "CR" },
  { code: "4020", name: "Cancellation Fee Revenue", type: "REVENUE", normal: "CR" },
  { code: "4030", name: "Merchandise Sales", type: "REVENUE", normal: "CR" },
  { code: "4040", name: "B2B Booking Commissions", type: "REVENUE", normal: "CR" },
  { code: "4090", name: "Discounts & Subsidies (Contra)", type: "REVENUE", normal: "DR" },
  // 5000s - 6000s Expenses (Normal DR)
  { code: "5100", name: "Direct Trip COGS - Fixed", type: "EXPENSE", normal: "DR" },
  { code: "5200", name: "Direct Trip COGS - Variable", type: "EXPENSE", normal: "DR" },
  { code: "5300", name: "Merchandise COGS", type: "EXPENSE", normal: "DR" },
  { code: "6100", name: "General Operating Overhead", type: "EXPENSE", normal: "DR" },
  { code: "6120", name: "Bank & Mobile Money Charges", type: "EXPENSE", normal: "DR" }
];

const DEFAULT_LEDGER = {
  schemaVersion: 1,
  companyName: "Talani Adventures Accounts",
  entities: [
    { id: "ent_gik", name: "Group ya Ile Kitu" },
    { id: "ent_talani", name: "Talani Premium Tours" },
    { id: "ent_adamanti", name: "Adamanti Hospitality" }
  ],
  pools: [
    { id: "pool_hq", name: "General / HQ Overhead" },
    { id: "pool_gatamaiyu", name: "Gatamaiyu Expedition" }
  ],
  entries: [],
  lastUpdated: new Date().toISOString()
};

function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtKES(n) { return "KSh " + Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function getAcc(code) { return COA.find((a) => a.code === code) || { code, name: code, type: "EXPENSE", normal: "DR" }; }

function loadLedger() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_LEDGER));
    const parsed = JSON.parse(raw);
    return {
      ...JSON.parse(JSON.stringify(DEFAULT_LEDGER)),
      ...parsed,
      entities: parsed.entities?.length ? parsed.entities : DEFAULT_LEDGER.entities,
      pools: parsed.pools?.length ? parsed.pools : DEFAULT_LEDGER.pools,
      entries: parsed.entries || []
    };
  } catch { return JSON.parse(JSON.stringify(DEFAULT_LEDGER)); }
}

function loadSecrets() {
  try { return JSON.parse(localStorage.getItem(SECRETS_KEY) || "{}"); }
  catch { return {}; }
}

let ledger = loadLedger();
let secrets = loadSecrets();
let currentDraftDir = "OUT";

function saveLedger(autoSync = false) {
  ledger.lastUpdated = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ledger));
  if (autoSync && navigator.onLine && secrets.ghRepo && secrets.ghToken && secrets.teamPin) {
    syncToGitHub(true);
  }
}

// ================= STRICT DOUBLE-ENTRY ENGINE =================
function computeBalances(entries = ledger.entries) {
  const bal = {};
  COA.forEach((a) => (bal[a.code] = 0));

  for (const je of entries) {
    for (const ln of je.lines || []) {
      const acc = getAcc(ln.accountCode);
      const dr = Number(ln.debit || 0);
      const cr = Number(ln.credit || 0);
      bal[acc.code] = (bal[acc.code] || 0) + (acc.normal === "DR" ? dr - cr : cr - dr);
    }
  }
  return bal;
}

function validateAndPostJE({ date, mpesaCode, memo, entityId, poolId, etimsVerified, lines, isReversal = false, reversesId = null }) {
  const cleanLines = lines
    .map((l) => ({ accountCode: l.accountCode, debit: Number(l.debit || 0), credit: Number(l.credit || 0) }))
    .filter((l) => l.debit > 0 || l.credit > 0);

  const totalDr = cleanLines.reduce((s, l) => s + l.debit, 0);
  const totalCr = cleanLines.reduce((s, l) => s + l.credit, 0);

  if (cleanLines.length < 2 || totalDr <= 0 || Math.abs(totalDr - totalCr) > 0.01) {
    throw new Error(`Unbalanced Journal Entry! Debits (${totalDr.toFixed(2)}) ≠ Credits (${totalCr.toFixed(2)}).`);
  }

  const je = {
    id: "JE-" + Date.now() + "-" + Math.random().toString(36).slice(2, 5).toUpperCase(),
    timestamp: new Date().toISOString(),
    date: date || todayStr(),
    mpesaCode: (mpesaCode || "").trim().toUpperCase(),
    memo: memo || "Journal Entry",
    entityId: entityId || ledger.entities[0].id,
    poolId: poolId || ledger.pools[0].id,
    etimsVerified: !!etimsVerified,
    isReversal,
    reversesId,
    reversedBy: null,
    lines: cleanLines
  };

  ledger.entries.unshift(je);
  saveLedger(true);
  renderAll();
  return je;
}

window.reverseEntry = function (jeId) {
  const orig = ledger.entries.find((e) => e.id === jeId);
  if (!orig || orig.reversedBy) return;
  if (!confirm(`Create an immutable Reversing Journal Entry for ${orig.id} (${orig.memo})?`)) return;

  const revLines = orig.lines.map((l) => ({
    accountCode: l.accountCode,
    debit: l.credit,
    credit: l.debit
  }));

  const rev = validateAndPostJE({
    date: todayStr(),
    mpesaCode: orig.mpesaCode ? `REV-${orig.mpesaCode}` : "",
    memo: `REVERSAL of ${orig.id}: ${orig.memo}`,
    entityId: orig.entityId,
    poolId: orig.poolId,
    etimsVerified: false,
    lines: revLines,
    isReversal: true,
    reversesId: orig.id
  });

  orig.reversedBy = rev.id;
  saveLedger(true);
  renderAll();
};

function findDuplicateMpesa(code) {
  const clean = (code || "").trim().toUpperCase();
  if (!clean) return null;
  return ledger.entries.find((e) => e.mpesaCode === clean && !e.reversedBy && !e.isReversal) || null;
}

// ================= GEMINI AI M-PESA PARSER =================
async function callGeminiJSON(prompt) {
  if (!secrets.geminiKey) throw new Error("No Gemini API key set. Open Setup to paste your key.");
  let lastErr = "All Gemini models busy.";

  for (const model of GEMINI_MODELS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(secrets.geminiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            system_instruction: { parts: [{ text: "Return ONLY a valid raw JSON object with no markdown fences or explanation." }] },
            generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
            contents: [{ role: "user", parts: [{ text: prompt }] }]
          })
        }
      );
      clearTimeout(timer);
      const data = await res.json();
      if (res.ok) {
        const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
        return JSON.parse(text.replace(/```json|```/g, "").trim());
      }
      lastErr = data.error?.message || `HTTP ${res.status}`;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === "AbortError" ? `${model} timed out` : e.message;
    }
  }
  throw new Error(lastErr);
}

document.getElementById("parse-mpesa-btn").addEventListener("click", async () => {
  const sms = document.getElementById("mpesa-sms-input").value.trim();
  const hint = document.getElementById("mpesa-hint-input").value.trim();
  const statusEl = document.getElementById("parse-status");
  if (!sms) return alert("Paste an M-Pesa message first.");

  statusEl.textContent = "Parsing M-Pesa message with Gemini...";
  const coaList = COA.map((a) => `${a.code}: ${a.name}`).join("\n");

  const prompt = `Extract Kenyan M-Pesa transaction details from this SMS:
SMS: "${sms}"
User Hint: "${hint || "None"}"
Available Chart of Accounts:
${coaList}

Rules:
- direction: "IN" if money was received into our account, "OUT" if sent/paid/withdrawn.
- amount: numeric principal amount in KES (excluding transaction cost).
- fee: numeric transaction cost in KES (0 if received or none).
- mpesaCode: exact M-Pesa confirmation code (e.g., UK48X91P2Q).
- date: YYYY-MM-DD (use ${todayStr()} if unclear).
- counterparty: person/business name.
- memo: concise description combining counterparty and hint.
- suggestedOffsetCode: best 4-digit CoA code from list above. For incoming client trip deposits use "2010" (Deferred Client Deposits). For bus/guide/medic use "5100", for meals/park fees/snacks use "5200", for general overhead use "6100".

Reply ONLY with JSON:
{"mpesaCode":"","direction":"OUT","amount":0,"fee":0,"date":"YYYY-MM-DD","counterparty":"","memo":"","suggestedOffsetCode":"5100"}`;

  try {
    const parsed = await callGeminiJSON(prompt);
    statusEl.textContent = "Draft ready. Review accounts and approve.";
    openDraftEditor(parsed);
  } catch (err) {
    statusEl.textContent = "Parse failed: " + err.message;
  }
});

function openDraftEditor(data) {
  currentDraftDir = data.direction === "IN" ? "IN" : "OUT";
  document.getElementById("draft-card").classList.remove("hidden");

  const dirBadge = document.getElementById("draft-dir-badge");
  dirBadge.textContent = currentDraftDir === "IN" ? "⬇ INCOMING" : "⬆ OUTGOING";
  dirBadge.className = `badge ${currentDraftDir === "IN" ? "in" : "out"}`;

  document.getElementById("draft-code").value = (data.mpesaCode || "").toUpperCase();
  document.getElementById("draft-date").value = data.date || todayStr();
  document.getElementById("draft-memo").value = data.memo || data.counterparty || "";
  document.getElementById("draft-amount").value = Number(data.amount || 0);
  document.getElementById("draft-fee").value = currentDraftDir === "OUT" ? Number(data.fee || 0) : 0;
  document.getElementById("draft-cash-acc").value = "1010";
  document.getElementById("draft-offset-acc").value = data.suggestedOffsetCode || (currentDraftDir === "IN" ? "2010" : "5100");
  document.getElementById("draft-entity").value = document.getElementById("mpesa-entity-select").value;
  document.getElementById("draft-pool").value = document.getElementById("mpesa-pool-select").value;
  document.getElementById("draft-etims").checked = false;

  updateDraftPreview();
}

function buildDraftLines() {
  const amt = Number(document.getElementById("draft-amount").value || 0);
  const fee = currentDraftDir === "OUT" ? Number(document.getElementById("draft-fee").value || 0) : 0;
  const cashCode = document.getElementById("draft-cash-acc").value;
  const offsetCode = document.getElementById("draft-offset-acc").value;

  if (currentDraftDir === "IN") {
    return [
      { accountCode: cashCode, debit: amt, credit: 0 },
      { accountCode: offsetCode, debit: 0, credit: amt }
    ];
  } else {
    const lines = [{ accountCode: offsetCode, debit: amt, credit: 0 }];
    if (fee > 0) lines.push({ accountCode: "6120", debit: fee, credit: 0 });
    lines.push({ accountCode: cashCode, debit: 0, credit: amt + fee });
    return lines;
  }
}

function updateDraftPreview() {
  const code = document.getElementById("draft-code").value;
  const dup = findDuplicateMpesa(code);
  const dupEl = document.getElementById("duplicate-alert");
  if (dup) {
    dupEl.innerHTML = `<strong>⚠ DUPLICATE M-PESA CODE DETECTED:</strong> Code <strong>${esc(code)}</strong> was already posted on ${dup.date} (${esc(dup.memo)}).`;
    dupEl.classList.remove("hidden");
  } else {
    dupEl.classList.add("hidden");
  }

  const lines = buildDraftLines();
  document.getElementById("draft-preview-lines").innerHTML = lines
    .map((l) => {
      const a = getAcc(l.accountCode);
      return l.debit > 0
        ? `<div class="je-line je-dr"><span>DR ${a.code} ${esc(a.name)}</span><strong>${fmtKES(l.debit)}</strong></div>`
        : `<div class="je-line je-cr"><span>CR ${a.code} ${esc(a.name)}</span><strong>${fmtKES(l.credit)}</strong></div>`;
    })
    .join("");
}

["draft-code", "draft-amount", "draft-fee", "draft-cash-acc", "draft-offset-acc"].forEach((id) => {
  document.getElementById(id).addEventListener("input", updateDraftPreview);
});

document.getElementById("post-draft-btn").addEventListener("click", () => {
  const code = document.getElementById("draft-code").value.trim();
  const dup = findDuplicateMpesa(code);
  if (dup && !confirm(`Warning: M-Pesa code ${code} is already in the ledger. Post anyway?`)) return;

  try {
    validateAndPostJE({
      date: document.getElementById("draft-date").value,
      mpesaCode: code,
      memo: document.getElementById("draft-memo").value.trim(),
      entityId: document.getElementById("draft-entity").value,
      poolId: document.getElementById("draft-pool").value,
      etimsVerified: document.getElementById("draft-etims").checked,
      lines: buildDraftLines()
    });
    document.getElementById("draft-card").classList.add("hidden");
    document.getElementById("mpesa-sms-input").value = "";
    document.getElementById("mpesa-hint-input").value = "";
    document.getElementById("parse-status").textContent = "✓ Posted to immutable General Ledger.";
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("cancel-draft-btn").addEventListener("click", () => {
  document.getElementById("draft-card").classList.add("hidden");
});

document.getElementById("open-manual-btn").addEventListener("click", () => {
  switchTab("view-ai");
  const dir = confirm("Is this an INCOMING cash receipt? (OK = Incoming, Cancel = Outgoing payment)") ? "IN" : "OUT";
  openDraftEditor({ direction: dir, date: todayStr(), amount: 0, fee: 0, memo: "" });
});

// ================= AES-256-GCM ENCRYPTION & GITHUB SYNC =================
function bufToB64(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function encryptPayload(obj, pin) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMat = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMat,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, updatedAt: new Date().toISOString(), salt: bufToB64(salt), iv: bufToB64(iv), ct: bufToB64(cipher) };
}

async function syncToGitHub(silent = false) {
  const hdr = document.getElementById("header-sync-status");
  if (!secrets.ghRepo || !secrets.ghToken || !secrets.teamPin) {
    if (!silent) alert("Configure GitHub Repo, Token, and Team PIN in Setup first.");
    return;
  }

  hdr.textContent = "Encrypting & syncing...";
  try {
    const encrypted = await encryptPayload(ledger, secrets.teamPin);
    const contentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(encrypted, null, 2))));
    const apiUrl = `https://api.github.com/repos/${secrets.ghRepo.trim()}/contents/docs/ledger.enc.json`;
    const headers = {
      Authorization: `Bearer ${secrets.ghToken.trim()}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    };

    let sha = undefined;
    const check = await fetch(apiUrl, { headers });
    if (check.ok) {
      const existing = await check.json();
      sha = existing.sha;
    }

    const put = await fetch(apiUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `Sync encrypted ledger (${ledger.entries.length} entries)`,
        content: contentB64,
        sha
      })
    });

    if (!put.ok) {
      const errData = await put.json();
      throw new Error(errData.message || `HTTP ${put.status}`);
    }

    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    hdr.textContent = `Synced ${time} • v0.1`;
    if (!silent) document.getElementById("cfg-status").textContent = `✓ Encrypted snapshot synced to ${secrets.ghRepo} at ${time}.`;
  } catch (err) {
    hdr.textContent = "Sync failed (Local safe)";
    if (!silent) alert("GitHub Sync failed: " + err.message);
  }
}

document.getElementById("sync-now-btn").addEventListener("click", () => syncToGitHub(false));
document.getElementById("test-sync-btn").addEventListener("click", () => syncToGitHub(false));

// ================= ENTITIES & POOLS MANAGEMENT =================
document.getElementById("add-entity-btn").addEventListener("click", () => {
  const name = document.getElementById("new-entity-name").value.trim();
  if (!name) return;
  ledger.entities.push({ id: "ent_" + Date.now(), name });
  document.getElementById("new-entity-name").value = "";
  saveLedger(true);
  renderAll();
});

window.renameEntity = function (id) {
  const e = ledger.entities.find((x) => x.id === id);
  if (!e) return;
  const next = prompt("Rename Subsidiary / Entity:", e.name);
  if (!next || !next.trim()) return;
  e.name = next.trim();
  saveLedger(true);
  renderAll();
};

document.getElementById("add-pool-btn").addEventListener("click", () => {
  const name = document.getElementById("new-pool-name").value.trim();
  if (!name) return;
  ledger.pools.push({ id: "pool_" + Date.now(), name });
  document.getElementById("new-pool-name").value = "";
  saveLedger(true);
  renderAll();
});

window.renamePool = function (id) {
  const p = ledger.pools.find((x) => x.id === id);
  if (!p) return;
  const next = prompt("Rename Trip / Project Pool:", p.name);
  if (!next || !next.trim()) return;
  p.name = next.trim();
  saveLedger(true);
  renderAll();
};

// ================= SETTINGS & VAULT IO =================
document.getElementById("save-cfg-btn").addEventListener("click", () => {
  secrets = {
    geminiKey: document.getElementById("cfg-gemini-key").value.trim(),
    ghRepo: document.getElementById("cfg-gh-repo").value.trim(),
    ghToken: document.getElementById("cfg-gh-token").value.trim(),
    teamPin: document.getElementById("cfg-team-pin").value.trim()
  };
  localStorage.setItem(SECRETS_KEY, JSON.stringify(secrets));
  document.getElementById("cfg-status").textContent = "✓ Keys & Team PIN saved locally on this device.";
});

document.getElementById("export-vault-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `talani-accounts-vault-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  document.getElementById("vault-status").textContent = "Vault exported (API keys & tokens excluded).";
});

document.getElementById("import-vault-input").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const imp = JSON.parse(ev.target.result);
      if (!Array.isArray(imp.entries)) throw new Error("Invalid vault");
      ledger = imp;
      saveLedger(false);
      renderAll();
      document.getElementById("vault-status").textContent = "✓ Vault imported successfully.";
    } catch { document.getElementById("vault-status").textContent = "Error: Invalid JSON vault."; }
  };
  reader.readAsText(f);
});

// ================= RENDERERS =================
function populateDropdowns() {
  const entOpts = ledger.entities.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
  const poolOpts = ledger.pools.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");

  ["mpesa-entity-select", "draft-entity"].forEach((id) => (document.getElementById(id).innerHTML = entOpts));
  ["mpesa-pool-select", "draft-pool"].forEach((id) => (document.getElementById(id).innerHTML = poolOpts));

  const curFilterEnt = document.getElementById("filter-entity").value;
  const curFilterPool = document.getElementById("filter-pool").value;
  document.getElementById("filter-entity").innerHTML = `<option value="all">All Entities</option>` + entOpts;
  document.getElementById("filter-pool").innerHTML = `<option value="all">All Trip Pools</option>` + poolOpts;
  if (curFilterEnt) document.getElementById("filter-entity").value = curFilterEnt;
  if (curFilterPool) document.getElementById("filter-pool").value = curFilterPool;

  const cashOpts = COA.filter((a) => a.isCash).map((a) => `<option value="${a.code}">${a.code} — ${esc(a.name)}</option>`).join("");
  const allOpts = COA.map((a) => `<option value="${a.code}">${a.code} — ${esc(a.name)}</option>`).join("");
  document.getElementById("draft-cash-acc").innerHTML = cashOpts;
  document.getElementById("draft-offset-acc").innerHTML = allOpts;
}

function renderDashboard() {
  const bal = computeBalances();
  const totalCash = COA.filter((a) => a.isCash).reduce((s, a) => s + (bal[a.code] || 0), 0);
  const restricted = COA.filter((a) => a.restricted).reduce((s, a) => s + Math.max(0, bal[a.code] || 0), 0);
  const freeCash = totalCash - restricted;

  document.getElementById("dash-free-cash").textContent = fmtKES(freeCash);
  document.getElementById("dash-total-cash").textContent = fmtKES(totalCash);
  document.getElementById("dash-restricted-cash").textContent = fmtKES(restricted);

  const assets = COA.filter((a) => a.type === "ASSET").reduce((s, a) => s + (bal[a.code] || 0), 0);
  const liab = COA.filter((a) => a.type === "LIABILITY").reduce((s, a) => s + (bal[a.code] || 0), 0);
  const eqBase = COA.filter((a) => a.type === "EQUITY").reduce((s, a) => s + (a.normal === "CR" ? bal[a.code] : -bal[a.code]), 0);
  const rev = COA.filter((a) => a.type === "REVENUE").reduce((s, a) => s + (a.normal === "CR" ? bal[a.code] : -bal[a.code]), 0);
  const exp = COA.filter((a) => a.type === "EXPENSE").reduce((s, a) => s + (bal[a.code] || 0), 0);
  const netIncome = rev - exp;
  const isBalanced = Math.abs(assets - (liab + eqBase + netIncome)) < 0.05;

  const badge = document.getElementById("gl-balance-badge");
  badge.textContent = isBalanced ? "✓ BALANCED" : "⚠ OUT OF BALANCE";
  badge.className = `badge ${isBalanced ? "ok" : "err"}`;

  document.getElementById("dash-equation-grid").innerHTML = `
    <div class="stat-box"><span class="muted">Total Assets</span><strong>${fmtKES(assets)}</strong></div>
    <div class="stat-box"><span class="muted">Total Liabilities</span><strong>${fmtKES(liab)}</strong></div>
    <div class="stat-box"><span class="muted">Equity + Net Income</span><strong>${fmtKES(eqBase + netIncome)}</strong></div>
    <div class="stat-box"><span class="muted">Net Profit (P&L)</span><strong>${fmtKES(netIncome)}</strong></div>`;

  // Entity summary
  document.getElementById("dash-entity-summary").innerHTML = ledger.entities
    .map((e) => {
      const subBal = computeBalances(ledger.entries.filter((je) => je.entityId === e.id));
      const eCash = COA.filter((a) => a.isCash).reduce((s, a) => s + (subBal[a.code] || 0), 0);
      const eDep = subBal["2010"] || 0;
      return `<div class="list-row"><span><strong>${esc(e.name)}</strong></span><span>Cash: ${fmtKES(eCash)} • Dep: ${fmtKES(eDep)}</span></div>`;
    })
    .join("");

  // Pool summary
  document.getElementById("dash-pool-summary").innerHTML = ledger.pools
    .map((p) => {
      const pBal = computeBalances(ledger.entries.filter((je) => je.poolId === p.id));
      const pIn = (pBal["2010"] || 0) + (pBal["4010"] || 0);
      const pCost = (pBal["5100"] || 0) + (pBal["5200"] || 0) + (pBal["6120"] || 0);
      return `<div class="list-row"><span><strong>${esc(p.name)}</strong></span><span>In: ${fmtKES(pIn)} • Out: ${fmtKES(pCost)}</span></div>`;
    })
    .join("");
}

function renderLedger() {
  const entF = document.getElementById("filter-entity").value || "all";
  const poolF = document.getElementById("filter-pool").value || "all";
  const q = (document.getElementById("filter-search").value || "").toLowerCase();

  const items = ledger.entries.filter((je) => {
    if (entF !== "all" && je.entityId !== entF) return false;
    if (poolF !== "all" && je.poolId !== poolF) return false;
    if (q && !`${je.mpesaCode} ${je.memo} ${je.id}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const el = document.getElementById("ledger-list");
  if (!items.length) {
    el.innerHTML = `<div class="card muted">No journal entries yet. Paste an M-Pesa SMS in the AI M-Pesa tab to post your first entry.</div>`;
    return;
  }

  el.innerHTML = items
    .map((je) => {
      const ent = ledger.entities.find((e) => e.id === je.entityId)?.name || "Entity";
      const pool = ledger.pools.find((p) => p.id === je.poolId)?.name || "Pool";
      const linesHtml = je.lines
        .map((l) => {
          const a = getAcc(l.accountCode);
          return l.debit > 0
            ? `<div class="je-line je-dr"><span>DR ${a.code} ${esc(a.name)}</span><strong>${fmtKES(l.debit)}</strong></div>`
            : `<div class="je-line je-cr"><span>CR ${a.code} ${esc(a.name)}</span><strong>${fmtKES(l.credit)}</strong></div>`;
        })
        .join("");

      return `
      <div class="je-card ${je.reversedBy ? "reversed" : ""} ${je.isReversal ? "is-rev" : ""}">
        <div class="card-top" style="margin-bottom:4px;">
          <strong style="font-size:0.88rem;">${esc(je.memo)}</strong>
          ${!je.reversedBy && !je.isReversal ? `<button class="btn-mini danger" onclick="reverseEntry('${je.id}')">↩ Reverse</button>` : ""}
        </div>
        <div class="je-meta">
          <span class="tag">${je.date}</span>
          ${je.mpesaCode ? `<span class="tag">M-Pesa: ${esc(je.mpesaCode)}</span>` : ""}
          <span class="tag">${esc(ent)}</span>
          <span class="tag">${esc(pool)}</span>
          <span class="tag ${je.etimsVerified ? "etims-ok" : "etims-no"}">${je.etimsVerified ? "eTIMS ✓" : "No eTIMS"}</span>
          ${je.reversedBy ? `<span class="tag">REVERSED</span>` : ""}
        </div>
        <div class="journal-preview" style="margin:0;">${linesHtml}</div>
      </div>`;
    })
    .join("");
}

function renderSetup() {
  document.getElementById("entity-list").innerHTML = ledger.entities
    .map((e) => `<div class="list-row"><span>${esc(e.name)}</span><button class="btn-mini" onclick="renameEntity('${e.id}')">✎ Rename</button></div>`)
    .join("");

  document.getElementById("pool-list").innerHTML = ledger.pools
    .map((p) => `<div class="list-row"><span>${esc(p.name)}</span><button class="btn-mini" onclick="renamePool('${p.id}')">✎ Rename</button></div>`)
    .join("");

  document.getElementById("cfg-gemini-key").value = secrets.geminiKey || "";
  document.getElementById("cfg-gh-repo").value = secrets.ghRepo || "";
  document.getElementById("cfg-gh-token").value = secrets.ghToken || "";
  document.getElementById("cfg-team-pin").value = secrets.teamPin || "";
}

function renderAll() {
  populateDropdowns();
  renderDashboard();
  renderLedger();
  renderSetup();
}

// ================= NAVIGATION & FILTERS =================
function switchTab(id) {
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.target === id));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id));
}
document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.target)));
["filter-entity", "filter-pool", "filter-search"].forEach((id) => {
  document.getElementById(id).addEventListener("input", renderLedger);
});

renderAll();
