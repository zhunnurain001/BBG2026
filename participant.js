const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;

async function lookup(code) {
  const msg = $("#msg"); msg.classList.add("hidden");
  $("#result").classList.add("hidden");
  code = (code || "").trim();
  if (!code) return show(msg, "Please enter your registration code.");
  const { data, error } = await sb.rpc("get_registration_by_code", { p_code: code });
  if (error) return show(msg, friendlyError(error));
  if (!data) return show(msg, "No registration found for that code. Check it and try again.");

  const st = data.payment_status;
  const label = { pending: "Pending verification", approved: "Approved", rejected: "Rejected" }[st];
  $("#seatBox").innerHTML =
    st === "approved" ? `<div class="seat"><span>🎉 Your seat is confirmed</span><b>${esc(data.seat_number)}</b><span>${esc(data.package_name)}</span></div>` :
    st === "rejected" ? `<div class="alert err"><b>Payment rejected.</b> ${esc(data.rejection_reason || "Please contact the organiser.")}</div>` :
    `<div class="alert" style="background:#fdf2d8;color:var(--warn)">⏳ Your payment is awaiting verification. A seat is assigned once it is approved.</div>`;

  $("#details").innerHTML =
    kv("Status", `<span class="badge b-${st}">${label}</span>`) +
    kv("Full name", esc(data.full_name)) +
    kv("Phone", esc(data.phone)) +
    kv("Matric number", esc(data.matric_number || "—")) +
    kv("Package", esc(data.package_name)) +
    kv("Amount submitted", naira(data.amount_paid)) +
    kv("Payment reference", esc(data.transaction_reference)) +
    kv("Seat number", esc(data.seat_number || "Not assigned yet")) +
    kv("Submitted", fmtDate(data.submitted_at)) +
    (data.approved_at ? kv("Approved", fmtDate(data.approved_at)) : "") +
    kv("Registration code", esc(data.registration_code));

  try {
    const ev = await loadEvent();
    $("#eventBox").innerHTML = `<h3 style="color:var(--green);margin-bottom:6px">${esc(ev.event_name)}</h3>` +
      kv("Date", fmtEvent(ev.event_date)) + kv("Venue", esc(ev.venue));
  } catch (_) {}
  $("#result").classList.remove("hidden");
  try { localStorage.setItem("bbq_code", data.registration_code); } catch (_) {}
}

$("#lookup").addEventListener("submit", e => { e.preventDefault(); lookup($("#code").value); });
(function () {
  const q = new URLSearchParams(location.search).get("code");
  let saved = null; try { saved = localStorage.getItem("bbq_code"); } catch (_) {}
  const c = q || saved;
  if (c) { $("#code").value = c; lookup(c); }
})();
