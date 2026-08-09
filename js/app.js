// app.js — UI controller for UNO Ledger.
import { store } from "./store.js";
import { CONFIG } from "./config.js";
import { startCloud, signOut } from "./cloud.js";
import { CURRENCIES, formatMoney, toMinor, toMajor, currencyFactor, currencyDigits } from "./money.js";
import { computeOwed, computePaid, computeBalances, settleUp, validateExpense } from "./split.js";

const CATEGORIES = {
  general: "🧾", food: "🍽️", groceries: "🛒", drinks: "🍺", lodging: "🏨",
  transport: "🚕", flights: "✈️", fuel: "⛽", tickets: "🎟️", shopping: "🛍️",
  fun: "🎉", gifts: "🎁", medical: "💊", settle: "✅",
};
const FREQ = { daily: "Every day", every3: "Every 3 days", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };
const CLOUD = CONFIG.MODE === "cloud"; // cloud mode = accounts; add people by email only

let view = { type: "dashboard", ledgerId: null, tab: "expenses" };
let _chatHook = null; // set by renderChat so realtime can live-update the open thread
function onRealtime(evt) {
  updateInboxBadge();
  if (view.type === "chat") { if (_chatHook) _chatHook(evt); }
  else if (view.type === "messages") renderMessages();
}

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (name) => (name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const fmtBytes = (n) => { n = Number(n) || 0; if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(0) + " KB"; return (n / 1048576).toFixed(1) + " MB"; };
// Highlight @mentions in a message body. Longest labels first so overlapping names don't partial-match.
function renderMsgBody(text, mentions) {
  let html = esc(text);
  const ms = (mentions || []).slice().sort((a, b) => (b.label || "").length - (a.label || "").length);
  for (const mn of ms) {
    if (!mn.label) continue;
    const token = "@" + esc(mn.label);
    html = html.split(token).join(`<span class="mention">@${esc(mn.label)}</span>`);
  }
  return html;
}
// profile-thumbnail colors people can pick from
const AVATAR_COLORS = ["#2f6fd6", "#8A2432", "#D8A32B", "#2ecc71", "#7b5cff", "#e0559b", "#0ea5a5", "#e67e22", "#6B7280", "#111827"];
const avColor = (m) => (m && m.color) || "#2f6fd6";
const avatarEl = (m, { cls = "", attrs = "" } = {}) => `<div class="avatar ${cls}" style="background:${avColor(m)}"${attrs ? " " + attrs : ""}>${esc(initials(m?.name))}</div>`;
const kindLabel = { group: "Group", trip: "Trip", individual: "Friend" };
const kindIcon = { group: "👨‍👩‍👧", trip: "🧳", individual: "🧍" };

// ---- trip→group rollup: a group's pages include expenses from its trips ----
function childrenOf(l) { return store.ledgers().filter((x) => x.parentId === l.id); }
function rolledExpenses(l) {
  if (l.kind === "group") {
    const kids = childrenOf(l);
    return [l, ...kids].flatMap((x) => store.expensesFor(x.id).map((e) => (x.id === l.id ? e : { ...e, _tripName: x.name })));
  }
  return store.expensesFor(l.id);
}
function rolledMemberIds(l) {
  if (l.kind === "group") return [...new Set([...l.memberIds, ...childrenOf(l).flatMap((k) => k.memberIds)])];
  return l.memberIds;
}
// A 1:1 ledger shows the OTHER person's name to each side (so it reads correctly
// for both people), falling back to the stored label.
function otherMember(l) {
  if (l.kind !== "individual") return null;
  const otherId = l.memberIds.find((id) => id !== "you");
  return otherId ? store.memberById(otherId) : null;
}
function ledgerDisplayName(l) {
  if (l.kind === "individual") { const o = otherMember(l); if (o) return o.name; }
  return l.name;
}

// Pairwise net between you and one friend across a set of expenses, in `base`.
// Positive = the friend owes you; negative = you owe the friend.
function netBetween(friendId, expenses, base) {
  let major = 0;
  for (const e of expenses) {
    const cur = e.currency || base, fx = typeof e.fxToBase === "number" ? e.fxToBase : 1;
    const add = (minor) => { major += toMajor(minor, cur) * fx; };
    if (e.settlement) {
      if (e.from === "you" && e.to === friendId) add(e.amountMinor);
      else if (e.from === friendId && e.to === "you") add(-e.amountMinor);
      continue;
    }
    const owed = computeOwed(e), paid = computePaid(e);
    const totalPaid = [...paid.values()].reduce((a, b) => a + b, 0) || e.amountMinor;
    const myPaid = paid.get("you") || 0, fPaid = paid.get(friendId) || 0;
    if (myPaid) add(Math.round((owed.get(friendId) || 0) * (myPaid / totalPaid)));   // friend owes you
    if (fPaid) add(-Math.round((owed.get("you") || 0) * (fPaid / totalPaid)));        // you owe friend
  }
  return Math.round(major * currencyFactor(base));
}
// Your net with a friend across every ledger you share, per base currency.
function friendNet(friendId) {
  const byCur = {};
  for (const l of store.ledgers()) {
    if (l.kind === "trip" && l.parentId && store.ledgerById(l.parentId)) continue;
    if (!rolledMemberIds(l).includes(friendId)) continue;
    const n = netBetween(friendId, rolledExpenses(l), l.baseCurrency);
    if (n) byCur[l.baseCurrency] = (byCur[l.baseCurrency] || 0) + n;
  }
  return byCur;
}
// Am I an (effective) admin of this ledger? A trip inherits its parent group's
// admins while it's tagged to that group.
function iAmAdminOf(l) {
  if (!l) return false;
  if (l.iAmAdmin) return true;
  if (l.kind === "trip" && l.parentId) { const p = store.ledgerById(l.parentId); return !!(p && p.iAmAdmin); }
  return false;
}
// The most recent pay-to details a person provided on an expense they paid.
function payToFor(personId, exps) {
  const rel = (exps || []).filter((e) => !e.settlement && e.paymentInfo && computePaid(e).has(personId))
    .sort((a, b) => (b.date || b.createdAt || 0) - (a.date || a.createdAt || 0));
  return rel.length ? rel[0].paymentInfo : "";
}
// Can I edit/delete this expense? Its creator always can; so can an admin of the
// expense's own ledger (or its parent group). Local mode is single-user → yes.
function canEditExpense(e) {
  if (!CLOUD) return true;
  const l = store.ledgerById(e.ledgerId);
  return !!(e.mine || iAmAdminOf(l));
}

// Ledgers you share with a friend (top-level; groups include their trips).
function sharedLedgers(friendId) {
  return store.ledgers().filter((l) => {
    if (l.kind === "trip" && l.parentId && store.ledgerById(l.parentId)) return false;
    return rolledMemberIds(l).includes(friendId);
  });
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- sidebar ----------
function youNet() {
  // aggregate "you" net across all ledgers, in each ledger's base currency.
  // Skip trips that belong to a group — their value is counted inside the group.
  const byCur = {};
  for (const l of store.ledgers()) {
    if (l.kind === "trip" && l.parentId && store.ledgerById(l.parentId)) continue;
    const { base } = computeBalances(rolledExpenses(l), l.baseCurrency);
    const n = base.get("you") || 0;
    byCur[l.baseCurrency] = (byCur[l.baseCurrency] || 0) + n;
  }
  return byCur;
}

function renderSidebar() {
  const you = store.state.you;
  const nets = youNet();
  const netStr = Object.keys(nets).length
    ? Object.entries(nets).filter(([, v]) => v !== 0).map(([c, v]) => `<span class="${v >= 0 ? "pos" : "neg"}">${v >= 0 ? "owed " : "owe "}${formatMoney(Math.abs(v), c)}</span>`).join(" · ") || "all settled up ✨"
    : "no activity yet";
  $("#youCard").innerHTML = `
    <div style="display:flex;align-items:center;gap:9px">
      ${avatarEl(you)}
      <div><div style="font-weight:600">${esc(you.name)}${CLOUD && you.username ? ` <span class="exp-meta">@${esc(you.username)}</span>` : (you.email ? "" : ' <span class="tag">add email</span>')}</div>
      <div class="you-net">${netStr}</div></div>
    </div>`;
  $("#youCard").onclick = () => openPersonModal("you");

  const groups = store.ledgers().filter((l) => l.kind === "group");
  const trips = store.ledgers().filter((l) => l.kind === "trip");
  fillList("#groupList", groups);
  fillList("#tripList", trips);

  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view.type || (view.type === "friend" && b.dataset.view === "friends")));
  updateInboxBadge();
}

function fillList(sel, ledgers) {
  const el = $(sel);
  if (!ledgers.length) { el.innerHTML = `<div class="empty">none yet</div>`; return; }
  el.innerHTML = ledgers.map((l) => {
    const { base } = computeBalances(rolledExpenses(l), l.baseCurrency);
    const n = base.get("you") || 0;
    const badge = n === 0 ? "" : `<span class="badge ${n > 0 ? "owed" : "owe"}">${n > 0 ? "+" : ""}${formatMoney(n, l.baseCurrency)}</span>`;
    return `<button data-ledger="${l.id}" class="${view.ledgerId === l.id ? "active" : ""}">${kindIcon[l.kind]} <span>${esc(ledgerDisplayName(l))}</span>${badge}</button>`;
  }).join("");
  el.querySelectorAll("[data-ledger]").forEach((b) => b.onclick = () => { view = { type: "ledger", ledgerId: b.dataset.ledger, tab: "expenses" }; setSidebar(false); render(); });
}

// ---------- dashboard ----------
function renderDashboard() {
  const main = $("#main");
  const ledgers = store.ledgers();
  const nets = youNet();
  const owed = Object.entries(nets).filter(([, v]) => v > 0);
  const owe = Object.entries(nets).filter(([, v]) => v < 0);
  const fmtSum = (arr) => arr.length ? arr.map(([c, v]) => formatMoney(Math.abs(v), c)).join(" · ") : formatMoney(0);

  main.innerHTML = `
    ${mobileBar()}
    <div class="page-head">
      <div><h1 class="page-title">🏠 Dashboard</h1><p class="page-sub">Everything you're splitting, in one place.</p></div>
      <button class="btn" id="quickAdd">＋ Add expense</button>
    </div>
    <div class="grid cards-3" style="margin-top:14px">
      <div class="card stat"><div class="label">You are owed</div><div class="value pos">${fmtSum(owed)}</div></div>
      <div class="card stat"><div class="label">You owe</div><div class="value neg">${fmtSum(owe)}</div></div>
      <div class="card stat"><div class="label">Active ledgers</div><div class="value">${ledgers.length}</div></div>
    </div>
    <h3 style="margin:26px 0 10px">Your groups, trips & friends</h3>
    <div id="dashList"></div>`;

  const list = $("#dashList");
  if (!ledgers.length) {
    list.innerHTML = emptyState("🧳", "Nothing here yet", "Create a group for your friend circle, a trip for your next getaway, or a 1:1 ledger with one friend.",
      `<div class="row" style="max-width:420px;margin:14px auto 0">
        <button class="btn" data-new="trip">🧳 New trip</button>
        <button class="btn ghost" data-new="group">👨‍👩‍👧 New group</button>
      </div>`);
  } else {
    list.innerHTML = ledgers.map((l) => {
      const { base } = computeBalances(rolledExpenses(l), l.baseCurrency);
      const n = base.get("you") || 0;
      const count = rolledExpenses(l).filter((e) => !e.settlement).length;
      const parent = l.parentId ? store.ledgerById(l.parentId) : null;
      return `<div class="exp-row" data-ledger="${l.id}" style="cursor:pointer">
        <div class="exp-cat">${kindIcon[l.kind]}</div>
        <div class="exp-main"><div class="exp-desc">${esc(ledgerDisplayName(l))}${parent ? ` <span class="tag">in ${esc(parent.name)}</span>` : ""}</div>
          <div class="exp-meta">${kindLabel[l.kind]} · ${rolledMemberIds(l).length} people · ${count} expense${count === 1 ? "" : "s"} · ${l.baseCurrency}</div></div>
        <div class="exp-amt"><div class="${n >= 0 ? "pos" : "neg"}">${n === 0 ? "settled" : (n > 0 ? "you're owed " : "you owe ") + formatMoney(Math.abs(n), l.baseCurrency)}</div></div>
      </div>`;
    }).join("");
    list.querySelectorAll("[data-ledger]").forEach((b) => b.onclick = () => { view = { type: "ledger", ledgerId: b.dataset.ledger, tab: "expenses" }; render(); });
  }
  main.querySelectorAll("[data-new]").forEach((b) => b.onclick = () => openLedgerModal(b.dataset.new));
  $("#quickAdd").onclick = () => { if (!ledgers.length) return toast("Create a trip or group first."); openExpenseModal(ledgers[0].id); };
  wireMobile();
}

// ---------- friends hub ----------
const sumAbs = (byCur) => Object.values(byCur).reduce((a, b) => a + Math.abs(b), 0);
const netToStr = (net, verbYou = "you owe ", verbThem = "owes you ") =>
  Object.keys(net).length && Object.values(net).some((v) => v !== 0)
    ? Object.entries(net).filter(([, v]) => v !== 0).map(([c, v]) => `<span class="${v >= 0 ? "pos" : "neg"}">${v > 0 ? verbThem : verbYou}${formatMoney(Math.abs(v), c)}</span>`).join(" · ")
    : `<span class="exp-meta">settled up</span>`;

