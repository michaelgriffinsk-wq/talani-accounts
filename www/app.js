const STORAGE_KEY = "talani_accounts_ledger_v1";
const SECRETS_KEY = "talani_accounts_secrets_v1";
const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash"];

// ================= CHART OF ACCOUNTS (1000s - 6000s) =================
const COA = [
  { code: "1010", name: "M-Pesa Treasury", type: "ASSET", normal: "DR", isCash: true },
  { code: "1020", name: "Bank Account", type: "ASSET", normal: "DR", isCash: true },
  { code: "1030", name: "Trail Float / Petty Cash", type: "ASSET", normal: "DR", isCash: true },
  { code: "1100", name: "Accounts Receivable (Clients)", type: "ASSET", normal: "DR" },
  { code: "1200", name: "Merchandise Inventory", type: "ASSET", normal: "DR" },
  { code: "1500", name: "Fixed Assets / Equipment", type: "ASSET", normal: "DR" },
  { code: "2010", name: "Deferred Client Deposits", type: "LIABILITY", normal: "CR", restricted: true },
  { code: "2020", name: "Accounts Payable (Suppliers)", type: "LIABILITY", normal: "CR", restricted: true },
  { code: "2030", name: "Due to Partners (Reimbursements)", type: "LIABILITY", normal: "CR", restricted: true },
  { code: "2040", name: "Taxes Payable (KRA/VAT/WHT)", type: "LIABILITY", normal: "CR", restricted: true },
  { code: "2050", name: "Customer Credit Vouchers", type: "LIABILITY", normal: "CR", restricted: true },
  { code: "2100", name: "Loans Payable", type: "LIABILITY", normal: "CR" },
  { code: "3010", name: "Partner Capital", type: "EQUITY", normal: "CR" },
  { code: "3020", name: "Retained Earnings", type: "EQUITY", normal: "CR" },
  { code: "3025", name: "Designated Reserves (Tithe/Emergency)", type: "EQUITY", normal: "CR" },
  { code: "3030", name: "Partner Draws / Distributions", type: "EQUITY", normal: "DR" },
  { code: "4010", name: "Earned Trip Revenue", type: "REVENUE", normal: "CR" },
  { code: "4020", name: "Cancellation Fee Revenue", type: "REVENUE", normal: "CR" },
  { code: "4030", name: "Merchandise Sales", type: "REVENUE", normal: "CR" },
  { code: "4040", name: "B2B Booking Commissions", type: "REVENUE", normal: "CR" },
  { code: "4090", name: "Discounts & Subsidies (Contra)", type: "REVENUE", normal: "DR" },
  { code: "5100", name: "Direct Trip COGS - Fixed", type: "EXPENSE", normal: "DR" },
  { code: "5200", name: "Direct Trip COGS - Variable", type: "EXPENSE", normal: "DR" },
  { code: "5300", name: "Merchandise COGS", type: "EXPENSE", normal: "DR" },
  { code: "6100", name: "General Operating Overhead", type: "EXPENSE", normal: "DR" },
  { code: "6120", name: "Bank & Mobile Money Charges", type: "EXPENSE", normal: "DR" }
];

const DEFAULT_LEDGER = {
  schemaVersion: 2,
  companyName: "Talani Adventures Accounts",
  entities: [
    { id: "ent_gik", name: "Group ya Ile Kitu" },
    { id: "ent_talani", name: "Talani Premium Tours" },
    { id: "ent_adamanti", name: "Adamanti Hospitality" }
  ],
  pools: [
    { id: "pool_hq", name: "General / HQ Overhead", status: "OPEN" },
    { id: "pool_gatamaiyu", name: "Gatamaiyu Expedition", status: "OPEN" }
  ],
  entries: [],
  bookings: [],
  payables: [],
  floats: [],
  reimbursements: [],
  lastUpdated: new Date().toISOString()
};

function todayStr() { return new Date().toISOString().slice(0, 10); }
function fmtKES(n) { return "KSh " + Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function getAcc(code) { return COA.find((a) => a.code === code) || { code, name: code, type: "EXPENSE", normal: "DR" }; }

function normalizeLedgerData(p) {
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_LEDGER)),
    ...p,
    schemaVersion: 2,
    entities: p?.entities?.length ? p.entities : DEFAULT_LEDGER.entities,
    pools: (p?.pools?.length ? p.pools : DEFAULT_LEDGER.pools).map((x) => ({ status: "OPEN", ...x })),
    entries: p?.entries || [],
    bookings: p?.bookings || [],
    payables: p?.payables || [],
    floats: p?.floats || [],
    reimbursements: p?.reimbursements || []
  };
}

function loadLedger() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_LEDGER));
    return normalizeLedgerData(JSON.parse(raw));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_LEDGER));
  }
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

function assertPoolOpen(poolId) {
  const pool = ledger.pools.find((p) => p.id === poolId);
  if (pool && pool.status === "CLOSED") {
    throw new Error(`Pool "${pool.name}" is CLOSED & LOCKED. Reopen it only if an auditor approves.`);
  }
}

