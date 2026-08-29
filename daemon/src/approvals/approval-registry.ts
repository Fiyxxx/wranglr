export type ApprovalDecision = "approve" | "reject";

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalRegistry {
  private pending = new Map<string, PendingApproval>();

  request(id: string, timeoutMs: number): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve("reject");
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
  }

  respond(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(decision);
    return true;
  }
}
