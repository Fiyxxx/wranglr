"use client";

import { useEffect, useState, type FormEvent } from "react";
import { savePairing } from "../../lib/pairing";

export default function PairPage() {
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("7420");
  const [token, setToken] = useState("");
  const [secure, setSecure] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setSecure(window.location.protocol === "https:");
  }, []);

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

    savePairing({ hostname: hostname.trim(), port: parsedPort, token: token.trim(), secure });
    window.location.href = "/dashboard";
  }

  return (
    <main className="page narrow-page">
      <header className="hero compact-hero">
        <p className="eyebrow">Private tailnet connection</p>
        <h1>Pair your phone</h1>
        <p>Use the connection details printed when the Wranglr daemon starts.</p>
      </header>
      <form className="card form-stack" onSubmit={handleSubmit}>
        {error && <p role="alert">{error}</p>}

        <label htmlFor="hostname">Hostname</label>
        <input id="hostname" autoCapitalize="none" autoCorrect="off" placeholder="machine.tailnet.ts.net" value={hostname} onChange={(e) => setHostname(e.target.value)} />

        <label htmlFor="port">Port</label>
        <input id="port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />

        <label htmlFor="token">Token</label>
        <input id="token" type="password" autoCapitalize="none" autoCorrect="off" value={token} onChange={(e) => setToken(e.target.value)} />

        <label className="checkbox-row">
          <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
          Use HTTPS/WSS
        </label>

        <button className="primary-button" type="submit">Pair</button>
      </form>
      <a className="secondary-link" href="/pair/scan">Scan the daemon QR instead</a>
    </main>
  );
}