function validateAndPostJE({ date, mpesaCode, memo, entityId, poolId, etimsVerified, lines, isReversal = false, reversesId = null, bypassLock = false }) {
  if (!bypassLock) assertPoolOpen(poolId);

  const cleanLines = lines
    .map((l) => ({ accountCode: l.accountCode, debit: Number(l.debit || 0), credit: Number(l.credit || 0) }))
    .filter((l) => l.debit > 0 || l.credit > 0);

  const totalDr = cleanLines.reduce((s, l) => s + l.debit, 0);
  const totalCr = cleanLines.reduce((s, l) => s + l.credit, 0);

  if (cleanLines.length < 2 || totalDr <= 0 || Math.abs(totalDr - totalCr) > 0.01) {
    throw new Error(`Unbalanced Journal Entry! DR (${totalDr.toFixed(2)}) ≠ CR (${totalCr.toFixed(2)}).`);
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

  try {
    const rev = validateAndPostJE({
      date: todayStr(),
      mpesaCode: orig.mpesaCode ? `REV-${orig.mpesaCode}` : "",
      memo: `REVERSAL of ${orig.id}: ${orig.memo}`,
      entityId: orig.entityId,
      poolId: orig.poolId,
      etimsVerified: false,
      lines: orig.lines.map((l) => ({ accountCode: l.accountCode, debit: l.credit, credit: l.debit })),
      isReversal: true,
      reversesId: orig.id
    });
    orig.reversedBy = rev.id;
    saveLedger(true);
    renderAll();
  } catch (e) { alert(e.message); }
};

function findDuplicateMpesa(code) {
  const clean = (code || "").trim().toUpperCase();
  if (!clean) return null;
  return ledger.entries.find((e) => e.mpesaCode === clean && !e.reversedBy && !e.isReversal) || null;
}

// ================= v0.2 MODULE 1: CLIENTS A/R & CANCELLATIONS =================
document.getElementById("add-ar-btn").addEventListener("click", () => {
  const entityId = document.getElementById("ar-entity").value;
  const poolId = document.getElementById("ar-pool").value;
  const clientName = document.getElementById("ar-name").value.trim();
  const ticketPrice = Number(document.getElementById("ar-price").value || 0);
  const discount = Number(document.getElementById("ar-discount").value || 0);
  const deposit = Number(document.getElementById("ar-deposit").value || 0);
  const mpesaCode = document.getElementById("ar-mpesa").value.trim();
  const isAgency = document.getElementById("ar-agency").checked;

  if (!clientName || ticketPrice <= 0) return alert("Enter client name and ticket price.");
  const netDue = Math.max(0, ticketPrice - discount);
  if (deposit > netDue) return alert("Deposit cannot exceed net ticket price.");

  try {
    assertPoolOpen(poolId);
    if (deposit > 0) {
      validateAndPostJE({
        date: todayStr(),
        mpesaCode,
        memo: `Client Deposit (${isAgency ? "Agency" : "Principal"}): ${clientName}`,
        entityId,
        poolId,
        lines: [
          { accountCode: "1010", debit: deposit, credit: 0 },
          { accountCode: "2010", debit: 0, credit: deposit }
        ]
      });
    }
    ledger.bookings.unshift({
      id: "BK-" + Date.now(),
      entityId,
      poolId,
      clientName,
      ticketPrice,
      discount,
      paid: deposit,
      isAgency,
      status: "ACTIVE"
    });
    document.getElementById("ar-name").value = "";
    document.getElementById("ar-deposit").value = "0";
    document.getElementById("ar-mpesa").value = "";
    saveLedger(true);
    renderAll();
  } catch (e) { alert(e.message); }
});

window.payArInstallment = function (id) {
  const b = ledger.bookings.find((x) => x.id === id);
  if (!b || b.status !== "ACTIVE") return;
  const bal = Math.max(0, b.ticketPrice - b.discount - b.paid);
  const amt = Number(prompt(`Installment from ${b.clientName} (Balance: ${fmtKES(bal)}):`, bal));
  if (!amt || amt <= 0) return;
  const code = prompt("M-Pesa Code (optional):") || "";

  try {
    validateAndPostJE({
      date: todayStr(),
      mpesaCode: code,
      memo: `Client Installment: ${b.clientName}`,
      entityId: b.entityId,
      poolId: b.poolId,
      lines: [
        { accountCode: "1010", debit: amt, credit: 0 },
        { accountCode: "2010", debit: 0, credit: amt }
      ]
    });
    b.paid += amt;
    saveLedger(true);
    renderAll();
  } catch (e) { alert(e.message); }
};

window.cancelBooking = function (id, mode) {
  const b = ledger.bookings.find((x) => x.id === id);
  if (!b || b.status !== "ACTIVE") return;
  if (b.paid <= 0) {
    b.status = "CANCELLED";
    saveLedger(true);
    return renderAll();
  }

  try {
    if (mode === "REFUND") {
      const fee = Number(prompt(`Cash Refund of ${fmtKES(b.paid)} to ${b.clientName}. Enter M-Pesa send fee (0 if none):`, "0") || 0);
      const lines = [
        { accountCode: "2010", debit: b.paid, credit: 0 },
        { accountCode: "1010", debit: 0, credit: b.paid + fee }
      ];
      if (fee > 0) lines.push({ accountCode: "6120", debit: fee, credit: 0 });
      validateAndPostJE({ date: todayStr(), memo: `Cash Refund: ${b.clientName}`, entityId: b.entityId, poolId: b.poolId, lines });
      b.status = "REFUNDED";
    } else if (mode === "FORFEIT") {
      if (!confirm(`Forfeit ${fmtKES(b.paid)} from ${b.clientName} to Cancellation Fee Revenue (4020)?`)) return;
      validateAndPostJE({
        date: todayStr(),
        memo: `Forfeited Deposit: ${b.clientName}`,
        entityId: b.entityId,
        poolId: b.poolId,
        lines: [
          { accountCode: "2010", debit: b.paid, credit: 0 },
          { accountCode: "4020", debit: 0, credit: b.paid }
        ]
      });
      b.status = "FORFEITED";
    } else if (mode === "VOUCHER") {
      if (!confirm(`Convert ${fmtKES(b.paid)} from ${b.clientName} into a Customer Credit Voucher (2050)?`)) return;
      validateAndPostJE({
        date: todayStr(),
        memo: `Credit Voucher Issued: ${b.clientName}`,
        entityId: b.entityId,
        poolId: b.poolId,
        lines: [
          { accountCode: "2010", debit: b.paid, credit: 0 },
          { accountCode: "2050", debit: 0, credit: b.paid }
        ]
      });
      b.status = "VOUCHER";
    }
    saveLedger(true);
    renderAll();
  } catch (e) { alert(e.message); }
};

// ================= v0.2 MODULE 2: SUPPLIERS A/P =================
document.getElementById("add-ap-btn").addEventListener("click", () => {
  const entityId = document.getElementById("ap-entity").value;
  const poolId = document.getElementById("ap-pool").value;
  const vendor = document.getElementById("ap-vendor").value.trim();
  const cogsCode = document.getElementById("ap-cogs").value;
  const dueDate = document.getElementById("ap-due").value || todayStr();
  const totalAmount = Number(document.getElementById("ap-total").value || 0);

  if (!vendor || totalAmount <= 0) return alert("Enter vendor name and quoted amount.");
  try {
    validateAndPostJE({
      date: todayStr(),
      memo: `Supplier Bill (A/P): ${vendor}`,
      entityId,
      poolId,
      lines: [
        { accountCode: cogsCode, debit: totalAmount, credit: 0 },
        { accountCode: "2020", debit: 0, credit: totalAmount }
      ]
    });
    ledger.payables.unshift({
      id: "AP-" + Date.now(),
      entityId,
      poolId,
      vendor,
      cogsCode,
      dueDate,
      totalAmount,
      paidAmount: 0,
      status: "OPEN"
    });
    document.getElementById("ap-vendor").value = "";
    document.getElementById("ap-total").value = "";
    saveLedger(true);
    renderAll();
  } catch (e) { alert(e.message); }
});

window.paySupplierAP = function (id) {
  const p = ledger.payables.find((x) => x.id === id);
  if (!p || p.status !== "OPEN") return;
  const bal = p.totalAmount - p.paidAmount;
  const amt = Number(prompt(`Pay ${p.vendor} (Remaining A/P: ${fmtKES(bal)}):`, bal));
  if (!amt || amt <= 0) return;
  const fee = Number(prompt("M-Pesa Transaction Fee (KSh, 0 if none):", "0") || 0);
  const code = prompt("M-Pesa Code (optional):") || "";

  try {
    const lines = [
      { accountCode: "2020", debit: amt, credit: 0 },
      { accountCode: "1010", debit: 0, credit: amt + fee }
    ];
    if (fee > 0) lines.push({ accountCode: "6120", debit: fee, credit: 0 });
    validateAndPostJE({ date: todayStr(), mpesaCode: code, memo: `Supplier Payment: ${p.vendor}`, entityId: p.entityId, poolId: p.poolId, lines });
    p.paidAmount += amt;
    if (p.paidAmount >= p.totalAmount - 0.01) p.status = "PAID";
    saveLedger(true);
    renderAll();
  } catch (e) { alert(e.message); }
};

// ================= v0.2 MODULE 3: TRAIL FLOAT & PARTNERS =================
document.getElementById("add-float-btn").addEventListener("click", () => {
  const entityId = document.getElementById("fl-entity").value;
  const poolId = document.getElementById("fl-pool").value;
  const holder = document.getElementById("fl-holder").value.trim();
  const issued = Number(document.getElementById("fl-amount").value || 0);
  if (!holder || issued <= 0) return alert("Enter coordinator name and cash issued.");

  try {
    validateAndPostJE({
      date: todayStr(),
      memo: `Trail Float Issued to ${holder}`,
      entityId,
      poolId,
      lines: [
        { accountCode: "1030", debit: issued, credit: 0 },
        { accountCode: "1010", debit: 0, credit: issued }
      ]
    });
    ledger.floats.unshift({ id: "FL-" + Date.now(), entityId, poolId, holder, issued, spent: 0, returned: 0, status: "OPEN" });
    document.getElementById("fl-holder").value = "";
    document.getElementById("fl-amount").value = "";
    saveLedger(true);
    renderAll();
  } catch (e) { alert(e.message); }
});

window.logFloatSpend = function (id) {
  const f = ledger.floats.find((x) => x.id === id);
  if (!f || f.status !== "OPEN") return;
  const rem = f.issued - f.spent - f.returned;
  const amt = Number(prompt(`Expense receipt from ${f.holder}'s float (Unaccounted: ${fmtKES(rem)}):`, rem));
  if (!amt || amt <= 0) return;
  const item = prompt("Receipt description (e.g., Park gate tips / Water):") || "Trail Expense";

  try {
    validateAndPostJE({
      date: todayStr(),
      memo: `Trail Float Expense (${f.holder}): ${item}`,
      entityId: f.entityId,
      poolId: f.poolId,
      lines: [
        { accountCode: "5200", debit: amt, credit: 0 },
        { accountCode: "1030", debit: 0, credit: amt }
      ]
    });
    f.spent += amt;
    if (f.issued - f.spent - f.returned <= 0.01) f.status = "SETTLED";
    saveLedger(true);
    renderAll();
  } catch (e) { alert(e.message); }
};

window.returnFloatChange = function (id) {
  const f = ledger.floats.find((x) => x.id === id);
  if (!f || f.status !== "OPEN") return;
  const rem = f.issued - f.spent - f.returned;
  if (rem <= 0) { f.status = "SETTLED"; saveLedger(true); return renderAll(); }
  if (!confirm(`Return remaining ${fmtKES(rem)} from ${f.holder} back to M-Pesa Treasury (1010)?`)) return;

  try {
    validateAndPostJE({
      date: todayStr(),
      memo: `Trail Float Change Returned: ${f.holder}`,
      entityId: f.entityId,
      poolId: f.poolId,
      lines: [
        { accountCode: "1010", debit: rem, credit: 0 },
        { accountCode: "1030", debit: 0, credit: rem }
      ]
    });
    f.returned += rem;
    f.status = "SETTLED";
    saveLedger(true);
    renderAll();
  } catch (e) { alert(e.message); }
};

document.getElementById("add-reimb-btn").addEventListener("click", () => {
  const entityId = document.getElementById("re-entity").value;
  const poolId = document.getElementById("re-pool").value;
  const partnerName = document.getElementById("re-partner").value.trim();
  const amount = Number(document.getElementById("re-amount").value || 0);
  const memo = document.getElementById("re-memo").value.trim() || "Out-of-pocket expense";
  const cogs = document.getElementById("re-cogs").value;
  if (!partnerName || amount <= 0) return alert("Enter partner name and amount.");

  try {
    validateAndPostJE({
      date: todayStr(),
      memo: `Partner Paid (${partnerName}): ${memo}`,
      entityId,
      poolId,
      lines: [
        { accountCode: cogs, debit: amount, credit: 0 },
        { accountCode: "2030", debit: 0, credit: amount }
      ]
    });
    ledger.reimbursements.unshift({ id: "RE-" + Date.now(), entityId, poolId, partnerName, memo, amount, status: "OPEN" });
    document.getElementById("re-partner").value = "";
    document.getElementById("re-amount").value = "";
    document.getElementById("re-memo").value = "";
    saveLedger(true);
    renderAll();
  } catch (e) { alert(e.message); }
});

window.settlePartnerReimb = function (id) {
  const r = ledger.reimbursements.find((x) => x.id === id);
  if (!r || r.status !== "OPEN") return;
  const fee = Number(prompt(`Reimburse ${r.partnerName} ${fmtKES(r.amount)}. Enter M-Pesa fee (0 if none):`, "0") || 0);
  const code = prompt("M-Pesa Code (optional):") || "";
  try {
    const lines = [
      { accountCode: "2030", debit: r.amount, credit: 0 },
      { accountCode: "1010", debit: 0, credit: r.amount + fee }
    ];
    if (fee > 0) lines.push({ accountCode: "6120", debit: fee, credit: 0 });
    validateAndPostJE({ date: todayStr(), mpesaCode: code, memo: `Partner Reimbursed: ${r.partnerName}`, entityId: r.entityId, poolId: r.poolId, lines });
    r.status = "PAID";
    saveLedger(true);
    renderAll();
  } catch (e) { alert(e.message); }
};

// ================= v0.2 MODULE 4: 4-STEP TRIP CLOSE WATERFALL =================
window.runTripClose = function (poolId) {
  const pool = ledger.pools.find((p) => p.id === poolId);
  if (!pool || pool.status === "CLOSED") return;

  const pBal = computeBalances(ledger.entries.filter((e) => e.poolId === poolId));
  const deferred = Math.max(0, pBal["2010"] || 0);
  const poolBookings = ledger.bookings.filter((b) => b.poolId === poolId && b.status === "ACTIVE");
  const totalDiscounts = poolBookings.reduce((s, b) => s + Number(b.discount || 0), 0);
  const isAgencyPool = poolBookings.length > 0 && poolBookings.every((b) => b.isAgency);
  const revAcc = isAgencyPool ? "4040" : "4010";
  const entId = poolBookings[0]?.entityId || ledger.entities[0].id;

  const reservePct = Number(prompt(`Recognize ${fmtKES(deferred)} Deferred → Earned Revenue.\nEnter Reserve Allocation % of Net Profit (e.g., 10 for Tithe/Reserve, 0 to skip):`, "10") || 0);

  try {
    if (deferred > 0) {
      const lines = [
        { accountCode: "2010", debit: deferred, credit: 0 },
        { accountCode: revAcc, debit: 0, credit: deferred + totalDiscounts }
      ];
      if (totalDiscounts > 0) lines.push({ accountCode: "4090", debit: totalDiscounts, credit: 0 });
      validateAndPostJE({ date: todayStr(), memo: `Trip Close: Revenue Recognition (${pool.name})`, entityId: entId, poolId, lines });
    }
    poolBookings.forEach((b) => (b.status = "EARNED"));

    const freshBal = computeBalances(ledger.entries.filter((e) => e.poolId === poolId));
    const rev = (freshBal["4010"] || 0) + (freshBal["4020"] || 0) + (freshBal["4040"] || 0) - (freshBal["4090"] || 0);
    const exp = (freshBal["5100"] || 0) + (freshBal["5200"] || 0) + (freshBal["6100"] || 0) + (freshBal["6120"] || 0);
    const netProfit = rev - exp;

    if (netProfit > 0 && reservePct > 0) {
      const resAmt = Math.round((netProfit * reservePct) / 100);
      if (resAmt > 0) {
        validateAndPostJE({
          date: todayStr(),
          memo: `Trip Close: ${reservePct}% Reserve Allocation (${pool.name})`,
          entityId: entId,
          poolId,
          lines: [
            { accountCode: "3020", debit: resAmt, credit: 0 },
            { accountCode: "3025", debit: 0, credit: resAmt }
          ]
        });
      }
    }

    pool.status = "CLOSED";
    saveLedger(true);
    renderAll();
    alert(`✓ "${pool.name}" closed & locked! Net Profit: ${fmtKES(netProfit)}.`);
  } catch (e) { alert(e.message); }
};

// ================= GEMINI AI M-PESA & BANK PARSER =================
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
            system_instruction: { parts: [{ text: "Return ONLY a valid raw JSON object with no markdown fences." }] },
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
  if (!sms) return alert("Paste an M-Pesa, Bank, or Pesalink message first.");

  statusEl.textContent = "Parsing message with Gemini...";
  const coaList = COA.map((a) => `${a.code}: ${a.name}`).join("\n");
  const prompt = `You are a Kenyan tour company accountant. Parse this M-Pesa, Bank SMS, Pesalink, or Bank-to-M-Pesa transfer message.
SMS: "${sms}"
Hint: "${hint || "None"}"
CoA:\n${coaList}
Rules:
- direction="IN" if money was received, else "OUT".
- amount=principal KES, fee=transaction charge KES (0 if IN).
- Extract the transaction reference code (M-Pesa code or Bank/Pesalink ref) into "mpesaCode".
- date=YYYY-MM-DD (use ${todayStr()} if unclear).
- If money landed in or left M-Pesa (even if sent from a bank like KCB/Equity/Co-op), set "cashAccountCode" to "1010". If it is a direct Bank account alert, set "cashAccountCode" to "1020".
- suggestedOffsetCode=best 4-digit CoA code (2010 for incoming client trip deposits, 5100 fixed COGS, 5200 variable COGS, 6100 overhead).
Return ONLY raw JSON:
{"mpesaCode":"","direction":"IN","amount":0,"fee":0,"date":"${todayStr()}","counterparty":"","memo":"","cashAccountCode":"1010","suggestedOffsetCode":"2010"}`;

  try {
    const parsed = await callGeminiJSON(prompt);
    statusEl.textContent = "Draft ready. Review and approve.";
    openDraftEditor(parsed);
  } catch (err) { statusEl.textContent = "Parse failed: " + err.message; }
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
  document.getElementById("draft-cash-acc").value = data.cashAccountCode || "1010";
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
    return [{ accountCode: cashCode, debit: amt, credit: 0 }, { accountCode: offsetCode, debit: 0, credit: amt }];
  }
  const lines = [{ accountCode: offsetCode, debit: amt, credit: 0 }];
  if (fee > 0) lines.push({ accountCode: "6120", debit: fee, credit: 0 });
  lines.push({ accountCode: cashCode, debit: 0, credit: amt + fee });
  return lines;
}

