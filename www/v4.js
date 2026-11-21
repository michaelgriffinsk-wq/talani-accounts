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
      renderV4();
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

    const pnlEl = document.getElementById("rep-pnl-box");
    if (pnlEl) {
      pnlEl.innerHTML = `
        <div class="list-row"><span>Gross Revenue</span><strong>${fmtKES(grossRev)}</strong></div>
        <div class="list-row"><span>Less: Discounts (4090)</span><span>(${fmtKES(discounts)})</span></div>
        <div class="list-row"><span>Direct Trip & Merch COGS</span><span>(${fmtKES(cogs)})</span></div>
        <div class="list-row"><strong>Gross Profit</strong><strong>${fmtKES(grossProfit)}</strong></div>
        <div class="list-row"><span>Operating Expenses & Fees</span><span>(${fmtKES(opex)})</span></div>
        <div class="list-row"><strong>Net Profit (${margin}% Margin)</strong><strong style="color:${netProfit >= 0 ? "var(--accent)" : "var(--danger)"}">${fmtKES(netProfit)}</strong></div>`;
    }

    // Balance Sheet
    const cash = (b["1010"] || 0) + (b["1020"] || 0) + (b["1030"] || 0);
    const inv = b["1200"] || 0;
    const faNet = (b["1500"] || 0) - (b["1510"] || 0);
    const totalAssets = cash + (b["1100"] || 0) + inv + faNet;
    const totalLiab = (b["2010"] || 0) + (b["2020"] || 0) + (b["2030"] || 0) + (b["2040"] || 0) + (b["2050"] || 0) + (b["2100"] || 0);
    const equity = (b["3010"] || 0) + (b["3020"] || 0) + (b["3025"] || 0) - (b["3030"] || 0) + netProfit;

    const bsEl = document.getElementById("rep-bs-box");
    if (bsEl) {
      bsEl.innerHTML = `
        <div class="list-row"><span>Cash & Trail Floats</span><strong>${fmtKES(cash)}</strong></div>
        <div class="list-row"><span>Accounts Receivable (A/R)</span><strong>${fmtKES(b["1100"] || 0)}</strong></div>
        <div class="list-row"><span>Inventory + Net Fixed Assets</span><strong>${fmtKES(inv + faNet)}</strong></div>
        <div class="list-row"><strong>Total Assets</strong><strong>${fmtKES(totalAssets)}</strong></div>
        <div class="list-row"><span>Deferred Deposits & Vouchers</span><span>${fmtKES((b["2010"] || 0) + (b["2050"] || 0))}</span></div>
        <div class="list-row"><span>A/P, Partners, Taxes & Loans</span><span>${fmtKES((b["2020"] || 0) + (b["2030"] || 0) + (b["2040"] || 0) + (b["2100"] || 0))}</span></div>
        <div class="list-row"><strong>Total Liabilities + Equity</strong><strong>${fmtKES(totalLiab + equity)}</strong></div>`;
    }

    // Cash Flow (Direct summary)
    const investing = -(b["1500"] || 0);
    const financing = (b["2100"] || 0) + (b["3010"] || 0) - (b["3030"] || 0);
    const operating = cash - investing - financing;

    const cfEl = document.getElementById("rep-cf-box");
    if (cfEl) {
      cfEl.innerHTML = `
        <div class="list-row"><span>Operating Cash Flow</span><strong>${fmtKES(operating)}</strong></div>
        <div class="list-row"><span>Investing Cash Flow (CapEx)</span><strong>${fmtKES(investing)}</strong></div>
        <div class="list-row"><span>Financing (Loans / Capital / Draws)</span><strong>${fmtKES(financing)}</strong></div>
        <div class="list-row"><strong>Net Cash Position</strong><strong style="color:var(--accent)">${fmtKES(cash)}</strong></div>`;
    }
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
    const fixInp = document.getElementById("var-bud-fixed");
    const varInp = document.getElementById("var-bud-var");
    if (fixInp) fixInp.value = bud.fixed || "";
    if (varInp) varInp.value = bud.variable || "";

    const b = computeBalances(ledger.entries.filter((e) => e.poolId === pid));
    const actFix = b["5100"] || 0;
    const actVar = b["5200"] || 0;
    const varFix = bud.fixed - actFix;
    const varVar = bud.variable - actVar;

    const varBox = document.getElementById("var-report-box");
    if (varBox) {
      varBox.innerHTML = `
        <div class="list-row"><span>Fixed COGS (5100)</span><span>Act: ${fmtKES(actFix)} | Var: <strong style="color:${varFix >= 0 ? "var(--accent)" : "var(--danger)"}">${fmtKES(varFix)}</strong></span></div>
        <div class="list-row"><span>Variable COGS (5200)</span><span>Act: ${fmtKES(actVar)} | Var: <strong style="color:${varVar >= 0 ? "var(--accent)" : "var(--danger)"}">${fmtKES(varVar)}</strong></span></div>`;
    }

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

    const agingBox = document.getElementById("aging-box");
    if (agingBox) {
      agingBox.innerHTML = `
        <div class="list-row"><strong>Client A/R (0-7d / 8-30d / 30+d)</strong><span>${fmtKES(ar.b1)} / ${fmtKES(ar.b2)} / ${fmtKES(ar.b3)}</span></div>
        <div class="list-row"><strong>Supplier A/P (0-7d / 8-30d / 30+d)</strong><span class="warn-text">${fmtKES(ap.b1)} / ${fmtKES(ap.b2)} / ${fmtKES(ap.b3)}</span></div>`;
    }
  }

  function renderV4() {
    const repEnt = document.getElementById("rep-entity");
    const repPool = document.getElementById("rep-pool");
    const varPool = document.getElementById("var-pool-select");

    if (repEnt) {
      const prev = repEnt.value;
      repEnt.innerHTML = `<option value="all">All Subsidiaries / Brands</option>` +
        (ledger.entities || []).map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
      if (prev && (prev === "all" || ledger.entities.some((e) => e.id === prev))) repEnt.value = prev;
    }
    if (repPool) {
      const prev = repPool.value;
      repPool.innerHTML = `<option value="all">All Trip & Project Pools</option>` +
        (ledger.pools || []).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
      if (prev && (prev === "all" || ledger.pools.some((p) => p.id === prev))) repPool.value = prev;
    }
    if (varPool) {
      const prev = varPool.value;
      varPool.innerHTML = (ledger.pools || [])
        .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
      if (prev && ledger.pools.some((p) => p.id === prev)) varPool.value = prev;
    }

    renderFinancials();
    renderVarianceAndAging();
  }

  document.getElementById("rep-entity")?.addEventListener("change", renderFinancials);
  document.getElementById("rep-pool")?.addEventListener("change", renderFinancials);
  document.getElementById("var-pool-select")?.addEventListener("change", renderVarianceAndAging);

  // ================= 4. CPA CSV & VAULT EXPORTS (Android Share + Desktop Download) =================
  window.nativeExportFile = async function (filename, content, statusEl) {
    try { await navigator.clipboard.writeText(content); } catch {}

    const { Filesystem, Share } = window.Capacitor?.Plugins || {};
    if (Filesystem) {
      try {
        const saved = await Filesystem.writeFile({
          path: filename,
          data: content,
          directory: "CACHE",
          encoding: "utf8"
        });
        if (statusEl) statusEl.textContent = `✓ Ready: ${filename}`;
        if (Share) {
          await Share.share({ title: filename, text: filename, url: saved.uri, dialogTitle: `Save or Send ${filename}` });
        }
        return;
      } catch (err) {
        if (statusEl) statusEl.textContent = "Export error: " + err.message;
        return;
      }
    }

    // Standard browser / desktop download fallback
    try {
      const mime = filename.endsWith(".json") ? "application/json" : "text/csv;charset=utf-8;";
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      if (statusEl) statusEl.textContent = `✓ Downloaded ${filename}`;
    } catch {
      if (statusEl) statusEl.textContent = "✓ Copied to clipboard.";
    }
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

  // Override Export Vault button so Android WebView opens native Share/Save sheet cleanly
  const oldExportBtn = document.getElementById("export-vault-btn");
  if (oldExportBtn) {
    const newExportBtn = oldExportBtn.cloneNode(true);
    oldExportBtn.parentNode.replaceChild(newExportBtn, oldExportBtn);
    newExportBtn.addEventListener("click", () => {
      const statusEl = document.getElementById("vault-status");
      const filename = `Talani_Vault_${todayStr()}.json`;
      window.nativeExportFile(filename, JSON.stringify(ledger, null, 2), statusEl);
    });
  }

  // ================= 5. CONVERSATIONAL AI CFO (MULTI-THREAD + MARKDOWN) =================
  const CFO_KEY = "talani_cfo_chats_v1";
  let cfoStore = (() => {
    try { return JSON.parse(localStorage.getItem(CFO_KEY)) || { activeId: null, threads: [] }; }
    catch { return { activeId: null, threads: [] }; }
  })();

  function saveCfoStore() { localStorage.setItem(CFO_KEY, JSON.stringify(cfoStore)); }

  function createCfoThread() {
    const t = { id: "cfo_" + Date.now(), title: "New CFO Chat", createdAt: todayStr(), messages: [] };
    cfoStore.threads.unshift(t);
    cfoStore.activeId = t.id;
    saveCfoStore();
    renderCfoUI();
    return t;
  }

  function getActiveThread() {
    let t = cfoStore.threads.find((x) => x.id === cfoStore.activeId);
    if (!t) t = cfoStore.threads[0] || createCfoThread();
    cfoStore.activeId = t.id;
    return t;
  }

  function renderMarkdown(raw) {
    const safe = esc(raw || "");
    const lines = safe.split("\n");
    let html = "", inUl = false, inOl = false, inTable = false;

    const closeLists = () => {
      if (inUl) { html += "</ul>"; inUl = false; }
      if (inOl) { html += "</ol>"; inOl = false; }
      if (inTable) { html += "</tbody></table>"; inTable = false; }
    };
    const inline = (s) => s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) { closeLists(); continue; }

      if (line.startsWith("|") && line.endsWith("|")) {
        if (/^\|[\s\-:|]+\|$/.test(line)) continue;
        const cells = line.slice(1, -1).split("|").map((c) => inline(c.trim()));
        if (!inTable) {
          closeLists();
          inTable = true;
          html += `<table><thead><tr>${cells.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
        } else {
          html += `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
        }
        continue;
      }

      if (inTable) closeLists();

      if (line.startsWith("### ")) { closeLists(); html += `<h4>${inline(line.slice(4))}</h4>`; }
      else if (line.startsWith("## ")) { closeLists(); html += `<h3>${inline(line.slice(3))}</h3>`; }
      else if (/^[-*]\s+/.test(line)) {
        if (inOl) { html += "</ol>"; inOl = false; }
        if (!inUl) { html += "<ul>"; inUl = true; }
        html += `<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`;
      } else if (/^\d+\.\s+/.test(line)) {
        if (inUl) { html += "</ul>"; inUl = false; }
        if (!inOl) { html += "<ol>"; inOl = true; }
        html += `<li>${inline(line.replace(/^\d+\.\s+/, ""))}</li>`;
      } else {
        closeLists();
        html += `<p>${inline(line)}</p>`;
      }
    }
    closeLists();
    return html;
  }

  function renderCfoUI() {
    const sel = document.getElementById("cfo-thread-select");
    const box = document.getElementById("cfo-chat-box");
    if (!sel || !box) return;

    const active = getActiveThread();
    sel.innerHTML = cfoStore.threads
      .map((t) => `<option value="${t.id}" ${t.id === active.id ? "selected" : ""}>💬 ${esc(t.title)} (${t.createdAt})</option>`)
      .join("");

    if (!active.messages.length) {
      box.innerHTML = `<div class="cfo-empty">
        <strong>🤖 Talani AI CFO</strong><br/>
        Ask about free cash, trip margins, unpaid balances, or KRA eTIMS exposure.<br/><br/>
        <em>Try: "Break down Gatamaiyu Expedition profit vs. unpaid balances in a table."</em>
      </div>`;
      return;
    }

    box.innerHTML = active.messages.map((m) =>
      m.role === "user"
        ? `<div class="cfo-msg user">${esc(m.text).replace(/\n/g, "<br>")}</div>`
        : `<div class="cfo-msg model"><div class="cfo-role">🤖 AI CFO</div>${renderMarkdown(m.text)}</div>`
    ).join("");
    box.scrollTop = box.scrollHeight;
  }

  document.getElementById("cfo-thread-select")?.addEventListener("change", (e) => {
    cfoStore.activeId = e.target.value;
    saveCfoStore();
    renderCfoUI();
  });

  document.getElementById("cfo-new-btn")?.addEventListener("click", () => createCfoThread());

  document.getElementById("cfo-del-btn")?.addEventListener("click", () => {
    const active = getActiveThread();
    if (!confirm(`Delete chat "${active.title}"?`)) return;
    cfoStore.threads = cfoStore.threads.filter((t) => t.id !== active.id);
    cfoStore.activeId = cfoStore.threads[0]?.id || null;
    saveCfoStore();
    renderCfoUI();
  });

  async function sendCfoMessage() {
    const input = document.getElementById("cfo-input");
    const q = input.value.trim();
    if (!q) return;
    if (!secrets.geminiKey) return alert("Paste your Gemini API key in Setup first.");

    const thread = getActiveThread();
    if (!thread.messages.length) {
      thread.title = q.length > 34 ? q.slice(0, 34) + "…" : q;
    }
    thread.messages.push({ role: "user", text: q });
    input.value = "";
    saveCfoStore();
    renderCfoUI();

    const box = document.getElementById("cfo-chat-box");
    const typingEl = document.createElement("div");
    typingEl.className = "cfo-msg model";
    typingEl.innerHTML = `<div class="cfo-role">🤖 AI CFO</div><span class="muted">Analyzing live ledger...</span>`;
    box.appendChild(typingEl);
    box.scrollTop = box.scrollHeight;

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

    const contents = thread.messages.slice(-14).map((m) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.text }]
    }));

    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(secrets.geminiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              system_instruction: {
                parts: [{
                  text: `You are the AI CFO for Talani Adventures (Kenya). Use clean Markdown (headings, bold figures, bullet points, and short tables when helpful). Base every number strictly on this LIVE LEDGER SNAPSHOT:\n${JSON.stringify(context)}`
                }]
              },
              generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
              contents
            })
          }
        );
        const data = await res.json();
        if (res.ok) {
          const text = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join("");
          thread.messages.push({ role: "model", text });
          saveCfoStore();
          renderCfoUI();
          return;
        }
      } catch {}
    }
    typingEl.innerHTML = `<div class="cfo-role">🤖 AI CFO</div><span class="warn-text">Could not reach Gemini. Check your connection or API key.</span>`;
  }

  document.getElementById("cfo-send-btn")?.addEventListener("click", sendCfoMessage);
  document.getElementById("cfo-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendCfoMessage();
  });
  renderCfoUI();

  // ================= 6. SHOW UNPAID CLIENT BALANCES =================
  document.getElementById("show-owed-btn")?.addEventListener("click", () => {
    const box = document.getElementById("ar-owed-box");
    if (!box) return;
    box.classList.toggle("hidden");
    if (box.classList.contains("hidden")) return;

    const unpaid = (ledger.bookings || [])
      .filter((b) => b.status === "ACTIVE")
      .map((b) => ({
        ...b,
        netPrice: b.ticketPrice - (b.discount || 0),
        owed: Math.max(0, b.ticketPrice - (b.discount || 0) - (b.paid || 0))
      }))
      .filter((b) => b.owed > 0);

    if (!unpaid.length) {
      box.innerHTML = `<div class="muted">✓ All active client bookings are fully paid.</div>`;
      return;
    }

    const totalOwed = unpaid.reduce((s, b) => s + b.owed, 0);
    box.innerHTML = `
      <div class="card-top">
        <h3>Still Owed (${unpaid.length} Clients)</h3>
        <strong class="warn-text">${fmtKES(totalOwed)}</strong>
      </div>
      ${unpaid.map((b) => `
        <div class="list-row">
          <div>
            <strong>${esc(b.clientName)}</strong>
            <div class="muted small">Paid ${fmtKES(b.paid)} of ${fmtKES(b.netPrice)}</div>
          </div>
          <div style="text-align:right;">
            <strong class="warn-text">${fmtKES(b.owed)}</strong><br/>
            <button class="btn-mini copy-rem-btn" data-name="${esc(b.clientName)}" data-owed="${b.owed}">Copy Reminder</button>
          </div>
        </div>
      `).join("")}`;

    box.querySelectorAll(".copy-rem-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const msg = `Hi ${btn.dataset.name}, friendly reminder that your remaining balance for the upcoming Talani trip is KSh ${Number(btn.dataset.owed).toLocaleString()}.`;
        try { await navigator.clipboard.writeText(msg); } catch {}
        btn.textContent = "✓ Copied";
      });
    });
  });

  // ================= 7. AI PARSER -> CLIENT A/R BRIDGE =================
  function refreshDraftArBridge() {
    const bridge = document.getElementById("draft-ar-bridge");
    const offsetAcc = document.getElementById("draft-offset-acc")?.value;
    const modeSel = document.getElementById("draft-ar-mode");
    const newFields = document.getElementById("draft-ar-new-fields");
    if (!bridge || !modeSel) return;

    const isClientDeposit = offsetAcc === "2010" || offsetAcc === "1100";
    bridge.classList.toggle("hidden", !isClientDeposit);
    if (!isClientDeposit) return;

    const unpaidOpts = (ledger.bookings || [])
      .filter((b) => b.status === "ACTIVE")
      .map((b) => {
        const owed = Math.max(0, b.ticketPrice - (b.discount || 0) - (b.paid || 0));
        return owed > 0 ? `<option value="${b.id}">Apply to: ${esc(b.clientName)} (Owes ${fmtKES(owed)})</option>` : "";
      })
      .join("");

    modeSel.innerHTML = `
      <option value="none">Do not link to Client A/R</option>
      <option value="new">+ Create New Client Booking</option>
      ${unpaidOpts}`;

    newFields.classList.add("hidden");
    const memoVal = document.getElementById("draft-memo")?.value || "";
    const nameInput = document.getElementById("draft-ar-name");
    if (nameInput && !nameInput.value) nameInput.value = memoVal;
  }

  document.getElementById("draft-offset-acc")?.addEventListener("change", refreshDraftArBridge);
  document.getElementById("draft-ar-mode")?.addEventListener("change", (e) => {
    document.getElementById("draft-ar-new-fields")?.classList.toggle("hidden", e.target.value !== "new");
  });

  const draftCardEl = document.getElementById("draft-card");
  if (draftCardEl) {
    new MutationObserver(() => {
      if (!draftCardEl.classList.contains("hidden")) refreshDraftArBridge();
    }).observe(draftCardEl, { attributes: true, attributeFilter: ["class"] });
  }

  document.getElementById("post-draft-btn")?.addEventListener("click", () => {
    const bridge = document.getElementById("draft-ar-bridge");
    if (!bridge || bridge.classList.contains("hidden")) return;

    const mode = document.getElementById("draft-ar-mode")?.value;
    const amount = Number(document.getElementById("draft-amount")?.value || 0);
    if (!mode || mode === "none" || amount <= 0) return;

    ledger.bookings = ledger.bookings || [];
    if (mode === "new") {
      const clientName = (document.getElementById("draft-ar-name")?.value || document.getElementById("draft-memo")?.value || "Client").trim();
      const ticketPrice = Number(document.getElementById("draft-ar-price")?.value || amount);
      const discount = Number(document.getElementById("draft-ar-disc")?.value || 0);
      ledger.bookings.push({
        id: "bk-" + Date.now(),
        entityId: document.getElementById("draft-entity").value,
        poolId: document.getElementById("draft-pool").value,
        clientName,
        ticketPrice,
        discount,
        paid: amount,
        isAgency: false,
        status: "ACTIVE"
      });
    } else {
      const existing = ledger.bookings.find((b) => b.id === mode);
      if (existing) existing.paid = (existing.paid || 0) + amount;
    }
    document.getElementById("draft-ar-name").value = "";
    document.getElementById("draft-ar-price").value = "";
  }, true);

  // ================= 8. TRIP ACCOUNTS (BUDGET, BREAK-EVEN & LIVE TRACKER) =================
  const DEFAULT_TRIP_BUDGET = () => ({
    fixed: [
      { id: "fx_bus", name: "Transport / Bus Hire", amount: 30000, billed: false },
      { id: "fx_guide", name: "Guide Costs", amount: 6000, billed: false },
      { id: "fx_medic", name: "Emergency Response / Medic", amount: 5000, billed: false },
      { id: "fx_float", name: "Floating Fees & Miscellaneous", amount: 3000, billed: false },
      { id: "fx_emerg", name: "Emergency Fund / Contingency", amount: 5000, billed: false },
      { id: "fx_mkt", name: "Marketing / Ads & Content", amount: 2000, billed: false },
      { id: "fx_mpesa", name: "M-Pesa Transaction Fee Buffer", amount: 1000, billed: false }
    ],
    variable: [
      { id: "vr_entry", name: "Park / Forest Entry Fees", amount: 300 },
      { id: "vr_food", name: "Snacks, Meals & Water", amount: 500 }
    ],
    bePax: 18,
    staffPax: 4,
    maxCap: 26,
    ticketPrice: 3000
  });

  function getTripBudget(poolId) {
    ledger.tripBudgets = ledger.tripBudgets || {};
    if (!ledger.tripBudgets[poolId]) {
      ledger.tripBudgets[poolId] = DEFAULT_TRIP_BUDGET();
    }
    return ledger.tripBudgets[poolId];
  }

  function renderTripAccounts() {
    const sel = document.getElementById("ta-pool-select");
    if (!sel) return;

    const prev = sel.value;
    sel.innerHTML = ledger.pools.map((p) => `<option value="${p.id}">${esc(p.name)}${p.status === "CLOSED" ? " [LOCKED]" : ""}</option>`).join("");
    if (prev && ledger.pools.some((p) => p.id === prev)) sel.value = prev;
    const poolId = sel.value;
    if (!poolId) return;

    const tb = getTripBudget(poolId);

    const poolEntries = ledger.entries.filter((e) => e.poolId === poolId);
    const pb = computeBalances(poolEntries);
    const custPaid = (pb["2010"] || 0) + (pb["4010"] || 0) + (pb["4020"] || 0) + (pb["4040"] || 0);
    const custOwed = (ledger.bookings || [])
      .filter((b) => b.poolId === poolId && b.status === "ACTIVE")
      .reduce((s, b) => s + Math.max(0, b.ticketPrice - (b.discount || 0) - (b.paid || 0)), 0);

    const poolPayables = (ledger.payables || []).filter((p) => p.poolId === poolId);
    const vendorOwed = poolPayables
      .filter((p) => p.status === "OPEN")
      .reduce((s, p) => s + Math.max(0, p.totalAmount - (p.paidAmount || 0)), 0);
    const totalCostsLogged = (pb["5100"] || 0) + (pb["5200"] || 0) + (pb["6100"] || 0) + (pb["6120"] || 0);
    const vendorPaid = Math.max(0, totalCostsLogged - vendorOwed);
    const netOffset = custPaid - (vendorPaid + vendorOwed);

    document.getElementById("ta-live-summary").innerHTML = `
      <div class="list-row"><span>Paid by Customers (Collected)</span><strong style="color:var(--accent)">${fmtKES(custPaid)}</strong></div>
      <div class="list-row"><span>Still Owed by Customers (A/R)</span><strong class="warn-text">${fmtKES(custOwed)}</strong></div>
      <div class="list-row"><span>Paid to Vendors (Disbursed)</span><strong>${fmtKES(vendorPaid)}</strong></div>
      <div class="list-row"><span>Still Owed to Vendors (A/P)</span><strong style="color:var(--danger)">${fmtKES(vendorOwed)}</strong></div>
      <div class="list-row"><strong>Net Cash Offset (Collected − All Vendor Costs)</strong><strong style="color:${netOffset >= 0 ? "var(--accent)" : "var(--danger)"}">${fmtKES(netOffset)}</strong></div>`;

    const openBills = poolPayables.filter((p) => p.status === "OPEN");
    document.getElementById("ta-live-vendors").innerHTML = openBills.length
      ? `<div class="muted small" style="margin-bottom:4px;">Unpaid Vendor Bills for this Trip:</div>` + openBills.map((p) => `
          <div class="list-row">
            <span><strong>${esc(p.vendor)}</strong> <span class="muted small">(Due ${p.dueDate || "TBD"})</span></span>
            <span><strong style="color:var(--danger)">${fmtKES(p.totalAmount - p.paidAmount)}</strong> <button class="btn-mini ok" onclick="paySupplierAP('${p.id}')">Pay</button></span>
          </div>`).join("")
      : `<div class="muted small">✓ No unpaid vendor bills for this trip.</div>`;

    const fixedTotal = tb.fixed.reduce((s, x) => s + Number(x.amount || 0), 0);
    document.getElementById("ta-fixed-total").textContent = fmtKES(fixedTotal);
    document.getElementById("ta-fixed-list").innerHTML = tb.fixed.map((item, idx) => `
      <div class="list-row" style="gap:6px; align-items:center;">
        <span style="flex:1; font-size:0.82rem;">${esc(item.name)}</span>
        <input type="number" class="ta-fix-amt" data-idx="${idx}" value="${item.amount}" style="width:92px; margin:0; padding:6px;" />
        ${item.billed
          ? `<span class="badge ok">✓ Billed</span>`
          : `<button class="btn-mini ta-bill-btn" data-idx="${idx}">+ Log Bill</button>`}
        <button class="btn-mini danger ta-del-fix" data-idx="${idx}">×</button>
      </div>`).join("");

    const varTotal = tb.variable.reduce((s, x) => s + Number(x.amount || 0), 0);
    document.getElementById("ta-var-total").textContent = `${fmtKES(varTotal)} / pax`;
    document.getElementById("ta-var-list").innerHTML = tb.variable.map((item, idx) => `
      <div class="list-row" style="gap:6px; align-items:center;">
        <span style="flex:1; font-size:0.82rem;">${esc(item.name)}</span>
        <input type="number" class="ta-var-amt" data-idx="${idx}" value="${item.amount}" style="width:92px; margin:0; padding:6px;" />
        <button class="btn-mini danger ta-del-var" data-idx="${idx}">×</button>
      </div>`).join("");

    document.getElementById("ta-be-pax").value = tb.bePax;
    document.getElementById("ta-staff-pax").value = tb.staffPax;
    document.getElementById("ta-max-cap").value = tb.maxCap;
    document.getElementById("ta-ticket-price").value = tb.ticketPrice;

    const bePax = Math.max(1, Number(tb.bePax || 1));
    const staffPax = Math.max(0, Number(tb.staffPax || 0));
    const maxCap = Math.max(bePax + staffPax, Number(tb.maxCap || 26));
    const maxPaying = Math.max(1, maxCap - staffPax);
    const price = Number(tb.ticketPrice || 0);

    const costAtBE = fixedTotal + varTotal * (bePax + staffPax);
    const bePrice = costAtBE / bePax;
    const profitAtBE = (price * bePax) - costAtBE;

    const costAtMax = fixedTotal + varTotal * (maxPaying + staffPax);
    const profitAtMax = (price * maxPaying) - costAtMax;

    document.getElementById("ta-pricing-results").innerHTML = `
      <div class="list-row"><span>Total Cost at ${bePax} Paying (+ ${staffPax} Staff)</span><strong>${fmtKES(costAtBE)}</strong></div>
      <div class="list-row"><strong>Break-Even Price (${bePax} Pax)</strong><strong style="color:var(--blue)">${fmtKES(Math.ceil(bePrice))}</strong></div>
      <div class="list-row"><span>Expected Profit at ${bePax} Pax (@ ${fmtKES(price)})</span><strong style="color:${profitAtBE >= 0 ? "var(--accent)" : "var(--danger)"}">${fmtKES(profitAtBE)}</strong></div>
      <div class="list-row"><strong>Target Profit at Max (${maxPaying} Paying)</strong><strong style="color:${profitAtMax >= 0 ? "var(--accent)" : "var(--danger)"}">${fmtKES(profitAtMax)}</strong></div>`;

    document.querySelectorAll(".ta-fix-amt").forEach((inp) => {
      inp.addEventListener("change", () => {
        tb.fixed[Number(inp.dataset.idx)].amount = Number(inp.value || 0);
        saveLedger(true);
        renderTripAccounts();
      });
    });
    document.querySelectorAll(".ta-var-amt").forEach((inp) => {
      inp.addEventListener("change", () => {
        tb.variable[Number(inp.dataset.idx)].amount = Number(inp.value || 0);
        saveLedger(true);
        renderTripAccounts();
      });
    });
    document.querySelectorAll(".ta-del-fix").forEach((btn) => {
      btn.addEventListener("click", () => {
        tb.fixed.splice(Number(btn.dataset.idx), 1);
        saveLedger(true);
        renderTripAccounts();
      });
    });
    document.querySelectorAll(".ta-del-var").forEach((btn) => {
      btn.addEventListener("click", () => {
        tb.variable.splice(Number(btn.dataset.idx), 1);
        saveLedger(true);
        renderTripAccounts();
      });
    });
    document.querySelectorAll(".ta-bill-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = tb.fixed[Number(btn.dataset.idx)];
        if (!item || item.amount <= 0) return alert("Enter a valid amount first.");
        const vendor = prompt(`Log "${item.name}" (${fmtKES(item.amount)}) as a Supplier Bill.\nEnter Vendor Name:`, item.name);
        if (!vendor) return;
        const dueDate = prompt("Due Date (YYYY-MM-DD):", todayStr()) || todayStr();
        const entId = ledger.entities[0]?.id || "ent_gik";
        try {
          validateAndPostJE({
            date: todayStr(),
            memo: `Supplier Bill (A/P): ${vendor}`,
            entityId: entId,
            poolId,
            lines: [
              { accountCode: "5100", debit: Number(item.amount), credit: 0 },
              { accountCode: "2020", debit: 0, credit: Number(item.amount) }
            ]
          });
          ledger.payables.unshift({
            id: "AP-" + Date.now(),
            entityId: entId,
            poolId,
            vendor: vendor.trim(),
            cogsCode: "5100",
            dueDate,
            totalAmount: Number(item.amount),
            paidAmount: 0,
            status: "OPEN"
          });
          item.billed = true;
          saveLedger(true);
          renderAll();
        } catch (e) { alert(e.message); }
      });
    });
  }

  document.getElementById("ta-pool-select")?.addEventListener("change", renderTripAccounts);
  ["ta-be-pax", "ta-staff-pax", "ta-max-cap", "ta-ticket-price"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
      const poolId = document.getElementById("ta-pool-select")?.value;
      if (!poolId) return;
      const tb = getTripBudget(poolId);
      tb.bePax = Number(document.getElementById("ta-be-pax").value || 1);
      tb.staffPax = Number(document.getElementById("ta-staff-pax").value || 0);
      tb.maxCap = Number(document.getElementById("ta-max-cap").value || 26);
      tb.ticketPrice = Number(document.getElementById("ta-ticket-price").value || 0);
      saveLedger(false);
      renderTripAccounts();
    });
  });

  document.getElementById("ta-add-fix-btn")?.addEventListener("click", () => {
    const poolId = document.getElementById("ta-pool-select")?.value;
    const name = document.getElementById("ta-new-fix-name").value.trim();
    const amount = Number(document.getElementById("ta-new-fix-amt").value || 0);
    if (!poolId || !name) return;
    getTripBudget(poolId).fixed.push({ id: "fx_" + Date.now(), name, amount, billed: false });
    document.getElementById("ta-new-fix-name").value = "";
    document.getElementById("ta-new-fix-amt").value = "";
    saveLedger(true);
    renderTripAccounts();
  });

  document.getElementById("ta-add-var-btn")?.addEventListener("click", () => {
    const poolId = document.getElementById("ta-pool-select")?.value;
    const name = document.getElementById("ta-new-var-name").value.trim();
    const amount = Number(document.getElementById("ta-new-var-amt").value || 0);
    if (!poolId || !name) return;
    getTripBudget(poolId).variable.push({ id: "vr_" + Date.now(), name, amount });
    document.getElementById("ta-new-var-name").value = "";
    document.getElementById("ta-new-var-amt").value = "";
    saveLedger(true);
    renderTripAccounts();
  });

  // ================= 9. RBAC ROLE PINS & APPROVALS INBOX =================
  let approvalsQueue = { updatedAt: null, requests: [] };
  let approvalsSha = null;

  function b64ToBufLocal(b64) {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }

  async function decryptPayloadLocal(pkg, pin) {
    const enc = new TextEncoder();
    const keyMat = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64ToBufLocal(pkg.salt), iterations: 100000, hash: "SHA-256" },
      keyMat, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBufLocal(pkg.iv) }, key, b64ToBufLocal(pkg.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text || "")));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function populateRolePins() {
    const rp = secrets.rolePins || {};
    ["strategy", "growth", "ops", "marketing"].forEach((role) => {
      const el = document.getElementById("pin-" + role);
      if (el && rp[role]) el.value = rp[role];
    });
  }

  document.getElementById("save-role-pins-btn")?.addEventListener("click", async () => {
    const roles = ["strategy", "growth", "ops", "marketing"];
    const names = {
      strategy: "Michael (Strategy & Clinical)",
      growth: "Robert (Growth & Ops Backup)",
      ops: "Edna (Tech & Ops)",
      marketing: "Tiffany (Marketing & Brand)"
    };
    secrets.rolePins = secrets.rolePins || {};
    ledger.rolePinHashes = ledger.rolePinHashes || {};

    for (const r of roles) {
      const val = (document.getElementById("pin-" + r)?.value || "").trim();
      if (val) {
        secrets.rolePins[r] = val;
        ledger.rolePinHashes[r] = { name: names[r], hash: await sha256Hex(`${r}:${val}`) };
      }
    }
    localStorage.setItem(SECRETS_KEY, JSON.stringify(secrets));
    saveLedger(true);
    document.getElementById("role-pins-status").textContent = "✓ Role PINs hashed & synced to Team Portal.";
  });

  document.getElementById("open-approvals-btn")?.addEventListener("click", () => {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.getElementById("view-approvals")?.classList.add("active");
    pullApprovalsQueue();
  });

  document.getElementById("refresh-approvals-btn")?.addEventListener("click", () => pullApprovalsQueue());

  async function pullApprovalsQueue(silent = false) {
    const statusEl = document.getElementById("approvals-status");
    if (!secrets.ghRepo || !secrets.ghToken || !secrets.teamPin) {
      if (!silent && statusEl) statusEl.textContent = "Configure GitHub Repo, Token, and Team PIN in Setup first.";
      return;
    }
    if (!silent && statusEl) statusEl.textContent = "Pulling encrypted approvals queue...";
    try {
      const apiUrl = `https://api.github.com/repos/${secrets.ghRepo.trim()}/contents/docs/approvals.enc.json`;
      const res = await fetch(apiUrl, {
        headers: { Authorization: `Bearer ${secrets.ghToken.trim()}`, Accept: "application/vnd.github+json" }
      });
      if (res.status === 404) {
        approvalsQueue = { updatedAt: new Date().toISOString(), requests: [] };
        approvalsSha = null;
        if (!silent && statusEl) statusEl.textContent = "No pending team requests yet.";
        renderApprovals();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const file = await res.json();
      approvalsSha = file.sha;
      const pkg = JSON.parse(decodeURIComponent(escape(atob(file.content.replace(/\n/g, "")))));
      approvalsQueue = await decryptPayloadLocal(pkg, secrets.teamPin);
      if (!silent && statusEl) statusEl.textContent = `✓ Queue synced (${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}).`;
      renderApprovals();
    } catch (err) {
      if (!silent && statusEl) statusEl.textContent = "Pull failed: " + err.message;
    }
  }

  async function pushApprovalsQueue() {
    const apiUrl = `https://api.github.com/repos/${secrets.ghRepo.trim()}/contents/docs/approvals.enc.json`;
    const headers = {
      Authorization: `Bearer ${secrets.ghToken.trim()}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    };
    const check = await fetch(apiUrl, { headers });
    if (check.ok) approvalsSha = (await check.json()).sha;

    approvalsQueue.updatedAt = new Date().toISOString();
    const encrypted = await encryptPayload(approvalsQueue, secrets.teamPin);
    const contentB64 = btoa(unescape(encodeURIComponent(JSON.stringify(encrypted, null, 2))));
    const put = await fetch(apiUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify({ message: `Update approvals queue (${approvalsQueue.requests.length} items)`, content: contentB64, sha: approvalsSha || undefined })
    });
    if (!put.ok) throw new Error((await put.json()).message || `HTTP ${put.status}`);
    approvalsSha = (await put.json()).content?.sha || approvalsSha;
  }

  window.approveAndPostReq = async function (reqId) {
    const req = (approvalsQueue.requests || []).find((r) => r.id === reqId);
    if (!req) return;
    if (req.status === "PENDING_CO_APPROVAL" && !confirm("This item has NOT been co-approved by the department lead yet. Override and post anyway?")) {
      return;
    }

    try {
      let je = null;
      const amt = Number(req.amount || 0);
      const entId = req.entityId || ledger.entities[0]?.id;
      const poolId = req.poolId || ledger.pools[0]?.id;
      const acc = req.accountCode || "5100";

      if (req.type === "SUPPLIER_BILL") {
        je = validateAndPostJE({
          date: todayStr(),
          memo: `Supplier Bill (A/P): ${req.counterparty} — ${req.memo}`,
          entityId: entId,
          poolId,
          lines: [
            { accountCode: acc, debit: amt, credit: 0 },
            { accountCode: "2020", debit: 0, credit: amt }
          ]
        });
        ledger.payables.unshift({
          id: "AP-" + Date.now(),
          entityId: entId,
          poolId,
          vendor: req.counterparty || req.memo,
          cogsCode: acc,
          dueDate: req.dueDate || todayStr(),
          totalAmount: amt,
          paidAmount: 0,
          status: "OPEN"
        });
      } else if (req.type === "SPEND_REQUEST") {
        je = validateAndPostJE({
          date: todayStr(),
          mpesaCode: req.mpesaCode || "",
          memo: `Approved Spend (${req.createdByName}): ${req.counterparty} — ${req.memo}`,
          entityId: entId,
          poolId,
          lines: [
            { accountCode: acc, debit: amt, credit: 0 },
            { accountCode: req.cashAccountCode || "1010", debit: 0, credit: amt }
          ]
        });
      } else if (req.type === "CLIENT_DEPOSIT") {
        je = validateAndPostJE({
          date: todayStr(),
          mpesaCode: req.mpesaCode || "",
          memo: `Client Deposit: ${req.counterparty}`,
          entityId: entId,
          poolId,
          lines: [
            { accountCode: req.cashAccountCode || "1010", debit: amt, credit: 0 },
            { accountCode: "2010", debit: 0, credit: amt }
          ]
        });
        const existing = (ledger.bookings || []).find(
          (b) => b.status === "ACTIVE" && b.poolId === poolId && b.clientName.toLowerCase() === String(req.counterparty || "").trim().toLowerCase()
        );
        if (existing) {
          existing.paid = (existing.paid || 0) + amt;
        } else {
          ledger.bookings.unshift({
            id: "BK-" + Date.now(),
            entityId: entId,
            poolId,
            clientName: req.counterparty || "Client",
            ticketPrice: Number(req.ticketPrice || amt),
            discount: Number(req.discount || 0),
            paid: amt,
            isAgency: false,
            status: "ACTIVE"
          });
        }
      } else if (req.type === "OUT_OF_POCKET") {
        je = validateAndPostJE({
          date: todayStr(),
          memo: `Partner Paid (${req.counterparty || req.createdByName}): ${req.memo}`,
          entityId: entId,
          poolId,
          lines: [
            { accountCode: acc, debit: amt, credit: 0 },
            { accountCode: "2030", debit: 0, credit: amt }
          ]
        });
        ledger.reimbursements.unshift({
          id: "RE-" + Date.now(),
          entityId: entId,
          poolId,
          partnerName: req.counterparty || req.createdByName,
          memo: req.memo,
          amount: amt,
          status: "OPEN"
        });
      }

      req.status = "APPROVED_POSTED";
      req.postedJeId = je?.id || "APPROVED_NO_JE";
      req.decidedAt = new Date().toISOString();

      saveLedger(true);
      await pushApprovalsQueue();
      renderAll();
      renderApprovals();
      alert("✓ Approved, posted to General Ledger, and synced!");
    } catch (err) {
      alert("Approval failed: " + err.message);
    }
  };

  window.rejectReq = async function (reqId) {
    const req = (approvalsQueue.requests || []).find((r) => r.id === reqId);
    if (!req) return;
    const reason = prompt(`Reject request from ${req.createdByName} (${fmtKES(req.amount)})?\nEnter reason:`);
    if (reason === null) return;
    req.status = "REJECTED";
    req.financeNote = reason.trim() || "Rejected by Finance";
    req.decidedAt = new Date().toISOString();
    try {
      await pushApprovalsQueue();
      renderApprovals();
    } catch (err) {
      alert("Failed to update queue: " + err.message);
    }
  };

  function renderReqCard(r, showActions) {
    const pool = ledger.pools.find((p) => p.id === r.poolId)?.name || "";
    const typeLabel = {
      SUPPLIER_BILL: "Supplier Bill (A/P)",
      SPEND_REQUEST: "Cash / Spend Request",
      CLIENT_DEPOSIT: "Client Deposit",
      OUT_OF_POCKET: "Out-of-Pocket Reimb.",
      B2B_QUOTE: "B2B Quote / Discount"
    }[r.type] || r.type;

    return `
      <div class="je-card">
        <div class="card-top" style="margin-bottom:4px;">
          <strong>${esc(r.counterparty || r.memo)}</strong>
          <strong style="color:var(--accent)">${fmtKES(r.amount)}</strong>
        </div>
        <div class="je-meta">
          <span class="tag">${esc(typeLabel)}</span>
          <span class="tag">${esc(pool)}</span>
          <span class="tag">By: ${esc(r.createdByName)}</span>
          ${r.coApprovedBy ? `<span class="tag etims-ok">Co-Approved: ${esc(r.coApprovedBy)}</span>` : ""}
          ${r.serviceVerified ? `<span class="tag etims-ok">Service Verified ✓</span>` : ""}
        </div>
        <div class="muted small" style="margin:4px 0 8px;">${esc(r.memo)}${r.mpesaCode ? ` • Ref: ${esc(r.mpesaCode)}` : ""}${r.financeNote ? ` • Note: ${esc(r.financeNote)}` : ""}</div>
        ${showActions ? `
          <div class="btn-row">
            <button class="btn-mini ok" onclick="approveAndPostReq('${r.id}')">✓ Approve & Post</button>
            <button class="btn-mini danger" onclick="rejectReq('${r.id}')">✕ Reject</button>
          </div>` : `<span class="badge ${r.status === "APPROVED_POSTED" ? "ok" : "err"}">${r.status}</span>`}
      </div>`;
  }

  function renderApprovals() {
    const list = approvalsQueue.requests || [];
    const ready = list.filter((r) => r.status === "PENDING_FINANCE");
    const waiting = list.filter((r) => r.status === "PENDING_CO_APPROVAL");
    const history = list.filter((r) => r.status === "APPROVED_POSTED" || r.status === "REJECTED").slice(0, 20);

    const badge = document.getElementById("approvals-badge");
    if (badge) badge.textContent = String(ready.length + waiting.length);

    const readyEl = document.getElementById("approvals-ready-list");
    const waitEl = document.getElementById("approvals-waiting-list");
    const histEl = document.getElementById("approvals-history-list");

    if (readyEl) readyEl.innerHTML = ready.map((r) => renderReqCard(r, true)).join("") || `<div class="muted small">✓ No items waiting for Finance sign-off.</div>`;
    if (waitEl) waitEl.innerHTML = waiting.map((r) => renderReqCard(r, true)).join("") || `<div class="muted small">None awaiting department co-approval.</div>`;
    if (histEl) histEl.innerHTML = history.map((r) => renderReqCard(r, false)).join("") || `<div class="muted small">No decisions logged yet.</div>`;
  }

  // Hook Trip Accounts + Reports into global renderAll
  const prevRenderAllTA = window.renderAll;
  window.renderAll = function () {
    prevRenderAllTA();
    renderTripAccounts();
    renderV4();
  };

  renderTripAccounts();
  renderV4();
  populateRolePins();
  if (navigator.onLine && secrets.ghRepo && secrets.ghToken && secrets.teamPin) {
    pullApprovalsQueue(true);
  }
})();
