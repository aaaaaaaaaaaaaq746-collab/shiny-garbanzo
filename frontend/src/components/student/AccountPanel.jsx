import { useEffect, useState } from "react";
import api, { setToken } from "../../api";
import { DEFAULT_NOTIFICATION_PREFS as DEFAULT_PREFS } from "../../lib/notify";

const PREF_LABELS = [
  ["orderUpdates", "Order status updates"],
  ["promotions", "Offers and promotions (none are sent yet)"],
  ["sound", "Sound for pickup alerts"],
];

/** Profile, notification preferences and password. */
export default function AccountPanel({ onPrefsChange }) {
  const [profile, setProfile] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState({ name: "", phone: "" });
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [passwords, setPasswords] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .get("/auth/me")
      .then((res) => {
        if (!active) return;
        setProfile(res.data);
        setForm({ name: res.data.name || "", phone: res.data.phone || "" });
        const merged = { ...DEFAULT_PREFS, ...(res.data.notificationPrefs || {}) };
        setPrefs(merged);
        onPrefsChange?.(merged);
      })
      .catch((err) => {
        if (active) setLoadError(err.message || "Could not load your profile");
      });
    return () => {
      active = false;
    };
  }, [onPrefsChange]); // the dashboard passes a stable state setter

  const flash = (text) => {
    setMessage(text);
    setError("");
  };
  const fail = (err) => {
    setError(err.message || "Something went wrong");
    setMessage("");
  };

  const saveProfile = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.put("/auth/me", { name: form.name, phone: form.phone });
      setProfile(res.data);
      flash("Profile saved.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const togglePref = async (key) => {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    try {
      await api.put("/auth/me", { notificationPrefs: { [key]: next[key] } });
      onPrefsChange?.(next);
      flash("Preferences saved.");
    } catch (err) {
      setPrefs(prefs);
      fail(err);
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    if (passwords.newPassword !== passwords.confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post("/auth/me/password", {
        currentPassword: passwords.currentPassword,
        newPassword: passwords.newPassword,
      });
      // The server revoked older sessions and issued a fresh token for this one.
      if (res.data?.token) setToken(res.data.token);
      setPasswords({ currentPassword: "", newPassword: "", confirm: "" });
      flash("Password changed. Other devices have been signed out.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full border border-gray-300 rounded px-2 py-1";

  return (
    <section aria-labelledby="account-heading" className="space-y-6" data-testid="account-panel">
      <h2 id="account-heading" className="text-2xl font-bold text-gray-800">
        Your account
      </h2>
      {loadError && <p className="text-red-600 text-sm">{loadError}</p>}
      {message && (
        <p role="status" className="text-green-700 text-sm">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-red-600 text-sm">
          {error}
        </p>
      )}

      <form onSubmit={saveProfile} className="bg-white rounded-3xl shadow p-6 max-w-xl space-y-3">
        <h3 className="font-bold text-purple-800">Profile</h3>
        {profile && <p className="text-xs text-gray-500">Signed in as {profile.email}</p>}
        <label className="block text-sm">
          Name
          <input className={input} value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label className="block text-sm">
          Phone (for pickup contact, optional)
          <input className={input} value={form.phone} maxLength={30} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </label>
        <button type="submit" disabled={busy} className="bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white font-semibold py-1 px-4 rounded-full">
          Save profile
        </button>
      </form>

      <fieldset className="bg-white rounded-3xl shadow p-6 max-w-xl space-y-2">
        <legend className="font-bold text-purple-800 px-1">Notifications</legend>
        {PREF_LABELS.map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!prefs[key]} onChange={() => togglePref(key)} />
            {label}
          </label>
        ))}
      </fieldset>

      <form onSubmit={changePassword} className="bg-white rounded-3xl shadow p-6 max-w-xl space-y-3">
        <h3 className="font-bold text-purple-800">Change password</h3>
        <label className="block text-sm">
          Current password
          <input type="password" autoComplete="current-password" className={input} value={passwords.currentPassword} onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })} required />
        </label>
        <label className="block text-sm">
          New password (at least 8 characters)
          <input type="password" autoComplete="new-password" className={input} value={passwords.newPassword} onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })} minLength={8} required />
        </label>
        <label className="block text-sm">
          Confirm new password
          <input type="password" autoComplete="new-password" className={input} value={passwords.confirm} onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })} minLength={8} required />
        </label>
        <button type="submit" disabled={busy} className="bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white font-semibold py-1 px-4 rounded-full">
          Change password
        </button>
      </form>
    </section>
  );
}
