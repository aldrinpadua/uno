// cloud.js — login + cloud sync (Supabase).
//
// Activated only when js/config.js has MODE:"cloud". It:
//   1. Shows a login screen (Google + magic-link email).
//   2. After login, hydrates a CloudStore from Supabase and swaps it in for the
//      LocalStore, so the rest of the app is unchanged.
//   3. Writes every change through to the relational tables (see supabase/schema.sql).
//
// Self-reference trick: inside the app the current user is always the id "you"
// (so none of the UI code had to change). When talking to Supabase we translate
// "you" <-> the user's real auth id, so a ledger shared between two people has a
// distinct, consistent id for each person.

import { CONFIG } from "./config.js";
import { setStore } from "./store.js";

let supabase = null;
let myId = null;   // auth user id (uuid)
let myEmail = "";

// ---------- Cloudflare Turnstile (CAPTCHA on the magic-link login) ----------
// Public site key from Cloudflare → Turnstile. Safe to expose. Add it to config.js:
//   TURNSTILE_SITE_KEY: "0x4AAAA...".  Leave it empty/undefined to disable the widget.
const TURNSTILE_SITE_KEY = CONFIG.TURNSTILE_SITE_KEY || "";
let _captchaToken = "";
let _turnstileId = null;
function mountTurnstile() {
  if (!TURNSTILE_SITE_KEY) return;                 // not configured → no widget
  const box = document.getElementById("cfTurnstile");
  if (!box) return;
  const render = () => {
    try {
      _turnstileId = window.turnstile.render(box, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (t) => { _captchaToken = t; },
        "expired-callback": () => { _captchaToken = ""; },
        "error-callback": () => { _captchaToken = ""; },
      });
    } catch (e) { console.error("[turnstile] render failed:", e); }
  };
  if (window.turnstile?.render) return render();
  // the api.js script loads async — wait for it (up to ~10s)
  let tries = 0;
  const iv = setInterval(() => {
    if (window.turnstile?.render) { clearInterval(iv); render(); }
    else if (++tries > 100) clearInterval(iv);
  }, 100);
}
function resetTurnstile() {
  _captchaToken = "";
  if (_turnstileId !== null && window.turnstile) { try { window.turnstile.reset(_turnstileId); } catch {} }
}

// ---------- auto sign-out after inactivity ----------
const IDLE_MINUTES = 10; // sign out after this many minutes with no activity
let _idleTimer = null;
function startIdleLogout() {
  if (_idleTimer) return; // already running for this session
  let last = Date.now();
  const bump = () => { last = Date.now(); };
  // any of these count as "active"
  ["mousemove", "mousedown", "keydown", "wheel", "scroll", "touchstart", "click"].forEach(
    (ev) => window.addEventListener(ev, bump, { passive: true }));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) bump(); });
  // check periodically — robust to the laptop sleeping (a single timeout could fire late)
  _idleTimer = setInterval(() => {
    if (Date.now() - last >= IDLE_MINUTES * 60 * 1000) {
      clearInterval(_idleTimer); _idleTimer = null;
      try { localStorage.setItem("uno.idleOut", "1"); } catch {}
      signOut();
    }
  }, 15000);
}

// ---------- invite-only platform: approval gate ----------
// Kept in sync with supabase/approvals.sql (is_platform_admin). Emails are public.
const ADMIN_EMAILS = ["aldrin.d.padua@gmail.com", "drinmeetsworld@gmail.com", "apadua@stevens.edu"];

// Make sure a profile row exists so admins can see and approve a new signup.
async function ensureOwnProfile(sb, name) {
  try {
    await sb.from("profiles").upsert(
      { id: myId, display_name: name, email: (myEmail || "").toLowerCase() || null },
      { onConflict: "id", ignoreDuplicates: true }, // never clobber an existing name/username
    );
  } catch (e) { console.error("[cloud] ensure profile failed:", e.message || e); }
}

// Email all three admins that someone is waiting — once per person per browser.
async function notifyAdminsOfSignup(sb, user) {
  const key = "uno.signupNotified." + user.id;
  try { if (localStorage.getItem(key)) return; } catch {}
  try {
    for (const to of ADMIN_EMAILS) {
      await sb.functions.invoke("notify-member", {
        body: { type: "approval-request", email: to, name: `${user.name || "Someone"} (${user.email})`, link: appUrl(), inviterName: "UNO" },
      });
    }
    try { localStorage.setItem(key, "1"); } catch {}
  } catch (e) { console.error("[cloud] notify admins failed:", e.message || e); }
}

const escH = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Shown when someone opens a shareable invite link (?invite=token) while logged in.
function inviteAcceptScreen(store, token, info) {
  const app = document.getElementById("app");
  const isFriend = info.type === "friend";
  const what = isFriend ? `be friends with <b>${escH(info.name)}</b>` : `join the ${info.type} <b>${escH(info.name)}</b>`;
  app.innerHTML = `<div class="login-screen"><div class="login-card">
    <div class="login-brand"><img src="./assets/logo.svg" alt="UNO" style="width:44px;height:44px"><h1>UNO</h1></div>
    <div class="card" style="margin-top:4px"><h3 style="margin:0 0 8px">✉️ You've been invited</h3>
      <p class="hint" style="margin:0">You've been invited to ${what} on UNO.</p></div>
    <div class="row" style="margin-top:12px"><button class="btn" id="invAcc">Accept</button><button class="btn ghost" id="invDec">Decline</button></div>
    <div id="invMsg" class="login-msg"></div>
  </div></div>`;
  const done = () => { try { localStorage.removeItem("uno.inviteToken"); } catch {} window.location.href = appUrl(); };
  document.getElementById("invAcc").onclick = async () => {
    document.getElementById("invAcc").disabled = true;
    const r = await store.acceptShared(token, info.type);
    if (r.ok) done(); else { document.getElementById("invMsg").textContent = r.error || "Couldn't accept."; document.getElementById("invAcc").disabled = false; }
  };
  document.getElementById("invDec").onclick = () => done();
}

