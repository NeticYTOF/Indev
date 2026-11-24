/**
 * Device-only encrypted secret storage.
 *
 * Secrets (the user's AI API key) are encrypted with AES-GCM under a
 * NON-extractable CryptoKey that is generated in this browser and kept in
 * IndexedDB as a CryptoKey object. Script on this origin can ask the browser
 * to decrypt, but the raw key material can never be read out, exported, or
 * synced anywhere. Only {iv, ciphertext} is stored; there is no plaintext
 * fallback: if the platform cannot do this, saving is refused.
 */

const DB_NAME = 'indeev-device';
const DB_VERSION = 1;
const STORE = 'secrets';
const WRAP_KEY_ID = '__device-wrap-key';

export class SecureStoreUnavailableError extends Error {
  constructor(message = 'Secure on-device storage is unavailable in this browser (needs IndexedDB and Web Crypto). The key was not saved.') {
    super(message);
    this.name = 'SecureStoreUnavailableError';
  }
}

interface SealedSecret {
  v: 1;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

/** Minimal async key-value backend; IndexedDB in the browser, injectable in tests. */
export interface SecretBackend {
  get(id: string): Promise<unknown>;
  put(id: string, value: unknown): Promise<void>;
  delete(id: string): Promise<void>;
}

export function isSecureStoreAvailable(): boolean {
  return typeof indexedDB !== 'undefined' &&
    typeof crypto !== 'undefined' && typeof crypto.subtle?.encrypt === 'function' &&
    (typeof isSecureContext === 'undefined' || isSecureContext);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    open.onerror = () => { dbPromise = null; reject(open.error ?? new Error('IndexedDB open failed')); };
    open.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB open blocked')); };
  });
  return dbPromise;
}

export const indexedDbBackend: SecretBackend = {
  async get(id) {
    const db = await openDb();
    return request(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
  },
  async put(id, value) {
    const db = await openDb();
    await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, id));
  },
  async delete(id) {
    const db = await openDb();
    await request(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
  },
};

function isSealed(value: unknown): value is SealedSecret {
  if (value == null || typeof value !== 'object') return false;
  const v = value as Partial<SealedSecret>;
  return v.v === 1 && v.iv instanceof Uint8Array && v.iv.byteLength === 12 && v.iv.buffer instanceof ArrayBuffer && v.ciphertext instanceof ArrayBuffer;
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== 'undefined' && value instanceof CryptoKey;
}

/** Encrypted secret store over a backend. Exported as a factory for tests. */
export function createSecretStore(backend: SecretBackend, subtle: SubtleCrypto = crypto.subtle) {
  let keyPromise: Promise<CryptoKey> | null = null;

  const wrapKey = (create: boolean): Promise<CryptoKey | null> => {
    if (keyPromise) return keyPromise;
    const pending = (async () => {
      const existing = await backend.get(WRAP_KEY_ID);
      if (isCryptoKey(existing)) return existing;
      if (!create) return null;
      const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await backend.put(WRAP_KEY_ID, key);
      return key;
    })();
    return pending.then((key) => {
      if (key) keyPromise = Promise.resolve(key);
      return key;
    }, (err: unknown) => { keyPromise = null; throw err; });
  };

  return {
    async save(name: string, value: string): Promise<void> {
      const key = await wrapKey(true);
      if (!key) throw new SecureStoreUnavailableError();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
      const sealed: SealedSecret = { v: 1, iv, ciphertext };
      await backend.put(`secret:${name}`, sealed);
    },
    async load(name: string): Promise<string | null> {
      const sealed = await backend.get(`secret:${name}`);
      if (sealed === undefined || sealed === null) return null;
      const key = await wrapKey(false);
      if (!key || !isSealed(sealed)) {
        // Wrap key lost (storage partly cleared) or a foreign record: the
        // secret is unrecoverable. Drop it instead of guessing.
        await backend.delete(`secret:${name}`);
        return null;
      }
      try {
        const plain = await subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.ciphertext);
        return new TextDecoder().decode(plain);
      } catch {
        await backend.delete(`secret:${name}`);
        return null;
      }
    },
    async has(name: string): Promise<boolean> {
      return isSealed(await backend.get(`secret:${name}`));
    },
    async remove(name: string): Promise<void> {
      await backend.delete(`secret:${name}`);
    },
  };
}

let browserStore: ReturnType<typeof createSecretStore> | null = null;
function store(): ReturnType<typeof createSecretStore> {
  if (!isSecureStoreAvailable()) throw new SecureStoreUnavailableError();
  browserStore ??= createSecretStore(indexedDbBackend);
  return browserStore;
}

export const saveSecret = (name: string, value: string): Promise<void> => store().save(name, value);
export const loadSecret = (name: string): Promise<string | null> => store().load(name);
export const hasSecret = async (name: string): Promise<boolean> =>
  isSecureStoreAvailable() ? store().has(name).catch(() => false) : false;
export const deleteSecret = (name: string): Promise<void> => store().remove(name);
