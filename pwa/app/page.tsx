"use client";

import { useEffect } from "react";
import { loadPairing } from "../lib/pairing";

export default function Home() {
  useEffect(() => {
    window.location.href = loadPairing() ? "/dashboard" : "/pair";
  }, []);

  return null;
}