function updateDraftPreview() {
  const code = document.getElementById("draft-code").value;
  const dup = findDuplicateMpesa(code);
  const dupEl = document.getElementById("duplicate-alert");
  if (dup) {
    dupEl.innerHTML = `<strong>⚠ DUPLICATE M-PESA CODE:</strong> ${esc(code)} already posted on ${dup.date}.`;
    dupEl.classList.remove("hidden");
  } else { dupEl.classList.add("hidden"); }

  document.getElementById("draft-preview-lines").innerHTML = buildDraftLines()
    .map((l) => {
      const a = getAcc(l.accountCode);
      return l.debit > 0
        ? `<div class="je-line je-dr"><span>DR ${a.code} ${esc(a.name)}</span><strong>${fmtKES(l.debit)}</strong></div>`
        : `<div class="je-line je-cr"><span>CR ${a.code} ${esc(a.name)}</span><strong>${fmtKES(l.credit)}</strong></div>`;
    }).join("");
}

["draft-code", "draft-amount", "draft-fee", "draft-cash-acc", "draft-offset-acc"].forEach((id) => {
  document.getElementById(id).addEventListener("input", updateDraftPreview);
});

document.getElementById("post-draft-btn").addEventListener("click", () => {
  const code = document.getElementById("draft-code").value.trim();
  if (findDuplicateMpesa(code) && !confirm(`M-Pesa code ${code} already exists. Post anyway?`)) return;
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
  } catch (err) { alert(err.message); }
});

