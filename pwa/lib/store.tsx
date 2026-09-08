import { createContext, useContext, useEffect, useReducer, useRef, type ReactNode } from "react";
import type { ClientMessage, ServerMessage } from "@wranglr/protocol";
import { WranglrWsClient, type ConnectionStatus } from "./ws-client";

export interface WorktreeStatus {
  path: string;
  herdrPaneId: string | null;
  state: "idle" | "working" | "blocked" | "done" | "unknown";
}

export interface PendingApproval {
  id: string;
  worktreePath: string;
  tool: string;
  input: Record<string, unknown>;
  risk: "low" | "medium" | "high";
}

export interface WranglrState {
  connectionStatus: ConnectionStatus;
  worktrees: WorktreeStatus[];
  hookEvents: Array<Extract<ServerMessage, { type: "hook_event" }>>;
  pendingApprovals: PendingApproval[];
  promptResults: Array<Extract<ServerMessage, { type: "prompt_result" }>>;
}

export const initialState: WranglrState = {
  connectionStatus: "connecting",
  worktrees: [],
  hookEvents: [],
  pendingApprovals: [],
  promptResults: [],
};

export type WranglrAction =
  | ServerMessage
  | { type: "connection_status"; status: ConnectionStatus };

const HOOK_EVENT_LOG_LIMIT = 200;

export function reducer(state: WranglrState, action: WranglrAction): WranglrState {
  switch (action.type) {
    case "connection_status":
      return { ...state, connectionStatus: action.status };
    case "worktree_status":
      return { ...state, worktrees: action.worktrees };
    case "hook_event":
      return { ...state, hookEvents: [...state.hookEvents, action].slice(-HOOK_EVENT_LOG_LIMIT) };
    case "approval_request":
      return {
        ...state,
        pendingApprovals: [
          ...state.pendingApprovals.filter((approval) => approval.id !== action.id),
          { id: action.id, worktreePath: action.worktreePath, tool: action.tool, input: action.input, risk: action.risk },
        ],
      };
    case "approval_resolved":
      return { ...state, pendingApprovals: state.pendingApprovals.filter((a) => a.id !== action.id) };
    case "prompt_result":
      return { ...state, promptResults: [...state.promptResults, action].slice(-20) };
    case "verification_result":
      return state;
    default:
      return state;
  }
}

export interface WranglrContextValue {
  state: WranglrState;
  send: (msg: ClientMessage) => void;
}

export const WranglrContext = createContext<WranglrContextValue | null>(null);

export function WranglrProvider({ url, children }: { url: string | null; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const clientRef = useRef<WranglrWsClient | null>(null);

  useEffect(() => {
    if (!url) {
      dispatch({ type: "connection_status", status: "closed" });
      return;
    }
    const client = new WranglrWsClient(url, {
      onMessage: (msg) => dispatch(msg),
      onStatusChange: (status) => dispatch({ type: "connection_status", status }),
    });
    clientRef.current = client;
    return () => client.close();
  }, [url]);

  const send = (msg: ClientMessage) => clientRef.current?.send(msg);

  return <WranglrContext.Provider value={{ state, send }}>{children}</WranglrContext.Provider>;
}

export function useWranglr(): WranglrContextValue {
  const ctx = useContext(WranglrContext);
  if (!ctx) throw new Error("useWranglr must be used within a WranglrProvider");
  return ctx;
}