function renderFriends() {
  const main = $("#main");
  const people = (CLOUD ? store.friends() : store.state.people).slice();
  const rows = people.map((m) => ({ m, net: friendNet(m.id) })).sort((a, b) => sumAbs(b.net) - sumAbs(a.net));
  const owed = {}, owe = {};
  rows.forEach((r) => Object.entries(r.net).forEach(([c, v]) => { if (v > 0) owed[c] = (owed[c] || 0) + v; else if (v < 0) owe[c] = (owe[c] || 0) + v; }));
  const fmtSum = (o) => Object.keys(o).length ? Object.entries(o).map(([c, v]) => formatMoney(Math.abs(v), c)).join(" · ") : formatMoney(0);
  const reqCount = CLOUD ? (store.state.friendRequests || []).length : 0;

  main.innerHTML = `
    ${mobileBar()}
    <div class="page-head">
      <div><h1 class="page-title">🧑‍🤝‍🧑 Friends</h1><p class="page-sub">People you've added and accepted.</p></div>
      ${CLOUD ? '<div style="display:flex;gap:8px"><button class="btn ghost" id="myLinkBtn">🔗 My link</button><button class="btn" id="addFriendBtn">＋ Add friend</button></div>' : '<button class="btn" data-new="individual">＋ Add friend</button>'}
    </div>
    ${reqCount ? `<div class="card" style="margin-top:14px;display:flex;align-items:center;justify-content:space-between"><div><b>${reqCount}</b> friend request${reqCount === 1 ? "" : "s"} waiting</div><button class="btn sm" id="goInbox">Review</button></div>` : ""}
    <div class="grid cards-3" style="margin-top:14px">
      <div class="card stat"><div class="label">You are owed</div><div class="value pos">${fmtSum(owed)}</div></div>
      <div class="card stat"><div class="label">You owe</div><div class="value neg">${fmtSum(owe)}</div></div>
      <div class="card stat"><div class="label">Friends</div><div class="value">${people.length}</div></div>
    </div>
    <div style="margin-top:20px" id="friendList"></div>`;
  if ($("#addFriendBtn")) $("#addFriendBtn").onclick = () => openAddFriendModal();
  if ($("#myLinkBtn")) $("#myLinkBtn").onclick = () => copyLink(store.friendLink(), "Your friend invite link");
  if ($("#goInbox")) $("#goInbox").onclick = () => { view = { type: "invitations" }; render(); };

  const list = $("#friendList");
  if (!people.length) {
    list.innerHTML = emptyState("🧑‍🤝‍🧑", "No friends yet", CLOUD ? "Add a friend by @username or email — they'll get a request to accept. Or share your link." : "Add people to your groups and trips and they'll show up here.");
  } else {
    list.innerHTML = rows.map(({ m, net }) => {
      const pending = CLOUD && !m.userId && m.email;
      const nShared = sharedLedgers(m.id).length;
      return `<div class="exp-row">
        <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;cursor:pointer" data-friend="${m.id}">
          ${avatarEl(m)}
          <div class="exp-main"><div class="exp-desc">${esc(m.name)}${m.username ? ` <span class="exp-meta">@${esc(m.username)}</span>` : ""}${pending ? ' <span class="tag" style="color:var(--amber)">pending</span>' : ""}</div>
            <div class="exp-meta">${nShared} shared ${nShared === 1 ? "ledger" : "ledgers"}</div></div>
        </div>
        <div class="exp-amt"><div>${netToStr(net)}</div></div>
        ${CLOUD && m.userId ? `<button class="icon-btn" data-dm="${m.userId}" title="Message">💬</button>` : ""}
      </div>`;
    }).join("");
    list.querySelectorAll("[data-friend]").forEach((b) => b.onclick = () => { view = { type: "friend", friendId: b.dataset.friend }; render(); });
    list.querySelectorAll("[data-dm]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); openDm(b.dataset.dm); });
  }
  main.querySelectorAll("[data-new]").forEach((b) => b.onclick = () => openLedgerModal(b.dataset.new));
  wireMobile();
}

async function copyLink(link, label) {
  if (!link) return toast("Link isn't ready yet — try again in a moment.");
  try { await navigator.clipboard.writeText(link); toast(`${label || "Link"} copied — paste it in a chat.`); }
  catch { modal("Invite link", `<p class="hint" style="margin-top:0">Copy this and send it to whoever you want to invite:</p><div class="mail-preview">${esc(link)}</div>`, `<button class="btn" data-close>Close</button>`); }
}

function openAddFriendModal() {
  modal("Add a friend", `
    <label style="margin-top:0">Their @username or email</label>
    <input id="afInput" autocapitalize="off" spellcheck="false" placeholder="@username or name@example.com">
    <div class="hint" style="margin-top:6px">They'll get a request to accept. A new email gets an invite to join.</div>
    <hr style="border-color:var(--line);margin:16px 0">
    <label style="margin-top:0">Or share your invite link</label>
    <div class="row"><input value="${esc(store.friendLink())}" readonly><button class="btn ghost" id="afCopy" style="flex:none">Copy</button></div>
    <div id="afMsg" style="margin-top:10px"></div>
  `, `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="afSend">Send request</button>`);
  $("#afCopy").onclick = () => copyLink(store.friendLink(), "Your friend invite link");
  $("#afSend").onclick = async () => {
    const v = $("#afInput").value.trim(); if (!v) return toast("Enter a @username or email.");
    const btn = $("#afSend"); btn.disabled = true; $("#afMsg").innerHTML = `<span class="hint">Sending…</span>`;
    const r = await store.sendFriendRequest(v); btn.disabled = false;
    if (r.ok) { closeModal(); toast(r.status === "invited" ? "Invite sent by email." : "Friend request sent."); render(); }
    else $("#afMsg").innerHTML = `<span class="neg">${esc(r.error)}</span>`;
  };
}

// ---------- invitations inbox (friend requests + group/trip invites) ----------
function renderInvitations() {
  const main = $("#main");
  const reqs = store.state.friendRequests || [];
  const invs = store.state.invitations || [];
  main.innerHTML = `${mobileBar()}
    <div class="page-head"><div><h1 class="page-title">✉️ Invitations</h1><p class="page-sub">Friend requests and group/trip invites waiting on you.</p></div></div>
    <h3 style="margin:18px 0 8px">Friend requests ${reqs.length ? `<span class="tag" style="color:var(--amber)">${reqs.length}</span>` : ""}</h3>
    <div class="card" style="padding:6px 0">${reqs.length ? reqs.map((r) => `<div class="bal-row">${avatarEl(r)}<div class="grow"><b>${esc(r.name)}</b>${r.username ? ` <span class="exp-meta">@${esc(r.username)}</span>` : ""} <span class="exp-meta">wants to be friends</span></div><button class="btn sm" data-facc="${r.id}">Accept</button> <button class="btn ghost sm" data-fdec="${r.id}">Decline</button></div>`).join("") : `<div class="exp-meta" style="padding:10px 14px">No friend requests.</div>`}</div>
    <h3 style="margin:22px 0 8px">Group &amp; trip invites ${invs.length ? `<span class="tag" style="color:var(--amber)">${invs.length}</span>` : ""}</h3>
    <div class="card" style="padding:6px 0">${invs.length ? invs.map((i) => `<div class="bal-row"><div class="exp-cat">${kindIcon[i.kind] || "👥"}</div><div class="grow"><b>${esc(i.name)}</b> <span class="exp-meta">${kindLabel[i.kind] || "Group"} · invited by ${esc(i.inviter)}</span></div><button class="btn sm" data-iacc="${i.ledgerId}">Accept</button> <button class="btn ghost sm" data-idec="${i.ledgerId}">Decline</button></div>`).join("") : `<div class="exp-meta" style="padding:10px 14px">No pending invites.</div>`}</div>`;
  wireMobile();
  main.querySelectorAll("[data-facc]").forEach((b) => b.onclick = async () => { b.disabled = true; const r = await store.acceptFriendRequest(+b.dataset.facc); if (r.ok) { toast("You're now friends."); render(); } else { b.disabled = false; toast(r.error || "Failed."); } });
  main.querySelectorAll("[data-fdec]").forEach((b) => b.onclick = async () => { b.disabled = true; const r = await store.declineFriendRequest(+b.dataset.fdec); if (r.ok) { toast("Declined."); render(); } else { b.disabled = false; toast(r.error || "Failed."); } });
  main.querySelectorAll("[data-iacc]").forEach((b) => b.onclick = async () => { b.disabled = true; const r = await store.acceptInvitation(b.dataset.iacc); if (r.ok) { toast("Joined."); render(); } else { b.disabled = false; toast(r.error || "Failed."); } });
  main.querySelectorAll("[data-idec]").forEach((b) => b.onclick = async () => { b.disabled = true; const r = await store.declineInvitation(b.dataset.idec); if (r.ok) { toast("Declined."); render(); } else { b.disabled = false; toast(r.error || "Failed."); } });
  refreshInbox(); // pull anything new the moment the inbox is opened
}

// ---------- messaging ----------
function chatAvatar(c) {
  const m = (c.members || [])[0];
  const label = c.isGroup ? "👥" : esc(initials(m ? m.name : "?"));
  const bg = c.isGroup ? "#2f6fd6" : avColor(m);
  return `<div class="avatar" style="background:${bg}">${label}</div>`;
}
function renderMessages() {
  const main = $("#main");
  const chats = store.state.chats || [];
  main.innerHTML = `${mobileBar()}
    <div class="page-head"><div><h1 class="page-title">💬 Messages</h1><p class="page-sub">Chat with friends and the people in your groups.</p></div>
      <button class="btn" id="newChatBtn">＋ New chat</button></div>
    <div style="margin-top:16px" id="chatList"></div>`;
  wireMobile();
  $("#newChatBtn").onclick = () => openNewChatModal();
  const list = $("#chatList");
  if (!chats.length) { list.innerHTML = emptyState("💬", "No chats yet", "Start a chat with a friend or a group. You can also tap the 💬 next to anyone in Friends or a group's Members."); }
  else list.innerHTML = chats.map((c) => `
    <div class="exp-row" data-chat="${c.id}" style="cursor:pointer">
      ${chatAvatar(c)}
      <div class="exp-main"><div class="exp-desc">${esc(store.chatTitle(c))}${c.isGroup ? ` <span class="exp-meta">· ${(c.members || []).length + 1} people</span>` : ""}</div>
        <div class="exp-meta" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60vw">${c.lastBody ? esc(c.lastBody) : "No messages yet"}</div></div>
      ${c.unread ? `<span class="nav-dot" style="margin-left:0">${c.unread}</span>` : ""}
    </div>`).join("");
  list.querySelectorAll("[data-chat]").forEach((el) => el.onclick = () => { view = { type: "chat", chatId: el.dataset.chat }; render(); });
  if (store.loadChats) store.loadChats().then(() => { if (view.type === "messages") renderMessages(); });
}

async function renderChat(chatId) {
  const main = $("#main");
  const c = store.chatMeta(chatId);
  const title = c ? store.chatTitle(c) : "Chat";
  main.innerHTML = `${mobileBar()}
    <div class="page-head">
      <div style="max-width:100%"><button class="link-btn" id="backMsgs" style="padding-left:0">← Messages</button>
        <h1 class="page-title" style="font-size:20px">${c && c.isGroup ? "👥 " : ""}${esc(title)}</h1>
        ${c && c.isGroup ? `<p class="page-sub">${(c.members || []).map((m) => esc(m.name)).join(", ")}${c.members && c.members.length ? " · you" : ""}</p>` : ""}</div>
      <div style="display:flex;gap:8px">${c && c.isGroup ? `<button class="btn ghost sm" id="chatManage">Manage</button>` : ""}<button class="icon-btn" id="chatDelete" title="Delete conversation (only for you)">🗑️</button></div>
    </div>
    <div id="msgScroll" style="max-height:calc(100vh - 280px);overflow-y:auto;padding:4px 0"><div class="exp-meta" style="padding:10px 14px">Loading…</div></div>
    <div style="position:relative;margin-top:12px">
      <div id="mentionMenu" class="mention-menu" hidden></div>
      <div class="row" style="position:sticky;bottom:0;flex-wrap:nowrap">
        <input type="file" id="msgFile" hidden>
        <button class="btn ghost" id="msgAttach" style="flex:none" title="Attach a photo or file">📎</button>
        <input id="msgInput" placeholder="Message… (type @ to mention)" autocomplete="off" style="flex:1;min-width:0">
        <button class="btn" id="msgSend" style="flex:none">Send</button>
      </div>
    </div>`;
  wireMobile();
  $("#backMsgs").onclick = () => { view = { type: "messages" }; render(); };
  if ($("#chatManage")) $("#chatManage").onclick = () => openManageChatModal(chatId);
  $("#chatDelete").onclick = () => confirmDelete("Delete this conversation for you? Others keep theirs, and it comes back if someone messages the chat again.", async () => {
    await store.clearChat(chatId); view = { type: "messages" }; render(); toast("Deleted for you.");
  }, { confirmLabel: "Delete for me" });

  let current = [];
  const reload = async () => { current = await store.chatMessages(chatId); if (view.type === "chat" && view.chatId === chatId) paint(current); };
  const paint = (msgs) => {
    const box = $("#msgScroll"); if (!box) return;
    if (!msgs.length) { box.innerHTML = `<div class="exp-meta" style="padding:10px 14px">No messages yet — say hi 👋</div>`; return; }
    box.innerHTML = msgs.map((m) => {
      const s = store.chatSender(chatId, m.sender);
      const time = new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const who = m.mine || !c || !c.isGroup ? "" : `<div class="msg-who">${esc(s.name)}</div>`;
      const atts = (m.attachments || []).map((a) => (a.type && a.type.startsWith("image/"))
        ? `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" class="msg-img" loading="lazy"></a>`
        : `<a href="${esc(a.url)}" target="_blank" rel="noopener" class="msg-file">📎 <span class="fn">${esc(a.name || "file")}</span>${a.size ? `<span class="fsz">${fmtBytes(a.size)}</span>` : ""}</a>`).join("");
      const inner = m.deleted
        ? `<div style="opacity:.6;font-style:italic">message deleted</div>`
        : `${atts}${m.body ? `<div>${renderMsgBody(m.body, m.mentions)}</div>` : ""}<div class="msg-time">${time}${m.editedAt ? " · edited" : ""}</div>`;
      const tap = (m.mine && !m.deleted) ? ` data-msg="${m.id}" style="cursor:pointer"` : "";
      return `<div class="msg-row ${m.mine ? "mine" : ""}">
        ${m.mine ? "" : `<div class="avatar sm" style="background:${avColor(s)}">${esc(initials(s.name))}</div>`}
        <div class="msg-bubble ${m.mine ? "mine" : ""}"${tap}>${who}${inner}</div>
      </div>`;
    }).join("");
    box.querySelectorAll("[data-msg]").forEach((el) => el.onclick = () => {
      const msg = current.find((x) => String(x.id) === el.dataset.msg); if (msg) openMessageActions(msg, reload);
    });
    box.scrollTop = box.scrollHeight;
  };
  current = await store.chatMessages(chatId);
  if (view.type !== "chat" || view.chatId !== chatId) return; // navigated away
  paint(current);
  store.markChatRead(chatId).then(() => updateInboxBadge());
  // live updates for this open thread (new messages, edits, deletes)
  _chatHook = (evt) => {
    if (view.type === "chat" && view.chatId === chatId && evt.chatId === chatId)
      reload().then(() => store.markChatRead(chatId).then(() => updateInboxBadge()));
  };

  // ---------- @-mentions ----------
  // Candidates: people in this chat + my groups/trips. Picked mentions are tracked
  // and, on send, kept only if their "@Label" text still appears in the message.
  let pendingMentions = [];
  let menuIdx = 0;
  const menu = $("#mentionMenu");
  const mentionCands = () => {
    const people = (c && c.members || []).map((m) => ({ type: "user", id: m.id, label: m.name }));
    const groups = store.ledgers().filter((l) => l.kind !== "individual").map((l) => ({ type: "group", id: l.id, label: ledgerDisplayName(l) }));
    return [...people, ...groups].filter((x) => x.label);
  };
  const hideMenu = () => { if (menu) { menu.hidden = true; menu.innerHTML = ""; menu._items = null; } };
  const highlight = () => { if (!menu || menu.hidden) return; menu.querySelectorAll(".mention-item").forEach((el, i) => el.classList.toggle("on", i === menuIdx)); };
  const pickMention = (cand) => {
    if (!cand) return;
    const inp = $("#msgInput"); const caret = inp.selectionStart ?? inp.value.length;
    const pre = inp.value.slice(0, caret), post = inp.value.slice(caret);
    const m = pre.match(/@([^\s@]*)$/); if (!m) { hideMenu(); return; }
    const start = caret - m[0].length;
    const insert = "@" + cand.label + " ";
    inp.value = pre.slice(0, start) + insert + post;
    const nc = start + insert.length; inp.setSelectionRange(nc, nc);
    if (!pendingMentions.some((x) => x.type === cand.type && x.id === cand.id)) pendingMentions.push({ ...cand });
    hideMenu(); inp.focus();
  };
  const onType = () => {
    const inp = $("#msgInput"); if (!inp || !menu) return;
    const caret = inp.selectionStart ?? inp.value.length;
    const m = inp.value.slice(0, caret).match(/@([^\s@]*)$/);
    if (!m) return hideMenu();
    const q = m[1].toLowerCase();
    const items = mentionCands().filter((x) => x.label.toLowerCase().includes(q)).slice(0, 6);
    if (!items.length) return hideMenu();
    menuIdx = 0; menu._items = items;
    menu.innerHTML = items.map((x, i) => `<div class="mention-item${i === 0 ? " on" : ""}" data-i="${i}">${x.type === "group" ? "👥 " : ""}${esc(x.label)}</div>`).join("");
    menu.hidden = false;
    menu.querySelectorAll(".mention-item").forEach((el) => el.onmousedown = (e) => { e.preventDefault(); pickMention(items[+el.dataset.i]); });
  };
  const finalizeMentions = (text) => pendingMentions.filter((m) => text.includes("@" + m.label));

  const send = async () => {
    const inp = $("#msgInput"); const text = inp.value.trim(); if (!text) return;
    const mentions = finalizeMentions(text);
    inp.value = ""; pendingMentions = []; hideMenu(); inp.focus();
    const r = await store.sendMessage(chatId, text, null, mentions);
    if (!r.ok) { toast(r.error || "Couldn't send."); return; }
    await reload();
    store.loadChats();
  };
  $("#msgSend").onclick = send;
  $("#msgInput").addEventListener("input", onType);
  $("#msgInput").onkeydown = (e) => {
    if (menu && !menu.hidden) {
      const items = menu._items || [];
      if (e.key === "ArrowDown") { e.preventDefault(); menuIdx = (menuIdx + 1) % items.length; highlight(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); menuIdx = (menuIdx - 1 + items.length) % items.length; highlight(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(items[menuIdx]); return; }
      if (e.key === "Escape") { e.preventDefault(); hideMenu(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };
  $("#msgInput").onblur = () => setTimeout(hideMenu, 120);
  $("#msgAttach").onclick = () => $("#msgFile").click();
  $("#msgFile").onchange = async () => {
    const f = $("#msgFile").files[0]; if (!f) return;
    $("#msgFile").value = "";
    if (f.size > 15 * 1024 * 1024) return toast("File too large (max 15 MB).");
    const att = $("#msgAttach"); att.disabled = true; toast("Uploading…");
    const up = await store.uploadChatFile(f); att.disabled = false;
    if (!up.ok) return toast(up.error || "Upload failed.");
    const inp = $("#msgInput"); const text = inp.value.trim();
    const mentions = finalizeMentions(text);
    inp.value = ""; pendingMentions = []; hideMenu();
    const r = await store.sendMessage(chatId, text, [up.attachment], mentions);
    if (!r.ok) return toast(r.error || "Couldn't send.");
    await reload(); store.loadChats();
  };
  setTimeout(() => { const i = $("#msgInput"); if (i) i.focus(); }, 40);
}

function openNewChatModal() {
  const friends = store.friends();
  const chosen = new Set();
  modal("New chat", `
    <label style="margin-top:0">Chat name (optional — for groups)</label>
    <input id="ncName" placeholder="e.g. Tokyo crew">
    <label>People</label>
    <div class="hint" style="margin-top:0">Pick friends. For a 1-on-1 it opens your existing thread if you have one.</div>
    <div class="chips" id="ncFriends" style="margin-top:8px">${friends.length ? friends.map((f) => `<span class="chip" data-u="${f.id}">${esc(f.name)}</span>`).join("") : `<span class="exp-meta">No friends yet — add some first.</span>`}</div>
    ${store.ledgers().filter((l) => l.kind !== "individual").length ? `<label>Or add everyone from a group/trip</label>
      <select id="ncLedger"><option value="">— none —</option>${store.ledgers().filter((l) => l.kind !== "individual").map((l) => `<option value="${l.id}">${esc(ledgerDisplayName(l))}</option>`).join("")}</select>` : ""}
    <div id="ncMsg" style="margin-top:10px"></div>
  `, `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="ncCreate">Start chat</button>`);
  $("#modalHost").querySelectorAll("[data-u]").forEach((ch) => ch.onclick = () => { ch.classList.toggle("on"); chosen.has(ch.dataset.u) ? chosen.delete(ch.dataset.u) : chosen.add(ch.dataset.u); });
  $("#ncCreate").onclick = async () => {
    const ids = [...chosen];
    const ledgerId = $("#ncLedger") ? $("#ncLedger").value : "";
    const name = $("#ncName").value.trim();
    if (!ids.length && !ledgerId) return toast("Pick at least one person or a group.");
    const btn = $("#ncCreate"); btn.disabled = true;

    // 1:1 with exactly one friend and no group → reuse existing thread
    if (ids.length === 1 && !ledgerId) {
      const r = await store.startDm(ids[0]);
      if (r.ok) { closeModal(); view = { type: "chat", chatId: r.chatId }; render(); }
      else { btn.disabled = false; toast(r.error || "Couldn't start chat."); }
      return;
    }
    // group: if an identical thread exists, offer to reuse
    if (ids.length && !ledgerId) {
      const existing = await store.findGroupChat(ids);
      if (existing) {
        btn.disabled = false;
        return confirmChoice("A chat with exactly these people already exists.", "Open it", "Start a new one", async (openExisting) => {
          if (openExisting) { closeModal(); view = { type: "chat", chatId: existing }; render(); }
          else { const r = await store.startGroupChat(name, ids); if (r.ok) { closeModal(); view = { type: "chat", chatId: r.chatId }; render(); } else toast(r.error || "Failed."); }
        });
      }
    }
    const r = await store.startGroupChat(name, ids);
    if (!r.ok) { btn.disabled = false; return toast(r.error || "Couldn't start chat."); }
    if (ledgerId) await store.addLedgerToChat(r.chatId, ledgerId);
    closeModal(); view = { type: "chat", chatId: r.chatId }; render();
  };
}

function openMessageActions(msg, reload) {
  modal("Your message", `
    <textarea id="emBody" rows="3">${esc(msg.body)}</textarea>
    <div class="hint" style="margin-top:6px">Edit your message, or delete it for everyone in the chat.</div>
  `, `<button class="btn danger" id="emDel" style="margin-right:auto">Delete</button><button class="btn ghost" data-close>Cancel</button><button class="btn" id="emSave">Save edit</button>`);
  $("#emSave").onclick = async () => {
    const v = $("#emBody").value.trim();
    if (!v) return toast("Message can't be empty — use Delete instead.");
    const r = await store.editMessage(msg.id, v); closeModal();
    if (r.ok) { reload(); toast("Edited."); } else toast(r.error || "Couldn't edit.");
  };
  $("#emDel").onclick = () => { closeModal(); confirmDelete("Delete this message for everyone in the chat?", async () => {
    const r = await store.deleteMessage(msg.id); if (r.ok) { reload(); toast("Deleted."); } else toast(r.error || "Couldn't delete.");
  }, { confirmLabel: "Delete" }); };
}

function openManageChatModal(chatId) {
  const c = store.chatMeta(chatId); if (!c) return;
  modal("Manage chat", `
    <label style="margin-top:0">Chat name</label>
    <div class="row"><input id="mcName" value="${esc(c.name || "")}" placeholder="Unnamed chat"><button class="btn ghost" id="mcRename" style="flex:none">Save</button></div>
    <label>Add a friend</label>
    <div class="chips" id="mcFriends">${store.friends().filter((f) => !(c.members || []).some((m) => m.id === f.id)).map((f) => `<span class="chip" data-add="${f.id}">＋ ${esc(f.name)}</span>`).join("") || `<span class="exp-meta">Everyone's already here.</span>`}</div>
    <label>Add everyone from a group/trip</label>
    <select id="mcLedger"><option value="">— pick —</option>${store.ledgers().filter((l) => l.kind !== "individual").map((l) => `<option value="${l.id}">${esc(ledgerDisplayName(l))}</option>`).join("")}</select>
    <div style="margin-top:10px"><button class="btn ghost sm" id="mcAddLedger">Add group's people</button></div>
    <div id="mcMsg" style="margin-top:10px"></div>
  `, `<button class="btn" data-close>Done</button>`);
  $("#mcRename").onclick = async () => { await store.renameChat(chatId, $("#mcName").value.trim()); toast("Renamed."); };
  $("#modalHost").querySelectorAll("[data-add]").forEach((b) => b.onclick = async () => { const r = await store.addUserToChat(chatId, b.dataset.add); if (r.ok) { toast("Added."); closeModal(); render(); } else toast(r.error || "Failed."); });
  $("#mcAddLedger").onclick = async () => { const lid = $("#mcLedger").value; if (!lid) return toast("Pick a group first."); const r = await store.addLedgerToChat(chatId, lid); if (r.ok) { toast("Added the group's people."); closeModal(); render(); } else toast(r.error || "Failed."); };
}

function renderFriendDetail(friendId) {
  const m = store.memberById(friendId);
  if (!m) { view = { type: "friends" }; return render(); }
  const main = $("#main");
  const net = friendNet(friendId);
  const shared = sharedLedgers(friendId);
  const owesYouTotal = Object.values(net).some((v) => v > 0);

  main.innerHTML = `
    ${mobileBar()}
    <div class="page-head">
      <div style="max-width:100%">
        <button class="link-btn" id="backFriends" style="padding-left:0">← Friends</button>
        <h1 class="page-title">${kindIcon.individual} ${esc(m.name)}</h1>
        <p class="page-sub">${m.username ? "@" + esc(m.username) + " · " : ""}${m.email ? esc(m.email) : "no email"}${CLOUD && !m.userId && m.email ? " · <span style='color:var(--amber)'>invited, pending</span>" : ""}</p>
      </div>
      <div style="display:flex;gap:8px">${CLOUD && m.userId ? `<button class="btn ghost" id="dmFriend">💬 Message</button>` : ""}<button class="btn" id="addFriendExp">＋ Add expense</button></div>
    </div>
    <div class="card stat"><div class="label">Your balance with ${esc(m.name)}</div><div class="value">${netToStr(net)}</div></div>
    ${owesYouTotal ? `<div style="margin-top:12px"><button class="btn ghost" id="remindFriend">✉️ Copy a reminder</button></div>` : ""}
    <h3 style="margin:22px 0 10px">Shared groups & trips</h3>
    <div id="sharedList"></div>`;

  $("#backFriends").onclick = () => { view = { type: "friends" }; render(); };
  if ($("#dmFriend")) $("#dmFriend").onclick = () => openDm(m.userId);
  $("#addFriendExp").onclick = async () => {
    // add an expense with just this person, in your 1:1 ledger (create if needed)
    let indiv = store.ledgers().find((l) => l.kind === "individual" && l.memberIds.includes(friendId));
    if (!indiv) {
      indiv = store.addLedger({ kind: "individual", name: m.name, baseCurrency: (shared[0] && shared[0].baseCurrency) || "USD", memberIds: CLOUD ? [] : [friendId] });
      if (CLOUD) await store.addFriendToLedger(indiv.id, friendId);
    }
    openExpenseModal(indiv.id);
  };
  const sl = $("#sharedList");
  if (!shared.length) sl.innerHTML = `<div class="exp-meta">No shared groups or trips yet.</div>`;
  else sl.innerHTML = "";
  shared.forEach((l) => {
    const lexps = rolledExpenses(l);
    const n = netBetween(friendId, lexps, l.baseCurrency);
    const payTo = n < 0 ? payToFor(friendId, lexps) : "";
    const row = document.createElement("div");
    row.className = "exp-row";
    row.innerHTML = `
      <div class="exp-cat">${kindIcon[l.kind]}</div>
      <div class="exp-main" style="cursor:pointer" data-open="${l.id}"><div class="exp-desc">${esc(ledgerDisplayName(l))}</div>
        <div class="exp-meta">${kindLabel[l.kind]} · ${l.baseCurrency}</div>${payTo ? `<div class="exp-meta" style="white-space:pre-wrap;color:var(--brand)">💸 Pay back to: ${esc(payTo)}</div>` : ""}</div>
      <div class="exp-amt"><div class="${n >= 0 ? "pos" : "neg"}">${n === 0 ? "settled" : (n > 0 ? "owes you " : "you owe ") + formatMoney(Math.abs(n), l.baseCurrency)}</div></div>
      ${n !== 0 ? `<button class="btn ghost sm" data-settle="${l.id}">Settle up</button>` : ""}`;
    sl.appendChild(row);
    row.querySelector("[data-open]").onclick = () => { view = { type: "ledger", ledgerId: l.id, tab: "expenses" }; render(); };
    const sb = row.querySelector("[data-settle]");
    if (sb) sb.onclick = () => {
      const from = n > 0 ? friendId : "you", to = n > 0 ? "you" : friendId;
      store.addExpense({ ledgerId: l.id, settlement: true, from, to, amountMinor: Math.abs(n), currency: l.baseCurrency, fxToBase: 1, date: Date.now(), description: "Settlement", category: "settle" });
      render(); toast(`Recorded a settlement in ${ledgerDisplayName(l)}.`);
    };
  });
  const rb = $("#remindFriend");
  if (rb) rb.onclick = async () => {
    const lines = shared.map((l) => ({ l, n: netBetween(friendId, rolledExpenses(l), l.baseCurrency) })).filter((x) => x.n > 0)
      .map((x) => `  • ${ledgerDisplayName(x.l)}: ${formatMoney(x.n, x.l.baseCurrency)}`);
    const myPay = shared.map((x) => payToFor("you", rolledExpenses(x))).find(Boolean) || "";
    const payLine = myPay ? `\n\nYou can send it via: ${myPay}` : "";
    const msg = `Hi ${m.name},\n\nJust a friendly reminder about what's outstanding between us on UNO Ledger:\n\n${lines.join("\n")}${payLine}\n\nThanks!\n— ${store.state.you.name}`;
    try { await navigator.clipboard.writeText(msg); toast("Reminder copied."); } catch { toast("Copy failed."); }
  };
  wireMobile();
}

// ---------- platform admin: approvals ----------
async function renderApprovals() {
  const main = $("#main");
  if (!CLOUD || !store.isPlatformAdmin) { view = { type: "dashboard" }; return render(); }
  main.innerHTML = `${mobileBar()}
    <div class="page-head">
      <div><h1 class="page-title">🛡️ Approvals</h1><p class="page-sub">Approve or reject people who’ve signed up. Any of the three admins can act — the list is shared, so once someone’s approved they drop off everyone’s pending list.</p></div>
      <button class="btn ghost" id="refreshAppr">↻ Refresh</button>
    </div>
    <div id="apprBody"><div class="exp-meta">Loading…</div></div>`;
  wireMobile();
  $("#refreshAppr").onclick = () => renderApprovals();

  const users = await store.listUsersAdmin();
  const pending = users.filter((u) => !u.approved);
  const approved = users.filter((u) => u.approved);
  store.state.pendingApprovals = pending.length; updateInboxBadge(); // keep the red badge in sync
  const row = (u, actions) => `<div class="bal-row">
    ${avatarEl(u)}
    <div class="grow"><b>${esc(u.name)}</b>${u.username ? ` <span class="exp-meta">@${esc(u.username)}</span>` : ""} <span class="exp-meta">${esc(u.email)}</span></div>
    ${actions}</div>`;
  $("#apprBody").innerHTML = `
    <h3 style="margin:18px 0 8px">Waiting for approval ${pending.length ? `<span class="tag" style="color:var(--amber)">${pending.length}</span>` : ""}</h3>
    <div class="card" style="padding:6px 0">${pending.length
      ? pending.map((u) => row(u, `<button class="btn sm" data-approve="${u.id}">Approve</button> <button class="icon-btn" data-reject="${u.id}" title="Reject & delete">🗑️</button>`)).join("")
      : `<div class="exp-meta" style="padding:10px 14px">No one is waiting. 🎉</div>`}</div>
    <h3 style="margin:22px 0 8px">Approved members</h3>
    <div class="card" style="padding:6px 0">${approved.length
      ? approved.map((u) => row(u, `<button class="btn ghost sm" data-revoke="${u.id}">Revoke</button>`)).join("")
      : `<div class="exp-meta" style="padding:10px 14px">No approved members yet.</div>`}</div>`;

  $("#apprBody").querySelectorAll("[data-approve]").forEach((b) => b.onclick = async () => {
    const u = users.find((x) => x.id === b.dataset.approve); b.disabled = true;
    const r = await store.setUserApproved(u.id, true, u.email, u.name);
    if (r.ok) { toast(`Approved ${u.name} — emailed them.`); renderApprovals(); } else { b.disabled = false; toast(r.error || "Couldn't approve."); }
  });
  $("#apprBody").querySelectorAll("[data-revoke]").forEach((b) => b.onclick = () => {
    const u = users.find((x) => x.id === b.dataset.revoke);
    confirmDelete(`Revoke access for ${u.name}? They'll be signed out and need approval again.`, async () => {
      const r = await store.setUserApproved(u.id, false);
      if (r.ok) { toast(`Revoked ${u.name}.`); renderApprovals(); } else toast(r.error || "Couldn't revoke.");
    }, { confirmLabel: "Revoke" });
  });
  $("#apprBody").querySelectorAll("[data-reject]").forEach((b) => b.onclick = () => {
    const u = users.find((x) => x.id === b.dataset.reject);
    confirmDelete(`Reject and permanently delete ${u.name} (${u.email})? This removes their account entirely.`, async () => {
      const r = await store.rejectUser(u.id);
      if (r.ok) { toast(`Rejected ${u.name}.`); renderApprovals(); } else toast(r.error || "Couldn't reject.");
    }, { confirmLabel: "Delete", phrase: CONFIRM_WORD });
  });
}

// ---------- ledger view ----------
function renderLedger() {
  const l = store.ledgerById(view.ledgerId);
  if (!l) { view = { type: "dashboard" }; return render(); }
  const main = $("#main");
  // Friend (1:1) ledgers don't need a Members tab — it's just the two of you.
  const tabs = l.kind === "individual"
    ? ["expenses", "balances", "settle", "reminders", "settings"]
    : ["expenses", "balances", "settle", "reminders", "members", "settings"];
  if (!tabs.includes(view.tab)) view.tab = "expenses";
  const tabLabel = { expenses: "Expenses", balances: "Balances", settle: "Settle up", reminders: "Reminders", members: "Members", settings: "Settings" };
  const parent = l.parentId ? store.ledgerById(l.parentId) : null;
  const nKids = childrenOf(l).length;

  main.innerHTML = `
    ${mobileBar()}
    <div class="page-head">
      <div>
        <h1 class="page-title">${kindIcon[l.kind]} ${esc(ledgerDisplayName(l))}</h1>
        <p class="page-sub">${kindLabel[l.kind]}${parent ? " in " + esc(parent.name) : ""} · base currency ${l.baseCurrency} · ${rolledMemberIds(l).length} people${l.kind === "group" && nKids ? ` · includes ${nKids} trip${nKids === 1 ? "" : "s"}` : ""}</p>
      </div>
      <button class="btn" id="addExp">＋ Add expense</button>
    </div>
    <div class="tabs">${tabs.map((t) => `<button class="tab ${view.tab === t ? "active" : ""}" data-tab="${t}">${tabLabel[t]}</button>`).join("")}</div>
    <div id="tabBody"></div>`;

  $("#addExp").onclick = () => openExpenseModal(l.id);
  main.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { view.tab = b.dataset.tab; renderLedger(); });

  const body = $("#tabBody");
  if (view.tab === "expenses") renderExpenses(body, l);
  else if (view.tab === "balances") renderBalances(body, l);
  else if (view.tab === "settle") renderSettle(body, l);
  else if (view.tab === "reminders") renderReminders(body, l);
  else if (view.tab === "members") renderMembers(body, l);
  else if (view.tab === "settings") renderSettings(body, l);
  wireMobile();
}

function renderExpenses(body, l) {
  const exps = rolledExpenses(l);
  if (!exps.length) { body.innerHTML = emptyState("🧾", "No expenses yet", "Add the first bill — dinner, the hotel, the rental car — and UNO Ledger figures out who owes what."); return; }
  body.innerHTML = exps.map((e) => {
    const canEdit = canEditExpense(e);
    if (e.settlement) {
      const from = store.memberById(e.from), to = store.memberById(e.to);
      return `<div class="exp-row"><div class="exp-cat">✅</div>
        <div class="exp-main"><div class="exp-desc">${esc(from?.name)} paid ${esc(to?.name)}</div>
        <div class="exp-meta">Settlement · ${new Date(e.date || e.createdAt).toLocaleDateString()}</div></div>
        <div class="exp-amt"><div>${formatMoney(e.amountMinor, e.currency)}</div></div>
        <div class="exp-actions">${canEdit ? `<button class="icon-btn" data-del="${e.id}" title="Delete">🗑️</button>` : ""}</div></div>`;
    }
    const owed = computeOwed(e);
    const paid = computePaid(e);
    const yourNet = (paid.get("you") || 0) - (owed.get("you") || 0);
    const payers = [...paid.keys()].map((id) => store.memberById(id)?.name).filter(Boolean);
    const receipt = e.receipt ? `<img src="${e.receipt}" class="receipt-thumb" data-receipt="${e.id}" title="View receipt">` : "";
    return `<div class="exp-row">
      <div class="exp-cat">${CATEGORIES[e.category] || "🧾"}</div>
      <div class="exp-main">
        <div class="exp-desc">${esc(e.description || "Expense")}</div>
        <div class="exp-meta">${esc(payers.join(", ") || "?")} paid · ${new Date(e.date || e.createdAt).toLocaleDateString()} · ${splitLabel(e)}${e._tripName ? ` · <span class="tag">🧳 ${esc(e._tripName)}</span>` : ""}${e.currency !== l.baseCurrency ? ` · <span class="tag">${e.currency}→${l.baseCurrency} @${e.fxToBase ?? 1}</span>` : ""}</div>
        ${e.paymentInfo && yourNet < 0 ? `<div class="exp-meta" style="white-space:pre-wrap;color:var(--brand)">💸 Pay back to: ${esc(e.paymentInfo)}</div>` : ""}
      </div>
      ${receipt}
      <div class="exp-amt"><div>${formatMoney(e.amountMinor, e.currency)}</div>
        <div class="exp-you ${yourNet >= 0 ? "pos" : "neg"}">${yourNet === 0 ? "not involved" : (yourNet > 0 ? "you lent " : "you borrowed ") + formatMoney(Math.abs(yourNet), e.currency)}</div></div>
      <div class="exp-actions">
        ${canEdit ? `<button class="icon-btn" data-edit="${e.id}" title="Edit">✏️</button>
        <button class="icon-btn" data-del="${e.id}" title="Delete">🗑️</button>` : `<span class="icon-btn" title="Only the person who added this (or an admin) can edit it" style="cursor:default;opacity:.5">🔒</span>`}
      </div></div>`;
  }).join("");
  body.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => { const ex = store.state.expenses.find((x) => x.id === b.dataset.edit); openExpenseModal(ex ? ex.ledgerId : l.id, b.dataset.edit); });
  body.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => { confirmDelete("Delete this entry?", () => { store.removeExpense(b.dataset.del); render(); toast("Deleted."); }); });
  body.querySelectorAll("[data-receipt]").forEach((img) => img.onclick = () => openReceipt(img.src));
}

function splitLabel(e) {
  const t = e.split?.type;
  const n = t === "items" ? new Set((e.split.items || []).flatMap((i) => i.participants)).size : (e.split?.participants?.length || 0);
  return { equal: `split ${n} ways`, exact: "exact amounts", percent: "by %", shares: "by shares", items: "itemized" }[t] || "split";
}

function renderBalances(body, l) {
  const { base, perCurrency } = computeBalances(rolledExpenses(l), l.baseCurrency);
  const rows = rolledMemberIds(l).map((id) => ({ m: store.memberById(id), net: base.get(id) || 0 })).filter((r) => r.m).sort((a, b) => b.net - a.net);
  const multi = Object.keys(perCurrency).length > 1;
  body.innerHTML = `
    ${multi ? `<div class="card" style="margin-bottom:14px"><div class="exp-meta">Multiple currencies used — balances below are converted to <b>${l.baseCurrency}</b> using each expense's rate.</div></div>` : ""}
    <div class="card" style="padding:6px 0">
      ${rows.map((r) => `<div class="bal-row">
        ${avatarEl(r.m)}
        <div class="grow"><b>${esc(r.m.name)}</b>${r.m.id === "you" ? " (you)" : ""}</div>
        <div class="${r.net >= 0 ? "pos" : "neg"}" style="font-weight:700">${r.net === 0 ? "settled up" : (r.net > 0 ? "gets back " : "owes ") + formatMoney(Math.abs(r.net), l.baseCurrency)}</div>
      </div>`).join("")}
    </div>`;
}

function renderSettle(body, l) {
  const exps = rolledExpenses(l);
  const { base } = computeBalances(exps, l.baseCurrency);
  const transfers = settleUp(base);
  if (!transfers.length) { body.innerHTML = emptyState("✅", "All settled up", "Nobody owes anybody. Nice."); return; }
  body.innerHTML = `
    <div class="card" style="margin-bottom:14px"><div class="exp-meta">💡 Smart settle-up: the fewest payments that clear every debt (${transfers.length} payment${transfers.length === 1 ? "" : "s"}).</div></div>
    <div class="card" style="padding:6px 0">
    ${transfers.map((t, i) => {
      const from = store.memberById(t.from), to = store.memberById(t.to);
      const payTo = payToFor(t.to, exps);
      return `<div class="settle-row" style="flex-wrap:wrap">
        ${avatarEl(from)}
        <div class="grow"><b>${esc(from?.name)}</b> pays <b>${esc(to?.name)}</b>${payTo ? `<div class="exp-meta" style="white-space:pre-wrap">💸 ${esc(payTo)}</div>` : ""}</div>
        <div style="font-weight:700">${formatMoney(t.amountMinor, l.baseCurrency)}</div>
        <button class="btn ghost sm" data-settle="${i}">Mark paid</button>
      </div>`;
    }).join("")}
    </div>`;
  body.querySelectorAll("[data-settle]").forEach((b) => b.onclick = () => {
    const t = transfers[+b.dataset.settle];
    store.addExpense({ ledgerId: l.id, settlement: true, from: t.from, to: t.to, amountMinor: t.amountMinor, currency: l.baseCurrency, fxToBase: 1, date: Date.now(), description: "Settlement", category: "settle" });
    render(); toast("Recorded payment.");
  });
}

function renderReminders(body, l) {
  const r = l.reminder || {};
  const admin = !CLOUD || iAmAdminOf(l);
  const { base } = computeBalances(rolledExpenses(l), l.baseCurrency);
  const debtors = rolledMemberIds(l).map((id) => ({ m: store.memberById(id), net: base.get(id) || 0 })).filter((x) => x.m && x.net < 0);
  const settingsCard = admin ? `
    <div class="card">
      <label style="margin-top:0">Automatic email reminders</label>
      <div class="row" style="align-items:center">
        <label style="margin:0"><input type="checkbox" id="remOn" ${r.enabled ? "checked" : ""} style="width:auto;margin-right:8px">Send reminders to people who owe</label>
      </div>
      <label>Frequency</label>
      <select id="remFreq">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${r.frequency === k ? "selected" : ""}>${v}</option>`).join("")}</select>
      <label>Custom message (optional — added to the top of the email)</label>
      <textarea id="remMsg" rows="2" placeholder="Hey! Here's what's outstanding from our trip 🙂">${esc(r.message || "")}</textarea>
      <div class="hint">When enabled, everyone who owes gets an automatic email on this schedule. You can also copy the previews below to send a reminder by hand any time.</div>
      <div style="margin-top:12px"><button class="btn" id="remSave">Save reminder settings</button></div>
    </div>`
    : `<div class="card"><div class="exp-meta">${r.enabled ? `Automatic reminders are ${FREQ[r.frequency] ? FREQ[r.frequency].toLowerCase() : "on"}.` : "Automatic reminders are off."} Only an admin can change this. You can still copy a reminder to send by hand below.</div></div>`;
  body.innerHTML = `
    ${settingsCard}
    <h3 style="margin:22px 0 10px">Who owes right now</h3>
    ${debtors.length ? debtors.map((d) => {
      const transfers = settleUp(base).filter((t) => t.from === d.m.id);
      return `<div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          ${avatarEl(d.m)}
          <div class="grow"><b>${esc(d.m.name)}</b> <span class="exp-meta">${d.m.email ? esc(d.m.email) : "⚠️ no email on file"}</span></div>
          <div class="neg" style="font-weight:700">owes ${formatMoney(-d.net, l.baseCurrency)}</div>
          <button class="btn ghost sm" data-copy="${d.m.id}">Copy email</button>
        </div>
        <div class="mail-preview" id="mail_${d.m.id}">${esc(reminderText(l, d.m, transfers))}</div>
      </div>`;
    }).join("") : emptyState("✅", "Nobody owes anything", "No reminders needed right now.")}`;

  if ($("#remSave")) $("#remSave").onclick = () => {
    store.updateLedger(l.id, { reminder: { ...r, enabled: $("#remOn").checked, frequency: $("#remFreq").value, message: $("#remMsg").value } });
    toast("Reminder settings saved."); render();
  };
  body.querySelectorAll("[data-copy]").forEach((b) => b.onclick = async () => {
    const txt = $("#mail_" + b.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(txt); toast("Reminder copied to clipboard."); }
    catch { toast("Copy failed — select the text manually."); }
  });
}

function reminderText(l, member, transfers) {
  const exps = rolledExpenses(l);
  const lines = transfers.map((t) => {
    const payTo = payToFor(t.to, exps);
    return `  • Pay ${store.memberById(t.to)?.name}: ${formatMoney(t.amountMinor, l.baseCurrency)}${payTo ? `\n      ↳ send to: ${payTo}` : ""}`;
  });
  const total = transfers.reduce((a, t) => a + t.amountMinor, 0);
  const custom = l.reminder?.message ? l.reminder.message + "\n\n" : "";
  return `Subject: Reminder: you owe ${formatMoney(total, l.baseCurrency)} for "${l.name}"

Hi ${member.name},

${custom}This is a friendly reminder about outstanding balances for ${l.name}. You currently owe a total of ${formatMoney(total, l.baseCurrency)}:

${lines.join("\n")}

Thanks!
— sent via UNO Ledger`;
}

function renderMembers(body, l) {
  const ownAdmins = new Set([l.createdBy, ...(l.admins || [])].filter(Boolean));
  const parentG = (l.kind === "trip" && l.parentId) ? store.ledgerById(l.parentId) : null;
  const groupAdmins = parentG ? new Set([parentG.createdBy, ...(parentG.admins || [])].filter(Boolean)) : new Set();
  const iAmAdmin = CLOUD && iAmAdminOf(l);
  const admin = !CLOUD || iAmAdminOf(l); // may I manage this ledger (add/remove members)?
  const isOwner = (id, m) => id === "you" ? !!l.iAmOwner : !!(m && m.userId && m.userId === l.createdBy);
  const ownAdmin = (id, m) => id === "you" ? !!l.iAmAdmin : !!(m && m.userId && ownAdmins.has(m.userId));
  const viaGroup = (id, m) => {
    if (id === "you") return !l.iAmAdmin && iAmAdminOf(l);
    return !!(m && m.userId && groupAdmins.has(m.userId) && !ownAdmins.has(m.userId));
  };
  const membersHtml = l.memberIds.map((id) => {
    const m = store.memberById(id);
    const pending = CLOUD && id !== "you" && m && !m.userId && m.email;
    const handle = CLOUD && m?.username ? ` <span class="exp-meta">@${esc(m.username)}</span>` : "";
    const meta = m?.email ? `<span class="exp-meta">${esc(m.email)}</span>` : (m?.username ? "" : `<span class="exp-meta">no email</span>`);
    const owner = isOwner(id, m), own = ownAdmin(id, m), via = viaGroup(id, m);
    const badgeText = owner ? "owner" : own ? "admin" : via ? "admin · via group" : "";
    const adminBadge = CLOUD && badgeText ? ` <span class="tag" style="color:var(--brand)">${badgeText}</span>` : "";
    // toggle only for real users who aren't the owner and aren't admin-via-group
    const canToggle = iAmAdmin && id !== "you" && m && m.userId && !owner && !via;
    const toggleBtn = canToggle ? `<button class="btn ghost sm" data-admin="${m.userId}" data-make="${own ? "0" : "1"}">${own ? "Remove admin" : "Make admin"}</button>` : "";
    // quick add-friend for a co-member who isn't your friend yet
    const friendBtn = (CLOUD && id !== "you" && m && m.userId && !store.isFriend(m.userId)) ? `<button class="btn ghost sm" data-friendadd="${m.userId}" data-fname="${esc(m.name)}" title="Send friend request">＋ Friend</button>` : "";
    const dmBtn = (CLOUD && id !== "you" && m && m.userId) ? `<button class="icon-btn" data-dm="${m.userId}" title="Message">💬</button>` : "";
    return `<div class="bal-row">
      ${avatarEl(m, { cls: "clk", attrs: `data-profile="${id}"` })}
      <div class="grow" data-profile="${id}" style="cursor:pointer"><b>${esc(m?.name)}</b>${id === "you" ? " (you)" : ""}${adminBadge}${handle} ${meta}${pending ? ` <span class="tag" style="color:var(--amber)">invited · not signed up yet</span>` : ""}</div>
      ${dmBtn}${friendBtn}${toggleBtn}
      ${(id === "you" || !admin) ? "" : `<button class="icon-btn" data-remove="${id}" title="Remove from ${esc(ledgerDisplayName(l))}">✖</button>`}
    </div>`;
  }).join("");
  const inheritNote = parentG ? `<div class="hint" style="margin:0 0 10px">👑 Admins of the group “${esc(parentG.name)}” can also manage this trip while it's tagged to it.</div>` : "";

  let addHtml;
  if (!admin) {
    addHtml = `<div class="card" style="margin-top:16px"><div class="exp-meta">👀 You're a member here. Only an admin can add or remove people.</div></div>`;
  } else if (CLOUD) {
    const inLedger = new Set(l.memberIds);
    const parent = l.kind === "trip" && l.parentId ? store.ledgerById(l.parentId) : null;
    const friendChip = (m) => `<span class="chip" data-add="${m.id}" title="${esc(m.email || (m.username ? "@" + m.username : ""))}">＋ ${esc(m.name)}${m.userId ? "" : ' <span class="tag" style="color:var(--amber)">pending</span>'}</span>`;
    // For a trip, surface the parent group's people first.
    const groupIds = new Set();
    let groupSection = "";
    if (parent) {
      const gp = parent.memberIds.filter((id) => id !== "you" && !inLedger.has(id)).map((id) => store.memberById(id)).filter(Boolean);
      gp.forEach((m) => groupIds.add(m.id));
      if (gp.length) groupSection = `<div class="card" style="margin-bottom:12px"><label style="margin-top:0">👥 Add from group “${esc(parent.name)}”</label><div class="chips">${gp.map(friendChip).join("")}</div></div>`;
    }
    const pendingIds = new Set((l.pendingInvites || []).map((p) => p.userId).filter(Boolean));
    const friends = store.friends().filter((p) => !inLedger.has(p.id) && !groupIds.has(p.id) && !pendingIds.has(p.userId));
    addHtml = `
      <h3 style="margin:20px 0 10px">Add people</h3>
      ${groupSection}
      <div class="card">
        <label style="margin-top:0">Your friends</label>
        ${friends.length ? `<div class="chips">${friends.map(friendChip).join("")}</div>` : `<div class="exp-meta">No other friends to add yet — add a new one below.</div>`}
        <hr style="border-color:var(--line);margin:16px 0">
        <label>Add a new friend</label>
        <div class="row"><input id="memEmail" type="text" autocapitalize="off" spellcheck="false" placeholder="email or @username"><button class="btn" id="memAdd" style="flex:none">Add</button></div>
        <div class="hint" style="margin-top:6px">Existing users are added instantly; a new email gets an invite automatically. This also adds them to your friends.</div>
        <div id="memResult" style="margin-top:10px"></div>
      </div>`;
  } else {
    const others = store.allMembers().filter((m) => !l.memberIds.includes(m.id));
    addHtml = `
      <h3 style="margin:20px 0 10px">Add people</h3>
      <div class="card">
        ${others.length ? `<div class="chips">${others.map((m) => `<span class="chip" data-add="${m.id}">＋ ${esc(m.name)}</span>`).join("")}</div>` : `<div class="exp-meta">Everyone's already here.</div>`}
        <div class="row" style="margin-top:14px">
          <input id="newName" placeholder="New person's name">
          <input id="newEmail" placeholder="email (for reminders)">
          <button class="btn" id="addNew" style="flex:none">Add</button>
        </div>
      </div>`;
  }

  // Leave section — any member can leave a group/trip (creator deletes instead).
  const leaveHtml = (CLOUD && l.kind !== "individual") ? `
    <div class="card" style="margin-top:16px">
      <button class="btn danger" id="leaveLedger">🚪 Leave ${esc(ledgerDisplayName(l))}</button>
      <div class="hint" style="margin-top:6px">You'll be removed and stop seeing its expenses. You can only leave once your balance here is settled up.${l.iAmOwner ? ` Since you created this ${kindLabel[l.kind].toLowerCase()}, the remaining members become admins so it stays managed (it isn't deleted).` : ""}</div>
    </div>` : "";
  const pendingHtml = (CLOUD && (l.pendingInvites || []).length) ? `
    <h3 style="margin:20px 0 8px">Pending invitations</h3>
    <div class="card" style="padding:6px 0">${l.pendingInvites.map((p) => `<div class="bal-row">${avatarEl(p)}<div class="grow"><b>${esc(p.name)}</b>${p.username ? ` <span class="exp-meta">@${esc(p.username)}</span>` : ""} <span class="tag" style="color:var(--amber)">awaiting acceptance</span></div>${admin ? `<button class="icon-btn" data-cancelinv="${esc(p.id)}" title="Cancel invite">✖</button>` : ""}</div>`).join("")}</div>` : "";
  const linkHtml = (CLOUD && admin && l.kind !== "individual") ? `<div class="card" style="margin-top:14px"><label style="margin-top:0">🔗 Shareable invite link</label><div class="row"><input value="${esc(store.ledgerLink(l))}" readonly><button class="btn ghost" id="copyLedgerLink" style="flex:none">Copy</button></div><div class="hint" style="margin-top:6px">Anyone who opens it is asked to join ${esc(ledgerDisplayName(l))}.</div></div>` : "";
  body.innerHTML = `${inheritNote}<div class="card" style="padding:6px 0">${membersHtml}</div>${pendingHtml}${addHtml}${linkHtml}${leaveHtml}`;
  if ($("#copyLedgerLink")) $("#copyLedgerLink").onclick = () => copyLink(store.ledgerLink(l), `${ledgerDisplayName(l)} invite link`);
  body.querySelectorAll("[data-friendadd]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    const r = await store.sendFriendRequestUid(b.dataset.friendadd);
    if (r.ok) toast(`Friend request sent to ${b.dataset.fname || "them"}.`); else { b.disabled = false; toast(r.error || "Couldn't send."); }
  });
  body.querySelectorAll("[data-dm]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); openDm(b.dataset.dm); });
  body.querySelectorAll("[data-cancelinv]").forEach((b) => b.onclick = () => {
    confirmDelete("Cancel this invitation?", async () => { await store.cancelInvite(l.id, b.dataset.cancelinv); render(); toast("Invitation cancelled."); }, { confirmLabel: "Cancel invite" });
  });
  const lv = $("#leaveLedger");
  if (lv) lv.onclick = () => {
    const { base } = computeBalances(rolledExpenses(l), l.baseCurrency);
    if (Math.round(base.get("you") || 0) !== 0) return toast("Settle up your balance here before leaving.");
    confirmDelete(`Leave ${ledgerDisplayName(l)}? You'll be removed and won't see its expenses anymore.`, async () => {
      const r = await store.leaveLedger(l.id);
      if (r.ok) { view = { type: "dashboard" }; render(); toast("You left."); } else toast(r.error || "Couldn't leave.");
    }, { confirmLabel: "Leave" });
  };
  body.querySelectorAll("[data-remove]").forEach((b) => b.onclick = () => {
    const m = store.memberById(b.dataset.remove);
    confirmDelete(`Remove ${m ? m.name : "this person"} from ${ledgerDisplayName(l)}?`, () => { store.updateLedger(l.id, { memberIds: l.memberIds.filter((x) => x !== b.dataset.remove) }); render(); toast("Removed."); }, { confirmLabel: "Remove", phrase: CONFIRM_WORD });
  });
  body.querySelectorAll("[data-profile]").forEach((el) => el.onclick = () => { const id = el.dataset.profile; if (id === "you") openPersonModal("you"); else openFriendProfile(store.memberById(id)); });
  body.querySelectorAll("[data-admin]").forEach((b) => b.onclick = async () => {
    const make = b.dataset.make === "1";
    const r = await store.setLedgerAdmin(l.id, b.dataset.admin, make);
    if (r.ok) { render(); toast(make ? "Made admin." : "Removed admin."); } else toast(r.error || "Couldn't update.");
  });

  if (!admin) { /* non-admins can't add people */ }
  else if (CLOUD) {
    body.querySelectorAll("[data-add]").forEach((b) => b.onclick = async () => {
      const r = await store.addFriendToLedger(l.id, b.dataset.add); render();
      if (r && r.already) toast(`${r.name || "They"} are already in this group.`);
      else if (r && r.name) toast(r.emailed ? `Added ${r.name} — emailed them.` : `Added ${r.name}.`);
    });
    $("#memAdd").onclick = async () => {
      const email = $("#memEmail").value.trim(); if (!email) return toast("Enter an email or @username.");
      const btn = $("#memAdd"); btn.disabled = true; $("#memResult").innerHTML = `<span class="hint">Checking…</span>`;
      const res = await store.addMemberByEmail(l.id, email);
      btn.disabled = false;
      if (res.status === "added") { toast(res.emailed ? `Added ${res.name} — emailed them.` : `Added ${res.name}.`); render(); }
      else if (res.status === "invited") { render(); openInvite(l, res); }
      else if (res.status === "exists") { $("#memResult").innerHTML = `<span class="hint">${esc(res.message)}</span>`; }
      else { $("#memResult").innerHTML = `<span class="neg">${esc(res.message || "Couldn't add them.")}</span>`; }
    };
  } else {
    body.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => { store.updateLedger(l.id, { memberIds: [...l.memberIds, b.dataset.add] }); render(); });
    $("#addNew").onclick = () => {
      const name = $("#newName").value.trim(); if (!name) return toast("Enter a name.");
      const p = store.addPerson({ name, email: $("#newEmail").value });
      store.updateLedger(l.id, { memberIds: [...l.memberIds, p.id] }); render();
    };
  }
}

function openFriendProfile(m) {
  if (!m) return;
  const pending = CLOUD && !m.userId && m.email;
  modal("Profile", `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <div class="avatar" style="width:46px;height:46px;font-size:16px;background:${avColor(m)}">${esc(initials(m.name))}</div>
      <div><div style="font-weight:700;font-size:17px">${esc(m.name)}</div>${m.username ? `<div class="exp-meta">@${esc(m.username)}</div>` : ""}</div>
    </div>
    <label style="margin-top:0">Email</label><div class="mail-preview">${m.email ? esc(m.email) : "—"}</div>
    <label>Username</label><div class="mail-preview">${m.username ? "@" + esc(m.username) : "— (not set yet)"}</div>
    ${pending ? `<div class="hint" style="margin-top:12px;color:var(--amber)">Invited — they haven't signed up yet. Their name and username will fill in once they do.</div>` : ""}
  `, `<button class="btn" data-close>Close</button>`);
}

function openInvite(l, res) {
  const msg = `Join me on UNO Ledger for "${l.name}"!\n\nSign in with ${res.email} here:\n${res.link}\n\nYou'll automatically join "${l.name}" once you sign in with that email.`;
  const head = res.emailed
    ? `✅ An invite email was sent automatically to <b>${esc(res.email)}</b>. They'll join "${esc(l.name)}" the moment they sign up with that email.<br><span class="hint">Didn't arrive? It may be in spam (school/work inboxes filter hard) — you can also share the link below directly.</span>`
    : `<b>${esc(res.email)}</b> was added as <b>pending</b>, but the invite email couldn't be sent automatically. Share the link below with them — they'll join "${esc(l.name)}" when they sign up with that email.`;
  modal(res.emailed ? "Invite emailed" : "Invite link", `
    <p class="hint" style="margin-top:0">${head}</p>
    <div class="mail-preview" id="invMsg">${esc(msg)}</div>
  `, `<button class="btn ghost" data-close>Close</button><button class="btn" id="copyInv">Copy link</button>`);
  $("#copyInv").onclick = async () => { try { await navigator.clipboard.writeText(msg); toast("Invite copied — you can also send it directly."); } catch { toast("Copy failed — select the text and copy it."); } };
}

function renderSettings(body, l) {
  const admin = !CLOUD || iAmAdminOf(l);
  const settingsCard = admin ? `
    <div class="card">
      <label style="margin-top:0">Name</label>
      <input id="lName" value="${esc(l.name)}">
      <label>Base currency (balances shown in this)</label>
      <select id="lCur">${Object.keys(CURRENCIES).map((c) => `<option value="${c}" ${l.baseCurrency === c ? "selected" : ""}>${c} — ${CURRENCIES[c].name}</option>`).join("")}</select>
      ${l.kind === "trip" ? `<label>Part of group (optional)</label>
        <select id="lParent"><option value="">— standalone —</option>${store.ledgers().filter((g) => g.kind === "group").map((g) => `<option value="${g.id}" ${l.parentId === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select>` : ""}
      <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" id="lSave">Save</button>
        <button class="btn danger" id="lDel">Delete ${kindLabel[l.kind].toLowerCase()}</button>
      </div>
    </div>`
    : `<div class="card"><div class="exp-meta">👀 Only an admin can rename, change, or delete this ${kindLabel[l.kind].toLowerCase()}. You can still export below.</div></div>`;
  body.innerHTML = `
    ${settingsCard}
    <div class="card" style="margin-top:14px">
      <label style="margin-top:0">Export</label>
      <div class="hint">Download all expenses${l.kind === "group" && childrenOf(l).length ? " (including its trips)" : ""} as a spreadsheet.</div>
      <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn ghost" id="lCsv">⬇ Export CSV (Excel)</button>
        <button class="btn ghost" id="lPrint">🖨 Print / Save as PDF</button>
      </div>
    </div>`;
  if ($("#lSave")) $("#lSave").onclick = () => {
    const patch = { name: $("#lName").value.trim() || l.name, baseCurrency: $("#lCur").value };
    if (l.kind === "trip") patch.parentId = $("#lParent").value || null;
    store.updateLedger(l.id, patch); render(); toast("Saved.");
  };
  if ($("#lDel")) $("#lDel").onclick = () => confirmDelete(`Delete "${ledgerDisplayName(l)}" and all of its expenses? Everyone in it loses access.`, () => { store.removeLedger(l.id); view = { type: "dashboard" }; render(); toast("Deleted."); }, { confirmLabel: `Delete ${kindLabel[l.kind].toLowerCase()}`, phrase: CONFIRM_WORD });
  $("#lCsv").onclick = () => exportLedgerCSV(l);
  $("#lPrint").onclick = () => exportLedgerPrint(l);
}

// ---------- export ----------
function csvCell(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function exportRows(l) {
  return rolledExpenses(l).filter((e) => !e.settlement).map((e) => {
    const paid = computePaid(e), owed = computeOwed(e);
    const payer = [...paid.keys()].map((id) => store.memberById(id)?.name).filter(Boolean).join("; ");
    const yourNet = (paid.get("you") || 0) - (owed.get("you") || 0);
    const d = currencyDigits(e.currency);
    return {
      date: new Date(e.date || e.createdAt).toISOString().slice(0, 10),
      description: e.description || "Expense",
      category: e.category || "",
      trip: e._tripName || "",
      paidBy: payer,
      amount: toMajor(e.amountMinor, e.currency).toFixed(d),
      currency: e.currency,
      split: splitLabel(e),
      yourNet: toMajor(yourNet, e.currency).toFixed(d),
    };
  });
}
function exportLedgerCSV(l) {
  const rows = exportRows(l);
  const header = ["Date", "Description", "Category", "Trip", "Paid by", "Amount", "Currency", "Split", "Your net"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) lines.push([r.date, r.description, r.category, r.trip, r.paidBy, r.amount, r.currency, r.split, r.yourNet].map(csvCell).join(","));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `${l.name.replace(/[^\w]+/g, "_")}_expenses.csv`; a.click();
  toast("CSV downloaded.");
}
function exportLedgerPrint(l) {
  const rows = exportRows(l);
  const { base } = computeBalances(rolledExpenses(l), l.baseCurrency);
  const balRows = rolledMemberIds(l).map((id) => ({ m: store.memberById(id), net: base.get(id) || 0 })).filter((r) => r.m);
  const w = window.open("", "_blank");
  if (!w) return toast("Allow pop-ups to print/export PDF.");
  const money = (minor, c) => formatMoney(minor, c);
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(l.name)} — expenses</title>
    <style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:32px;color:#111}h1{margin:0 0 2px}.sub{color:#666;margin-bottom:18px}
    table{border-collapse:collapse;width:100%;font-size:13px;margin-bottom:26px}th,td{border:1px solid #ddd;padding:7px 9px;text-align:left}th{background:#f4f4f4}
    td.n,th.n{text-align:right}h2{font-size:15px;margin:18px 0 8px}</style></head><body>
    <h1>${esc(l.name)}</h1><div class="sub">${kindLabel[l.kind]} · ${l.baseCurrency} · exported ${new Date().toLocaleDateString()}</div>
    <h2>Expenses</h2>
    <table><thead><tr><th>Date</th><th>Description</th><th>Category</th>${l.kind === "group" ? "<th>Trip</th>" : ""}<th>Paid by</th><th class="n">Amount</th><th>Split</th><th class="n">Your net</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.description)}</td><td>${esc(r.category)}</td>${l.kind === "group" ? `<td>${esc(r.trip)}</td>` : ""}<td>${esc(r.paidBy)}</td><td class="n">${esc(r.amount)} ${esc(r.currency)}</td><td>${esc(r.split)}</td><td class="n">${esc(r.yourNet)}</td></tr>`).join("")}
    </tbody></table>
    <h2>Balances (${l.baseCurrency})</h2>
    <table><thead><tr><th>Person</th><th class="n">Net</th></tr></thead><tbody>
    ${balRows.map((r) => `<tr><td>${esc(r.m.name)}${r.m.id === "you" ? " (you)" : ""}</td><td class="n">${r.net === 0 ? "settled" : (r.net > 0 ? "gets back " : "owes ") + money(Math.abs(r.net), l.baseCurrency)}</td></tr>`).join("")}
    </tbody></table>
    <script>window.onload=()=>window.print()</script></body></html>`);
  w.document.close();
}

// ---------- modals ----------
function modal(title, bodyHTML, footHTML) {
  setSidebar(false); // close the mobile drawer when any dialog opens
  const host = $("#modalHost");
  host.hidden = false;
  host.innerHTML = `<div class="modal"><div class="modal-head"><h3>${esc(title)}</h3><button class="close-x" data-close>×</button></div>
    <div class="modal-body">${bodyHTML}</div><div class="modal-foot">${footHTML}</div></div>`;
  host.onclick = (e) => { if (e.target === host || e.target.dataset.close !== undefined) closeModal(); };
  return host;
}
function closeModal() { const h = $("#modalHost"); h.hidden = true; h.innerHTML = ""; }

// In-app confirmation used for every delete/remove action. For heavier deletions
// (groups, trips, members) pass opts.phrase to require typing it to proceed.
const CONFIRM_WORD = "abracadabra";
function confirmDelete(message, onYes, opts = {}) {
  const phrase = opts.phrase;
  modal(opts.title || "Are you sure?", `
    <p style="margin-top:0;line-height:1.5">${esc(message)}</p>
    <p class="hint" style="margin-top:8px">This can't be undone.</p>
    ${phrase ? `<label>Type <b>${esc(phrase)}</b> below to confirm</label><input id="confirmPhrase" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="${esc(phrase)}">` : ""}
  `, `<button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="confirmYes"${phrase ? " disabled" : ""}>${esc(opts.confirmLabel || "Delete")}</button>`);
  if (phrase) {
    const inp = $("#confirmPhrase"), btn = $("#confirmYes");
    inp.oninput = () => { btn.disabled = inp.value.trim().toLowerCase() !== phrase.toLowerCase(); };
    setTimeout(() => inp.focus(), 30);
  }
  $("#confirmYes").onclick = () => { closeModal(); onYes(); };
}

// Two-way choice modal → cb(true) for the primary, cb(false) for the secondary.
function confirmChoice(message, yesLabel, noLabel, cb) {
  modal("Heads up", `<p style="margin-top:0">${esc(message)}</p>`, `<button class="btn ghost" id="ccNo">${esc(noLabel)}</button><button class="btn" id="ccYes">${esc(yesLabel)}</button>`);
  $("#ccYes").onclick = () => { closeModal(); cb(true); };
  $("#ccNo").onclick = () => { closeModal(); cb(false); };
}

function openLedgerModal(kind) {
  const people = store.state.people;
  const cloudFriend = CLOUD && kind === "individual";
  const nameLabel = kind === "individual" ? (CLOUD ? "Friend's email or @username" : "Friend's name") : "Name";
  const namePlaceholder = kind === "trip" ? "Tokyo 2026" : kind === "group" ? "College Friends" : (CLOUD ? "email or @username" : "Alex");
  modal(`New ${kindLabel[kind].toLowerCase()}`, `
    <label>${nameLabel}</label>
    <input id="mName" ${cloudFriend ? 'autocapitalize="off" spellcheck="false"' : ""} placeholder="${namePlaceholder}">
    <label>Base currency</label>
    <select id="mCur">${Object.keys(CURRENCIES).map((c) => `<option value="${c}">${c} — ${CURRENCIES[c].name}</option>`).join("")}</select>
    ${kind === "trip" ? `<label>Part of a group? (optional)</label><select id="mParent"><option value="">— standalone —</option>${store.ledgers().filter((g) => g.kind === "group").map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select>` : ""}
    ${cloudFriend
      ? `<div class="hint" style="margin-top:14px">Existing members (by email or @username) are added instantly. A new email gets an invite automatically. A @username that doesn't exist can't be invited — use their email.</div>`
      : (CLOUD
        ? `<div class="hint" style="margin-top:14px">👥 After you create this, open the <b>Members</b> tab to add people by email — existing users join instantly, anyone else gets an invite link.</div>`
        : (kind !== "individual" ? `<label>Add people (you're always included)</label>
      <div class="chips" id="mPeople">${people.map((p) => `<span class="chip" data-p="${p.id}">${esc(p.name)}</span>`).join("") || '<span class="exp-meta">No saved people yet — add them below or in the Members tab.</span>'}</div>
      <div class="row" style="margin-top:10px"><input id="mNewP" placeholder="quick add a name"><button class="btn ghost" id="mAddP" style="flex:none">Add</button></div>` : ""))}
  `, `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="mCreate">Create</button>`);

  const chosen = new Set();
  const host = $("#modalHost");
  host.querySelectorAll("[data-p]").forEach((c) => c.onclick = () => { c.classList.toggle("on"); chosen.has(c.dataset.p) ? chosen.delete(c.dataset.p) : chosen.add(c.dataset.p); });
  if ($("#mAddP")) $("#mAddP").onclick = () => {
    const n = $("#mNewP").value.trim(); if (!n) return;
    const p = store.addPerson({ name: n, email: "" });
    const span = document.createElement("span"); span.className = "chip on"; span.dataset.p = p.id; span.textContent = p.name;
    span.onclick = () => { span.classList.toggle("on"); chosen.has(p.id) ? chosen.delete(p.id) : chosen.add(p.id); };
    $("#mPeople").appendChild(span); chosen.add(p.id); $("#mNewP").value = "";
  };
  $("#mCreate").onclick = async () => {
    const input = $("#mName").value.trim();
    if (!input) return toast(cloudFriend ? "Enter their email or @username." : "Enter a name.");

    // Cloud 1:1 friend: create the ledger, then add/invite them by email or username.
    if (cloudFriend) {
      const btn = $("#mCreate"); btn.disabled = true;
      const tempName = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input) ? input.split("@")[0] : input.replace(/^@/, "");
      const l = store.addLedger({ kind, name: tempName, baseCurrency: $("#mCur").value, memberIds: [] });
      const res = await store.addMemberByEmail(l.id, input);
      if (res.status === "error" || res.status === "exists") { store.removeLedger(l.id); btn.disabled = false; return toast(res.message); }
      if (res.status === "added") store.updateLedger(l.id, { name: res.name });
      closeModal(); view = { type: "ledger", ledgerId: l.id, tab: "expenses" }; render();
      if (res.status === "invited") openInvite(l, res);
      else toast(res.emailed ? `Added ${res.name} — emailed them.` : `Added ${res.name}.`);
      return;
    }

    let memberIds = [];
    if (!CLOUD) {
      memberIds = [...chosen];
      if (kind === "individual") { const p = store.addPerson({ name: input, email: "" }); memberIds = [p.id]; }
    }
    const l = store.addLedger({ kind, name: input, baseCurrency: $("#mCur").value, memberIds, parentId: $("#mParent")?.value || null });
    closeModal(); view = { type: "ledger", ledgerId: l.id, tab: CLOUD ? "members" : "expenses" }; render();
    toast(`${kindLabel[kind]} created.${CLOUD ? " Add people by email in the Members tab." : ""}`);
  };
}

function openPersonModal(id) {
  const m = store.memberById(id);
  const showUser = id === "you" && CLOUD;
  modal(id === "you" ? "Your profile" : "Edit person", `
    <label>Name</label><input id="pName" value="${esc(m.name)}">
    ${showUser
      ? `<label>Email <span class="exp-meta">· your sign-in address</span></label>
         <div class="row"><input value="${esc(m.email || "")}" readonly style="opacity:.85"><button class="btn ghost" id="pChangeEmail" style="flex:none">Change</button></div>`
      : `<label>Email (for reminders)</label><input id="pEmail" value="${esc(m.email || "")}" placeholder="name@example.com">`}
    ${showUser ? `<label>Username</label>
      ${store.state.you.username
        ? `<div class="mail-preview">@${esc(store.state.you.username)} <span class="exp-meta">· permanent, can't be changed</span></div>`
        : `<div class="row"><input id="pUser" value="" placeholder="not set" disabled style="opacity:.85"><button class="btn ghost" id="pUserBtn" style="flex:none">Set username</button></div>`}` : ""}
    ${showUser ? `<label>Thumbnail color</label>
      <div style="display:flex;align-items:center;gap:12px">
        <div class="avatar" id="avPreview" style="background:${avColor(store.state.you)}">${esc(initials(store.state.you.name))}</div>
        <div class="chips" id="avSwatches">${AVATAR_COLORS.map((c) => `<span class="av-swatch${(store.state.you.color || "#2f6fd6") === c ? " on" : ""}" data-color="${c}" style="background:${c}"></span>`).join("")}</div>
      </div>` : ""}
  `, `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="pSave">Save</button>`);
  if (showUser && $("#pUserBtn")) $("#pUserBtn").onclick = () => { closeModal(); openUsernameModal(false); };
  if ($("#pChangeEmail")) $("#pChangeEmail").onclick = () => { closeModal(); openChangeEmailModal(); };
  let pickedColor = store.state.you.color || null;
  if (showUser) $("#avSwatches").querySelectorAll("[data-color]").forEach((s) => s.onclick = () => {
    pickedColor = s.dataset.color;
    $("#avSwatches").querySelectorAll("[data-color]").forEach((x) => x.classList.toggle("on", x === s));
    const pv = $("#avPreview"); if (pv) pv.style.background = pickedColor;
  });
  $("#pSave").onclick = async () => {
    const patch = { name: $("#pName").value.trim() || m.name };
    if ($("#pEmail")) patch.email = $("#pEmail").value.trim(); // own email is read-only (changed via the verified flow)
    store.updatePerson(id, patch);
    if (showUser && pickedColor !== (store.state.you.color || null)) await store.setAvatarColor(pickedColor);
    closeModal(); render(); toast("Saved.");
  };
}

