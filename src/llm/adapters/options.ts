/**
 * What every adapter is built from. Derived from `config.llm` (or one of its per-job
 * overrides) by `src/llm/index.ts`, so an adapter never reads the configuration itself and
 * can be built directly in a test with nothing else in scope.
 */
export interface AdapterOptions {
  /** Null only for ollama, which needs none. */
  readonly apiKey: string | null
  readonly model: string
  /** An override for a proxy or a self-hosted gateway. Null means the provider's own. */
  readonly baseUrl: string | null
  readonly timeoutMs: number
  /**
   * Injected so that no test in this repository reaches the network. Adapters are proved
   * against recorded provider payloads served through this. Spec 03, criterion 2.
   */
  readonly fetch?: typeof globalThis.fetch
}
