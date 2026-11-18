let ROWS = [], PKGS = [], PKGNAME = {};

// ---------- AUTH ----------
async function isAdmin(session) {
  if (!session) return false;
  const { data } = await sb.from("bbq_admins").select("user_id").eq("user_id", session.user.id).maybeSingle();
  return !!data;
}
async function route() {
  const { data: { session } } = await sb.auth.getSession();
  if (session && await isAdmin(session)) {
    $("#loginView").classList.add("hidden"); $("#dash").classList.remove("hidden");
    $("#logout").classList.remove("hidden"); $("#who").textContent = session.user.email;
    await loadAll();
  } else {
    if (session) { await sb.auth.signOut(); show($("#loginMsg"), "This account is not an authorised administrator."); }
    $("#dash").classList.add("hidden"); $("#loginView").classList.remove("hidden");
    $("#logout").classList.add("hidden"); $("#who").textContent = "";
  }
}
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const m = $("#loginMsg"); m.classList.add("hidden");
  const { error } = await sb.auth.signInWithPassword({ email: $("#email").value.trim(), password: $("#pass").value });
  if (error) return show(m, "Wrong email or password.");
  route();
});
$("#logout").addEventListener("click", async () => { await sb.auth.signOut(); route(); });

// ---------- DATA ----------
async function loadAll() {
  try {
    PKGS = await loadPackages();
    PKGNAME = Object.fromEntries(PKGS.map(p => [p.id, p.name]));
    $("#fPkg").innerHTML = '<option value="">All packages</option>' + PKGS.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
    await Promise.all([loadStats(), loadRows(), renderPkgs(), renderEvent()]);
  } catch (e) { show($("#adminMsg"), friendlyError(e)); }
}
async function loadStats() {
  const { data, error } = await sb.rpc("admin_dashboard_stats");
  if (error) throw error;
  const s = (l, v) => `<div class="card stat"><b>${v}</b><span>${l}</span></div>`;
  $("#stats").innerHTML = s("Total registrations", data.total_registrations) + s("Approved", data.approved) +
    s("Pending payments", data.pending) + s("Rejected", data.rejected) + s("Confirmed revenue", naira(data.confirmed_revenue));
}
async function loadRows() {
  const { data, error } = await sb.from("bbq_registrations").select("*").order("submitted_at", { ascending: false }).range(0, 4999);
  if (error) throw error;
  ROWS = data; renderRows();
}

// ---------- TABLE ----------
function filtered() {
  const q = $("#q").value.trim().toLowerCase(), p = $("#fPkg").value, s = $("#fStatus").value;
  return ROWS.filter(r =>
    (!p || r.package_id === p) && (!s || r.payment_status === s) &&
    (!q || [r.full_name, r.phone, r.matric_number].some(v => (v || "").toLowerCase().includes(q))));
}
function renderRows() {
  const list = filtered();
  $("#count").textContent = `${list.length} of ${ROWS.length} registrations shown`;
  $("#rows").innerHTML = list.length ? list.map(r => `
    <tr>
      <td><b>${esc(r.full_name)}</b><br><small>${esc(r.phone)}${r.matric_number ? " · " + esc(r.matric_number) : ""}</small></td>
      <td>${esc(PKGNAME[r.package_id] || r.package_id)}</td>
      <td>${naira(r.amount_paid)}</td>
      <td><small>${esc(r.transaction_reference)}</small></td>
      <td><span class="badge b-${esc(r.payment_status)}">${esc(r.payment_status)}</span>${r.rejection_reason ? `<br><small>${esc(r.rejection_reason)}</small>` : ""}</td>
      <td>${esc(r.seat_number || "—")}</td>
      <td><small>${fmtDate(r.submitted_at)}</small></td>
      <td><div class="actions">
        <button class="btn btn-ghost btn-sm" data-act="receipt" data-id="${r.id}">Receipt</button>
        ${r.payment_status !== "approved" ? `<button class="btn btn-green btn-sm" data-act="approve" data-id="${r.id}">Approve</button>` : ""}
        ${r.payment_status === "pending" ? `<button class="btn btn-danger btn-sm" data-act="reject" data-id="${r.id}">Reject</button>` : ""}
      </div></td>
    </tr>`).join("") : '<tr><td colspan="8">No registrations match.</td></tr>';
}
["q", "fPkg", "fStatus"].forEach(id => $("#" + id).addEventListener("input", renderRows));
$("#refresh").addEventListener("click", loadAll);