// Verified email change — Supabase sends a confirmation link; the login email
// only changes once it's clicked.
function openChangeEmailModal() {
  modal("Change email", `
    <p class="hint" style="margin-top:0">Your email is how you sign in. We'll send a confirmation link to the new address — the change only takes effect once you click it.</p>
    <label>Current</label><div class="mail-preview">${esc(store.state.you.email || "")}</div>
    <label>New email</label>
    <input id="ceInput" type="email" autocapitalize="off" spellcheck="false" placeholder="new@example.com">
    <div id="ceMsg" style="margin-top:10px"></div>
  `, `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="ceSend">Send confirmation</button>`);
  $("#ceSend").onclick = async () => {
    const v = $("#ceInput").value.trim();
    if (!v) return toast("Enter the new email.");
    const btn = $("#ceSend"); btn.disabled = true; $("#ceMsg").innerHTML = `<span class="hint">Sending…</span>`;
    const r = await store.changeEmail(v); btn.disabled = false;
    if (r.ok) $("#ceMsg").innerHTML = `<span class="pos">✅ Confirmation sent to ${esc(v)}. If asked, also confirm from your current inbox. Your sign-in email updates once you click the link.</span>`;
    else $("#ceMsg").innerHTML = `<span class="neg">${esc(r.error)}</span>`;
  };
  setTimeout(() => { const i = $("#ceInput"); if (i) i.focus(); }, 30);
}

