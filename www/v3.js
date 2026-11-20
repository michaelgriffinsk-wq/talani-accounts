// ================= v0.3: BALANCE SHEET, FX & KRA PREP =================
(function initV3() {
  // Extend Chart of Accounts for v0.3
  const extraCoa = [
    { code: "1510", name: "Accumulated Depreciation", type: "ASSET", normal: "CR" },
    { code: "4080", name: "Realized FX Gain", type: "REVENUE", normal: "CR" },
    { code: "6150", name: "Salaries & Employer Statutory", type: "EXPENSE", normal: "DR" },
    { code: "6200", name: "Depreciation Expense", type: "EXPENSE", normal: "DR" },
    { code: "6300", name: "Loan Interest Expense", type: "EXPENSE", normal: "DR" },
    { code: "6350", name: "Realized FX Loss", type: "EXPENSE", normal: "DR" }
  ];
  extraCoa.forEach((a) => { if (!COA.find((x) => x.code === a.code)) COA.push(a); });

  // Ensure v0.3 arrays exist on ledger
  function ensureV3Data() {
    ledger.assets = ledger.assets || [];
    ledger.inventory = ledger.inventory || [];
    ledger.loans = ledger.loans || [];
    ledger.partnerLog = ledger.partnerLog || [];
    ledger.fxLog = ledger.fxLog || [];
  }
  ensureV3Data();

  // Sub-tab switching for Books
  document.querySelectorAll("#books-subtabs .pill").forEach((p) => {
    p.addEventListener("click", () => {
      document.querySelectorAll("#books-subtabs .pill").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll("#view-books .ops-panel").forEach((x) => x.classList.remove("active"));
      p.classList.add("active");
      document.getElementById(p.dataset.bk).classList.add("active");
    });
  });

  // 1. FIXED ASSETS & DEPRECIATION
  document.getElementById("add-fa-btn").addEventListener("click", () => {
    const name = document.getElementById("fa-name").value.trim();
    const cost = Number(document.getElementById("fa-cost").value || 0);
    const months = Math.max(1, Number(document.getElementById("fa-months").value || 36));
    if (!name || cost <= 0) return alert("Enter asset name and cost.");

    validateAndPostJE({
      date: todayStr(),
      memo: `CapEx Purchase: ${name}`,
      entityId: ledger.entities[0].id,
      poolId: ledger.pools[0].id,
      lines: [
        { accountCode: "1500", debit: cost, credit: 0 },
        { accountCode: "1010", debit: 0, credit: cost }
      ]
    });
    ledger.assets.unshift({ id: "FA-" + Date.now(), name, cost, months, accumDep: 0 });
    document.getElementById("fa-name").value = "";
    document.getElementById("fa-cost").value = "";
    saveLedger(true);
    renderV3();
  });

  window.runAssetDep = function (id) {
    const a = ledger.assets.find((x) => x.id === id);
    if (!a) return;
    const rem = Math.max(0, a.cost - a.accumDep);
    const monthly = Math.min(rem, Math.round((a.cost / a.months) * 100) / 100);
    if (monthly <= 0) return alert("Asset is fully depreciated.");
    if (!confirm(`Post 1 month depreciation of ${fmtKES(monthly)} for ${a.name}?`)) return;

    validateAndPostJE({
      date: todayStr(),
      memo: `Monthly Depreciation: ${a.name}`,
      entityId: ledger.entities[0].id,
      poolId: ledger.pools[0].id,
      lines: [
        { accountCode: "6200", debit: monthly, credit: 0 },
        { accountCode: "1510", debit: 0, credit: monthly }
      ]
    });
    a.accumDep += monthly;
    saveLedger(true);
    renderV3();
  };

  // 2. MERCH INVENTORY (WEIGHTED AVERAGE)
  document.getElementById("add-inv-btn").addEventListener("click", () => {
    const name = document.getElementById("inv-name").value.trim();
    const qty = Number(document.getElementById("inv-qty").value || 0);
    const cost = Number(document.getElementById("inv-cost").value || 0);
    if (!name || qty <= 0 || cost <= 0) return alert("Enter item, quantity, and total cost.");

    validateAndPostJE({
      date: todayStr(),
      memo: `Merch Restock: ${qty}x ${name}`,
      entityId: ledger.entities[0].id,
      poolId: ledger.pools[0].id,
      lines: [
        { accountCode: "1200", debit: cost, credit: 0 },
        { accountCode: "1010", debit: 0, credit: cost }
      ]
    });

    const existing = ledger.inventory.find((i) => i.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.totalValue += cost;
      existing.qty += qty;
    } else {
      ledger.inventory.unshift({ id: "INV-" + Date.now(), name, qty, totalValue: cost });
    }
    document.getElementById("inv-name").value = "";
    document.getElementById("inv-qty").value = "";
    document.getElementById("inv-cost").value = "";
    saveLedger(true);
    renderV3();
  });

  window.sellInventory = function (id) {
    const item = ledger.inventory.find((x) => x.id === id);
    if (!item || item.qty <= 0) return;
    const sellQty = Number(prompt(`Sell how many "${item.name}"? (In stock: ${item.qty}):`, "1"));
    if (!sellQty || sellQty <= 0 || sellQty > item.qty) return alert("Invalid quantity.");
    const unitCost = item.totalValue / item.qty;
    const cogs = Math.round(unitCost * sellQty * 100) / 100;
    const saleTotal = Number(prompt(`Total Sale Price collected (KSh) for ${sellQty}x ${item.name} (Unit cost: ${fmtKES(unitCost)}):`, Math.round(cogs * 1.5)));
    if (!saleTotal || saleTotal <= 0) return;

    validateAndPostJE({
      date: todayStr(),
      memo: `Merch Sale: ${sellQty}x ${item.name}`,
      entityId: ledger.entities[0].id,
      poolId: ledger.pools[0].id,
      lines: [
        { accountCode: "1010", debit: saleTotal, credit: 0 },
        { accountCode: "4030", debit: 0, credit: saleTotal },
        { accountCode: "5300", debit: cogs, credit: 0 },
        { accountCode: "1200", debit: 0, credit: cogs }
      ]
    });
    item.qty -= sellQty;
    item.totalValue = Math.max(0, item.totalValue - cogs);
    saveLedger(true);
    renderV3();
  };

  // 3. LOANS & PARTNER CAPITAL
  document.getElementById("add-loan-btn").addEventListener("click", () => {
    const lender = document.getElementById("ln-lender").value.trim();
    const principal = Number(document.getElementById("ln-amt").value || 0);
    const rate = Number(document.getElementById("ln-rate").value || 0);
    if (!lender || principal <= 0) return alert("Enter lender and principal.");

    validateAndPostJE({
      date: todayStr(),
      memo: `Loan Received: ${lender} (${rate}%)`,
      entityId: ledger.entities[0].id,
      poolId: ledger.pools[0].id,
      lines: [
        { accountCode: "1010", debit: principal, credit: 0 },
        { accountCode: "2100", debit: 0, credit: principal }
      ]
    });
    ledger.loans.unshift({ id: "LN-" + Date.now(), lender, principal, balance: principal, rate });
    document.getElementById("ln-lender").value = "";
    document.getElementById("ln-amt").value = "";
    saveLedger(true);
    renderV3();
  });

  window.repayLoan = function (id) {
    const l = ledger.loans.find((x) => x.id === id);
    if (!l || l.balance <= 0) return;
    const prin = Number(prompt(`Principal repaid to ${l.lender} (Bal: ${fmtKES(l.balance)}):`, Math.min(l.balance, 5000)));
    if (!prin || prin <= 0) return;
    const interest = Number(prompt("Interest portion (KSh, 0 if none):", "0") || 0);

    const lines = [
      { accountCode: "2100", debit: prin, credit: 0 },
      { accountCode: "1010", debit: 0, credit: prin + interest }
    ];
    if (interest > 0) lines.push({ accountCode: "6300", debit: interest, credit: 0 });
    validateAndPostJE({ date: todayStr(), memo: `Loan Repayment: ${l.lender}`, entityId: ledger.entities[0].id, poolId: ledger.pools[0].id, lines });
    l.balance = Math.max(0, l.balance - prin);
    saveLedger(true);
    renderV3();
  };

  document.getElementById("add-pt-btn").addEventListener("click", () => {
    const name = document.getElementById("pt-name").value.trim();
    const type = document.getElementById("pt-type").value;
    const amt = Number(document.getElementById("pt-amt").value || 0);
    if (!name || amt <= 0) return alert("Enter partner name and amount.");

    const lines = type === "INJECT"
      ? [{ accountCode: "1010", debit: amt, credit: 0 }, { accountCode: "3010", debit: 0, credit: amt }]
      : [{ accountCode: "3030", debit: amt, credit: 0 }, { accountCode: "1010", debit: 0, credit: amt }];

    validateAndPostJE({ date: todayStr(), memo: `Partner ${type === "INJECT" ? "Capital" : "Draw"}: ${name}`, entityId: ledger.entities[0].id, poolId: ledger.pools[0].id, lines });
    ledger.partnerLog.unshift({ name, type, amt, date: todayStr() });
    document.getElementById("pt-name").value = "";
    document.getElementById("pt-amt").value = "";
    saveLedger(true);
    renderV3();
  });

  // 4. MULTI-CURRENCY FX GAIN/LOSS
  document.getElementById("post-fx-btn").addEventListener("click", () => {
    const desc = document.getElementById("fx-desc").value.trim();
    const curr = document.getElementById("fx-curr").value;
    const fAmt = Number(document.getElementById("fx-foreign").value || 0);
    const bookRate = Number(document.getElementById("fx-book-rate").value || 0);
    const paidRate = Number(document.getElementById("fx-paid-rate").value || 0);
    if (!desc || fAmt <= 0 || bookRate <= 0 || paidRate <= 0) return alert("Fill all FX fields.");

    const bookedKES = Math.round(fAmt * bookRate * 100) / 100;
    const paidKES = Math.round(fAmt * paidRate * 100) / 100;
    const diff = Math.round((paidKES - bookedKES) * 100) / 100;

    const lines = [
      { accountCode: "5100", debit: bookedKES, credit: 0 },
      { accountCode: "1020", debit: 0, credit: paidKES }
    ];
    if (diff > 0) lines.push({ accountCode: "6350", debit: diff, credit: 0 }); // FX Loss
    if (diff < 0) lines.push({ accountCode: "4080", debit: 0, credit: Math.abs(diff) }); // FX Gain

    validateAndPostJE({ date: todayStr(), memo: `FX (${curr} ${fAmt}): ${desc}`, entityId: ledger.entities[0].id, poolId: ledger.pools[0].id, lines });
    ledger.fxLog.unshift({ desc, curr, fAmt, bookedKES, paidKES, diff, date: todayStr() });
    document.getElementById("fx-desc").value = "";
    saveLedger(true);
    renderV3();
  });

  // 5. KRA WHT & 2026 KENYA PAYROLL
  document.getElementById("post-wht-btn").addEventListener("click", () => {
    const vendor = document.getElementById("wht-vendor").value.trim();
    const gross = Number(document.getElementById("wht-gross").value || 0);
    const rate = Number(document.getElementById("wht-rate").value || 5);
    if (!vendor || gross <= 0) return alert("Enter contractor and gross fee.");

    const wht = Math.round((gross * rate) / 100);
    const net = gross - wht;
    validateAndPostJE({
      date: todayStr(),
      memo: `WHT Contractor (${rate}%): ${vendor}`,
      entityId: ledger.entities[0].id,
      poolId: ledger.pools[0].id,
      lines: [
        { accountCode: "5100", debit: gross, credit: 0 },
        { accountCode: "1010", debit: 0, credit: net },
        { accountCode: "2040", debit: 0, credit: wht }
      ]
    });
    document.getElementById("wht-vendor").value = "";
    document.getElementById("wht-gross").value = "";
    saveLedger(true);
    renderV3();
  });

  function calcKenyaPayroll2026(gross) {
    const nssf = Math.min(6480, Math.round(gross * 0.06));
    const shif = Math.max(300, Math.round(gross * 0.0275));
    const ahl = Math.round(gross * 0.015);
    const taxable = Math.max(0, gross - nssf - shif - ahl);

    let tax = 0;
    const b1 = Math.min(taxable, 24000); tax += b1 * 0.1;
    const b2 = Math.max(0, Math.min(taxable - 24000, 8333)); tax += b2 * 0.25;
    const b3 = Math.max(0, Math.min(taxable - 32333, 467667)); tax += b3 * 0.3;
    const b4 = Math.max(0, Math.min(taxable - 500000, 300000)); tax += b4 * 0.325;
    const b5 = Math.max(0, taxable - 800000); tax += b5 * 0.35;

    const paye = Math.max(0, Math.round(tax - 2400));
    const net = gross - nssf - shif - ahl - paye;
    const empCost = gross + nssf + ahl + 50; // Employer NSSF + AHL match + NITA 50
    const totalStat = paye + shif + (nssf * 2) + (ahl * 2) + 50;
    return { gross, nssf, shif, ahl, paye, net, empCost, totalStat };
  }

  document.getElementById("pay-gross").addEventListener("input", () => {
    const g = Number(document.getElementById("pay-gross").value || 0);
    if (g <= 0) return;
    const p = calcKenyaPayroll2026(g);
    document.getElementById("pay-preview").innerHTML = `
      <div class="je-line"><span>NSSF (6%, cap 6,480)</span><strong>${fmtKES(p.nssf)}</strong></div>
      <div class="je-line"><span>SHIF (2.75%, min 300)</span><strong>${fmtKES(p.shif)}</strong></div>
      <div class="je-line"><span>Housing Levy (1.5%)</span><strong>${fmtKES(p.ahl)}</strong></div>
      <div class="je-line"><span>PAYE (after 2,400 relief)</span><strong>${fmtKES(p.paye)}</strong></div>
      <div class="je-line je-dr"><span>Employee Net Pay</span><strong>${fmtKES(p.net)}</strong></div>
      <div class="je-line je-cr"><span>Total Employer Cost (+Match & NITA)</span><strong>${fmtKES(p.empCost)}</strong></div>`;
  });

  document.getElementById("post-pay-btn").addEventListener("click", () => {
    const emp = document.getElementById("pay-emp").value.trim();
    const g = Number(document.getElementById("pay-gross").value || 0);
    if (!emp || g <= 0) return alert("Enter employee name and gross pay.");
    const p = calcKenyaPayroll2026(g);

    validateAndPostJE({
      date: todayStr(),
      memo: `Payroll (${emp}): Gross ${fmtKES(g)}`,
      entityId: ledger.entities[0].id,
      poolId: ledger.pools[0].id,
      lines: [
        { accountCode: "6150", debit: p.empCost, credit: 0 },
        { accountCode: "1010", debit: 0, credit: p.net },
        { accountCode: "2040", debit: 0, credit: p.totalStat }
      ]
    });
    document.getElementById("pay-emp").value = "";
    document.getElementById("pay-gross").value = "";
    saveLedger(true);
    renderV3();
  });

  // RENDER v0.3 UI
  function renderV3() {
    ensureV3Data();

    document.getElementById("fa-list").innerHTML = ledger.assets.map((a) => `
      <div class="je-card">
        <div class="card-top" style="margin-bottom:4px;">
          <strong>${esc(a.name)}</strong>
          <button class="btn-mini" onclick="runAssetDep('${a.id}')">📉 Depreciate 1 Mo</button>
        </div>
        <div class="je-meta">
          <span class="tag">Cost: ${fmtKES(a.cost)}</span>
          <span class="tag">Accum Dep: ${fmtKES(a.accumDep)}</span>
          <span class="tag">NBV: ${fmtKES(a.cost - a.accumDep)}</span>
        </div>
      </div>`).join("") || `<div class="card muted">No fixed assets recorded yet.</div>`;

    document.getElementById("inv-list").innerHTML = ledger.inventory.map((i) => `
      <div class="je-card">
        <div class="card-top" style="margin-bottom:4px;">
          <strong>${esc(i.name)} (${i.qty} in stock)</strong>
          <button class="btn-mini ok" onclick="sellInventory('${i.id}')">Sell / Issue</button>
        </div>
        <div class="je-meta">
          <span class="tag">Value: ${fmtKES(i.totalValue)}</span>
          <span class="tag">Avg Unit: ${fmtKES(i.qty ? i.totalValue / i.qty : 0)}</span>
        </div>
      </div>`).join("") || `<div class="card muted">No merchandise inventory yet.</div>`;

    document.getElementById("loan-list").innerHTML = ledger.loans.map((l) => `
      <div class="je-card ${l.balance <= 0 ? "settled" : ""}">
        <div class="card-top" style="margin-bottom:4px;">
          <strong>${esc(l.lender)} (${l.rate}%)</strong>
          ${l.balance > 0 ? `<button class="btn-mini ok" onclick="repayLoan('${l.id}')">Repay</button>` : `<span class="badge ok">PAID</span>`}
        </div>
        <div class="je-meta"><span class="tag">Orig: ${fmtKES(l.principal)}</span><span class="tag">Bal: ${fmtKES(l.balance)}</span></div>
      </div>`).join("") || `<div class="card muted">No active loans.</div>`;

    const bal = computeBalances();
    document.getElementById("partner-summary").innerHTML = `
      <div class="card">
        <div class="list-row"><span>Total Partner Capital (3010)</span><strong>${fmtKES(bal["3010"] || 0)}</strong></div>
        <div class="list-row"><span>Total Owner Draws (3030)</span><strong>${fmtKES(bal["3030"] || 0)}</strong></div>
      </div>`;

    document.getElementById("fx-list").innerHTML = ledger.fxLog.map((f) => `
      <div class="je-card">
        <strong>${esc(f.desc)} (${f.curr} ${f.fAmt})</strong>
        <div class="je-meta">
          <span class="tag">Booked: ${fmtKES(f.bookedKES)}</span>
          <span class="tag">Paid: ${fmtKES(f.paidKES)}</span>
          <span class="tag">${f.diff >= 0 ? "FX Loss: " + fmtKES(f.diff) : "FX Gain: " + fmtKES(Math.abs(f.diff))}</span>
        </div>
      </div>`).join("");

    // KRA VAT 5M Tracker & eTIMS Audit
    const turnover = (bal["4010"] || 0) + (bal["4020"] || 0) + (bal["4030"] || 0) + (bal["4040"] || 0);
    const pct = Math.min(100, Math.round((turnover / 5000000) * 100));
    const missingEtims = ledger.entries.filter((e) => !e.etimsVerified && !e.isReversal && !e.reversedBy && e.lines.some((l) => l.accountCode.startsWith("5") || l.accountCode.startsWith("6"))).length;

    document.getElementById("kra-summary").innerHTML = `
      <div class="list-row"><span>Taxable Turnover vs KSh 5M VAT Limit</span><strong>${fmtKES(turnover)} (${pct}%)</strong></div>
      <div class="list-row"><span>Expenses Missing eTIMS (Non-Deductible)</span><strong class="warn-text">${missingEtims} entries</strong></div>
      <div class="list-row"><span>Total Taxes/Statutory Payable (2040)</span><strong>${fmtKES(bal["2040"] || 0)}</strong></div>`;
  }

  // Hook into existing renderAll so Books stays in sync
  const origRenderAll = window.renderAll;
  window.renderAll = function () {
    origRenderAll();
    renderV3();
  };
  renderV3();
})();
