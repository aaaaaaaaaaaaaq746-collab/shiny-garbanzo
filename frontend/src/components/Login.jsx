import React, { useState } from "react";
import api, { setToken } from "../api";

export default function Login({ setUserRole, setUserName, switchPage }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");

    if (!email || !password) {
      setError("Please enter your email and password.");
      return;
    }

    setBusy(true);
    try {
      const res = await api.post("/auth/login", { email, password });
      setToken(res.data.token);
      setUserRole(res.data.role);
      setUserName(res.data.name);
    } catch (err) {
      setError(err.message || "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-purple-100 via-blue-100 to-green-100">
      <form
        onSubmit={handleLogin}
        className="bg-white p-10 rounded-xl shadow-lg w-96"
      >
        <h2 className="text-2xl font-bold mb-6 text-center text-purple-700">Login</h2>

        {error && (
          <p role="alert" className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">
            {error}
          </p>
        )}

        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          className="w-full mb-4 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-purple-400"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          className="w-full mb-4 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-purple-400"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-purple-500 hover:bg-purple-600 disabled:opacity-60 p-2 rounded text-white font-bold"
        >
          {busy ? "Logging in..." : "Login"}
        </button>

        {/* Link to Signup */}
        <p className="mt-4 text-center text-sm text-gray-600">
          New user?{" "}
          <button
            type="button"
            onClick={switchPage}
            className="text-purple-700 cursor-pointer font-semibold hover:underline bg-transparent"
          >
            Signup here
          </button>
        </p>
      </form>
    </div>
  );
}