document.getElementById("cancel-draft-btn").addEventListener("click", () => document.getElementById("draft-card").classList.add("hidden"));
document.getElementById("open-manual-btn").addEventListener("click", () => {
  switchTab("view-ai");
  openDraftEditor({ direction: confirm("INCOMING cash? (OK=In, Cancel=Out)") ? "IN" : "OUT", date: todayStr(), amount: 0, fee: 0 });
});

// ================= AES-256 ENCRYPTION & GITHUB SYNC =================
function bufToB64(buf) {
  let bin = "";
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

async function encryptPayload(obj, pin) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMat = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMat, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 2, updatedAt: new Date().toISOString(), salt: bufToB64(salt), iv: bufToB64(iv), ct: bufToB64(cipher) };
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
    const headers = { Authorization: `Bearer ${secrets.ghToken.trim()}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };

    let sha;
    const check = await fetch(apiUrl, { headers });
    if (check.ok) sha = (await check.json()).sha;

    const put = await fetch(apiUrl, { method: "PUT", headers, body: JSON.stringify({ message: `Sync ledger (${ledger.entries.length} JEs)`, content: contentB64, sha }) });
    if (!put.ok) throw new Error((await put.json()).message || `HTTP ${put.status}`);

    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    hdr.textContent = `Synced ${time} • v0.4`;
    if (!silent) document.getElementById("cfg-status").textContent = `✓ Synced to ${secrets.ghRepo} at ${time}.`;
  } catch (err) {
    hdr.textContent = "Sync failed (Local safe)";
    if (!silent) alert("GitHub Sync failed: " + err.message);
  }
}

document.getElementById("sync-now-btn").addEventListener("click", () => syncToGitHub(false));
document.getElementById("test-sync-btn").addEventListener("click", () => syncToGitHub(false));

// ================= ENTITIES, POOLS & SETTINGS =================
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
  const next = e && prompt("Rename Entity:", e.name);
  if (next?.trim()) { e.name = next.trim(); saveLedger(true); renderAll(); }
};
document.getElementById("add-pool-btn").addEventListener("click", () => {
  const name = document.getElementById("new-pool-name").value.trim();
  if (!name) return;
  ledger.pools.push({ id: "pool_" + Date.now(), name, status: "OPEN" });
  document.getElementById("new-pool-name").value = "";
  saveLedger(true);
  renderAll();
});
window.renamePool = function (id) {
  const p = ledger.pools.find((x) => x.id === id);
  const next = p && prompt("Rename Trip Pool:", p.name);
  if (next?.trim()) { p.name = next.trim(); saveLedger(true); renderAll(); }
};

document.getElementById("save-cfg-btn").addEventListener("click", () => {
  secrets = {
    ...secrets,
    geminiKey: document.getElementById("cfg-gemini-key").value.trim(),
    ghRepo: document.getElementById("cfg-gh-repo").value.trim(),
    ghToken: document.getElementById("cfg-gh-token").value.trim(),
    teamPin: document.getElementById("cfg-team-pin").value.trim()
  };
  localStorage.setItem(SECRETS_KEY, JSON.stringify(secrets));
  document.getElementById("cfg-status").textContent = "✓ Keys & Team PIN saved locally.";
});

document.getElementById("export-vault-btn").addEventListener("click", () => {
  const json = JSON.stringify(ledger, null, 2);
  const filename = `talani-accounts-vault-${todayStr()}.json`;
  if (typeof window.nativeExportFile === "function") {
    window.nativeExportFile(filename, json, document.getElementById("vault-status"));
  }
});

document.getElementById("import-vault-input")?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  const statusEl = document.getElementById("vault-status");
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = JSON.parse(String(ev.target.result || "{}"));
      const candidate = parsed?.ledger && typeof parsed.ledger === "object" ? parsed.ledger : parsed;
      if (!candidate || typeof candidate !== "object") throw new Error("Invalid vault JSON.");
      ledger = normalizeLedgerData(candidate);
      saveLedger(false);
      renderAll();
      if (statusEl) statusEl.textContent = `✓ Imported vault (${ledger.entries.length} JEs).`;
    } catch (err) {
      if (statusEl) statusEl.textContent = "Import failed: " + err.message;
      alert("Import failed: " + err.message);
    } finally {
      e.target.value = "";
    }
  };
  reader.readAsText(file);
});

// ================= RENDERERS =================
function populateDropdowns() {
  const entOpts = ledger.entities.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
  const poolOpts = ledger.pools.map((p) => `<option value="${p.id}">${esc(p.name)}${p.status === "CLOSED" ? " [LOCKED]" : ""}</option>`).join("");

  ["mpesa-entity-select", "draft-entity", "ar-entity", "ap-entity", "fl-entity", "re-entity"].forEach((id) => (document.getElementById(id).innerHTML = entOpts));
  ["mpesa-pool-select", "draft-pool", "ar-pool", "ap-pool", "fl-pool", "re-pool", "close-pool-select"].forEach((id) => (document.getElementById(id).innerHTML = poolOpts));

  const fe = document.getElementById("filter-entity").value;
  const fp = document.getElementById("filter-pool").value;
  document.getElementById("filter-entity").innerHTML = `<option value="all">All Entities</option>` + entOpts;
  document.getElementById("filter-pool").innerHTML = `<option value="all">All Pools</option>` + poolOpts;
  if (fe) document.getElementById("filter-entity").value = fe;
  if (fp) document.getElementById("filter-pool").value = fp;

  document.getElementById("draft-cash-acc").innerHTML = COA.filter((a) => a.isCash).map((a) => `<option value="${a.code}">${a.code} — ${esc(a.name)}</option>`).join("");
  document.getElementById("draft-offset-acc").innerHTML = COA.map((a) => `<option value="${a.code}">${a.code} — ${esc(a.name)}</option>`).join("");
}

function renderDashboard() {
  const bal = computeBalances();
  const totalCash = COA.filter((a) => a.isCash).reduce((s, a) => s + (bal[a.code] || 0), 0);
  const restricted = COA.filter((a) => a.restricted).reduce((s, a) => s + Math.max(0, bal[a.code] || 0), 0);
  document.getElementById("dash-free-cash").textContent = fmtKES(totalCash - restricted);
  document.getElementById("dash-total-cash").textContent = fmtKES(totalCash);
  document.getElementById("dash-restricted-cash").textContent = fmtKES(restricted);

  const assets = COA.filter((a) => a.type === "ASSET").reduce((s, a) => s + (bal[a.code] || 0), 0);
  const liab = COA.filter((a) => a.type === "LIABILITY").reduce((s, a) => s + (bal[a.code] || 0), 0);
  const eqBase = COA.filter((a) => a.type === "EQUITY").reduce((s, a) => s + (a.normal === "CR" ? bal[a.code] : -bal[a.code]), 0);
  const rev = COA.filter((a) => a.type === "REVENUE").reduce((s, a) => s + (a.normal === "CR" ? bal[a.code] : -bal[a.code]), 0);
  const exp = COA.filter((a) => a.type === "EXPENSE").reduce((s, a) => s + (bal[a.code] || 0), 0);
  const netIncome = rev - exp;
  const ok = Math.abs(assets - (liab + eqBase + netIncome)) < 0.05;

  const badge = document.getElementById("gl-balance-badge");
  badge.textContent = ok ? "✓ BALANCED" : "⚠ OUT OF BALANCE";
  badge.className = `badge ${ok ? "ok" : "err"}`;

  document.getElementById("dash-equation-grid").innerHTML = `
    <div class="stat-box"><span class="muted">Total Assets</span><strong>${fmtKES(assets)}</strong></div>
    <div class="stat-box"><span class="muted">Total Liabilities</span><strong>${fmtKES(liab)}</strong></div>
    <div class="stat-box"><span class="muted">Equity + Profit</span><strong>${fmtKES(eqBase + netIncome)}</strong></div>
    <div class="stat-box"><span class="muted">Net Profit (P&L)</span><strong>${fmtKES(netIncome)}</strong></div>`;

  document.getElementById("dash-entity-summary").innerHTML = ledger.entities.map((e) => {
    const b = computeBalances(ledger.entries.filter((je) => je.entityId === e.id));
    const c = COA.filter((a) => a.isCash).reduce((s, a) => s + (b[a.code] || 0), 0);
    return `<div class="list-row"><strong>${esc(e.name)}</strong><span>Cash: ${fmtKES(c)} • Dep: ${fmtKES(b["2010"] || 0)}</span></div>`;
  }).join("");

  document.getElementById("dash-pool-summary").innerHTML = ledger.pools.map((p) => {
    const b = computeBalances(ledger.entries.filter((je) => je.poolId === p.id));
    const inc = (b["2010"] || 0) + (b["4010"] || 0) + (b["4040"] || 0);
    const out = (b["5100"] || 0) + (b["5200"] || 0) + (b["6120"] || 0);
    return `<div class="list-row"><strong>${esc(p.name)} ${p.status === "CLOSED" ? "🔒" : ""}</strong><span>In: ${fmtKES(inc)} • Out: ${fmtKES(out)}</span></div>`;
  }).join("");
}

function renderOps() {
  document.getElementById("ar-list").innerHTML = ledger.bookings.map((b) => {
    const pool = ledger.pools.find((p) => p.id === b.poolId)?.name || "";
    const bal = Math.max(0, b.ticketPrice - b.discount - b.paid);
    return `
    <div class="je-card ${b.status !== "ACTIVE" ? "settled" : ""}">
      <div class="card-top" style="margin-bottom:4px;">
        <strong>${esc(b.clientName)}</strong>
        <span class="badge ${bal === 0 ? "ok" : "out"}">${b.status === "ACTIVE" ? (bal === 0 ? "PAID" : "BAL: " + fmtKES(bal)) : b.status}</span>
      </div>
      <div class="je-meta">
        <span class="tag">${esc(pool)}</span>
        <span class="tag">Net: ${fmtKES(b.ticketPrice - b.discount)}</span>
        <span class="tag">Paid: ${fmtKES(b.paid)}</span>
        ${b.discount > 0 ? `<span class="tag">Disc: ${fmtKES(b.discount)}</span>` : ""}
        ${b.isAgency ? `<span class="tag">Agency</span>` : ""}
      </div>
      ${b.status === "ACTIVE" ? `
        <div class="btn-row">
          ${bal > 0 ? `<button class="btn-mini ok" onclick="payArInstallment('${b.id}')">+ Pay Bal</button>` : ""}
          <button class="btn-mini warn" onclick="cancelBooking('${b.id}','VOUCHER')">Voucher</button>
          <button class="btn-mini" onclick="cancelBooking('${b.id}','FORFEIT')">Forfeit</button>
          <button class="btn-mini danger" onclick="cancelBooking('${b.id}','REFUND')">Refund</button>
        </div>` : ""}
    </div>`;
  }).join("") || `<div class="card muted">No client bookings logged yet.</div>`;

  document.getElementById("ap-list").innerHTML = ledger.payables.map((p) => {
    const pool = ledger.pools.find((x) => x.id === p.poolId)?.name || "";
    const bal = Math.max(0, p.totalAmount - p.paidAmount);
    return `
    <div class="je-card ${p.status === "PAID" ? "settled" : ""}">
      <div class="card-top" style="margin-bottom:4px;">
        <strong>${esc(p.vendor)}</strong>
        <span class="badge ${p.status === "PAID" ? "ok" : "err"}">${p.status === "PAID" ? "PAID" : "DUE: " + fmtKES(bal)}</span>
      </div>
      <div class="je-meta">
        <span class="tag">${esc(pool)}</span>
        <span class="tag">${p.cogsCode}</span>
        <span class="tag">Due: ${p.dueDate}</span>
      </div>
      ${p.status === "OPEN" ? `<button class="btn-mini ok" onclick="paySupplierAP('${p.id}')">💸 Record Payment</button>` : ""}
    </div>`;
  }).join("") || `<div class="card muted">No supplier payables logged yet.</div>`;

  document.getElementById("float-list").innerHTML = ledger.floats.map((f) => {
    const rem = Math.max(0, f.issued - f.spent - f.returned);
    return `
    <div class="je-card ${f.status === "SETTLED" ? "settled" : ""}">
      <div class="card-top" style="margin-bottom:4px;">
        <strong>Float: ${esc(f.holder)}</strong>
        <span class="badge ${f.status === "SETTLED" ? "ok" : "out"}">${f.status === "SETTLED" ? "SETTLED" : "OPEN: " + fmtKES(rem)}</span>
      </div>
      <div class="je-meta">
        <span class="tag">Issued: ${fmtKES(f.issued)}</span>
        <span class="tag">Spent: ${fmtKES(f.spent)}</span>
        <span class="tag">Returned: ${fmtKES(f.returned)}</span>
      </div>
      ${f.status === "OPEN" ? `
        <div class="btn-row">
          <button class="btn-mini" onclick="logFloatSpend('${f.id}')">+ Log Receipt</button>
          <button class="btn-mini ok" onclick="returnFloatChange('${f.id}')">↩ Return Change</button>
        </div>` : ""}
    </div>`;
  }).join("") || `<div class="card muted">No active trail floats.</div>`;

  document.getElementById("reimb-list").innerHTML = ledger.reimbursements.map((r) => `
    <div class="je-card ${r.status === "PAID" ? "settled" : ""}">
      <div class="card-top" style="margin-bottom:4px;">
        <strong>${esc(r.partnerName)} — ${esc(r.memo)}</strong>
        <span class="badge ${r.status === "PAID" ? "ok" : "out"}">${r.status === "PAID" ? "SETTLED" : fmtKES(r.amount)}</span>
      </div>
      ${r.status === "OPEN" ? `<button class="btn-mini ok" onclick="settlePartnerReimb('${r.id}')">✓ Reimburse Partner</button>` : ""}
    </div>`).join("") || `<div class="card muted">No partner reimbursements owed.</div>`;

  renderTripCloseBox();
}

function renderTripCloseBox() {
  const poolId = document.getElementById("close-pool-select").value;
  const pool = ledger.pools.find((p) => p.id === poolId);
  const box = document.getElementById("close-audit-box");
  if (!pool) return;

  const openAR = ledger.bookings.filter((b) => b.poolId === poolId && b.status === "ACTIVE" && (b.ticketPrice - b.discount - b.paid) > 0.01).length;
  const openAP = ledger.payables.filter((p) => p.poolId === poolId && p.status === "OPEN").length;
  const openFl = ledger.floats.filter((f) => f.poolId === poolId && f.status === "OPEN").length;
  const pBal = computeBalances(ledger.entries.filter((e) => e.poolId === poolId));
  const ready = openAR === 0 && openAP === 0 && openFl === 0 && pool.status !== "CLOSED";

  box.innerHTML = `
    <div class="check-row"><span>1. Unpaid Client Seats (A/R)</span><span class="${openAR === 0 ? "check-ok" : "check-fail"}">${openAR === 0 ? "✓ Clear" : openAR + " Open"}</span></div>
    <div class="check-row"><span>2. Unpaid Supplier Bills (A/P)</span><span class="${openAP === 0 ? "check-ok" : "check-fail"}">${openAP === 0 ? "✓ Clear" : openAP + " Open"}</span></div>
    <div class="check-row"><span>3. Unsettled Trail Floats</span><span class="${openFl === 0 ? "check-ok" : "check-fail"}">${openFl === 0 ? "✓ Clear" : openFl + " Open"}</span></div>
    <div class="check-row"><span>Deferred Deposits to Recognize</span><strong>${fmtKES(pBal["2010"] || 0)}</strong></div>
    <div style="margin-top:12px;">
      ${pool.status === "CLOSED"
        ? `<div class="badge ok" style="display:block;text-align:center;padding:8px;">🔒 POOL CLOSED & LOCKED</div>`
        : `<button class="btn ${ready ? "success" : "secondary"}" ${ready ? "" : "disabled"} onclick="runTripClose('${pool.id}')">${ready ? "✓ Execute Trip Close Waterfall" : "Clear Open Items Above First"}</button>`}
    </div>`;
}

document.getElementById("close-pool-select").addEventListener("change", renderTripCloseBox);

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

  document.getElementById("ledger-list").innerHTML = items.map((je) => {
    const ent = ledger.entities.find((e) => e.id === je.entityId)?.name || "";
    const pool = ledger.pools.find((p) => p.id === je.poolId)?.name || "";
    const linesHtml = je.lines.map((l) => {
      const a = getAcc(l.accountCode);
      return l.debit > 0
        ? `<div class="je-line je-dr"><span>DR ${a.code} ${esc(a.name)}</span><strong>${fmtKES(l.debit)}</strong></div>`
        : `<div class="je-line je-cr"><span>CR ${a.code} ${esc(a.name)}</span><strong>${fmtKES(l.credit)}</strong></div>`;
    }).join("");

    return `
    <div class="je-card ${je.reversedBy ? "reversed" : ""} ${je.isReversal ? "is-rev" : ""}">
      <div class="card-top" style="margin-bottom:4px;">
        <strong style="font-size:0.86rem;">${esc(je.memo)}</strong>
        ${!je.reversedBy && !je.isReversal ? `<button class="btn-mini danger" onclick="reverseEntry('${je.id}')">↩ Reverse</button>` : ""}
      </div>
      <div class="je-meta">
        <span class="tag">${je.date}</span>
        ${je.mpesaCode ? `<span class="tag">M-Pesa: ${esc(je.mpesaCode)}</span>` : ""}
        <span class="tag">${esc(ent)}</span>
        <span class="tag">${esc(pool)}</span>
        <span class="tag ${je.etimsVerified ? "etims-ok" : "etims-no"}">${je.etimsVerified ? "eTIMS ✓" : "No eTIMS"}</span>
      </div>
      <div class="journal-preview" style="margin:0;">${linesHtml}</div>
    </div>`;
  }).join("") || `<div class="card muted">No journal entries yet.</div>`;
}

function renderSetup() {
  document.getElementById("entity-list").innerHTML = ledger.entities.map((e) => `<div class="list-row"><span>${esc(e.name)}</span><button class="btn-mini" onclick="renameEntity('${e.id}')">✎ Rename</button></div>`).join("");
  document.getElementById("pool-list").innerHTML = ledger.pools.map((p) => `<div class="list-row"><span>${esc(p.name)} ${p.status === "CLOSED" ? "🔒" : ""}</span><button class="btn-mini" onclick="renamePool('${p.id}')">✎ Rename</button></div>`).join("");
  document.getElementById("cfg-gemini-key").value = secrets.geminiKey || "";
  document.getElementById("cfg-gh-repo").value = secrets.ghRepo || "";
  document.getElementById("cfg-gh-token").value = secrets.ghToken || "";
  document.getElementById("cfg-team-pin").value = secrets.teamPin || "";
}

function renderAll() {
  populateDropdowns();
  renderDashboard();
  renderOps();
  renderLedger();
  renderSetup();
}

// ================= NAVIGATION =================
function switchTab(id) {
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.target === id));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id));
}
document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.target)));

document.querySelectorAll("#ops-subtabs .pill").forEach((p) => {
  p.addEventListener("click", () => {
    document.querySelectorAll("#ops-subtabs .pill").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".ops-panel").forEach((x) => x.classList.remove("active"));
    p.classList.add("active");
    document.getElementById(p.dataset.ops).classList.add("active");
  });
});

["filter-entity", "filter-pool", "filter-search"].forEach((id) => document.getElementById(id).addEventListener("input", renderLedger));

window.addEventListener("DOMContentLoaded", () => {
  renderAll();
});
