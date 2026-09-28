/** The part of `Storage` the auth helpers use, so tests can pass a plain in-memory map. */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * The device's localStorage, or null when the browser hides it or throws (private mode, blocked
 * site data). Every helper below then runs without it instead of breaking the sign-in.
 */
export function deviceStorage(): KeyValueStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readItem(storage: KeyValueStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writeItem(storage: KeyValueStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // Quota or blocked storage: the feature degrades, it never throws into the UI.
  }
}

export function removeItem(storage: KeyValueStorage | null, key: string): void {
  try {
    storage?.removeItem(key)
  } catch {
    // Same as above.
  }
}

/** In-memory storage for tests and for code paths that must not touch the real device. */
export function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  }
}
