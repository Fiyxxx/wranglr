"use client";

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { parsePairingPayload, savePairing } from "../../../lib/pairing";

export default function ScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let rafId: number;
    let stopped = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch {
        setError("Camera access denied or unavailable.");
        return;
      }
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;
      video.srcObject = stream;
      await video.play();

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      function tick() {
        if (stopped || !video || !canvas || !ctx) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height);
          if (code) {
            const info = parsePairingPayload(code.data);
            if (info) {
              savePairing(info);
              window.location.href = "/dashboard";
              return;
            }
          }
        }
        rafId = requestAnimationFrame(tick);
      }
      rafId = requestAnimationFrame(tick);
    }

    start();

    return () => {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <main className="page narrow-page">
      <header className="hero compact-hero">
        <p className="eyebrow">Quick pairing</p>
        <h1>Scan the daemon QR</h1>
      </header>
      {error && <p role="alert">{error}</p>}
      <video ref={videoRef} muted playsInline />
      <canvas ref={canvasRef} style={{ display: "none" }} />
      <a className="secondary-link" href="/pair">Enter details manually instead</a>
    </main>
  );
}
