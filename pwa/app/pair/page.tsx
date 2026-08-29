"use client";

import { useState, type FormEvent } from "react";
import { savePairing } from "../../lib/pairing";

export default function PairPage() {
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("7420");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");

    // Validate hostname
    if (!hostname.trim()) {
      setError("Hostname is required");
      return;
    }

    // Validate token
    if (!token.trim()) {
      setError("Token is required");
      return;
    }

    // Validate port
    const parsedPort = Number(port);
    if (!isFinite(parsedPort) || parsedPort <= 0) {
      setError("Port must be a valid positive number");
      return;
    }

    savePairing({ hostname, port: parsedPort, token });
    window.location.href = "/dashboard";
  }

  return (
    <main>
      <h1>Pair with your daemon</h1>
      <form onSubmit={handleSubmit}>
        {error && <p role="alert">{error}</p>}

        <label htmlFor="hostname">Hostname</label>
        <input id="hostname" value={hostname} onChange={(e) => setHostname(e.target.value)} />

        <label htmlFor="port">Port</label>
        <input id="port" value={port} onChange={(e) => setPort(e.target.value)} />

        <label htmlFor="token">Token</label>
        <input id="token" value={token} onChange={(e) => setToken(e.target.value)} />

        <button type="submit">Pair</button>
      </form>
      <a href="/pair/scan">Scan QR instead</a>
    </main>
  );
}