// Username picker with a LIVE availability check against the database.
// required=true → shown on first sign-in and can't be dismissed until set.
function openUsernameModal(required) {
  const cur = store.state.you.username || "";
  modal("Pick your username", `
    <p class="hint" style="margin-top:0">Choose a unique username so friends can add you by <b>@username</b>. <b>Pick carefully — it's permanent and can't be changed later.</b></p>
    <label>Username</label>
    <div style="position:relative">
      <span style="position:absolute;left:11px;top:11px;color:var(--muted)">@</span>
      <input id="unInput" style="padding-left:24px" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="yourname" value="${esc(cur)}">
    </div>
    <div id="unMsg" class="hint" style="min-height:18px;margin-top:8px"></div>
  `, `${required ? "" : '<button class="btn ghost" data-close>Cancel</button>'}<button class="btn" id="unSave" disabled>Save</button>`);

  const host = $("#modalHost");
  if (required) { host.onclick = null; const x = host.querySelector(".close-x"); if (x) x.remove(); } // can't dismiss

  const input = $("#unInput"), msg = $("#unMsg"), save = $("#unSave");
  let timer;
  const check = async () => {
    const v = input.value.trim().toLowerCase();
    if (!v) { msg.textContent = ""; save.disabled = true; return; }
    if (!/^[a-z0-9_]{3,20}$/.test(v)) { msg.innerHTML = '<span class="neg">3–20 characters: lowercase letters, numbers, or underscore.</span>'; save.disabled = true; return; }
    if (v === cur) { msg.innerHTML = '<span class="pos">This is your current username.</span>'; save.disabled = false; return; }
    msg.textContent = "Checking availability…"; save.disabled = true;
    const ok = await store.usernameAvailable(v);
    if (input.value.trim().toLowerCase() !== v) return; // input changed while we were checking
    if (ok) { msg.innerHTML = `<span class="pos">@${esc(v)} is available ✓</span>`; save.disabled = false; }
    else { msg.innerHTML = `<span class="neg">@${esc(v)} is already taken — try another.</span>`; save.disabled = true; }
  };
  input.oninput = () => { save.disabled = true; clearTimeout(timer); timer = setTimeout(check, 350); };
  save.onclick = async () => {
    save.disabled = true; msg.textContent = "Saving…";
    const res = await store.setUsername(input.value.trim());
    if (res.ok) { closeModal(); render(); toast("Username saved."); }
    else { msg.innerHTML = `<span class="neg">${esc(res.error)}</span>`; save.disabled = false; }
  };
  setTimeout(() => input.focus(), 30);
}

