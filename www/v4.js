// ================= v0.4: REPORTS, CPA EXPORT, RECEIPT SCANNER & AI CFO =================
(function initV4() {
  ledger.budgets = ledger.budgets || {};

  // Header Reports Button (self-contained view switch)
  document.getElementById("open-reports-btn")?.addEventListener("click", () => {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.getElementById("view-reports")?.classList.add("active");
    renderV4();
  });

  // Sub-tabs inside Reports
  document.querySelectorAll("#rep-subtabs .pill").forEach((p) => {
    p.addEventListener("click", () => {
      document.querySelectorAll("#rep-subtabs .pill").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll("#view-reports .ops-panel").forEach((x) => x.classList.remove("active"));
      p.classList.add("active");
      document.getElementById(p.dataset.rep)?.classList.add("active");
    });
  });

  // ================= 1. MULTIMODAL RECEIPT PHOTO SCANNER =================
  document.getElementById("receipt-photo-input")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!secrets.geminiKey) return alert("Paste your Gemini API key in Setup first.");

    const statusEl = document.getElementById("parse-status");
    statusEl.textContent = "Scanning receipt photo with Gemini Vision...";

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const base64 = ev.target.result.split(",")[1];
      const mimeType = file.type || "image/jpeg";
      const coaList = COA.map((a) => `${a.code}: ${a.name}`).join("\n");
      const prompt = `Extract accounting details from this receipt or supplier quote image.
CoA:\n${coaList}
Return ONLY raw JSON:
{"mpesaCode":"","direction":"OUT","amount":0,"fee":0,"date":"${todayStr()}","counterparty":"","memo":"","suggestedOffsetCode":"5200","hasEtims":false}`;

      let lastErr = "Vision models busy.";
      for (const model of GEMINI_MODELS) {
        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(secrets.geminiKey)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
                contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }]
              })
            }
          );
          const data = await res.json();
          if (res.ok) {
            const text = (data.candidates?.[0]?.content?.parts || [])
              .filter((p) => !p.thought && p.text)
              .map((p) => p.text)
              .join("");
            const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
            statusEl.textContent = "✓ Receipt scanned. Review draft below.";
            openDraftEditor(parsed);
            if (parsed.hasEtims) document.getElementById("draft-etims").checked = true;
            e.target.value = "";
            return;
          }
          lastErr = data.error?.message || `HTTP ${res.status}`;
        } catch (err) {
          lastErr = err.message;
        }
      }
      statusEl.textContent = "Receipt scan failed: " + lastErr;
      e.target.value = "";
    };
    reader.readAsDataURL(file);
  });

  // ================= 2. REAL-TIME P&L, BALANCE SHEET & CASH FLOW =================
  function renderFinancials() {
    const entF = document.getElementById("rep-entity")?.value || "all";
    const poolF = document.getElementById("rep-pool")?.value || "all";
    const filtered = ledger.entries.filter((je) => {
      if (entF !== "all" && je.entityId !== entF) return false;
      if (poolF !== "all" && je.poolId !== poolF) return false;
      return true;
    });
    const b = computeBalances(filtered);

    // P&L
    const grossRev = (b["4010"] || 0) + (b["4020"] || 0) + (b["4030"] || 0) + (b["4040"] || 0) + (b["4080"] || 0);
    const discounts = b["4090"] || 0;
    const netRev = grossRev - discounts;
    const cogs = (b["5100"] || 0) + (b["5200"] || 0) + (b["5300"] || 0);
    const grossProfit = netRev - cogs;
    const opex = (b["6100"] || 0) + (b["6120"] || 0) + (b["6150"] || 0) + (b["6200"] || 0) + (b["6300"] || 0) + (b["6350"] || 0);
    const netProfit = grossProfit - opex;
    const margin = netRev > 0 ? Math.round((netProfit / netRev) * 100) : 0;

    document.getElementById("rep-pnl-box").innerHTML = `
      <div class="list-row"><span>Gross Revenue</span><strong>${fmtKES(grossRev)}</strong></div>
      <div class="list-row"><span>Less: Discounts (4090)</span><span>(${fmtKES(discounts)})</span></div>
      <div class="list-row"><span>Direct Trip & Merch COGS</span><span>(${fmtKES(cogs)})</span></div>
      <div class="list-row"><strong>Gross Profit</strong><strong>${fmtKES(grossProfit)}</strong></div>
      <div class="list-row"><span>Operating Expenses & Fees</span><span>(${fmtKES(opex)})</span></div>
      <div class="list-row"><strong>Net Profit (${margin}% Margin)</strong><strong style="color:${netProfit >= 0 ? "var(--accent)" : "var(--danger)"}">${fmtKES(netProfit)}</strong></div>`;

    // Balance Sheet
    const cash = (b["1010"] || 0) + (b["1020"] || 0) + (b["1030"] || 0);
    const inv = b["1200"] || 0;
    const faNet = (b["1500"] || 0) - (b["1510"] || 0);
    const totalAssets = cash + (b["1100"] || 0) + inv + faNet;
    const totalLiab = (b["2010"] || 0) + (b["2020"] || 0) + (b["2030"] || 0) + (b["2040"] || 0) + (b["2050"] || 0) + (b["2100"] || 0);
    const equity = (b["3010"] || 0) + (b["3020"] || 0) + (b["3025"] || 0) - (b["3030"] || 0) + netProfit;

    document.getElementById("rep-bs-box").innerHTML = `
      <div class="list-row"><span>Cash & Trail Floats</span><strong>${fmtKES(cash)}</strong></div>
      <div class="list-row"><span>Inventory + Net Fixed Assets</span><strong>${fmtKES(inv + faNet)}</strong></div>
      <div class="list-row"><strong>Total Assets</strong><strong>${fmtKES(totalAssets)}</strong></div>
      <div class="list-row"><span>Deferred Deposits & Vouchers</span><span>${fmtKES((b["2010"] || 0) + (b["2050"] || 0))}</span></div>
      <div class="list-row"><span>A/P, Partners, Taxes & Loans</span><span>${fmtKES((b["2020"] || 0) + (b["2030"] || 0) + (b["2040"] || 0) + (b["2100"] || 0))}</span></div>
      <div class="list-row"><strong>Total Liabilities + Equity</strong><strong>${fmtKES(totalLiab + equity)}</strong></div>`;

    // Cash Flow (Direct summary)
    const investing = -(b["1500"] || 0);
    const financing = (b["2100"] || 0) + (b["3010"] || 0) - (b["3030"] || 0);
    const operating = cash - investing - financing;

    document.getElementById("rep-cf-box").innerHTML = `
      <div class="list-row"><span>Operating Cash Flow</span><strong>${fmtKES(operating)}</strong></div>
      <div class="list-row"><span>Investing Cash Flow (CapEx)</span><strong>${fmtKES(investing)}</strong></div>
      <div class="list-row"><span>Financing (Loans / Capital / Draws)</span><strong>${fmtKES(financing)}</strong></div>
      <div class="list-row"><strong>Net Cash Position</strong><strong style="color:var(--accent)">${fmtKES(cash)}</strong></div>`;
  }

  // ================= 3. BUDGET VS ACTUAL & AGING =================
  document.getElementById("save-budget-btn")?.addEventListener("click", () => {
    const pid = document.getElementById("var-pool-select").value;
    ledger.budgets = ledger.budgets || {};
    ledger.budgets[pid] = {
      fixed: Number(document.getElementById("var-bud-fixed").value || 0),
      variable: Number(document.getElementById("var-bud-var").value || 0)
    };
    saveLedger(true);
    renderVarianceAndAging();
  });

  function renderVarianceAndAging() {
    const pid = document.getElementById("var-pool-select")?.value;
    const bud = (ledger.budgets || {})[pid] || { fixed: 0, variable: 0 };
    document.getElementById("var-bud-fixed").value = bud.fixed || "";
    document.getElementById("var-bud-var").value = bud.variable || "";

    const b = computeBalances(ledger.entries.filter((e) => e.poolId === pid));
    const actFix = b["5100"] || 0;
    const actVar = b["5200"] || 0;
    const varFix = bud.fixed - actFix;
    const varVar = bud.variable - actVar;

    document.getElementById("var-report-box").innerHTML = `
      <div class="list-row"><span>Fixed COGS (5100)</span><span>Act: ${fmtKES(actFix)} | Var: <strong style="color:${varFix >= 0 ? "var(--accent)" : "var(--danger)"}">${fmtKES(varFix)}</strong></span></div>
      <div class="list-row"><span>Variable COGS (5200)</span><span>Act: ${fmtKES(actVar)} | Var: <strong style="color:${varVar >= 0 ? "var(--accent)" : "var(--danger)"}">${fmtKES(varVar)}</strong></span></div>`;

    // Aging (0-7, 8-30, 30+ days)
    const now = Date.now();
    const daysSince = (d) => Math.max(0, Math.floor((now - new Date(d || todayStr()).getTime()) / 86400000));
    const ar = { b1: 0, b2: 0, b3: 0 }, ap = { b1: 0, b2: 0, b3: 0 };

    (ledger.bookings || []).filter((x) => x.status === "ACTIVE").forEach((x) => {
      const bal = Math.max(0, x.ticketPrice - x.discount - x.paid);
      const d = daysSince(Number(x.id.split("-")[1]) || now);
      if (d <= 7) ar.b1 += bal; else if (d <= 30) ar.b2 += bal; else ar.b3 += bal;
    });
    (ledger.payables || []).filter((x) => x.status === "OPEN").forEach((x) => {
      const bal = Math.max(0, x.totalAmount - x.paidAmount);
      const d = daysSince(x.dueDate);
      if (d <= 7) ap.b1 += bal; else if (d <= 30) ap.b2 += bal; else ap.b3 += bal;
    });

    document.getElementById("aging-box").innerHTML = `
      <div class="list-row"><strong>Client A/R (0-7d / 8-30d / 30+d)</strong><span>${fmtKES(ar.b1)} / ${fmtKES(ar.b2)} / ${fmtKES(ar.b3)}</span></div>
      <div class="list-row"><strong>Supplier A/P (0-7d / 8-30d / 30+d)</strong><span class="warn-text">${fmtKES(ap.b1)} / ${fmtKES(ap.b2)} / ${fmtKES(ap.b3)}</span></div>`;
  }

  // ================= 4. CPA CSV EXPORTS (Android Share + Desktop Download) =================
    window.nativeExportFile = async function (filename, content, statusEl) {
    try { await navigator.clipboard.writeText(content); } catch {}

    const { Filesystem, Share } = window.Capacitor?.Plugins || {};
    if (Filesystem) {
      try {
        const saved = await Filesystem.writeFile({
          path: filename,
          data: content,
          directory: "DOCUMENTS",
          encoding: "utf8"
        });
        if (statusEl) statusEl.textContent = `✓ Saved to Documents/${filename}`;
        if (Share) {
          await Share.share({ title: filename, url: saved.uri });
        }
        return;
      } catch (err) {
        if (statusEl) statusEl.textContent = "Export error: " + err.message;
        return;
      }
    }
    if (statusEl) statusEl.textContent = "✓ Copied to clipboard (paste into a .json or .csv file).";
  };

  async function downloadCSV(filename, rows) {
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const statusEl = document.getElementById("cpa-exp-status");
    return window.nativeExportFile(filename, csv, statusEl);
  }




  document.getElementById("exp-tb-btn")?.addEventListener("click", () => {
    const b = computeBalances();
    const rows = [["Account Code", "Account Name", "Type", "Debit (KES)", "Credit (KES)"]];
    COA.forEach((a) => {
      const val = b[a.code] || 0;
      if (Math.abs(val) < 0.01) return;
      const dr = (a.normal === "DR" && val >= 0) || (a.normal === "CR" && val < 0) ? Math.abs(val) : 0;
      const cr = dr === 0 ? Math.abs(val) : 0;
      rows.push([a.code, a.name, a.type, dr.toFixed(2), cr.toFixed(2)]);
    });
    downloadCSV(`Talani_Trial_Balance_${todayStr()}.csv`, rows);
  });

  document.getElementById("exp-gl-btn")?.addEventListener("click", () => {
    const rows = [["JE ID", "Date", "M-Pesa Code", "Entity", "Trip Pool", "Memo", "eTIMS", "Account", "Debit", "Credit"]];
    ledger.entries.forEach((je) => {
      const ent = ledger.entities.find((e) => e.id === je.entityId)?.name || "";
      const pool = ledger.pools.find((p) => p.id === je.poolId)?.name || "";
      je.lines.forEach((l) => {
        const a = getAcc(l.accountCode);
        rows.push([je.id, je.date, je.mpesaCode, ent, pool, je.memo, je.etimsVerified ? "YES" : "NO", `${a.code} ${a.name}`, l.debit.toFixed(2), l.credit.toFixed(2)]);
      });
    });
    downloadCSV(`Talani_General_Ledger_${todayStr()}.csv`, rows);
  });

  // ================= 5. CONVERSATIONAL AI CFO =================
  document.getElementById("cfo-send-btn")?.addEventListener("click", async () => {
    const q = document.getElementById("cfo-input").value.trim();
    if (!q) return;
    if (!secrets.geminiKey) return alert("Paste your Gemini API key in Setup first.");

    const box = document.getElementById("cfo-chat-box");
    box.innerHTML += `<div style="margin:6px 0;color:var(--blue)"><strong>You:</strong> ${esc(q)}</div>`;
    document.getElementById("cfo-input").value = "";

    const b = computeBalances();
    const context = {
      date: todayStr(),
      accountBalances: b,
      entities: ledger.entities,
      pools: ledger.pools.map((p) => ({ name: p.name, status: p.status, balances: computeBalances(ledger.entries.filter((e) => e.poolId === p.id)) })),
      openAR: (ledger.bookings || []).filter((x) => x.status === "ACTIVE").reduce((s, x) => s + Math.max(0, x.ticketPrice - x.discount - x.paid), 0),
      openAP: (ledger.payables || []).filter((x) => x.status === "OPEN").reduce((s, x) => s + Math.max(0, x.totalAmount - x.paidAmount), 0),
      totalEntries: ledger.entries.length
    };

    const replyEl = document.createElement("div");
    replyEl.style.margin = "6px 0";
    replyEl.textContent = "AI CFO analyzing live ledger...";
    box.appendChild(replyEl);
    box.scrollTop = box.scrollHeight;

    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(secrets.geminiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: "You are the CFO for Talani Adventures (Kenya). Answer concisely using the live KES accounting data provided. Highlight cash risks, margins, or eTIMS gaps." }] },
              generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
              contents: [{ role: "user", parts: [{ text: `LIVE DATA: ${JSON.stringify(context)}\n\nQUESTION: ${q}` }] }]
            })
          }
        );
        const data = await res.json();
        if (res.ok) {
          const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
          replyEl.innerHTML = `<strong style="color:var(--accent)">AI CFO:</strong> ${esc(text).replace(/\n/g, "<br>")}`;
          box.scrollTop = box.scrollHeight;
          return;
        }
      } catch {}
    }
    replyEl.textContent = "AI CFO error: Could not reach Gemini.";
  });

  // ================= SYNC DROPDOWNS & RENDER =================
  function renderV4() {
    const entOpts = `<option value="all">All Entities</option>` + ledger.entities.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
    const poolOpts = `<option value="all">All Trip Pools</option>` + ledger.pools.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    const purePools = ledger.pools.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");

    const re = document.getElementById("rep-entity");
    const rp = document.getElementById("rep-pool");
    const vp = document.getElementById("var-pool-select");
    if (re && !re.options.length) re.innerHTML = entOpts;
    if (rp && !rp.options.length) rp.innerHTML = poolOpts;
    if (vp && !vp.options.length) vp.innerHTML = purePools;

    renderFinancials();
    renderVarianceAndAging();
  }

  ["rep-entity", "rep-pool"].forEach((id) => document.getElementById(id)?.addEventListener("change", renderFinancials));
  document.getElementById("var-pool-select")?.addEventListener("change", renderVarianceAndAging);

  const prevRenderAll = window.renderAll;
  window.renderAll = function () {
    prevRenderAll();
    renderV4();
  };
  renderV4();
})();
