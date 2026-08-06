class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

let memoryFallback: Storage | null = null;

export function getBrowserStorage(): Storage {
  try {
    const storage = window.localStorage;
    const probeKey = "crm-agent.d02.storage-probe";
    const previousValue = storage.getItem(probeKey);
    storage.setItem(probeKey, "available");
    if (previousValue === null) {
      storage.removeItem(probeKey);
    } else {
      storage.setItem(probeKey, previousValue);
    }
    return storage;
  } catch {
    // Restricted or privacy-focused browsers may expose but reject localStorage.
  }

  memoryFallback ??= new MemoryStorage();
  return memoryFallback;
}