$("#rows").addEventListener("click", async e => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const r = ROWS.find(x => x.id === b.dataset.id), m = $("#adminMsg"); m.classList.add("hidden");
  try {
    if (b.dataset.act === "receipt") {
      const w = window.open("", "_blank");               // open first so pop-up blockers allow it
      const { data, error } = await sb.storage.from(C.RECEIPT_BUCKET).createSignedUrl(r.receipt_path, 120);
      if (error) { if (w) w.close(); throw error; }
      if (w) w.location = data.signedUrl; else show(m, "Please allow pop-ups to view receipts.");
    } else if (b.dataset.act === "approve") {
      if (!confirm(`Did you verify in OPay that ${naira(r.amount_paid)} with reference "${r.transaction_reference}" was really received?\n\nApprove ${r.full_name}?`)) return;
      b.disabled = true;
      const { data, error } = await sb.rpc("approve_registration", { p_registration_id: r.id });
      if (error) throw error;
      show(m, `Approved. Seat ${data.seat_number} assigned to ${r.full_name}.`, "ok");
      await Promise.all([loadStats(), loadRows()]);
    } else if (b.dataset.act === "reject") {
      const reason = prompt(`Reject ${r.full_name}'s payment? Enter a short reason (shown to the participant):`);
      if (reason === null) return;
      const { error } = await sb.rpc("reject_registration", { p_registration_id: r.id, p_reason: reason });
      if (error) throw error;
      show(m, "Payment rejected. The record is kept.", "ok");
      await Promise.all([loadStats(), loadRows()]);
    }
  } catch (err) { show(m, friendlyError(err)); }
});

// ---------- CSV ----------
$("#csv").addEventListener("click", () => {
  const cols = ["full_name", "phone", "matric_number", "package", "amount_paid", "transaction_reference", "payment_status", "seat_number", "registration_code", "submitted_at", "approved_at"];
  const cell = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const lines = [cols.join(",")].concat(filtered().map(r =>
    cols.map(c => cell(c === "package" ? PKGNAME[r.package_id] : r[c])).join(",")));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `bbq-participants-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
});

// ---------- PACKAGES ----------
async function renderPkgs() {
  $("#pkgEdit").innerHTML = '<h3 style="color:var(--green)">Package prices</h3><p class="hint">Changes apply to the public site immediately.</p>' +
    PKGS.map(p => `
      <div class="kv" style="align-items:center">
        <span><b>${esc(p.name)}</b>${p.allow_custom_amount ? ' <small>(any amount allowed)</small>' : ""}</span>
        <span><input type="number" min="1" value="${p.price}" data-pid="${esc(p.id)}" style="width:130px;display:inline-block">
        <button class="btn btn-green btn-sm" data-save="${esc(p.id)}">Save</button></span>
      </div>`).join("") + '<div class="alert hidden" id="pkgMsg"></div>';
  $$("[data-save]").forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.save, v = Number($(`[data-pid="${id}"]`).value), m = $("#pkgMsg");
    if (!(v > 0)) return show(m, "Enter a valid price.");
    const { error } = await sb.from("bbq_packages").update({ price: v }).eq("id", id);
    if (error) return show(m, friendlyError(error));
    show(m, "Price updated.", "ok"); PKGS = await loadPackages();
  }));
}
// ---------- EVENT ----------
async function renderEvent() {
  const ev = await loadEvent();
  $("#eventInfo").innerHTML = '<h3 style="color:var(--green)">Event information</h3>' +
    [["Event", ev.event_name], ["Date", fmtEvent(ev.event_date)], ["Venue", ev.venue], ["Account name", ev.account_name], ["Account number", ev.account_number]]
      .map(([k, v]) => `<div class="kv"><span>${k}</span><span>${esc(v)}</span></div>`).join("");
}
// ---------- TABS ----------
$$(".tab").forEach(t => t.addEventListener("click", () => {
  $$(".tab").forEach(x => x.classList.toggle("active", x === t));
  ["people", "pkgs", "event"].forEach(n => $("#tab-" + n).classList.toggle("hidden", n !== t.dataset.tab));
}));

route();
