import React, { useState } from "react";
import api, { setToken } from "../api";

/**
 * Public registration.
 *
 * The role selector was removed: the backend always forces the "student"
 * role on this endpoint and ignores any submitted role, so offering the
 * choice would have been misleading. Administrators are provisioned with
 * `npm run seed:admin`.
 */
export default function Signup({ switchPage, setUserRole, setUserName }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSignup = async (e) => {
    e.preventDefault();
    setError("");

    if (!name || !email || !password) {
      setError("All fields are required.");
      return;
    }

    setBusy(true);
    try {
      // 1. Create the account. No role is sent, and none is honoured.
      await api.post("/auth/signup", { name, email, password });

      // 2. Sign in automatically.
      const res = await api.post("/auth/login", { email, password });

      // 3. Persist the session.
      setToken(res.data.token);
      setUserRole(res.data.role);
      setUserName(res.data.name);

      // 4. Reset the form.
      setName("");
      setEmail("");
      setPassword("");
    } catch (err) {
      setError(err.message || "Signup failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-purple-100 via-blue-100 to-green-100">
      <form
        onSubmit={handleSignup}
        className="bg-white p-10 rounded-xl shadow-lg w-96"
      >
        <h2 className="text-2xl font-bold mb-6 text-center text-purple-700">
          Signup
        </h2>

        {error && (
          <p role="alert" className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">
            {error}
          </p>
        )}

        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="name">
          Full Name
        </label>
        <input
          id="name"
          type="text"
          autoComplete="name"
          placeholder="Full Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full mb-4 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-purple-400"
        />

        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="signup-email">
          Email
        </label>
        <input
          id="signup-email"
          type="email"
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full mb-4 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-purple-400"
        />

        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="signup-password">
          Password
        </label>
        <input
          id="signup-password"
          type="password"
          autoComplete="new-password"
          placeholder="Password (min 8 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mb-4 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-purple-400"
        />

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-purple-500 hover:bg-purple-600 disabled:opacity-60 p-2 rounded text-white font-bold transition duration-300"
        >
          {busy ? "Creating account..." : "Signup"}
        </button>

        <p className="mt-4 text-center text-sm text-gray-600">
          Already have an account?{" "}
          <button
            type="button"
            onClick={switchPage}
            className="text-purple-700 cursor-pointer font-semibold hover:underline bg-transparent"
          >
            Login here
          </button>
        </p>
      </form>
    </div>
  );
}