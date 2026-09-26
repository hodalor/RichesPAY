export interface OAuthTokenPayload {
  access_token: string;
  expires_in?: number;
  token_type?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export class OAuthTokenCache {
  #cache = new Map<string, CachedToken>();
  #now: () => number;

  constructor(now?: () => number) {
    this.#now = now ?? Date.now;
  }

  async getToken(
    cacheKey: string,
    load: () => Promise<OAuthTokenPayload>
  ): Promise<string> {
    const now = this.#now();
    const cached = this.#cache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return cached.accessToken;
    }

    const loaded = await load();
    const expiresInSeconds = loaded.expires_in ?? 300;
    const expiresAt = now + Math.max(expiresInSeconds - 30, 1) * 1000;

    this.#cache.set(cacheKey, {
      accessToken: loaded.access_token,
      expiresAt
    });

    return loaded.access_token;
  }
}
