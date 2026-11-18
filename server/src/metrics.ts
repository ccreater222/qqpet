export class MetricsRegistry {
  private readonly counters = new Map<string, number>()

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by)
  }

  set(name: string, value: number): void {
    this.counters.set(name, value)
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)))
  }
}
