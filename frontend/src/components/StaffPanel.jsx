import React, { useEffect, useState } from "react";
import api from "../api";

const ROLE_LABEL = { staff: "Staff", kitchen: "Kitchen", admin: "Administrator" };
const MANAGED_ROLES = ["staff", "kitchen", "admin"];

/**
 * Staff, kitchen and administrator accounts (Phase 2 section 7). Students are
 * not listed here: the list shows only staff-type accounts. Changes are
 * applied by the server immediately.
 */
export default function StaffPanel() {
  const [accounts, setAccounts] = useState([]);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "kitchen" });

  const load = async () => {
    try {
      const lists = await Promise.all(MANAGED_ROLES.map((role) => api.get("/users", { params: { role } })));
      setAccounts(lists.flatMap((r) => r.data || []));
    } catch (err) {
      setError(err.message || "Could not load accounts");
    }
  };

  useEffect(() => {
    let alive = true;
    Promise.all(MANAGED_ROLES.map((role) => api.get("/users", { params: { role } })))
      .then((lists) => {
        if (alive) setAccounts(lists.flatMap((r) => r.data || []));
      })
      .catch((err) => {
        if (alive) setError(err.message || "Could not load accounts");
      });
    api
      .get("/auth/me")
      .then((res) => {
        if (alive) setCurrentUserId(res.data.id);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const create = async (e) => {
    e.preventDefault();
    setError("");
    setNotice("");
    try {
      const res = await api.post("/users", form);
      setAccounts((prev) => [...prev, res.data]);
      setNotice(`Created ${ROLE_LABEL[res.data.role]} account for ${res.data.email}`);
      setForm({ name: "", email: "", password: "", role: "kitchen" });
    } catch (err) {
      setError(err.message || "Could not create account");
    }
  };

  const changeRole = async (id, role) => {
    setError("");
    try {
      const res = await api.put(`/users/${id}/role`, { role });
      setAccounts((prev) => prev.map((a) => (a.id === id ? res.data : a)));
      if (role !== "student") setNotice(`Role updated to ${ROLE_LABEL[role] || role}`);
      else await load();
    } catch (err) {
      setError(err.message || "Could not change role");
      await load();
    }
  };

  const setActive = async (id, isActive) => {
    setError("");
    try {
      const res = await api.put(`/users/${id}/active`, { isActive });
      setAccounts((prev) => prev.map((a) => (a.id === id ? res.data : a)));
    } catch (err) {
      setError(err.message || "Could not update account");
    }
  };

  return (
    <section data-testid="staff-panel" className="bg-white p-6 rounded-3xl shadow-2xl mb-8 space-y-4">
      <h2 className="text-2xl font-bold text-gray-800">Staff accounts</h2>
      <p className="text-sm text-gray-600">
        Kitchen accounts see only the kitchen display. Staff can manage the menu. Deactivated accounts are refused on their next request.
      </p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}

      <form onSubmit={create} className="grid grid-cols-1 md:grid-cols-5 gap-2 text-sm" aria-label="New staff account">
        <input aria-label="Staff name" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="border rounded p-2" />
        <input aria-label="Staff email" type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="border rounded p-2" />
        <input aria-label="Staff password" type="password" placeholder="Temporary password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="border rounded p-2" />
        <select aria-label="Staff role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="border rounded p-2">
          {MANAGED_ROLES.map((r) => (
            <option key={r} value={r}>{ROLE_LABEL[r]}</option>
          ))}
        </select>
        <button type="submit" className="bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded-full px-4 py-2">Create account</button>
      </form>

      <ul className="divide-y" data-testid="staff-list">
        {accounts.length === 0 && <li className="py-2 text-sm text-gray-500">No staff accounts yet.</li>}
        {accounts.map((a) => (
          <li key={a.id} className="py-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <div>
              <span className="font-semibold">{a.name}</span> <span className="text-gray-500">{a.email}</span>
              {!a.isActive && <span className="ml-2 text-xs text-red-600 font-semibold">Deactivated</span>}
            </div>
            <div className="flex items-center gap-2">
              <select
                aria-label={`Role for ${a.name}`}
                value={a.role}
                onChange={(e) => changeRole(a.id, e.target.value)}
                disabled={a.id === currentUserId && a.role === "admin"}
                className="border rounded p-1"
              >
                {MANAGED_ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                ))}
                <option value="student">Student</option>
              </select>
              <button
                type="button"
                onClick={() => setActive(a.id, !a.isActive)}
                disabled={a.id === currentUserId}
                className="bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50 rounded-full px-3 py-1"
              >
                {a.isActive ? "Deactivate" : "Activate"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
