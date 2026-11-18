// Shared helpers + Supabase client. Load AFTER config.js and the Supabase SDK.
const C = window.BBQ_CONFIG;
const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY);

const naira = n => "₦" + Number(n || 0).toLocaleString("en-NG");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = d => d ? new Date(d).toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" }) : "—";
const fmtEvent = d => new Date(d).toLocaleDateString("en-NG", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" });
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function show(el, msg, type = "err") {
  el.className = "alert " + type;
  el.textContent = msg;
  el.classList.remove("hidden");
}

async function loadEvent() {
  const { data, error } = await sb.from("bbq_event_settings").select("*").eq("id", 1).single();
  if (error) throw error;
  return data;
}
async function loadPackages() {
  const { data, error } = await sb.from("bbq_packages").select("*").order("price");
  if (error) throw error;
  return data;
}
function friendlyError(e) {
  const m = (e && e.message) || "Something went wrong.";
  if (/permission denied/i.test(m)) return "The database is not fully set up yet (permissions). Please contact the organiser.";
  return m;
}
