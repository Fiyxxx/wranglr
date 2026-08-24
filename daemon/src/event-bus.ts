export class EventBus<TEvent = unknown> {
  private listeners = new Set<(event: TEvent) => void>();

  publish(event: TEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: TEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
