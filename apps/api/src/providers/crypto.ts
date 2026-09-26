import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class CredentialEncryptionService {
  #key: Buffer;

  constructor(base64Key: string) {
    this.#key = Buffer.from(base64Key, "base64");
  }

  decrypt<T>(payload: string): T {
    const parsed = JSON.parse(payload) as {
      ciphertext: string;
      iv: string;
      tag: string;
    };

    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(parsed.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64")),
      decipher.final()
    ]);

    return JSON.parse(plaintext.toString("utf8")) as T;
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");

    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);

    return JSON.stringify({
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64")
    });
  }
}
