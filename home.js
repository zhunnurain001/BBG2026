let EVENT = null, PACKAGES = [];

// Fallback = 21 Nov 2026, 00:00 Nigerian time. Replaced by the database date when it loads.
const FALLBACK_EVENT_DATE = "2026-11-20T23:00:00Z";
let cdTimer = null;

function startCountdown(date) {
  if (cdTimer) clearInterval(cdTimer);
  const target = new Date(date).getTime();
  const set = (id, v) => $("#" + id).textContent = String(v).padStart(2, "0");
  const tick = () => {
    let diff = Math.max(0, target - Date.now());
    set("cdD", Math.floor(diff / 864e5));
    set("cdH", Math.floor(diff % 864e5 / 36e5));
    set("cdM", Math.floor(diff % 36e5 / 6e4));
    set("cdS", Math.floor(diff % 6e4 / 1e3));
    if (diff === 0) $("#heroMeta").textContent = "The BBQ is happening now! 🔥";
  };
  tick(); cdTimer = setInterval(tick, 1000);
}

function renderPackages() {
  const grid = $("#pkgGrid");
  grid.innerHTML = PACKAGES.map((p, i) => `
    <div class="card price-card" data-id="${esc(p.id)}">
      ${i === PACKAGES.length - 1 ? '<span class="tag">PREMIUM</span>' : ""}
      <h3>${esc(p.name)}</h3>
      <div class="amt">${naira(p.price)}</div>
      ${isCustom(p) ? '<p class="hint">or any preferred amount</p>' : ""}
      <button class="btn btn-green btn-sm" type="button">Select</button>
    </div>`).join("");
  $$(".price-card").forEach(c => c.addEventListener("click", () => {
    $("#package").value = c.dataset.id; onPackageChange();
    document.getElementById("register").scrollIntoView({ behavior: "smooth" });
  }));
  $("#package").innerHTML = '<option value="">Select a package…</option>' +
    PACKAGES.map(p => `<option value="${esc(p.id)}">${esc(p.name)} – ${naira(p.price)}</option>`).join("");
}

const isCustom = p => p.allow_custom_amount ?? (p.id === "normal");

function onPackageChange() {
  const p = PACKAGES.find(x => x.id === $("#package").value);
  const amt = $("#amount"), hint = $("#amountHint");
  $$(".price-card").forEach(c => c.classList.toggle("sel", p && c.dataset.id === p.id));
  if (!p) { amt.value = ""; amt.readOnly = false; hint.textContent = ""; return; }
  if (isCustom(p)) {
    amt.readOnly = false; amt.value = p.price;
    hint.textContent = `Minimum suggested: ${naira(p.price)}. You may pay any amount you prefer.`;
  } else {
    amt.readOnly = true; amt.value = p.price;
    hint.textContent = `Fixed price: ${naira(p.price)}.`;
  }
}

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

async function submitForm(e) {
  e.preventDefault();
  const msg = $("#formMsg"), btn = $("#submitBtn");
  msg.classList.add("hidden");
  const file = $("#receipt").files[0];
  if (!$("#fullName").value.trim()) return show(msg, "Please enter your full name.");
  if (!$("#phone").value.trim()) return show(msg, "Please enter your phone number.");
  if (!$("#package").value) return show(msg, "Please choose a package.");
  if (!$("#ref").value.trim()) return show(msg, "Please enter your OPay transaction reference.");
  if (!file) return show(msg, "Please upload your payment receipt.");
  const ext = EXT[file.type];
  if (!ext) return show(msg, "Receipt must be a JPG, PNG, WEBP or PDF file.");
  if (file.size > C.MAX_FILE_BYTES) return show(msg, "Receipt is too large. Maximum size is 2 MB.");

  btn.disabled = true; btn.textContent = "Uploading receipt…";
  try {
    const path = `receipts/${crypto.randomUUID()}.${ext}`;
    const up = await sb.storage.from(C.RECEIPT_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
    if (up.error) throw up.error;

    btn.textContent = "Saving registration…";
    const { data, error } = await sb.rpc("submit_registration", {
      p_full_name: $("#fullName").value,
      p_phone: $("#phone").value,
      p_matric_number: $("#matric").value,
      p_package_id: $("#package").value,
      p_amount: Number($("#amount").value),
      p_transaction_reference: $("#ref").value,
      p_receipt_path: path
    });
    if (error) throw error;

    const code = data.registration_code;
    try { localStorage.setItem("bbq_code", code); } catch (_) {} // convenience only; real data lives in Supabase
    $("#regCode").textContent = code;
    $("#dashLink").href = "my-registration.html?code=" + encodeURIComponent(code);
    $("#regForm").classList.add("hidden");
    $("#successCard").classList.remove("hidden");
    $("#successCard").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (err) {
    show(msg, friendlyError(err));
  } finally {
    btn.disabled = false; btn.textContent = "Submit Registration";
  }
}

(async function init() {
  $("#cName").textContent = C.CONTACT_NAME;
  $("#cTel").textContent = C.CONTACT_PHONE;
  $("#cTel").href = "tel:" + C.CONTACT_PHONE;
  startCountdown(FALLBACK_EVENT_DATE);   // runs immediately, even if the database is unreachable
  $("#heroMeta").textContent = "21 November 2026 · IBBUL, Lapai Staff Quarters, Niger State, Nigeria";
  try {
    [EVENT, PACKAGES] = await Promise.all([loadEvent(), loadPackages()]);
    $("#evName").textContent = EVENT.event_name;
    $("#heroMeta").textContent = `${fmtEvent(EVENT.event_date)} · ${EVENT.venue}`;
    $("#infoDate").textContent = fmtEvent(EVENT.event_date);
    $("#infoVenue").textContent = EVENT.venue;
    $("#acctNum").textContent = EVENT.account_number;
    $("#acctName").textContent = `OPay · ${EVENT.account_name}`;
    startCountdown(EVENT.event_date);
    renderPackages();
  } catch (e) {
    $("#pkgGrid").innerHTML = `<div class="card info-card">${esc(friendlyError(e))}</div>`;
  }
  $("#package").addEventListener("change", onPackageChange);
  $("#regForm").addEventListener("submit", submitForm);
})();
