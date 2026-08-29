"use client";

import { useState, type FormEvent } from "react";
import { savePairing } from "../../lib/pairing";

export default function PairPage() {
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("7420");
  const [token, setToken] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    savePairing({ hostname, port: Number(port), token });
    window.location.href = "/dashboard";
  }

  return (
    <main>
      <h1>Pair with your daemon</h1>
      <form onSubmit={handleSubmit}>
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
