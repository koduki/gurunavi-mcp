import { createHash } from "node:crypto";

import { Firestore, Timestamp } from "@google-cloud/firestore";

import type { AppConfig } from "../config.js";

export interface StoredValue<T> {
  value: T;
  expiresAt?: string | Timestamp;
}

export interface KeyValueStore {
  get<T>(namespace: string, key: string): Promise<T | undefined>;
  put<T>(namespace: string, key: string, value: T, expiresAt?: string): Promise<void>;
  compareAndSet<T>(
    namespace: string,
    key: string,
    predicate: (current: T | undefined) => boolean,
    next: T,
    expiresAt?: string,
  ): Promise<boolean>;
  delete(namespace: string, key: string): Promise<void>;
}

interface MemoryEntry {
  value: unknown;
  expiresAt?: string;
}

export class MemoryKeyValueStore implements KeyValueStore {
  readonly #values = new Map<string, MemoryEntry>();

  get<T>(namespace: string, key: string): Promise<T | undefined> {
    const compoundKey = `${namespace}:${key}`;
    const entry = this.#values.get(compoundKey);
    if (entry === undefined) {
      return Promise.resolve(undefined);
    }
    const expiration =
      entry.expiresAt === undefined ? undefined : Date.parse(entry.expiresAt);
    if (expiration !== undefined && expiration <= Date.now()) {
      this.#values.delete(compoundKey);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(structuredClone(entry.value) as T);
  }

  put<T>(namespace: string, key: string, value: T, expiresAt?: string): Promise<void> {
    this.#values.set(`${namespace}:${key}`, {
      value: structuredClone(value),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    return Promise.resolve();
  }

  compareAndSet<T>(
    namespace: string,
    key: string,
    predicate: (current: T | undefined) => boolean,
    next: T,
    expiresAt?: string,
  ): Promise<boolean> {
    const compoundKey = `${namespace}:${key}`;
    const entry = this.#values.get(compoundKey);
    const expired =
      entry?.expiresAt !== undefined && Date.parse(entry.expiresAt) <= Date.now();
    const current =
      entry === undefined || expired ? undefined : (structuredClone(entry.value) as T);
    if (!predicate(current)) {
      return Promise.resolve(false);
    }
    this.#values.set(compoundKey, {
      value: structuredClone(next),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    return Promise.resolve(true);
  }

  delete(namespace: string, key: string): Promise<void> {
    this.#values.delete(`${namespace}:${key}`);
    return Promise.resolve();
  }
}

export class FirestoreKeyValueStore implements KeyValueStore {
  readonly #firestore: Firestore;

  constructor(config: AppConfig) {
    this.#firestore = new Firestore({
      ...(config.googleCloudProject === undefined ? {} : { projectId: config.googleCloudProject }),
      databaseId: config.firestoreDatabaseId,
    });
  }

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    const snapshot = await this.#document(namespace, key).get();
    if (!snapshot.exists) {
      return undefined;
    }
    const entry = snapshot.data() as StoredValue<T> | undefined;
    if (entry === undefined) {
      return undefined;
    }
    const expiration =
      entry.expiresAt instanceof Timestamp
        ? entry.expiresAt.toMillis()
        : entry.expiresAt === undefined
          ? undefined
          : Date.parse(entry.expiresAt);
    if (expiration !== undefined && expiration <= Date.now()) {
      await snapshot.ref.delete();
      return undefined;
    }
    return entry.value;
  }

  async put<T>(namespace: string, key: string, value: T, expiresAt?: string): Promise<void> {
    const entry: StoredValue<T> = {
      value,
      ...(expiresAt === undefined ? {} : { expiresAt: Timestamp.fromDate(new Date(expiresAt)) }),
    };
    await this.#document(namespace, key).set(entry);
  }

  async compareAndSet<T>(
    namespace: string,
    key: string,
    predicate: (current: T | undefined) => boolean,
    next: T,
    expiresAt?: string,
  ): Promise<boolean> {
    const document = this.#document(namespace, key);
    return this.#firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(document);
      const entry = snapshot.exists
        ? (snapshot.data() as StoredValue<T> | undefined)
        : undefined;
      const expiration =
        entry?.expiresAt instanceof Timestamp
          ? entry.expiresAt.toMillis()
          : entry?.expiresAt === undefined
            ? undefined
            : Date.parse(entry.expiresAt);
      const current =
        entry === undefined || (expiration !== undefined && expiration <= Date.now())
          ? undefined
          : entry.value;
      if (!predicate(current)) {
        return false;
      }
      transaction.set(document, {
        value: next,
        ...(expiresAt === undefined
          ? {}
          : { expiresAt: Timestamp.fromDate(new Date(expiresAt)) }),
      } satisfies StoredValue<T>);
      return true;
    });
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.#document(namespace, key).delete();
  }

  #document(namespace: string, key: string) {
    const safeNamespace = namespace.replaceAll(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
    const documentId = createHash("sha256").update(key).digest("hex");
    return this.#firestore.collection(`gurunavi_mcp_${safeNamespace}`).doc(documentId);
  }
}

export function createKeyValueStore(config: AppConfig): KeyValueStore {
  if (config.googleCloudProject === undefined || config.nodeEnv === "test") {
    return new MemoryKeyValueStore();
  }
  return new FirestoreKeyValueStore(config);
}