// ---------- expense modal (the big one) ----------
function openExpenseModal(ledgerId, editId) {
  const l = store.ledgerById(ledgerId);
  const existing = editId ? store.state.expenses.find((e) => e.id === editId) : null;
  const members = l.memberIds.map((id) => store.memberById(id)).filter(Boolean);

  // working state
  const st = {
    currency: existing?.currency || l.baseCurrency,
    method: existing?.split?.type || "equal",
    participants: new Set(existing ? participantsOf(existing) : l.memberIds),
    payer: existing?.paidBy?.[0]?.memberId || "you",
    receipt: existing?.receipt || null,
    items: null,   // lazily built {items:[{name,amount,parts:Set}], tax, tip}
  };
  // seed itemized editor from an existing itemized expense
  if (existing?.split?.type === "items") {
    const legacyShared = existing.split.sharedMinor ? toMajor(existing.split.sharedMinor, existing.currency) : "";
    st.items = {
      items: (existing.split.items || []).map((it) => ({ name: it.name, amount: toMajor(it.amountMinor, existing.currency), parts: new Set(it.participants) })),
      tax: existing.split.taxMinor ? toMajor(existing.split.taxMinor, existing.currency) : (legacyShared || ""),
      tip: existing.split.tipMinor ? toMajor(existing.split.tipMinor, existing.currency) : "",
    };
  }

  modal(existing ? "Edit expense" : "Add expense", `
    <label>Description</label>
    <input id="eDesc" value="${esc(existing?.description || "")}" placeholder="Dinner at Nabe">
    <div class="row">
      <div><label>Amount</label><input id="eAmt" type="text" inputmode="decimal" value="${existing ? toMajor(existing.amountMinor, existing.currency) : ""}" placeholder="0.00"></div>
      <div style="flex:0 0 120px"><label>Currency</label><select id="eCur">${Object.keys(CURRENCIES).map((c) => `<option value="${c}" ${st.currency === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
    </div>
    <div id="fxRow" ${st.currency === l.baseCurrency ? "hidden" : ""}>
      <label>Exchange rate → ${l.baseCurrency} <span class="hint" style="display:inline">(1 <span id="fxFrom">${st.currency}</span> = ? ${l.baseCurrency})</span></label>
      <input id="eFx" type="text" inputmode="decimal" value="${existing?.fxToBase ?? ""}" placeholder="e.g. 0.0067">
    </div>
    <div class="row">
      <div><label>Paid by</label><select id="ePayer">${members.map((m) => `<option value="${m.id}" ${st.payer === m.id ? "selected" : ""}>${esc(m.name)}${m.id === "you" ? " (you)" : ""}</option>`).join("")}</select></div>
      <div><label>Date</label><input id="eDate" type="date" value="${new Date(existing?.date || Date.now()).toISOString().slice(0, 10)}"></div>
      <div style="flex:0 0 92px"><label>Category</label><select id="eCat">${Object.keys(CATEGORIES).filter((c) => c !== "settle").map((c) => `<option value="${c}" ${existing?.category === c ? "selected" : ""}>${CATEGORIES[c]} ${c}</option>`).join("")}</select></div>
    </div>

    <label>Split method</label>
    <div class="seg" id="eMethod">
      ${[["equal", "= Equal"], ["exact", "Exact"], ["percent", "%"], ["shares", "Shares"], ["items", "Items"]].map(([k, v]) => `<button data-m="${k}" class="${st.method === k ? "on" : ""}">${v}</button>`).join("")}
    </div>
    <div id="splitArea" style="margin-top:12px"></div>
    <div id="splitStatus" class="hint"></div>

    <label>Pay the payer back to… (optional)</label>
    <textarea id="ePay" rows="2" placeholder="e.g. Venmo @drin · Zelle 555-123-4567 · PayPal drin@email · BPI 1234-5678 · or just 'Cash'">${esc(existing?.paymentInfo || "")}</textarea>
    <div class="hint">Venmo, Zelle, PayPal, a bank account, Cash, or anything else — shown to everyone who owes on this expense so they know where to send the money.</div>

    <label>Receipt photo (optional)</label>
    <input id="eReceipt" type="file" accept="image/*">
    <div id="receiptPrev" style="margin-top:8px">${st.receipt ? `<img src="${st.receipt}" class="receipt-thumb">` : ""}</div>
  `, `<button class="btn ghost" data-close>Cancel</button><button class="btn" id="eSave">${existing ? "Save changes" : "Add expense"}</button>`);

  const host = $("#modalHost");
  const amtEl = $("#eAmt"), curEl = $("#eCur");

  function renderSplitArea() {
    const area = $("#splitArea");
    const parts = members.filter((m) => st.participants.has(m.id));
    // In itemized mode the total is computed from subtotal + tax + tip, so the
    // Amount box becomes read-only and auto-fills.
    amtEl.readOnly = st.method === "items";
    amtEl.style.opacity = st.method === "items" ? "0.7" : "1";
    if (st.method === "items") { renderItemsEditor(area, members, st, updateStatus); updateStatus(); return; }

    // participant chips
    let html = `<div class="chips">${members.map((m) => `<span class="chip ${st.participants.has(m.id) ? "on" : ""}" data-part="${m.id}">${esc(m.name)}</span>`).join("")}</div>`;
    if (st.method !== "equal") {
      html += `<div style="margin-top:12px">${parts.map((m) => `<div class="split-line"><span class="name">${esc(m.name)}</span>
        <input data-val="${m.id}" type="text" inputmode="decimal" placeholder="${st.method === "percent" ? "%" : st.method === "shares" ? "shares" : "amount"}" value="${prefill(existing, m.id, st.method)}"></div>`).join("")}</div>`;
    }
    area.innerHTML = html;
    area.querySelectorAll("[data-part]").forEach((c) => c.onclick = () => {
      const id = c.dataset.part;
      st.participants.has(id) ? st.participants.delete(id) : st.participants.add(id);
      renderSplitArea();
    });
    area.querySelectorAll("[data-val]").forEach((inp) => inp.oninput = updateStatus);
    updateStatus();
  }

  function currentSplit() {
    const parts = members.filter((m) => st.participants.has(m.id)).map((m) => m.id);
    if (st.method === "items") {
      const cur = st.currency;
      const src = st.items || { items: [], tax: "", tip: "" };
      const items = src.items.filter((it) => it.name || it.amount).map((it) => ({ name: it.name, amountMinor: toMinor(it.amount || 0, cur), participants: [...it.parts] }));
      return { type: "items", items, taxMinor: toMinor(src.tax || 0, cur), tipMinor: toMinor(src.tip || 0, cur) };
    }
    if (st.method === "equal") return { type: "equal", participants: parts };
    if (st.method === "exact") return { type: "exact", participants: parts, amounts: parts.map((id) => toMinor($(`[data-val="${id}"]`).value || 0, st.currency)) };
    // percent or shares
    return { type: st.method, participants: parts, weights: parts.map((id) => parseFloat($(`[data-val="${id}"]`).value || 0) || 0) };
  }

  function updateStatus() {
    const totalMinor = toMinor(amtEl.value || 0, st.currency);
    const exp = { amountMinor: totalMinor, currency: st.currency, split: currentSplit(), paidBy: [{ memberId: st.payer, amountMinor: totalMinor }] };
    const owed = computeOwed(exp);
    const sum = [...owed.values()].reduce((a, b) => a + b, 0);
    const el = $("#splitStatus");
    if (st.method === "percent") {
      const pct = (currentSplit().weights || []).reduce((a, b) => a + b, 0);
      el.innerHTML = `Percentages add to <b>${pct}%</b>. ${pct === 100 ? "✅" : "⚠️ should be 100%"}`;
    } else if (st.method === "items") {
      const s = currentSplit();
      const subtotal = (s.items || []).reduce((a, i) => a + i.amountMinor, 0);
      const tax = s.taxMinor || 0, tip = s.tipMinor || 0;
      const grand = subtotal + tax + tip;
      // auto-fill the (read-only) Amount box with the computed grand total
      amtEl.value = grand ? toMajor(grand, st.currency) : "";
      const parts = [`Subtotal <b>${formatMoney(subtotal, st.currency)}</b>`];
      if (tax) parts.push(`tax <b>${formatMoney(tax, st.currency)}</b>`);
      if (tip) parts.push(`tip <b>${formatMoney(tip, st.currency)}</b>`);
      el.innerHTML = `${parts.join(" + ")} = total <b>${formatMoney(grand, st.currency)}</b> ✅<br><span style="color:var(--muted)">Tax &amp; tip are shared out in proportion to what each person ordered.</span>`;
    } else {
      const diff = totalMinor - sum;
      el.innerHTML = diff === 0 ? "Splits add up ✅" : `<span class="neg">Off by ${formatMoney(Math.abs(diff), st.currency)} — ${diff > 0 ? "unassigned" : "over"}</span>`;
    }
  }

  host.querySelectorAll("[data-m]").forEach((b) => b.onclick = () => {
    st.method = b.dataset.m;
    host.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("on", x.dataset.m === st.method));
    renderSplitArea();
  });
  curEl.onchange = () => { st.currency = curEl.value; $("#fxRow").hidden = st.currency === l.baseCurrency; $("#fxFrom").textContent = st.currency; renderSplitArea(); };
  amtEl.oninput = () => { if (st.method === "equal" || st.method === "items") updateStatus(); else updateStatus(); };
  $("#ePayer").onchange = (e) => st.payer = e.target.value;
  $("#eReceipt").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    st.receipt = await resizeImage(file);
    $("#receiptPrev").innerHTML = `<img src="${st.receipt}" class="receipt-thumb">`;
  };

  $("#eSave").onclick = () => {
    const split = currentSplit();
    const amountMinor = st.method === "items"
      ? (split.items || []).reduce((a, i) => a + i.amountMinor, 0) + (split.taxMinor || 0) + (split.tipMinor || 0)
      : toMinor(amtEl.value || 0, st.currency);
    if (amountMinor <= 0) return toast(st.method === "items" ? "Add at least one item." : "Enter an amount.");
    const exp = {
      ledgerId, description: $("#eDesc").value.trim(), amountMinor, currency: st.currency,
      fxToBase: st.currency === l.baseCurrency ? 1 : (parseFloat($("#eFx").value) || 1),
      paidBy: [{ memberId: st.payer, amountMinor }],
      split, category: $("#eCat").value, date: new Date($("#eDate").value).getTime() || Date.now(),
      receipt: st.receipt || null,
      paymentInfo: ($("#ePay").value || "").trim() || null,
    };
    const errs = validateExpense(exp);
    if (errs.length && !confirm("Heads up — the split doesn't add up exactly:\n\n" + errs.join("\n") + "\n\nSave anyway?")) return;
    if (existing) store.updateExpense(existing.id, exp); else store.addExpense(exp);
    closeModal(); render(); toast(existing ? "Expense updated." : "Expense added.");
  };

  renderSplitArea();
}

// itemized editor — all state lives on st.items (per-modal, no globals)
function renderItemsEditor(area, members, st, onChange) {
  if (!st.items) st.items = { items: [{ name: "", amount: "", parts: new Set(st.participants) }], tax: "", tip: "" };
  const S = st.items;
  if (!("tax" in S)) S.tax = ""; if (!("tip" in S)) S.tip = "";
  const draw = () => {
    // preserve focus across redraws (chips redraw the whole area)
    const active = document.activeElement;
    const activeKey = active && active.dataset ? (active.dataset.iname !== undefined ? "n" + active.dataset.iname : active.dataset.iamt !== undefined ? "a" + active.dataset.iamt : active.id) : null;
    area.innerHTML = `
      <div class="hint">Add each item and tap who shared it. Enter the <b>subtotal</b> per item; tax and gratuity below are optional and get split in proportion to what each person ordered.</div>
      ${S.items.map((it, i) => `
        <div class="card" style="margin:10px 0;padding:12px">
          <div class="row"><input data-iname="${i}" placeholder="Item (e.g. Ramen)" value="${esc(it.name)}"><input data-iamt="${i}" style="flex:0 0 110px" inputmode="decimal" placeholder="amount" value="${esc(it.amount)}"></div>
          <div class="chips" style="margin-top:8px">${members.map((m) => `<span class="chip ${it.parts.has(m.id) ? "on" : ""}" data-ip="${i}:${m.id}">${esc(m.name)}</span>`).join("")}</div>
          <button class="link-btn" data-irm="${i}" style="margin-top:6px">✖ remove item</button>
        </div>`).join("")}
      <button class="btn ghost sm" id="addItem">＋ Add item</button>
      <div class="row" style="margin-top:6px">
        <div><label>Tax (optional)</label><input id="iTax" inputmode="decimal" placeholder="0.00" value="${esc(S.tax)}"></div>
        <div><label>Gratuity / tip (optional)</label><input id="iTip" inputmode="decimal" placeholder="0.00" value="${esc(S.tip)}"></div>
      </div>
    `;
    area.querySelector("#addItem").onclick = () => { S.items.push({ name: "", amount: "", parts: new Set(st.participants) }); draw(); onChange && onChange(); };
    area.querySelectorAll("[data-iname]").forEach((el) => el.oninput = () => { S.items[+el.dataset.iname].name = el.value; });
    area.querySelectorAll("[data-iamt]").forEach((el) => el.oninput = () => { S.items[+el.dataset.iamt].amount = el.value; onChange && onChange(); });
    area.querySelector("#iTax").oninput = (e) => { S.tax = e.target.value; onChange && onChange(); };
    area.querySelector("#iTip").oninput = (e) => { S.tip = e.target.value; onChange && onChange(); };
    area.querySelectorAll("[data-ip]").forEach((c) => c.onclick = () => { const [i, id] = c.dataset.ip.split(":"); const p = S.items[+i].parts; p.has(id) ? p.delete(id) : p.add(id); draw(); onChange && onChange(); });
    area.querySelectorAll("[data-irm]").forEach((b) => b.onclick = () => { S.items.splice(+b.dataset.irm, 1); if (!S.items.length) S.items.push({ name: "", amount: "", parts: new Set(st.participants) }); draw(); onChange && onChange(); });
    // restore focus
    if (activeKey) {
      const sel = activeKey[0] === "n" ? `[data-iname="${activeKey.slice(1)}"]` : activeKey[0] === "a" ? `[data-iamt="${activeKey.slice(1)}"]` : "#" + activeKey;
      const el = area.querySelector(sel); if (el) { el.focus(); const v = el.value; el.value = ""; el.value = v; }
    }
  };
  draw();
}

function participantsOf(e) {
  if (e.split?.type === "items") return [...new Set((e.split.items || []).flatMap((i) => i.participants))];
  return e.split?.participants || [];
}
function prefill(existing, id, method) {
  if (!existing || !existing.split) return "";
  const s = existing.split; const idx = (s.participants || []).indexOf(id);
  if (idx < 0) return "";
  if (method === "exact") return toMajor((s.amounts || [])[idx] || 0, existing.currency);
  if (method === "percent" || method === "shares") return (s.weights || [])[idx] || "";
  return "";
}

function openReceipt(src) {
  modal("Receipt", `<img src="${src}" style="width:100%;border-radius:8px">`, `<button class="btn" data-close>Close</button>`);
}

// ---------- image resize (keep localStorage small) ----------
function resizeImage(file, max = 1000, quality = 0.7) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(null);
    const r = new FileReader(); r.onload = () => (img.src = r.result); r.readAsDataURL(file);
  });
}

// ---------- backup ----------
function openBackup() {
  const intro = CLOUD
    ? "Your data is stored in your cloud database and shared with everyone in your groups. Use Export to download your own snapshot (a JSON file) for your records."
    : "Your data is saved in this browser. Export a backup to keep it safe or move it to another device, and import one to restore it.";
  modal("Export data", `
    <p class="hint" style="margin-top:0">${intro}</p>
    <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
      <button class="btn" id="expBtn">⬇️ Export (.json)</button>
      ${CLOUD ? "" : `<button class="btn ghost" id="impBtn">⬆️ Import backup</button>`}
    </div>
    <input id="impFile" type="file" accept="application/json" hidden>
    ${CLOUD ? "" : `<hr style="border-color:var(--line);margin:18px 0"><button class="btn danger" id="resetBtn">Erase all data</button>`}
  `, `<button class="btn ghost" data-close>Close</button>`);
  $("#expBtn").onclick = () => {
    const blob = new Blob([store.exportJSON()], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `uno-ledger-export-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  };
  if ($("#impBtn")) $("#impBtn").onclick = () => $("#impFile").click();
  if ($("#impFile")) $("#impFile").onchange = (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { store.importJSON(r.result); closeModal(); render(); toast("Backup restored."); } catch (err) { toast(err.message); } }; r.readAsText(f); };
  if ($("#resetBtn")) $("#resetBtn").onclick = () => confirmDelete("Erase ALL data on this device?", () => { store.reset(); view = { type: "dashboard" }; render(); toast("Erased."); }, { confirmLabel: "Erase everything" });
}

