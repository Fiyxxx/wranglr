"use client";

import { useEffect, useRef } from "react";
import type { TerminalPaneState } from "../lib/store";

const KEY_SEQUENCES: Record<string, string> = {
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\x7f": "backspace",
  "\x1b": "esc",
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1b[3~": "delete",
  "\x1b[H": "home",
  "\x1b[F": "end",
  "\x1b[5~": "pageup",
  "\x1b[6~": "pagedown",
};

function toTerminalNewlines(value: string): string {
  return value.replace(/(^|[^\r])\n/g, "$1\r\n");
}

function decodeInput(data: string): { text?: string; keys?: string[] } {
  const key = KEY_SEQUENCES[data];
  if (key) return { keys: [key] };
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) return { keys: [`ctrl+${String.fromCharCode(96 + code)}`] };
  }
  return { text: data };
}

export function TerminalView({
  pane,
  onInput,
  onReady,
}: {
  pane: TerminalPaneState;
  onInput: (input: { text?: string; keys?: string[] }) => void;
  onReady?: (focus: () => void) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const renderedContentRef = useRef("");
  const paneRef = useRef(pane);
  const inputRef = useRef(onInput);

  paneRef.current = pane;
  inputRef.current = onInput;

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let dataDisposable: { dispose: () => void } | null = null;

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(
      ([{ Terminal }, { FitAddon }]) => {
        if (disposed || !hostRef.current) return;
        const terminal = new Terminal({
          allowProposedApi: false,
          convertEol: true,
          cursorBlink: true,
          cursorStyle: "block",
          drawBoldTextInBrightColors: true,
          fontFamily: '"Berkeley Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
          fontSize: 12,
          fontWeight: "400",
          fontWeightBold: "700",
          letterSpacing: -0.15,
          lineHeight: 1.2,
          minimumContrastRatio: 4.5,
          scrollback: 20_000,
          smoothScrollDuration: 80,
          theme: {
            background: "#101310",
            foreground: "#c8d0c8",
            cursor: "#c9d4ce",
            cursorAccent: "#101310",
            selectionBackground: "#2a555c99",
            black: "#101310",
            red: "#ef8581",
            green: "#7fbd85",
            yellow: "#c9ad68",
            blue: "#73a6bd",
            magenta: "#a99bc4",
            cyan: "#3db4c5",
            white: "#c8d0c8",
            brightBlack: "#69736c",
            brightRed: "#ff9a93",
            brightGreen: "#9bc79b",
            brightYellow: "#ddc17a",
            brightBlue: "#8dbbd0",
            brightMagenta: "#c0afd7",
            brightCyan: "#5cc7d5",
            brightWhite: "#eef2ed",
          },
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(hostRef.current);
        terminalRef.current = terminal;
        fitRef.current = fitAddon;
        fitAddon.fit();

        const current = paneRef.current.content;
        terminal.write(toTerminalNewlines(current));
        renderedContentRef.current = current;
        terminal.scrollToBottom();

        dataDisposable = terminal.onData((data) => inputRef.current(decodeInput(data)));
        onReady?.(() => terminal.focus());
        resizeObserver = new ResizeObserver(() => fitAddon.fit());
        resizeObserver.observe(hostRef.current);
      },
    );

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      dataDisposable?.dispose();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      renderedContentRef.current = "";
    };
  }, [pane.paneId, onReady]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || pane.content === renderedContentRef.current) return;

    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY - 1;
    if (pane.content.startsWith(renderedContentRef.current)) {
      terminal.write(toTerminalNewlines(pane.content.slice(renderedContentRef.current.length)));
    } else {
      terminal.reset();
      terminal.write(toTerminalNewlines(pane.content));
    }
    renderedContentRef.current = pane.content;
    if (wasAtBottom) terminal.scrollToBottom();
  }, [pane.content, pane.revision]);

  return (
    <div
      className="terminal-view"
      data-terminal-pane={pane.paneId}
      ref={hostRef}
      role="region"
      aria-label={`Live Herdr terminal for ${pane.worktreePath}`}
    />
  );
}
