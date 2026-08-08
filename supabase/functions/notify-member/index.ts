// UNO Ledger — email someone when they're invited to, or added to, a group.
// Deployed as a Supabase Edge Function; called by the app (js/cloud.js) whenever
// you add a person by email in the Members tab.
//
// Secrets it needs (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY                        — from resend.com
//   FROM_EMAIL                            — a verified sender, e.g. "UNO Ledger <hello@aldrinpadua.com>"
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — provided automatically
//   APP_ORIGIN (optional)                 — e.g. "https://aldrinpadua.com" — if set, the invite
//                                           link must start with it, so nobody can use this
//                                           function to email arbitrary links from your domain.
//
// Abuse protection:
//   • Requires a real signed-in user (a valid user JWT — the public anon key is rejected).
//   • Rate-limited to MAX_PER_HOUR emails per user (see abuse-guard.sql).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_PER_HOUR = 20;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

async function sendEmail(to: string, subject: string, text: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("FROM_EMAIL") || "onboarding@resend.dev", to, subject, text }),
  });
  if (!res.ok) console.error("Resend error", res.status, await res.text());
  return res.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // 1) Require a real signed-in user — the anon key alone is not enough.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: "sign in required" }, 401);

    // 2) Per-user rate limit (backed by email_events; see abuse-guard.sql).
    const { data: allowed, error: rlErr } = await admin.rpc("rate_take", {
      p_actor: user.id, p_limit: MAX_PER_HOUR, p_window_secs: 3600,
    });
    if (rlErr) console.error("rate_take error", rlErr.message);
    if (allowed === false) return json({ error: "rate limit — try again later", rateLimited: true }, 429);

    const { type, email, name, groupName, context, inviterName, link } = await req.json();
    if (!email || !isEmail(email) || !link) return json({ error: "missing or invalid email/link" }, 400);

    // 3) Don't let this be an open relay: the link must point at our own app.
    const origin = Deno.env.get("APP_ORIGIN");
    if (origin && !String(link).startsWith(origin)) return json({ error: "invalid link" }, 400);

    const who = inviterName || "A friend";
    const greeting = name ? `Hi ${name},` : "Hi,";
    const isFriend = context === "friend"; // 1:1 friend add vs. a group/trip
    let subject: string, body: string;

    if (isFriend && type === "invite") {
      subject = `${who} added you as a friend on UNO Ledger`;
      body = `${greeting}\n\n${who} wants to split expenses with you on UNO Ledger and added you as a friend.\n\nJoin here — sign in with this email (${email}) and you'll be connected automatically:\n${link}\n\nUNO Ledger makes it easy to split trips and bills with friends.\n\n— UNO Ledger`;
    } else if (isFriend) {
      subject = `${who} added you as a friend on UNO Ledger`;
      body = `${greeting}\n\n${who} added you as a friend on UNO Ledger so you two can split and settle expenses together. Open it here:\n${link}\n\n— UNO Ledger`;
    } else if (type === "invite") {
      subject = `${who} invited you to "${groupName}" on UNO Ledger`;
      body = `${greeting}\n\n${who} is splitting expenses for "${groupName}" on UNO Ledger and added you.\n\nJoin here — sign in with this email (${email}) and you'll automatically be part of "${groupName}":\n${link}\n\nUNO Ledger makes it easy to split trips and bills with friends.\n\n— UNO Ledger`;
    } else {
      subject = `${who} added you to "${groupName}" on UNO Ledger`;
      body = `${greeting}\n\n${who} added you to "${groupName}" on UNO Ledger. Open it here to see the shared expenses and what's owed:\n${link}\n\n— UNO Ledger`;
    }

    const ok = await sendEmail(email, subject, body);
    return json({ ok });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