// ---------- misc ----------
function emptyState(icon, title, sub, extra = "") {
  return `<div class="empty-state"><div class="big">${icon}</div><h3 style="margin:0 0 6px;color:var(--text)">${esc(title)}</h3><p style="max-width:440px;margin:0 auto">${esc(sub)}</p>${extra}</div>`;
}
function mobileBar() { return `<div class="mobile-bar"><button class="hamburger" id="hamburger">☰ Menu</button><b>UNO Ledger</b></div>`; }
function setSidebar(open) {
  const sb = $("#sidebar"); if (sb) sb.classList.toggle("open", open);
  const bd = $("#backdrop"); if (bd) bd.hidden = !open;
}
function wireMobile() {
  const h = $("#hamburger"); if (h) h.onclick = () => setSidebar(!$("#sidebar").classList.contains("open"));
  const bd = $("#backdrop"); if (bd) bd.onclick = () => setSidebar(false);
}

// ---------- boot ----------
function render() {
  if (CLOUD && store) store.activeChat = (view.type === "chat" ? view.chatId : null);
  renderSidebar();
  if (view.type === "dashboard") renderDashboard();
  else if (view.type === "friends") renderFriends();
  else if (view.type === "friend") renderFriendDetail(view.friendId);
  else if (view.type === "approvals") renderApprovals();
  else if (view.type === "invitations") renderInvitations();
  else if (view.type === "messages") renderMessages();
  else if (view.type === "chat") renderChat(view.chatId);
  else renderLedger();
  try { localStorage.setItem("uno.view", JSON.stringify(view)); } catch (e) {}
}
// Restore the last page so a refresh lands where you were.
function restoreView() {
  try { const v = JSON.parse(localStorage.getItem("uno.view")); if (v && v.type) view = v; } catch (e) {}
}

