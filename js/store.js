// store.js — the local data layer.
//
// Keeps everything in memory and persists it to the browser's localStorage.
// When MODE is "cloud" (js/config.js), js/cloud.js swaps in a Supabase-backed
// store with the same API via setStore(), so no UI code changes.

const LS_KEY = "billbreak.v1";

function uid() {
  return "id_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

const emptyState = () => ({
  version: 1,
  you: { id: "you", name: "You", email: "" },
  people: [],      // {id, name, email}
  ledgers: [],     // {id, kind:'group'|'trip'|'individual', name, baseCurrency, memberIds, parentId, reminder, createdAt}
  expenses: [],    // {id, ledgerId, ...} (see split.js for the shape)
});

class LocalStore {
  constructor() {
    this.state = this._load();
    this.listeners = new Set();
  }
  _load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { console.warn("load failed", e); }
    return emptyState();
  }
  _persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.state)); }
    catch (e) { console.warn("persist failed", e); }
    this.listeners.forEach((fn) => fn(this.state));
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // ---- people --------------------------------------------------------------
  allMembers() { return [this.state.you, ...this.state.people]; }
  memberById(id) { return this.allMembers().find((m) => m.id === id); }
  addPerson({ name, email }) {
    const p = { id: uid(), name: name.trim(), email: (email || "").trim() };
    this.state.people.push(p);
    this._persist();
    return p;
  }
  updatePerson(id, patch) {
    if (id === "you") { Object.assign(this.state.you, patch); this._persist(); return; }
    const p = this.state.people.find((x) => x.id === id);
    if (p) { Object.assign(p, patch); this._persist(); }
  }
  removePerson(id) {
    this.state.people = this.state.people.filter((p) => p.id !== id);
    this.state.ledgers.forEach((l) => { l.memberIds = l.memberIds.filter((m) => m !== id); });
    this._persist();
  }

  // ---- ledgers (groups / trips / individuals) ------------------------------
  ledgers() { return this.state.ledgers; }
  ledgerById(id) { return this.state.ledgers.find((l) => l.id === id); }
  addLedger({ kind, name, baseCurrency = "USD", memberIds = [], parentId = null }) {
    const l = {
      id: uid(), kind, name: name.trim(), baseCurrency,
      memberIds: [...new Set(["you", ...memberIds])],
      parentId,
      reminder: { enabled: false, frequency: "weekly", lastSentAt: null, message: "" },
      createdAt: Date.now(),
    };
    this.state.ledgers.push(l);
    this._persist();
    return l;
  }
  updateLedger(id, patch) {
    const l = this.ledgerById(id);
    if (l) { Object.assign(l, patch); this._persist(); }
  }
  removeLedger(id) {
    this.state.ledgers = this.state.ledgers.filter((l) => l.id !== id && l.parentId !== id);
    this.state.expenses = this.state.expenses.filter((e) => e.ledgerId !== id);
    this._persist();
  }

  // ---- expenses ------------------------------------------------------------
  expensesFor(ledgerId) {
    return this.state.expenses
      .filter((e) => e.ledgerId === ledgerId)
      .sort((a, b) => (b.date || 0) - (a.date || 0) || b.createdAt - a.createdAt);
  }
  addExpense(exp) {
    const e = { id: uid(), createdAt: Date.now(), ...exp };
    this.state.expenses.push(e);
    this._persist();
    return e;
  }
  updateExpense(id, patch) {
    const e = this.state.expenses.find((x) => x.id === id);
    if (e) { Object.assign(e, patch); this._persist(); }
  }
  removeExpense(id) {
    this.state.expenses = this.state.expenses.filter((e) => e.id !== id);
    this._persist();
  }

  exportJSON() { return JSON.stringify(this.state, null, 2); }
  importJSON(text) {
    const data = JSON.parse(text);
    if (!data || !data.version) throw new Error("Not a UNO backup file.");
    this.state = data;
    this._persist();
  }
  reset() { this.state = emptyState(); this._persist(); }
}

// `store` is a live binding: cloud mode swaps in a CloudStore via setStore()
// (js/cloud.js) after login, and every importer sees the new instance.
export let store = new LocalStore();
export function setStore(s) { store = s; }
export { uid };