// The "you're signed in but need approval" screen.
function pendingScreen(user) {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand"><img src="./assets/logo.svg" alt="UNO" style="width:44px;height:44px"><h1>UNO</h1><p>Almost there…</p></div>
        <div class="card" style="margin-top:4px">
          <h3 style="margin:0 0 8px">⏳ Waiting for approval</h3>
          <p class="hint" style="margin:0">UNO is invite-only. You're signed in as <b id="pEmail"></b>, but an admin needs to approve your account before you can start. We've let them know — you'll be able to get in as soon as one of them approves you.</p>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn" id="pCheck">Check again</button>
          <button class="btn ghost" id="pOut">Sign out</button>
        </div>
        <div id="pMsg" class="login-msg"></div>
      </div>
    </div>`;
  const em = document.getElementById("pEmail"); if (em) em.textContent = user.email || "";
  document.getElementById("pCheck").onclick = () => window.location.reload();
  document.getElementById("pOut").onclick = () => signOut();
}

async function getClient() {
  if (supabase) return supabase;
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, detectSessionInUrl: true, autoRefreshToken: true },
  });
  return supabase;
}

// the app's own URL (used as the invite link)
const appUrl = () => window.location.origin + window.location.pathname;

// ---------- self-reference translation ----------
const mapRef = (r, from, to) => (r === from ? to : r);
function translateExpenseData(data, from, to) {
  const d = JSON.parse(JSON.stringify(data || {}));
  if (Array.isArray(d.paidBy)) d.paidBy.forEach((p) => (p.memberId = mapRef(p.memberId, from, to)));
  if (d.split) {
    if (Array.isArray(d.split.participants)) d.split.participants = d.split.participants.map((x) => mapRef(x, from, to));
    if (Array.isArray(d.split.sharedParticipants)) d.split.sharedParticipants = d.split.sharedParticipants.map((x) => mapRef(x, from, to));
    if (Array.isArray(d.split.items)) d.split.items.forEach((it) => (it.participants = (it.participants || []).map((x) => mapRef(x, from, to))));
  }
  if (d.from) d.from = mapRef(d.from, from, to);
  if (d.to) d.to = mapRef(d.to, from, to);
  return d;
}

// ================= CloudStore =================
// Same public API as LocalStore (js/store.js), backed by Supabase.
// Reads are synchronous (from in-memory `state`, hydrated at login).
// Writes update memory immediately, then persist in the background.
class CloudStore {
  constructor(client) {
    this.sb = client;
    this.state = { version: 1, you: { id: "you", name: "You", email: "" }, people: [], ledgers: [], expenses: [], friends: [], friendRequests: [], invitations: [], chats: [], polls: [] };
    this.listeners = new Set();
    this.isPlatformAdmin = false; // one of the three platform admins?
    this.nameById = new Map();    // member_ref -> {name,...} for anyone (active/pending/left)
    this.messageListeners = new Set(); // realtime message-change subscribers (the UI)
    this.activeChat = null;       // chat currently open (so its incoming msgs don't count unread)
    this._rtChannel = null;
    // my member_ref can differ per ledger: it's my auth id in ledgers I created,
    // but a generated "pending" id in ledgers I was invited to. Track per ledger.
    this.myRefByLedger = {};
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _notify() { this.listeners.forEach((fn) => fn(this.state)); }
  async _try(label, fn) { try { await fn(); } catch (e) { console.error("[cloud] " + label + " failed:", e.message || e); } }
  _myRef(ledgerId) { return this.myRefByLedger[ledgerId] || myId; }

  // ---- initial load ----
  async hydrate() {
    const you = this.state.you;
    // Load the profile if it exists (don't clobber a name/username the user set);
    // create it on very first login.
    await this._try("profile load", async () => {
      const { data: prof } = await this.sb.from("profiles").select("display_name,email,username,friend_token,avatar_color,timezone,favorites").eq("id", myId).maybeSingle();
      if (prof) {
        you.name = prof.display_name || you.name;
        you.email = (prof.email || myEmail || "").toLowerCase();
        you.username = prof.username || null;
        you.friendToken = prof.friend_token || null;
        you.color = prof.avatar_color || null;
        you.timezone = prof.timezone || null;
        you.favorites = Array.isArray(prof.favorites) ? prof.favorites : [];
      } else {
        await this.sb.from("profiles").insert({ id: myId, display_name: you.name, email: (myEmail || "").toLowerCase() });
        you.username = null;
      }
    });
    you.email = (you.email || myEmail || "").toLowerCase();
    // If the auth (login) email changed via the verified flow, sync the profile copy.
    if (myEmail && you.email !== (myEmail || "").toLowerCase()) {
      you.email = (myEmail || "").toLowerCase();
      this._try("sync login email", () => this.sb.from("profiles").update({ email: you.email }).eq("id", myId));
    }

    // Claim any pending invites addressed to my email (sets user_id on rows the
    // inviter created for me before I had an account) — so I become a real,
    // visible member without needing the inviter to refresh. Prefer the
    // security-definer RPC (see supabase/friend-sync.sql); fall back to the older
    // RLS-based update if that function isn't deployed yet.
    await this._try("claim invites", async () => {
      const { error } = await this.sb.rpc("claim_my_invites");
      if (error) await this.sb.from("ledger_members").update({ user_id: myId }).is("user_id", null).ilike("email", myEmail);
    });

    const ledRes = await this.sb.from("ledgers").select("*");
    if (ledRes.error) throw new Error("Loading your groups failed: " + ledRes.error.message);
    const ledgers = ledRes.data || [];
    const ids = ledgers.map((l) => l.id);
    let members = [], expenses = [];
    if (ids.length) {
      members = (await this.sb.from("ledger_members").select("*").in("ledger_id", ids)).data || [];
      expenses = (await this.sb.from("expenses").select("*").in("ledger_id", ids)).data || [];
    }

    // Enrich member rows from live profiles so real users always show their
    // current name/username/email — and heal "pending" rows for friends who have
    // since signed up (matched by email), which also makes them real members.
    const profById = new Map(), profByEmail = new Map();
    await this._try("member profiles", async () => {
      const { data } = await this.sb.rpc("member_profiles");
      for (const p of data || []) { profById.set(p.id, p); if (p.email) profByEmail.set(p.email.toLowerCase(), p); }
    });
    const goodName = (p) => {
      const prefix = (p.email || "").split("@")[0];
      return (p.display_name && p.display_name !== prefix) ? p.display_name : (p.username || p.display_name || prefix);
    };
    const heals = [];
    for (const m of members) {
      const pr = (m.user_id && profById.get(m.user_id)) || (m.email && profByEmail.get((m.email || "").toLowerCase())) || null;
      if (!pr) continue;
      const wasPending = !m.user_id;
      m.name = goodName(pr); m.username = pr.username || null; m.email = pr.email || m.email; m.color = pr.avatar_color || null;
      if (wasPending && pr.id !== myId) {
        m.user_id = pr.id; // resolve locally + queue a DB heal
        heals.push({ ledger_id: m.ledger_id, member_ref: m.member_ref, user_id: pr.id, name: m.name, username: m.username, email: (m.email || "").toLowerCase() || null });
      }
    }
    for (const h of heals) this._try("heal member", () => this.sb.from("ledger_members")
      .update({ user_id: h.user_id, name: h.name, username: h.username, email: h.email })
      .eq("ledger_id", h.ledger_id).eq("member_ref", h.member_ref));

    // my ref in each ledger = the member row whose user_id is me (and still active)
    this.myRefByLedger = {};
    for (const l of ledgers) {
      const mine = members.find((m) => m.ledger_id === l.id && m.user_id === myId && !m.has_left);
      this.myRefByLedger[l.id] = mine ? mine.member_ref : myId;
    }
    // Resolve any member_ref → current name (active, pending, or left) for display.
    const nameById = new Map();
    for (const m of members) if (m.name) nameById.set(m.member_ref, { name: m.name, email: m.email || "", username: m.username || null, userId: m.user_id || null, color: m.color || null });
    this.nameById = nameById;

    // people = every ACTIVE (accepted + not left) co-member that isn't me. Used only
    // for name resolution now — the Friends list is explicit (state.friends below).
    const myRefs = new Set(Object.values(this.myRefByLedger));
    const peopleMap = new Map();
    for (const m of members) {
      if (m.user_id === myId || myRefs.has(m.member_ref)) continue;
      if (m.has_left || !m.accepted) continue;
      if (!peopleMap.has(m.member_ref)) peopleMap.set(m.member_ref, { id: m.member_ref, name: m.name, email: m.email || "", username: m.username || null, userId: m.user_id || null, color: m.color || null });
    }
    this.state.people = [...peopleMap.values()];
    this.state.ledgers = ledgers.map((l) => {
      const myRef = this.myRefByLedger[l.id];
      const admins = l.admins || [];
      const rows = members.filter((m) => m.ledger_id === l.id);
      const seen = new Set();
      const active = rows.filter((m) => !m.has_left && m.accepted)
        .sort((a, b) => (b.user_id ? 1 : 0) - (a.user_id ? 1 : 0))
        .filter((m) => { const k = ((m.email || "").toLowerCase()) || m.user_id || m.member_ref; if (seen.has(k)) return false; seen.add(k); return true; });
      const pending = rows.filter((m) => !m.has_left && !m.accepted)
        .map((m) => ({ id: m.member_ref, name: m.name, email: m.email || "", username: m.username || null, userId: m.user_id || null }));
      return {
        id: l.id, kind: l.kind, name: l.name, baseCurrency: l.base_currency,
        parentId: l.parent_id,
        memberIds: active.map((m) => mapRef(m.member_ref, myRef, "you")),
        pendingInvites: pending,
        joinToken: l.join_token || null,
        reminder: l.reminder || { enabled: false, frequency: "weekly", lastSentAt: null, message: "" },
        tripDetails: l.trip_details || null,
        admins, createdBy: l.created_by,
        iAmAdmin: l.created_by === myId || admins.includes(myId),
        iAmOwner: l.created_by === myId,
        createdAt: new Date(l.created_at).getTime(),
      };
    });
    this.state.expenses = expenses.map((e) => ({ id: e.id, ledgerId: e.ledger_id, createdAt: new Date(e.created_at).getTime(), mine: e.created_by === myId, ...translateExpenseData(e.data, this.myRefByLedger[e.ledger_id] || myId, "you") }));

    // ---- social layer: explicit friends + incoming requests + group/trip invites ----
    this.state.friends = []; this.state.friendRequests = []; this.state.invitations = [];
    await this._try("friends", async () => {
      const { data } = await this.sb.rpc("my_friends");
      this.state.friends = (data || []).map((f) => ({ id: f.id, name: f.name || (f.email || "").split("@")[0], username: f.username || null, email: f.email || "", userId: f.id, color: f.avatar_color || null, active: f.active !== false }));
    });
    await this._try("friend requests", async () => {
      const { data } = await this.sb.rpc("my_friend_requests");
      this.state.friendRequests = (data || []).map((r) => ({ id: r.friendship_id, requester: r.requester, name: r.name || (r.email || "").split("@")[0], username: r.username || null, email: r.email || "" }));
    });
    await this._try("invitations", async () => {
      const { data } = await this.sb.rpc("my_invitations");
      this.state.invitations = (data || []).map((i) => ({ ledgerId: i.ledger_id, kind: i.kind, name: i.name, inviter: i.inviter || "Someone" }));
    });
    await this.loadChats();
    await this.loadPolls();

    // platform admins: how many signups are waiting for approval (for the red badge)
    this.state.pendingApprovals = 0;
    if (this.isPlatformAdmin) {
      await this._try("pending approvals", async () => {
        const { data } = await this.sb.rpc("list_users_admin");
        this.state.pendingApprovals = (data || []).filter((u) => !u.approved).length;
      });
    }

    this._notify();
    if (this.state.you.username) this._propagateSelf(); // refresh my copies for others
  }
  // Counts for the sidebar red-dots.
  pendingCount() { return (this.state.friendRequests?.length || 0) + (this.state.invitations?.length || 0) + (this.state.polls || []).filter((p) => p.myStatus === "invited").length; }
  pendingApprovalCount() { return this.state.pendingApprovals || 0; }
  // Re-pull just the pending queues (friend requests, invites, approvals) without a
  // full hydrate — used to refresh badges when the tab regains focus / inbox opens.
  async refreshInbox() {
    await this._try("refresh friend requests", async () => {
      const { data } = await this.sb.rpc("my_friend_requests");
      this.state.friendRequests = (data || []).map((r) => ({ id: r.friendship_id, requester: r.requester, name: r.name || (r.email || "").split("@")[0], username: r.username || null, email: r.email || "" }));
    });
    await this._try("refresh invitations", async () => {
      const { data } = await this.sb.rpc("my_invitations");
      this.state.invitations = (data || []).map((i) => ({ ledgerId: i.ledger_id, kind: i.kind, name: i.name, inviter: i.inviter || "Someone" }));
    });
    if (this.isPlatformAdmin) await this._try("refresh approvals", async () => {
      const { data } = await this.sb.rpc("list_users_admin");
      this.state.pendingApprovals = (data || []).filter((u) => !u.approved).length;
    });
    await this.loadChats();
    await this.loadPolls();
    this._notify();
  }

  // ---- messaging ----
  async loadChats() {
    await this._try("chats", async () => {
      const { data } = await this.sb.rpc("my_chats");
      this.state.chats = (data || []).map((c) => ({
        id: c.id, name: c.name || null, isGroup: !!c.is_group,
        lastBody: c.last_body || "", lastAt: c.last_at ? new Date(c.last_at).getTime() : 0,
        unread: c.unread || 0, clearedAt: c.cleared_at || null, members: c.members || [],
        disabled: !!c.disabled, // 1:1 whose other person was revoked/deleted → read-only
      })).sort((a, b) => b.lastAt - a.lastAt);
    });
    this._notify();
  }
  messagesUnread() { return (this.state.chats || []).reduce((a, c) => a + (c.unread || 0), 0); }
  chatMeta(chatId) { return (this.state.chats || []).find((c) => c.id === chatId) || null; }
  // Title for a chat: its name, else the other members' names.
  chatTitle(c) {
    if (!c) return "Chat";
    if (c.name) return c.name;
    const names = (c.members || []).map((m) => m.name).filter(Boolean);
    return names.length ? names.join(", ") : "Chat";
  }
  async startDm(userId) {
    const { data, error } = await this.sb.rpc("start_dm", { p_other: userId });
    if (error) return { ok: false, error: error.message };
    await this.loadChats();
    return { ok: true, chatId: data };
  }
  async findGroupChat(userIds) {
    try { const { data } = await this.sb.rpc("find_group_chat", { p_users: userIds }); return data || null; }
    catch { return null; }
  }
  async startGroupChat(name, userIds) {
    const { data, error } = await this.sb.rpc("start_group_chat", { p_name: name || null, p_users: userIds });
    if (error) return { ok: false, error: error.message };
    await this.loadChats();
    return { ok: true, chatId: data };
  }
  async addUserToChat(chatId, userId) {
    const { data, error } = await this.sb.rpc("add_user_to_chat", { p_chat: chatId, p_user: userId });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    await this.loadChats(); return { ok: true };
  }
  async addLedgerToChat(chatId, ledgerId) {
    const { data, error } = await this.sb.rpc("add_ledger_to_chat", { p_chat: chatId, p_ledger: ledgerId });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    await this.loadChats(); return { ok: true };
  }
  async renameChat(chatId, name) {
    const c = this.chatMeta(chatId); if (c) c.name = name || null; this._notify();
    await this._try("rename chat", () => this.sb.rpc("rename_chat", { p_chat: chatId, p_name: name || null }));
    return { ok: true };
  }
  async chatMessages(chatId) {
    const meta = this.chatMeta(chatId);
    let q = this.sb.from("messages").select("*").eq("chat_id", chatId).order("created_at", { ascending: true });
    if (meta && meta.clearedAt) q = q.gt("created_at", meta.clearedAt); // hide messages I cleared
    const { data, error } = await q;
    if (error) { console.error("[cloud] load messages failed:", error.message); return []; }
    return (data || []).map((m) => ({ id: m.id, chatId: m.chat_id, sender: m.sender, mine: m.sender === myId, body: m.body || "", deleted: !!m.deleted, editedAt: m.edited_at || null, attachments: m.attachments || null, mentions: m.mentions || null, at: m.created_at ? new Date(m.created_at).getTime() : 0, pinnedAt: m.pinned_at ? new Date(m.pinned_at).getTime() : null, pinnedBy: m.pinned_by || null }));
  }
  // Pin/unpin a message (any chat member may; capped at 15/chat server-side).
  async pinMessage(messageId, pin) {
    const { data, error } = await this.sb.rpc("set_message_pin", { p_message: messageId, p_pin: !!pin });
    if (error) return { ok: false, error: error.message };
    if (data && data.ok === false) return data;
    return { ok: true };
  }
  async sendMessage(chatId, body, attachments, mentions) {
    const meta = this.chatMeta(chatId);
    if (meta && meta.disabled) return { ok: false, error: "This person is no longer on UNO — messaging is disabled." };
    const text = (body || "").trim();
    const atts = (attachments && attachments.length) ? attachments : null;
    const mens = (mentions && mentions.length) ? mentions : null;
    if (!text && !atts) return { ok: false, error: "Empty message." };
    const { error } = await this.sb.from("messages").insert({ chat_id: chatId, sender: myId, body: text || null, attachments: atts, mentions: mens });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }
  async uploadChatFile(file) {
    try {
      const ext = (file.name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${myId}/${crypto.randomUUID()}${ext ? "." + ext : ""}`;
      const { error } = await this.sb.storage.from("chat-uploads").upload(path, file, { upsert: false, contentType: file.type || undefined });
      if (error) return { ok: false, error: error.message };
      const { data } = this.sb.storage.from("chat-uploads").getPublicUrl(path);
      return { ok: true, attachment: { url: data.publicUrl, name: file.name, type: file.type || "", size: file.size } };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }

  // ---- polls ----
  polls() { return this.state.polls || []; }
  pollsPending() {
    const now = Date.now();
    return (this.state.polls || []).filter((p) =>
      !p.closed && (!p.deadline || new Date(p.deadline).getTime() > now) &&
      (p.myStatus === "invited" || (p.myStatus === "accepted" && !p.voted))).length;
  }
  async loadPolls() {
    await this._try("polls", async () => {
      const { data } = await this.sb.rpc("my_polls");
      this.state.polls = (data || []).map((p) => ({
        id: p.id, title: p.title, kind: p.kind, closed: p.closed, deadline: p.deadline,
        isMine: p.is_mine, canManage: p.can_manage, isRunoff: p.is_runoff,
        myStatus: p.my_status, optionCount: p.option_count,
        participantCount: p.participant_count, voted: p.voted,
        createdAt: p.created_at ? new Date(p.created_at).getTime() : 0,
      }));
    });
    this._notify();
  }
  async pollDetail(pollId) {
    const { data, error } = await this.sb.rpc("poll_detail", { p_poll: pollId });
    if (error) return { error: error.message };
    return data || { error: "Not found." };
  }
  async uploadPollImage(file) {
    try {
      const ext = (file.name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${myId}/${crypto.randomUUID()}${ext ? "." + ext : ""}`;
      const { error } = await this.sb.storage.from("poll-uploads").upload(path, file, { upsert: false, contentType: file.type || undefined });
      if (error) return { ok: false, error: error.message };
      const { data } = this.sb.storage.from("poll-uploads").getPublicUrl(path);
      return { ok: true, url: data.publicUrl };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }
  async createPoll({ title, kind, multiple, addOptions, deadline, options, userIds, ledgerIds }) {
    const { data, error } = await this.sb.rpc("create_poll", {
      p_title: title, p_kind: kind, p_multiple: !!multiple, p_add_options: !!addOptions,
      p_deadline: deadline || null, p_options: options || [],
      p_users: userIds || [], p_ledgers: ledgerIds || [],
    });
    if (error) return { ok: false, error: error.message };
    // fire invite emails (best-effort)
    this._try("poll invite email", () => this.sb.functions.invoke("notify-poll", { body: { pollId: data, event: "invite" } }));
    await this.loadPolls();
    return { ok: true, pollId: data };
  }
  async addPollOption(pollId, option) {
    const { error } = await this.sb.rpc("add_poll_option", { p_poll: pollId, p_option: option });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }
  async votePoll(pollId, optionIds) {
    const { data, error } = await this.sb.rpc("vote_poll", { p_poll: pollId, p_options: optionIds || [] });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Couldn't vote." };
    await this.loadPolls();
    return { ok: true };
  }
  async respondPoll(pollId, accept) {
    const { data, error } = await this.sb.rpc("respond_poll", { p_poll: pollId, p_accept: accept });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    if (!accept) this._try("poll decline email", () => this.sb.functions.invoke("notify-poll", { body: { pollId, event: "declined" } }));
    await this.loadPolls();
    return { ok: true };
  }
  async closePoll(pollId) {
    const { data, error } = await this.sb.rpc("close_poll", { p_poll: pollId });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    if (Array.isArray(data.paths) && data.paths.length) this._try("poll image cleanup", () => this.sb.storage.from("poll-uploads").remove(data.paths));
    await this.loadPolls();
    return { ok: true };
  }
  async updatePoll(pollId, { title, deadline, multiple, addOptions }) {
    const { data, error } = await this.sb.rpc("update_poll", { p_poll: pollId, p_title: title ?? null, p_deadline: deadline || null, p_multiple: multiple, p_add_options: addOptions });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    await this.loadPolls(); return { ok: true };
  }
  async setPollAdmin(pollId, userId, add) {
    const { data, error } = await this.sb.rpc("set_poll_admin", { p_poll: pollId, p_user: userId, p_add: add });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    return { ok: true };
  }
  async updatePollOption(optionId, patch) {
    const { data, error } = await this.sb.rpc("update_poll_option", { p_option: optionId, p_patch: patch });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    return { ok: true };
  }
  async removePollOption(optionId) {
    const { data, error } = await this.sb.rpc("remove_poll_option", { p_option: optionId });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    if (data.path) this._try("poll image cleanup", () => this.sb.storage.from("poll-uploads").remove([data.path]));
    return { ok: true };
  }
  async createRunoff(pollId, deadline) {
    const { data, error } = await this.sb.rpc("create_runoff", { p_poll: pollId, p_deadline: deadline || null });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    this._try("runoff invite email", () => this.sb.functions.invoke("notify-poll", { body: { pollId: data.poll_id, event: "invite" } }));
    await this.loadPolls();
    return { ok: true, pollId: data.poll_id };
  }
  async reopenPoll(pollId) {
    const { data, error } = await this.sb.rpc("reopen_poll", { p_poll: pollId });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    await this.loadPolls();
    return { ok: true };
  }
  async deletePoll(pollId) {
    const { data, error } = await this.sb.rpc("delete_poll", { p_poll: pollId });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    if (Array.isArray(data.paths) && data.paths.length) this._try("poll image cleanup", () => this.sb.storage.from("poll-uploads").remove(data.paths));
    this.state.polls = (this.state.polls || []).filter((p) => p.id !== pollId);
    this._notify();
    return { ok: true };
  }
  async editMessage(messageId, body) {
    const text = (body || "").trim(); if (!text) return { ok: false, error: "Message can't be empty — delete it instead." };
    const { error } = await this.sb.from("messages").update({ body: text, edited_at: new Date().toISOString() }).eq("id", messageId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }
  async deleteMessage(messageId) {
    // Purge any attachment files from storage first, then soft-delete the message
    // (row stays as a "message deleted" tombstone, but body + attachments are cleared).
    try {
      const { data } = await this.sb.from("messages").select("attachments").eq("id", messageId).maybeSingle();
      const atts = data && data.attachments;
      if (Array.isArray(atts) && atts.length) {
        const paths = atts.map((a) => (a && a.url ? String(a.url).replace(/^.*\/chat-uploads\//, "") : null)).filter(Boolean);
        if (paths.length) await this._try("chat file delete", () => this.sb.storage.from("chat-uploads").remove(paths));
      }
    } catch (e) { console.error("[cloud] attachment cleanup on delete:", e.message || e); }
    const { error } = await this.sb.from("messages").update({ deleted: true, body: null, attachments: null }).eq("id", messageId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }
  async clearChat(chatId) {
    this.state.chats = (this.state.chats || []).filter((c) => c.id !== chatId); this._notify();
    await this._try("clear chat", () => this.sb.rpc("clear_chat", { p_chat: chatId }));
    return { ok: true };
  }
  // Leave a group chat. If I was the last member, the chat is deleted server-side
  // (messages + members cascade) and its attachment files are returned so we can
  // remove them from storage too.
  async leaveChat(chatId) {
    const { data, error } = await this.sb.rpc("leave_chat", { p_chat: chatId });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Couldn't leave chat." };
    if (data.deleted && Array.isArray(data.paths) && data.paths.length) {
      await this._try("chat file cleanup", () => this.sb.storage.from("chat-uploads").remove(data.paths));
    }
    this.state.chats = (this.state.chats || []).filter((c) => c.id !== chatId);
    if (this.activeChat === chatId) this.activeChat = null;
    this._notify();
    return { ok: true, deleted: !!data.deleted };
  }
  // ---- realtime (live messages + unread badges) ----
  onMessage(fn) { this.messageListeners.add(fn); return () => this.messageListeners.delete(fn); }
  startRealtime() {
    if (this._rtChannel) return;
    try {
      this._rtChannel = this.sb.channel("uno-messages")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => this._onMessageEvent(p))
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, (p) => this._onMessageEvent(p))
        .subscribe();
    } catch (e) { console.error("[cloud] realtime subscribe failed:", e.message || e); }
  }
  async _onMessageEvent(payload) {
    const row = payload.new || payload.old; if (!row) return;
    const chatId = row.chat_id;
    if (payload.eventType === "INSERT") {
      const c = this.chatMeta(chatId);
      if (!c) { await this.loadChats(); } // a new or reappearing chat
      else {
        c.lastBody = row.deleted ? "message deleted" : (row.body || "");
        c.lastAt = row.created_at ? new Date(row.created_at).getTime() : Date.now();
        if (row.sender !== myId && this.activeChat !== chatId) c.unread = (c.unread || 0) + 1;
        (this.state.chats || []).sort((a, b) => b.lastAt - a.lastAt);
      }
    } else {
      await this.loadChats(); // edits/deletes → refresh previews & counts
    }
    this._notify();
    this.messageListeners.forEach((fn) => { try { fn({ chatId, eventType: payload.eventType }); } catch {} });
  }
  async markChatRead(chatId) {
    const c = this.chatMeta(chatId); if (c) c.unread = 0; this._notify();
    await this._try("mark read", () => this.sb.rpc("mark_chat_read", { p_chat: chatId }));
  }
  // Resolve a sender uid to a display name/color within a chat.
  chatSender(chatId, uid) {
    if (uid === myId) return { id: myId, name: this.state.you.name, username: this.state.you.username, color: this.state.you.color, you: true };
    const c = this.chatMeta(chatId);
    const m = c && (c.members || []).find((x) => x.id === uid);
    return m ? { id: m.id, name: m.name, username: m.username, color: m.color } : { name: "Former member", color: null, gone: true };
  }

  // ---- reads (mirror LocalStore) ----
  allMembers() { return [this.state.you, ...this.state.people, ...(this.state.friends || [])]; }
  memberById(id) {
    const m = this.allMembers().find((x) => x.id === id);
    if (m) return m;
    const n = this.nameById && this.nameById.get(id); // pending/left member — resolve name for display
    return n ? { id, ...n } : undefined;
  }
  friends() { return this.state.friends || []; }
  async setAvatarColor(color) {
    this.state.you.color = color || null; this._notify();
    await this._try("avatar color", () => this.sb.from("profiles").update({ avatar_color: color || null }).eq("id", myId));
    return { ok: true };
  }
  async setTimezone(tz) {
    this.state.you.timezone = tz || null; this._notify();
    await this._try("timezone", () => this.sb.from("profiles").update({ timezone: tz || null }).eq("id", myId));
    return { ok: true };
  }
  // Star/unstar a group or trip. Favorites are an ordered list (order marked), kept
  // on the profile so they follow the user across devices.
  async toggleFavorite(id) {
    const you = this.state.you;
    const fav = Array.isArray(you.favorites) ? you.favorites.slice() : [];
    const i = fav.indexOf(id);
    if (i >= 0) fav.splice(i, 1); else fav.push(id);
    you.favorites = fav; this._notify();
    await this._try("favorites", () => this.sb.from("profiles").update({ favorites: fav }).eq("id", myId));
    return { ok: true };
  }
  // Start a verified email change: Supabase emails a confirmation link to the new
  // address (and, if "Secure email change" is on, the current one too). The login
  // email only changes once they click it; the app syncs profiles/member copies
  // on the next load (see hydrate).
  async changeEmail(newEmail) {
    const email = (newEmail || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "Enter a valid email address." };
    if (email === (this.state.you.email || "").toLowerCase()) return { ok: false, error: "That's already your email." };
    const { error } = await this.sb.auth.updateUser({ email }, { emailRedirectTo: appUrl() });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }
  isFriend(userId) { return !!userId && (this.state.friends || []).some((f) => f.userId === userId || f.id === userId); }
  friendLink() { return appUrl() + "?invite=" + (this.state.you.friendToken || ""); }
  ledgerLink(l) { return l && l.joinToken ? appUrl() + "?invite=" + l.joinToken : ""; }

  // ---- friends (explicit, consent-based) ----
  async sendFriendRequest(identifier) {
    try {
      const { data, error } = await this.sb.rpc("send_friend_request", { p_identifier: identifier });
      if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Couldn't send request." };
      if (data.email) {
        const type = data.status === "invited" ? "friend-invite" : "friend-request";
        this._try("friend req email", () => this.sb.functions.invoke("notify-member", { body: { type, email: data.email, name: this.state.you.name, link: this.friendLink(), inviterName: this.state.you.name } }));
      }
      return { ok: true, status: data.status };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }
  async sendFriendRequestUid(userId) {
    try {
      const { data, error } = await this.sb.rpc("send_friend_request_uid", { p_user: userId });
      if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Couldn't send request." };
      if (data.email) this._try("friend req email", () => this.sb.functions.invoke("notify-member", { body: { type: "friend-request", email: data.email, name: this.state.you.name, link: this.friendLink(), inviterName: this.state.you.name } }));
      return { ok: true, status: data.status };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }
  async acceptFriendRequest(friendshipId) {
    const { data, error } = await this.sb.rpc("accept_friend_request", { p_friendship: friendshipId });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    await this.hydrate(); return { ok: true };
  }
  async declineFriendRequest(friendshipId) {
    const { data, error } = await this.sb.rpc("decline_friend_request", { p_friendship: friendshipId });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    if (data.requester_email) this._try("decline email", () => this.sb.functions.invoke("notify-member", { body: { type: "friend-declined", email: data.requester_email, name: this.state.you.name, link: appUrl(), inviterName: this.state.you.name } }));
    await this.hydrate(); return { ok: true };
  }
  async unfriendUser(userId) {
    const { error } = await this.sb.rpc("unfriend", { p_user: userId });
    if (error) return { ok: false, error: error.message };
    await this.hydrate(); return { ok: true };
  }

  // ---- group/trip invitations ----
  async acceptInvitation(ledgerId) {
    const { data, error } = await this.sb.rpc("accept_invitation", { p_ledger: ledgerId });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    await this.hydrate(); return { ok: true };
  }
  async declineInvitation(ledgerId) {
    const { data, error } = await this.sb.rpc("decline_invitation", { p_ledger: ledgerId });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Failed." };
    if (data.inviter_email) this._try("decline invite email", () => this.sb.functions.invoke("notify-member", { body: { type: "invite-declined", email: data.inviter_email, name: this.state.you.name, groupName: data.ledger || "a group", link: appUrl(), inviterName: this.state.you.name } }));
    await this.hydrate(); return { ok: true };
  }

  // ---- shareable invite links ----
  async resolveInvite(token) {
    try { const { data } = await this.sb.rpc("resolve_invite", { p_token: token }); return data || null; }
    catch (e) { console.error("[cloud] resolve invite failed:", e.message || e); return null; }
  }
  async acceptShared(token, type) {
    const fn = type === "friend" ? "befriend_by_token" : "join_ledger_by_token";
    const { data, error } = await this.sb.rpc(fn, { p_token: token });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Couldn't accept." };
    await this.hydrate(); return { ok: true, ...data };
  }
  // Is someone with this identity already a member of the ledger? Matches on the
  // underlying user id, email, or username — not just the member_ref — so the same
  // person can't be added twice (e.g. once as a pending invite, once after signing up).
  _existingMember(l, { userId = null, email = null, username = null } = {}) {
    const em = (email || "").toLowerCase() || null;
    const un = (username || "").toLowerCase() || null;
    const cand = [...l.memberIds.map((id) => this.memberById(id)), ...(l.pendingInvites || [])];
    return cand.find((m) => m && (
      (userId && m.userId && m.userId === userId) ||
      (em && (m.email || "").toLowerCase() === em) ||
      (un && (m.username || "").toLowerCase() === un)
    ));
  }
  ledgers() { return this.state.ledgers; }
  ledgerById(id) { return this.state.ledgers.find((l) => l.id === id); }
  expensesFor(ledgerId) {
    return this.state.expenses.filter((e) => e.ledgerId === ledgerId).sort((a, b) => (b.date || 0) - (a.date || 0) || b.createdAt - a.createdAt);
  }

  // ---- helpers for member rows ----
  _memberRow(ledgerId, ref) {
    // has_left:false — (re)adding a member always makes them active again, which
    // reactivates a row they'd previously left and re-links their old expenses.
    if (ref === "you") return { ledger_id: ledgerId, member_ref: this._myRef(ledgerId), name: this.state.you.name, email: (this.state.you.email || myEmail || "").toLowerCase() || null, username: this.state.you.username || null, user_id: myId, has_left: false };
    const p = this.state.people.find((x) => x.id === ref);
    return { ledger_id: ledgerId, member_ref: ref, name: p?.name || "Friend", email: (p?.email || "").toLowerCase() || null, username: p?.username || null, user_id: p?.userId || null, has_left: false };
  }

  // If this person already has a row in this ledger (active OR left), return its
  // member_ref so we reuse it — that re-links every past expense to them instead
  // of stranding their history under an old id. Null if they've never been in it.
  async _existingRefFor(ledgerId, { userId = null, email = null }) {
    try {
      if (userId) {
        const { data } = await this.sb.from("ledger_members").select("member_ref").eq("ledger_id", ledgerId).eq("user_id", userId).limit(1);
        if (data && data.length) return data[0].member_ref;
      }
      const em = (email || "").toLowerCase();
      if (em) {
        const { data } = await this.sb.from("ledger_members").select("member_ref").eq("ledger_id", ledgerId).ilike("email", em).limit(1);
        if (data && data.length) return data[0].member_ref;
      }
    } catch (e) { console.error("[cloud] existing-ref lookup failed:", e.message || e); }
    return null;
  }

  // Keep my own name/username/email copies fresh across every ledger I'm in, so
  // other people see my real identity (not a placeholder) after I set it.
  async _propagateSelf() {
    const you = this.state.you;
    await this._try("propagate self", () => this.sb.from("ledger_members")
      .update({ name: you.name, username: you.username || null, email: (you.email || "").toLowerCase() || null })
      .eq("user_id", myId));
  }

  // Promote/demote a group or trip admin (only an admin can do this).
  async setLedgerAdmin(ledgerId, userId, makeAdmin) {
    const l = this.ledgerById(ledgerId);
    if (!l) return { ok: false, error: "Not found." };
    try {
      const { data, error } = await this.sb.rpc("set_ledger_admin", { p_ledger: ledgerId, p_user: userId, p_make: makeAdmin });
      if (error) throw error;
      if (data && data.ok) {
        l.admins = makeAdmin ? [...new Set([...(l.admins || []), userId])] : (l.admins || []).filter((x) => x !== userId);
        l.iAmAdmin = l.createdBy === myId || l.admins.includes(myId);
        this._notify();
        return { ok: true };
      }
      return { ok: false, error: (data && data.error) || "Couldn't update admin." };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }

  // ---- platform admin: approve / revoke new signups ----
  // Fetches fresh from the DB each call, so once any admin approves someone the
  // others see the current state (an approved person leaves the pending list).
  async listUsersAdmin() {
    const { data, error } = await this.sb.rpc("list_users_admin");
    if (error) { console.error("[cloud] list users failed:", error.message); return []; }
    return (data || []).map((u) => ({
      id: u.id, email: u.email || "", username: u.username || null,
      name: u.display_name || (u.email || "").split("@")[0] || "User",
      approved: !!u.approved, createdAt: u.created_at,
    }));
  }
  async setUserApproved(userId, approved, userEmail, userName) {
    try {
      const { data, error } = await this.sb.rpc("set_user_approved", { p_user: userId, p_approved: approved });
      if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Couldn't update." };
      if (approved && userEmail) {
        this._try("approve email", () => this.sb.functions.invoke("notify-member", {
          body: { type: "approval-granted", email: userEmail, name: userName || "", link: appUrl(), inviterName: "UNO" },
        }));
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }
  async rejectUser(userId) {
    try {
      const { data, error } = await this.sb.rpc("reject_user", { p_user: userId });
      if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Couldn't reject." };
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }

  // Add an existing friend (already in your people list) to a ledger.
  async addFriendToLedger(ledgerId, personId) {
    const l = this.ledgerById(ledgerId);
    const person = this.memberById(personId);
    if (!l || !person || l.memberIds.includes(personId)) return { ok: false };
    await this._pendingWrites?.[ledgerId]; // make sure the ledger row exists first
    // If this friend still looks "pending" but has an email, they may have
    // signed up since — re-check so we add them as a full member, not pending.
    if (!person.userId && person.email) {
      try {
        const { data } = await this.sb.rpc("find_member", { p_identifier: person.email });
        const u = Array.isArray(data) ? data[0] : data;
        if (u && u.id !== myId) { person.userId = u.id; if (u.username) person.username = u.username; if (u.display_name) person.name = u.display_name; }
      } catch (e) { console.error("[cloud] re-resolve friend failed:", e.message || e); }
    }
    // Don't add the same underlying person twice (e.g. once pending, once signed up).
    const already = this._existingMember(l, { userId: person.userId, email: person.email, username: person.username });
    if (already) return { ok: false, name: already.name, already: true };
    // reuse their prior member_ref here (if they were once in this ledger) so a
    // rejoin re-links all their past expenses. Reactivates the row (has_left:false).
    const ref = (await this._existingRefFor(ledgerId, { userId: person.userId, email: person.email })) || personId;
    const pendingInvite = l.kind !== "individual";
    if (pendingInvite) { (l.pendingInvites = l.pendingInvites || []).push({ id: ref, name: person.name, email: person.email || "", username: person.username || null, userId: person.userId || null }); }
    else { l.memberIds = [...new Set([...l.memberIds, ref])]; }
    this._notify();
    const row = { ledger_id: ledgerId, member_ref: ref, name: person.name, email: (person.email || "").toLowerCase() || null, username: person.username || null, user_id: person.userId || null, has_left: false, accepted: !pendingInvite };
    await this._try("add friend to ledger", () => this.sb.from("ledger_members").upsert(row, { onConflict: "ledger_id,member_ref" }));
    const emailed = person.email ? await this._notifyMember(pendingInvite ? "invite" : "added", person.email, person.name, l.name, l.kind === "individual" ? "friend" : "group") : false;
    return { ok: true, emailed, name: person.name, pending: pendingInvite };
  }

  // ---- usernames ----
  async usernameAvailable(name) {
    try { const { data, error } = await this.sb.rpc("username_available", { p_username: name }); if (error) throw error; return !!data; }
    catch (e) { console.error("[cloud] username check failed:", e.message || e); return false; }
  }
  async setUsername(name) {
    try {
      const { data, error } = await this.sb.rpc("set_username", { p_username: name });
      if (error) throw error;
      if (data && data.ok) {
        this.state.you.username = data.username;
        // If they never set a real display name (it's blank or just the email
        // prefix), use the username so friends see something meaningful.
        const prefix = (myEmail || "").split("@")[0];
        if (!this.state.you.name || this.state.you.name === prefix) {
          this.state.you.name = data.username;
          this._try("set display name", () => this.sb.from("profiles").update({ display_name: data.username }).eq("id", myId));
        }
        this._notify();
        await this._propagateSelf();
        return { ok: true };
      }
      return { ok: false, error: (data && data.error) || "Couldn't set username." };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }

  // Add a member by EMAIL or @USERNAME. Existing users join instantly; a new
  // email becomes a pending invite (auto-join on signup). A username that
  // doesn't exist can't be invited (there's no address to send to).
  async addMemberByEmail(ledgerId, rawInput) {
    const input = (rawInput || "").trim();
    const l = this.ledgerById(ledgerId);
    if (!l) return { status: "error", message: "Group not found." };
    if (!input) return { status: "error", message: "Enter an email or @username." };
    await this._pendingWrites?.[ledgerId]; // make sure the ledger row exists first
    const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input);
    const handle = input.replace(/^@/, "").toLowerCase();
    const email = isEmail ? input.toLowerCase() : null;

    // look the person up (email or username, secure exact match)
    let user = null;
    try {
      const { data, error } = await this.sb.rpc("find_member", { p_identifier: isEmail ? email : handle });
      if (error) throw error;
      user = Array.isArray(data) ? data[0] : data;
    } catch (e) { console.error("[cloud] user lookup failed:", e.message || e); }

    if (user && user.id === myId) return { status: "exists", message: "That's you — you're already in this group." };
    if (user) {
      const already = l.memberIds.includes(user.id) ? this.memberById(user.id)
        : this._existingMember(l, { userId: user.id, email: user.email || email, username: user.username });
      if (already) return { status: "exists", message: `${already.name || user.display_name || "They"} are already in this group.` };
      const label = user.display_name || user.username || (email ? email.split("@")[0] : handle);
      const resolvedEmail = email || user.email || ""; // works whether added by email or username
      // reuse their prior member_ref here (if they were once in this ledger) so
      // rejoining re-links all their past expenses instead of starting fresh.
      const ref = (await this._existingRefFor(ledgerId, { userId: user.id, email: resolvedEmail })) || user.id;
      let person = this.state.people.find((p) => p.id === ref) || this.state.people.find((p) => p.userId === user.id)
        || { id: ref, name: label, email: resolvedEmail, username: user.username || null, userId: user.id };
      person.id = ref; person.userId = user.id; if (resolvedEmail) person.email = resolvedEmail; if (user.username) person.username = user.username;
      const pendingInvite = l.kind !== "individual"; // groups/trips must be accepted; 1:1 is instant
      if (pendingInvite) { (l.pendingInvites = l.pendingInvites || []).push({ id: ref, name: person.name, email: person.email || "", username: person.username || null, userId: person.userId || null }); }
      else { if (!this.state.people.includes(person)) this.state.people.push(person); l.memberIds = [...new Set([...l.memberIds, ref])]; }
      this._notify();
      await this._try("add member", () => this.sb.from("ledger_members").upsert({ ...this._memberRow(ledgerId, ref), name: person.name, email: (person.email || "").toLowerCase() || null, username: person.username || null, user_id: person.userId || null, accepted: !pendingInvite }, { onConflict: "ledger_id,member_ref" }));
      const emailed = person.email ? await this._notifyMember(pendingInvite ? "invite" : "added", person.email, person.name, l.name, l.kind === "individual" ? "friend" : "group") : false;
      return { status: "added", name: person.name, emailed, pending: pendingInvite };
    }

    // not found
    if (!isEmail) return { status: "error", message: `No one has the username @${handle}. To invite someone new, use their email instead.` };
    const dupe = this._existingMember(l, { email });
    if (dupe) return { status: "exists", message: `${dupe.name} is already in this group.` };
    const ref = crypto.randomUUID();
    const person = { id: ref, name: email.split("@")[0], email, username: null, userId: null };
    const pendingInvite = l.kind !== "individual";
    if (pendingInvite) { (l.pendingInvites = l.pendingInvites || []).push(person); }
    else { this.state.people.push(person); l.memberIds = [...new Set([...l.memberIds, ref])]; }
    this._notify();
    await this._try("invite", () => this.sb.from("ledger_members").insert({ ...this._memberRow(ledgerId, ref), accepted: !pendingInvite }));
    const emailed = await this._notifyMember("invite", email, person.name, l.name, l.kind === "individual" ? "friend" : "group");
    return { status: "invited", email, name: person.name, link: appUrl(), emailed };
  }

  // Fire the notify-member edge function; returns true if the email was sent.
  async _notifyMember(type, email, name, groupName, context = "group") {
    try {
      const { data, error } = await this.sb.functions.invoke("notify-member", {
        body: { type, email, name, groupName, context, inviterName: this.state.you.name, link: appUrl() },
      });
      if (error) throw error;
      return data?.ok !== false;
    } catch (e) { console.error("[cloud] notify-member failed:", e.message || e); return false; }
  }

  // ---- people ----
  addPerson({ name, email }) {
    const p = { id: crypto.randomUUID(), name: name.trim(), email: (email || "").trim() };
    this.state.people.push(p); this._notify();
    return p; // persists to DB when added to a ledger
  }
  updatePerson(id, patch) {
    if (id === "you") {
      Object.assign(this.state.you, patch); this._notify();
      this._try("profile update", () => this.sb.from("profiles").update({ display_name: this.state.you.name, email: this.state.you.email }).eq("id", myId));
      this._try("member self update", () => this.sb.from("ledger_members").update({ name: this.state.you.name, email: this.state.you.email }).eq("user_id", myId));
      return;
    }
    const p = this.state.people.find((x) => x.id === id);
    if (p) { Object.assign(p, patch); this._notify(); this._try("member update", () => this.sb.from("ledger_members").update({ name: p.name, email: p.email }).eq("member_ref", id)); }
  }
  removePerson(id) {
    this.state.people = this.state.people.filter((p) => p.id !== id);
    this.state.ledgers.forEach((l) => (l.memberIds = l.memberIds.filter((m) => m !== id)));
    this._notify();
    this._try("member remove", () => this.sb.from("ledger_members").delete().eq("member_ref", id));
  }

  // ---- ledgers ----
  addLedger({ kind, name, baseCurrency = "USD", memberIds = [], parentId = null }) {
    const id = crypto.randomUUID();
    const l = { id, kind, name: name.trim(), baseCurrency, memberIds: [...new Set(["you", ...memberIds])], parentId, reminder: { enabled: false, frequency: "weekly", lastSentAt: null, message: "" }, admins: [], createdBy: myId, iAmAdmin: true, iAmOwner: true, createdAt: Date.now() };
    this.myRefByLedger[id] = myId; // I created it, so my ref here is my auth id
    this.state.ledgers.push(l); this._notify();
    // Track the create so member writes can wait for the ledger row to exist first
    // (otherwise adding a friend right after creating the 1:1 ledger can hit a
    // foreign-key race and silently drop the friend's membership row).
    this._pendingWrites = this._pendingWrites || {};
    this._pendingWrites[id] = this._try("ledger insert", async () => {
      await this.sb.from("ledgers").insert({ id, kind, name: l.name, base_currency: baseCurrency, parent_id: parentId, reminder: l.reminder, created_by: myId });
      await this.sb.from("ledger_members").insert(l.memberIds.map((ref) => this._memberRow(id, ref)));
    });
    return l;
  }
  updateLedger(id, patch) {
    const l = this.ledgerById(id); if (!l) return;
    const oldMembers = new Set(l.memberIds);
    Object.assign(l, patch); this._notify();
    this._try("ledger update", async () => {
      await this.sb.from("ledgers").update({ name: l.name, base_currency: l.baseCurrency, parent_id: l.parentId, reminder: l.reminder }).eq("id", id);
      if (patch.memberIds) {
        const now = new Set(l.memberIds);
        const added = [...now].filter((x) => !oldMembers.has(x));
        const removed = [...oldMembers].filter((x) => !now.has(x));
        if (added.length) await this.sb.from("ledger_members").upsert(added.map((ref) => this._memberRow(id, ref)), { onConflict: "ledger_id,member_ref" });
        for (const ref of removed) await this.sb.from("ledger_members").delete().eq("ledger_id", id).eq("member_ref", ref === "you" ? this._myRef(id) : ref);
      }
    });
  }
  // Definitive delete via RPC: succeeds for the owner, the original founder, an
  // admin of an ownerless group, or any dead (no-active-member) group. On failure
  // we re-hydrate so a blocked delete can't leave a "ghost" removed from the UI
  // but alive in the DB (which is what made deleted groups reappear).
  async removeLedger(id) {
    const { data, error } = await this.sb.rpc("delete_ledger", { p_ledger: id });
    if (error || !(data && data.ok)) { await this.hydrate(); return { ok: false, error: (data && data.error) || error?.message || "Couldn't delete." }; }
    this.state.ledgers = this.state.ledgers.filter((l) => l.id !== id && l.parentId !== id);
    this.state.expenses = this.state.expenses.filter((e) => e.ledgerId !== id);
    this._notify();
    return { ok: true };
  }

  // Save a trip's details (creator/admins only — enforced server-side by set_trip_details).
  async setTripDetails(ledgerId, details) {
    const { data, error } = await this.sb.rpc("set_trip_details", { p_ledger: ledgerId, p_details: details });
    if (error) return { ok: false, error: error.message };
    if (data && data.ok === false) return data;
    const l = this.ledgerById(ledgerId);
    if (l) { l.tripDetails = details; this._notify(); }
    return { ok: true };
  }

  // Leave a group/trip (works for owners too — ownership hands off server-side).
  async leaveLedger(ledgerId) {
    const l = this.ledgerById(ledgerId);
    if (!l) return { ok: false, error: "Not found." };
    this.state.ledgers = this.state.ledgers.filter((x) => x.id !== ledgerId); // drop from my view
    this.state.expenses = this.state.expenses.filter((e) => e.ledgerId !== ledgerId);
    this._notify();
    const { data, error } = await this.sb.rpc("leave_ledger", { p_ledger: ledgerId });
    if (error || !(data && data.ok)) { await this.hydrate(); return { ok: false, error: (data && data.error) || error?.message || "Couldn't leave." }; }
    return { ok: true };
  }

  // Owner hands ownership of a group/trip to another active member.
  async transferOwnership(ledgerId, userId) {
    const { data, error } = await this.sb.rpc("transfer_ownership", { p_ledger: ledgerId, p_user: userId });
    if (error || !(data && data.ok)) return { ok: false, error: (data && data.error) || error?.message || "Couldn't transfer." };
    await this.hydrate(); return { ok: true };
  }

  // Admin cancels a pending invitation (removes the not-yet-accepted member row).
  async cancelInvite(ledgerId, ref) {
    const l = this.ledgerById(ledgerId);
    if (l) l.pendingInvites = (l.pendingInvites || []).filter((p) => p.id !== ref);
    this._notify();
    await this._try("cancel invite", () => this.sb.from("ledger_members").delete().eq("ledger_id", ledgerId).eq("member_ref", ref));
    return { ok: true };
  }

  // ---- expenses ----
  addExpense(exp) {
    const id = crypto.randomUUID();
    const e = { id, createdAt: Date.now(), mine: true, ...exp };
    this.state.expenses.push(e); this._notify();
    const { ledgerId, ...rest } = e; const { id: _i, mine: _m, createdAt: _c, ...data } = rest;
    this._try("expense insert", () => this.sb.from("expenses").insert({ id, ledger_id: ledgerId, data: translateExpenseData(data, "you", this._myRef(ledgerId)), created_by: myId }));
    return e;
  }
  updateExpense(id, patch) {
    const e = this.state.expenses.find((x) => x.id === id); if (!e) return;
    Object.assign(e, patch); this._notify();
    const { ledgerId, id: _i, createdAt, mine, ...data } = e;
    this._try("expense update", () => this.sb.from("expenses").update({ data: translateExpenseData(data, "you", this._myRef(ledgerId)) }).eq("id", id));
  }
  removeExpense(id) {
    this.state.expenses = this.state.expenses.filter((e) => e.id !== id); this._notify();
    this._try("expense delete", () => this.sb.from("expenses").delete().eq("id", id));
  }

  exportJSON() { return JSON.stringify(this.state, null, 2); }
  importJSON() { throw new Error("Import isn't available in cloud mode — data already lives in your Supabase project."); }
  reset() { throw new Error("Erase-all is disabled in cloud mode. Delete ledgers individually, or drop the tables in Supabase."); }
}

// ================= login screen =================
function loginScreen(onGoogle, onMagic) {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand"><img src="./assets/logo.svg" alt="UNO" style="width:44px;height:44px;border-radius:10px"><h1>UNO</h1><p>one place. one us.</p></div>
        <button class="btn google-btn" id="gBtn">
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35 24 35c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 5.1 29.5 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21c10.5 0 20-7.6 20-21 0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.5 5.1 29.5 3 24 3 16 3 9.1 7.6 6.3 14.7z"/><path fill="#4CAF50" d="M24 45c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35.5 26.7 36 24 36c-5.3 0-9.7-2.6-11.3-6.9l-6.5 5C9.1 40.4 16 45 24 45z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.5l6.3 5.3C41.6 36.6 44 31 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>
          Continue with Google
        </button>
        <div class="login-or"><span>or</span></div>
        <label>Email — we'll send you a magic sign-in link</label>
        <input id="mEmail" type="email" placeholder="you@example.com" autocomplete="email">
        ${TURNSTILE_SITE_KEY ? `<div id="cfTurnstile" style="margin-top:10px;display:flex;justify-content:center"></div>` : ""}
        <button class="btn" id="mBtn" style="width:100%;margin-top:10px">Send magic link</button>
        <div id="loginMsg" class="login-msg"></div>
      </div>
    </div>`;
  document.getElementById("gBtn").onclick = onGoogle;
  document.getElementById("mBtn").onclick = () => {
    const email = document.getElementById("mEmail").value.trim();
    if (!email) { document.getElementById("loginMsg").textContent = "Enter your email first."; return; }
    if (TURNSTILE_SITE_KEY && !_captchaToken) { loginMsg("Please complete the “I’m human” check first."); return; }
    onMagic(email);
  };
  mountTurnstile();
}
function loginMsg(text, ok) { const el = document.getElementById("loginMsg"); if (el) { el.textContent = text; el.className = "login-msg " + (ok ? "ok" : "err"); } }

// ================= boot entry =================
// Returns true when authenticated + hydrated (app should render), false when the
// login screen is showing (app should NOT render).
export async function startCloud() {
  const sb = await getClient();
  // Capture a shareable invite token (?invite=…) and remember it across sign-up/redirect.
  try { const t = new URL(window.location.href).searchParams.get("invite"); if (t) localStorage.setItem("uno.inviteToken", t); } catch {}
  const { data: { session } } = await sb.auth.getSession();

  if (!session) {
    loginScreen(
      async () => {
        loginMsg("Redirecting to Google…", true);
        await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.href.split("#")[0] } });
      },
      async (email) => {
        loginMsg("Sending link…", true);
        const { error } = await sb.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.href.split("#")[0], captchaToken: _captchaToken || undefined },
        });
        loginMsg(error ? ("Couldn't send: " + error.message) : "✅ Check your inbox for the sign-in link, then come back here.", !error);
        resetTurnstile(); // each attempt needs a fresh token
      }
    );
    // when auth completes (magic link click / OAuth return) reload to re-run boot
    sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_IN") window.location.reload(); });
    // let them know why they landed back here, if it was an idle timeout
    try { if (localStorage.getItem("uno.idleOut")) { localStorage.removeItem("uno.idleOut"); loginMsg(`You were signed out after ${IDLE_MINUTES} minutes of inactivity. Sign in again to continue.`, true); } } catch {}
    return false;
  }

  myId = session.user.id;
  myEmail = session.user.email || "";
  const youName = session.user.user_metadata?.full_name || session.user.user_metadata?.name || (myEmail ? myEmail.split("@")[0] : "You");

  // Invite-only gate: make sure a profile row exists, then check approval.
  // Fail-open if approvals.sql isn't installed yet (so nothing breaks pre-migration).
  await ensureOwnProfile(sb, youName);
  const appr = await sb.rpc("am_i_approved");
  const approved = appr.error ? true : (appr.data === true);
  const adm = await sb.rpc("is_platform_admin");
  const isAdmin = adm.data === true;
  if (!approved) {
    notifyAdminsOfSignup(sb, { id: myId, name: youName, email: myEmail }); // best-effort
    pendingScreen({ email: myEmail });
    return false;
  }

  const store = new CloudStore(sb);
  store.isPlatformAdmin = isAdmin;
  store.state.you.name = youName;
  store.state.you.email = myEmail;
  setStore(store);
  await store.hydrate();

  // If they arrived via a shareable invite link, show the accept/decline screen.
  let inviteTok = null;
  try { inviteTok = localStorage.getItem("uno.inviteToken"); } catch {}
  if (inviteTok) {
    const info = await store.resolveInvite(inviteTok);
    if (info && info.type) { inviteAcceptScreen(store, inviteTok, info); return false; }
    try { localStorage.removeItem("uno.inviteToken"); } catch {} // invalid/expired
  }

  startIdleLogout(); // begin the inactivity countdown
  return true;
}

export async function signOut() {
  const sb = await getClient();
  // Forget the last page so the NEXT sign-in starts fresh on the Dashboard.
  // (A plain refresh keeps its session and still restores the last page.)
  try { localStorage.removeItem("uno.view"); } catch {}
  await sb.auth.signOut();
  window.location.reload();
}