// wire global sidebar buttons
document.querySelectorAll(".nav-item").forEach((b) => b.onclick = () => { view = { type: b.dataset.view }; setSidebar(false); render(); });
document.querySelectorAll("[data-new]").forEach((b) => b.onclick = () => openLedgerModal(b.dataset.new));
$("#dataBtn").onclick = () => openBackup();

function openPeopleModal() {
  const people = store.state.people;
  modal("People", `
    <p class="hint" style="margin-top:0">${CLOUD ? "People across your groups. To add someone new, open a group's <b>Members</b> tab and add them by email." : "Friends you split with. Add their email so reminders can reach them."}</p>
    <div class="card" style="padding:6px 0">
      <div class="bal-row">${avatarEl(store.state.you)}<div class="grow"><b>${esc(store.state.you.name)}</b> (you)</div><button class="btn ghost sm" id="editYou">Edit</button></div>
      ${people.map((p) => `<div class="bal-row">${avatarEl(p)}<div class="grow"><b>${esc(p.name)}</b> <span class="exp-meta">${p.email ? esc(p.email) : "no email"}</span>${CLOUD && !p.userId && p.email ? ` <span class="tag" style="color:var(--amber)">pending</span>` : ""}</div>${CLOUD ? "" : `<button class="icon-btn" data-pedit="${p.id}">✏️</button>`}<button class="icon-btn" data-pdel="${p.id}">🗑️</button></div>`).join("")}
    </div>
    ${CLOUD ? "" : `<div class="row" style="margin-top:14px"><input id="ppName" placeholder="name"><input id="ppEmail" placeholder="email"><button class="btn" id="ppAdd" style="flex:none">Add</button></div>`}
  `, `<button class="btn ghost" data-close>Close</button>`);
  $("#editYou").onclick = () => openPersonModal("you");
  if ($("#ppAdd")) $("#ppAdd").onclick = () => { const n = $("#ppName").value.trim(); if (!n) return toast("Enter a name."); store.addPerson({ name: n, email: $("#ppEmail").value }); openPeopleModal(); render(); };
  document.querySelectorAll("[data-pedit]").forEach((b) => b.onclick = () => openPersonModal(b.dataset.pedit));
  document.querySelectorAll("[data-pdel]").forEach((b) => b.onclick = () => confirmDelete("Remove this person from all your groups and trips?", () => { store.removePerson(b.dataset.pdel); openPeopleModal(); render(); }, { confirmLabel: "Remove", phrase: CONFIRM_WORD }));
}

