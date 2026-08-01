import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { KeyManagementServiceClient } from "@google-cloud/kms";

import type { AppConfig } from "../config.js";

export interface StateCipher {
  encrypt(value: unknown): Promise<string>;
  decrypt<T>(encoded: string): Promise<T>;
}

interface AesEnvelope {
  nonce: string;
  tag: string;
  ciphertext: string;
}

interface KmsEnvelope extends AesEnvelope {
  wrapped_key: string;
}

export class LocalStateCipher implements StateCipher {
  readonly #key: Buffer;

  constructor(secret: string) {
    const decoded = Buffer.from(secret, "base64");
    this.#key =
      decoded.length === 32 ? decoded : createHash("sha256").update(secret, "utf8").digest();
  }

  encrypt(value: unknown): Promise<string> {
    const envelope = encryptAes(value, this.#key);
    return Promise.resolve(`local1.${encodeEnvelope(envelope)}`);
  }

  decrypt<T>(encoded: string): Promise<T> {
    const payload = encoded.startsWith("local1.") ? encoded.slice("local1.".length) : encoded;
    return Promise.resolve().then(() =>
      decryptAes<T>(decodeEnvelope<AesEnvelope>(payload), this.#key),
    );
  }
}

export class KmsEnvelopeStateCipher implements StateCipher {
  readonly #kms = new KeyManagementServiceClient();
  readonly #localFallback: LocalStateCipher;

  constructor(
    readonly keyName: string,
    localSecret: string,
  ) {
    this.#localFallback = new LocalStateCipher(localSecret);
  }

  async encrypt(value: unknown): Promise<string> {
    const dataKey = randomBytes(32);
    const [wrapped] = await this.#kms.encrypt({
      name: this.keyName,
      plaintext: dataKey,
    });
    if (wrapped.ciphertext === null || wrapped.ciphertext === undefined) {
      throw new Error("Cloud KMS did not return wrapped key material");
    }
    const encrypted = encryptAes(value, dataKey);
    const envelope: KmsEnvelope = {
      ...encrypted,
      wrapped_key: Buffer.from(wrapped.ciphertext).toString("base64url"),
    };
    dataKey.fill(0);
    return `kms1.${encodeEnvelope(envelope)}`;
  }

  async decrypt<T>(encoded: string): Promise<T> {
    if (!encoded.startsWith("kms1.")) {
      return this.#localFallback.decrypt<T>(encoded);
    }
    const envelope = decodeEnvelope<KmsEnvelope>(encoded.slice("kms1.".length));
    const [unwrapped] = await this.#kms.decrypt({
      name: this.keyName,
      ciphertext: Buffer.from(envelope.wrapped_key, "base64url"),
    });
    if (unwrapped.plaintext === null || unwrapped.plaintext === undefined) {
      throw new Error("Cloud KMS did not return decrypted key material");
    }
    const dataKey = Buffer.from(unwrapped.plaintext);
    try {
      return decryptAes<T>(envelope, dataKey);
    } finally {
      dataKey.fill(0);
    }
  }
}

export function createStateCipher(config: AppConfig): StateCipher {
  return config.kmsKeyName === undefined
    ? new LocalStateCipher(config.sessionEncryptionKey)
    : new KmsEnvelopeStateCipher(config.kmsKeyName, config.sessionEncryptionKey);
}

function encryptAes(value: unknown, key: Buffer): AesEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptAes<T>(envelope: AesEnvelope, key: Buffer): T {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64url"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

function encodeEnvelope(value: AesEnvelope | KmsEnvelope): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeEnvelope<T extends AesEnvelope>(encoded: string): T {
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  if (
    typeof value.nonce !== "string" ||
    typeof value.tag !== "string" ||
    typeof value.ciphertext !== "string"
  ) {
    throw new Error("Encrypted browser state is malformed");
  }
  return value;
}
