import { useState } from "react";
import api from "../api";

const TITLE_MAX = 120;
const BODY_MAX = 500;

/**
 * Admin-only: send one message to every student who opted into promotions.
 * Each student's own preferences still decide whether it goes out by email or
 * push, so this is a notice, not a broadcast that overrides anyone's choice.
 */
export default function AnnouncementPanel() {
  const [form, setForm] = useState({ title: "", body: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const res = await api.post("/notifications/announcements", {
        title: form.title.trim(),
        body: form.body.trim(),
      });
      const count = res.data?.recipients ?? 0;
      // The server queues one message per recipient. Delivery happens in the
      // background and follows each student's own email and push settings.
      setMessage(
        count === 1
          ? "Queued for 1 student who opted into offers."
          : `Queued for ${count} students who opted into offers.`
      );
      setForm({ title: "", body: "" });
    } catch (err) {
      setError(err.message || "Could not send the announcement");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white p-6 rounded-3xl shadow-2xl mb-8" aria-labelledby="announcement-heading">
      <h2 id="announcement-heading" className="text-2xl font-bold mb-4 text-gray-800">
        Send an announcement
      </h2>
      <form onSubmit={submit} className="space-y-3 max-w-xl" data-testid="announcement-form">
        <label className="block text-sm">
          Title
          <input
            className="mt-1 w-full border border-gray-300 rounded px-2 py-1"
            value={form.title}
            maxLength={TITLE_MAX}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
          />
        </label>
        <label className="block text-sm">
          Message
          <textarea
            className="mt-1 w-full border border-gray-300 rounded px-2 py-1"
            rows={3}
            value={form.body}
            maxLength={BODY_MAX}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            required
          />
        </label>
        <p className="text-xs text-gray-500">
          Goes to students who turned on offers and announcements. Email and browser delivery follow each student&apos;s own settings.
        </p>
        <button
          type="submit"
          disabled={busy || !form.title.trim() || !form.body.trim()}
          className="bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white font-semibold py-1 px-4 rounded-full"
        >
          {busy ? "Sending…" : "Send announcement"}
        </button>
        {message && <p className="text-sm text-green-700" role="status">{message}</p>}
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      </form>
    </section>
  );
}