function addSignOut() {
  const foot = document.querySelector(".sidebar-foot");
  if (foot && !document.getElementById("signOutBtn")) {
    const b = document.createElement("button");
    b.className = "link-btn"; b.id = "signOutBtn"; b.textContent = "🚪 Sign out";
    b.onclick = () => signOut();
    foot.appendChild(b);
  }
}

// Everyone gets an "Invitations" item in the sidebar with a red-dot count.
function addInboxNav() {
  if (!CLOUD) return;
  const nav = document.querySelector(".nav");
  if (!nav || document.getElementById("inboxNav")) return;
  const b = document.createElement("button");
  b.className = "nav-item"; b.id = "inboxNav"; b.dataset.view = "invitations";
  b.innerHTML = `✉️ <span>Invitations</span> <span class="nav-dot" id="inboxDot" hidden></span>`;
  b.onclick = () => { view = { type: "invitations" }; setSidebar(false); render(); };
  nav.appendChild(b);
}
// Messages item in the sidebar with an unread red-dot count.
function addMessagesNav() {
  if (!CLOUD) return;
  const nav = document.querySelector(".nav");
  if (!nav || document.getElementById("msgNav")) return;
  const b = document.createElement("button");
  b.className = "nav-item"; b.id = "msgNav"; b.dataset.view = "messages";
  b.innerHTML = `💬 <span>Messages</span> <span class="nav-dot" id="msgDot" hidden></span>`;
  b.onclick = () => { view = { type: "messages" }; setSidebar(false); render(); };
  nav.appendChild(b);
}
// Open (or reuse) a 1:1 chat with someone, then jump into it.
async function openDm(userId) {
  const r = await store.startDm(userId);
  if (r.ok) { view = { type: "chat", chatId: r.chatId }; render(); }
  else toast(r.error || "Couldn't open chat.");
}
function setDot(id, n) {
  const dot = document.getElementById(id);
  if (!dot) return;
  if (n > 0) { dot.textContent = n; dot.hidden = false; } else { dot.hidden = true; }
}
function updateInboxBadge() {
  setDot("inboxDot", CLOUD && store.pendingCount ? store.pendingCount() : 0);
  setDot("apprDot", CLOUD && store.isPlatformAdmin && store.pendingApprovalCount ? store.pendingApprovalCount() : 0);
  setDot("msgDot", CLOUD && store.messagesUnread ? store.messagesUnread() : 0);
}
// Refresh pending queues when the tab regains focus, so new items appear without a reload.
let _inboxBusy = false;
async function refreshInbox() {
  if (!CLOUD || !store.refreshInbox || _inboxBusy || document.hidden) return;
  _inboxBusy = true;
  const tally = () => (store.pendingCount ? store.pendingCount() : 0) + (store.pendingApprovalCount ? store.pendingApprovalCount() : 0) + (store.messagesUnread ? store.messagesUnread() : 0);
  const before = tally();
  try { await store.refreshInbox(); } finally { _inboxBusy = false; }
  updateInboxBadge();
  if (tally() !== before && ["invitations", "approvals", "messages", "chat"].includes(view.type)) render();
}
function wireInboxRefresh() {
  if (!CLOUD) return;
  document.addEventListener("visibilitychange", refreshInbox);
  window.addEventListener("focus", refreshInbox);
}

// Platform admins get an "Approvals" item in the sidebar.
function addAdminNav() {
  if (!CLOUD || !store.isPlatformAdmin) return;
  const nav = document.querySelector(".nav");
  if (!nav || document.getElementById("apprNav")) return;
  const b = document.createElement("button");
  b.className = "nav-item"; b.id = "apprNav"; b.dataset.view = "approvals";
  b.innerHTML = `🛡️ <span>Approvals</span> <span class="nav-dot" id="apprDot" hidden></span>`;
  b.onclick = () => { view = { type: "approvals" }; setSidebar(false); render(); };
  nav.appendChild(b);
}

async function boot() {
  if (CONFIG.MODE === "cloud") {
    let ok = false;
    try { ok = await startCloud(); }
    catch (e) {
      document.getElementById("main").innerHTML =
        `<div class="empty-state"><div class="big">⚠️</div><h3 style="color:var(--text)">Couldn't connect to Supabase</h3><p>${esc(e.message || e)}</p><p class="hint">Double-check SUPABASE_URL and the key in js/config.js.</p></div>`;
      return;
    }
    if (!ok) return; // login screen is showing; don't render the app
    addSignOut();
    addMessagesNav();
    addInboxNav();
    addAdminNav();
    wireInboxRefresh();
    if (store.onMessage) store.onMessage(onRealtime);
    if (store.startRealtime) store.startRealtime();
    restoreView();
    render();
    if (!store.state.you.username) openUsernameModal(true); // required on first sign-in
    return;
  }
  restoreView();
  render();
}
boot();
