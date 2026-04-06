import type { ServerAdapterModule, AdapterModel } from "../types.js";

/**
 * Adapter registry — maps adapter type strings to adapter modules.
 * Adapted from Paperclip's server/src/adapters/registry.ts.
 */
export class AdapterRegistry {
  private adaptersByType = new Map<string, ServerAdapterModule>();

  constructor(adapters: ServerAdapterModule[] = []) {
    for (const adapter of adapters) {
      this.adaptersByType.set(adapter.type, adapter);
    }
  }

  /**
   * Register an adapter module.
   */
  register(adapter: ServerAdapterModule): void {
    this.adaptersByType.set(adapter.type, adapter);
  }

  /**
   * Get an adapter by type. Throws if not found.
   */
  get(type: string): ServerAdapterModule {
    const adapter = this.adaptersByType.get(type);
    if (!adapter) {
      throw new Error(`Unknown adapter type: "${type}". Available: ${this.listTypes().join(", ")}`);
    }
    return adapter;
  }

  /**
   * Find an adapter by type. Returns null if not found.
   */
  find(type: string): ServerAdapterModule | null {
    return this.adaptersByType.get(type) ?? null;
  }

  /**
   * List all registered adapter types.
   */
  listTypes(): string[] {
    return Array.from(this.adaptersByType.keys());
  }

  /**
   * List all registered adapter modules.
   */
  listAll(): ServerAdapterModule[] {
    return Array.from(this.adaptersByType.values());
  }

  /**
   * List models for a given adapter type.
   */
  async listModels(type: string): Promise<AdapterModel[]> {
    const adapter = this.adaptersByType.get(type);
    if (!adapter) return [];
    if (adapter.listModels) {
      const discovered = await adapter.listModels();
      if (discovered.length > 0) return discovered;
    }
    return adapter.models ?? [];
  }

  /**
   * List models for all registered adapters.
   */
  async listAllModels(): Promise<
    Array<{ adapterType: string; models: AdapterModel[] }>
  > {
    const results: Array<{ adapterType: string; models: AdapterModel[] }> = [];
    for (const adapter of this.adaptersByType.values()) {
      const models = await this.listModels(adapter.type);
      results.push({ adapterType: adapter.type, models });
    }
    return results;
  }
}
