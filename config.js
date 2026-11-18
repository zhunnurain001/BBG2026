// Public settings only. The anon/publishable key is SAFE in the browser
// (what it can do is limited by Row Level Security in the database).
// NEVER put the service_role / secret key in this project.
window.BBQ_CONFIG = {
  SUPABASE_URL: "https://hccnxiruxmevzgktffxr.supabase.co",
  SUPABASE_KEY: "sb_publishable_vVZGHG4duMNAYac5tYiHyA_HUpn_gK9",
  RECEIPT_BUCKET: "bbq-receipts",
  MAX_FILE_BYTES: 2 * 1024 * 1024, // 2 MB (same limit as the bucket)
  CONTACT_NAME: "Usman Ayuba Zago",
  CONTACT_PHONE: "07065844626"      // change to your real contact number if different
};
