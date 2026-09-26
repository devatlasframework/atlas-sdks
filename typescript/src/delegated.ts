import { createHash, randomBytes } from 'node:crypto';
import {
  AtlasApiError,
  AtlasConfigurationError,
  AtlasConnectionError,
  AtlasError,
  RefreshRefusedError,
} from './errors.js';
import type { components } from './generated/contract.js';
import {
  Transport,
  checkedBaseUrl,
  type CallOptions,
  type ClientOptions,
  type TransportInternals,
} from './transport.js';

/** What the token exchange answers with. Its field names are RFC 6749's: snake_case. */
export type DelegatedPassResponse = components['schemas']['DelegatedPassResponse'];

/** What the token exchange reads. Its field names are this API's own: camelCase. */
export type TokenExchangeRequest = components['schemas']['TokenExchangeRequest'];

/** A PKCE pair: keep `verifier` on your server; send `challenge` to the consent page. */
export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  /** S256 is the only method ATLAS accepts. */
  readonly method: 'S256';
}

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * The S256 challenge for a verifier: base64url of its SHA-256, without padding (RFC 7636).
 *
 * @example
 * ```ts
 * pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'); // 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
 * ```
 */
export function pkceChallenge(verifier: string): string {
  if (typeof verifier !== 'string' || !VERIFIER.test(verifier)) {
    throw new AtlasConfigurationError(
      'a PKCE verifier is 43 to 128 characters drawn from A-Z, a-z, 0-9, "-", ".", "_" and "~"',
    );
  }
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * A fresh PKCE pair, with a verifier of 32 random bytes.
 *
 * @example
 * ```ts
 * const pkce = createPkcePair();
 * // store pkce.verifier with the sign-in attempt; put pkce.challenge in the consent URL
 * ```
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return Object.freeze({ verifier, challenge: pkceChallenge(verifier), method: 'S256' as const });
}

/** Everything the consent page needs. */
export interface AuthorizationUrlOptions {
  /**
   * The ATLAS web address you were given, where people sign in. It is not the API's address: the
   * two are served from different hosts, which is why the contract names neither.
   */
  readonly webBaseUrl: string;
  /** Your application's client id. */
  readonly clientId: string;
  /** The organisation whose content the pass will read. */
  readonly orgId: string;
  /** Where ATLAS sends the person back, exactly as you registered it: it is matched character for character. */
  readonly redirectUri: string;
  /** The permissions to ask for, such as `content:read`. */
  readonly scopes: readonly string[];
  /** A value you generate per attempt and check when the person returns. */
  readonly state: string;
  /** From `createPkcePair()`. */
  readonly codeChallenge: string;
}

/**
 * The address to send a person to, to consent to your application acting as them.
 *
 * @example
 * ```ts
 * const pkce = createPkcePair();
 * const state = randomUUID();
 * response.redirect(authorizationUrl({
 *   webBaseUrl: process.env.ATLAS_WEB_URL!, clientId, orgId,
 *   redirectUri: 'https://app.example.test/atlas/callback',
 *   scopes: ['content:read'], state, codeChallenge: pkce.challenge,
 * }));
 * ```
 */
export function authorizationUrl(options: AuthorizationUrlOptions): string {
  const base = checkedBaseUrl(options?.webBaseUrl, 'webBaseUrl');
  const parameters: [string, string][] = [
    ['client_id', options.clientId],
    ['org_id', options.orgId],
    ['redirect_uri', options.redirectUri],
    ['scope', options.scopes.join(' ')],
    ['state', options.state],
    ['code_challenge', options.codeChallenge],
    ['code_challenge_method', 'S256'],
  ];
  for (const [name, value] of parameters) {
    if (typeof value !== 'string' || value === '') throw new AtlasConfigurationError(`${name} is required`);
  }
  const query = parameters.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
  return `${base}/oauth/authorize?${query}`;
}

/** Where a pass is renewed, and by which application. */
export interface DelegatedPassOptions extends ClientOptions {
  /** Your application's client id: every renewal names it. */
  readonly clientId: string;
  /**
   * Called with the renewed pass after every renewal, and awaited before the new token is used.
   * Store the snapshot here if you store passes at all: a renewal spends the refresh token you
   * stored before, and presenting a spent one - after a restart, or from a second process - is
   * treated as theft and revokes the grant. If this throws, the error reaches you, and the pass in
   * memory still holds the renewed tokens.
   */
  readonly onRenewed?: (snapshot: DelegatedPassSnapshot) => void | Promise<void>;
}

/** What `exchangeCode` needs from the person's return to your `redirectUri`. */
export interface ExchangeCodeOptions extends DelegatedPassOptions, CallOptions {
  /** The one-time `code` ATLAS sent back. It expires about a minute after consent. */
  readonly code: string;
  /** The same `redirectUri` the consent URL named. */
  readonly redirectUri: string;
  /** The verifier whose challenge the consent URL carried. */
  readonly codeVerifier: string;
}

/** A pass as you would store it between processes. Treat it like a password: it can be renewed. */
export interface DelegatedPassSnapshot {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  /** ISO 8601. */
  readonly expiresAt: string;
  readonly scope: string;
}

/** How close to expiry a pass is renewed before use. */
const RENEW_MARGIN_MS = 30_000;

/**
 * A delegated pass and its renewal: the access token you send, and the refresh token that replaces
 * it before it expires.
 *
 * Renewal follows the rules the token exchange sets. A refresh token works once, and presenting a
 * spent one is treated as theft, revoking every renewal token under the grant. So:
 *
 * - two renewals never run at once in one process, and one grant belongs to one process: two
 *   processes renewing the same stored pass will present a spent token;
 * - a renewal is never repeated automatically after a failure that may have reached ATLAS (a
 *   `5xx`, a redirect, a lost connection) - see `renewalOutcomeUnknown`;
 * - a refused renewal (`400`) drops the refresh token, and leaves the pass in use until it expires;
 * - a throttled renewal (`429`) spent nothing, and keeps the refresh token.
 */
export class DelegatedPass {
  #accessToken: string;
  #refreshToken: string | undefined;
  #expiresAt: Date;
  #scope: string;
  #outcomeUnknown = false;
  readonly #clientId: string;
  readonly #transport: Transport;
  readonly #now: () => Date;
  readonly #onRenewed: DelegatedPassOptions['onRenewed'];
  #renewing: Promise<void> | undefined;

  private constructor(
    snapshot: DelegatedPassSnapshot,
    options: DelegatedPassOptions,
    internals: TransportInternals,
  ) {
    if (typeof options?.clientId !== 'string' || options.clientId === '') {
      throw new AtlasConfigurationError('clientId is required');
    }
    this.#accessToken = snapshot.accessToken;
    this.#refreshToken = snapshot.refreshToken;
    this.#expiresAt = new Date(snapshot.expiresAt);
    this.#scope = snapshot.scope;
    this.#clientId = options.clientId;
    this.#transport = new Transport(options, internals);
    this.#now = internals.now ?? (() => new Date());
    this.#onRenewed = options.onRenewed;
  }

  /** A pass from the token exchange's answer, as `exchangeCode` returns it. */
  static fromResponse(
    response: DelegatedPassResponse,
    options: DelegatedPassOptions,
    internals: TransportInternals = {},
  ): DelegatedPass {
    const now = (internals.now ?? (() => new Date()))();
    return new DelegatedPass(DelegatedPass.#snapshotOf(response, now), options, internals);
  }

  /** A pass you stored with `snapshot()`. */
  static restore(
    snapshot: DelegatedPassSnapshot,
    options: DelegatedPassOptions,
    internals: TransportInternals = {},
  ): DelegatedPass {
    if (typeof snapshot?.accessToken !== 'string' || Number.isNaN(Date.parse(snapshot.expiresAt))) {
      throw new AtlasConfigurationError('a pass snapshot needs an accessToken and an ISO expiresAt');
    }
    return new DelegatedPass(snapshot, options, internals);
  }

  static #snapshotOf(response: DelegatedPassResponse, now: Date): DelegatedPassSnapshot {
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: new Date(now.getTime() + response.expires_in * 1000).toISOString(),
      scope: response.scope,
    };
  }

  /** The token to send as `Authorization: Bearer`. */
  get accessToken(): string {
    return this.#accessToken;
  }

  /** When the access token stops working. */
  get expiresAt(): Date {
    return new Date(this.#expiresAt.getTime());
  }

  /** The permissions the person granted, space-separated, exactly as they consented to them. */
  get scope(): string {
    return this.#scope;
  }

  /** Whether a renewal token is still held. It is dropped once the exchange refuses it. */
  get renewable(): boolean {
    return this.#refreshToken !== undefined;
  }

  /**
   * True after a renewal failed in a way that may have reached ATLAS - a `5xx`, a redirect, or a
   * lost connection. The renewal may have landed, in which case the refresh token still held is
   * spent and presenting it again revokes the grant. While this is true the pass is never renewed
   * automatically; calling `refresh()` yourself is the decision to try that token again.
   */
  get renewalOutcomeUnknown(): boolean {
    return this.#outcomeUnknown;
  }

  isExpired(): boolean {
    return this.#now().getTime() >= this.#expiresAt.getTime();
  }

  /** Everything needed to `restore` this pass later. Includes the refresh token: store it like a password. */
  snapshot(): DelegatedPassSnapshot {
    return {
      accessToken: this.#accessToken,
      refreshToken: this.#refreshToken,
      expiresAt: this.#expiresAt.toISOString(),
      scope: this.#scope,
    };
  }

  /**
   * Renews the pass now. Concurrent calls share one renewal, because a refresh token works once.
   *
   * Every failure throws `RefreshRefusedError` and leaves the current pass in use until it expires.
   * A refusal (`400`) also drops the refresh token, so it is never presented again. A throttled
   * renewal (`429`) keeps it: nothing was spent. Any other failure may have reached ATLAS, so it
   * keeps the token and sets `renewalOutcomeUnknown`, and only another call to `refresh()` - yours,
   * never the SDK's - presents it again.
   *
   * @example
   * ```ts
   * try {
   *   await pass.refresh();
   * } catch (error) {
   *   if (error instanceof RefreshRefusedError) scheduleReconsent(error.stillValidUntil);
   *   else throw error;
   * }
   * ```
   */
  refresh(options: CallOptions = {}): Promise<void> {
    this.#renewing ??= this.#renew(options.signal).finally(() => {
      this.#renewing = undefined;
    });
    return this.#renewing;
  }

  async #renew(signal: AbortSignal | undefined): Promise<void> {
    const refreshToken = this.#refreshToken;
    if (refreshToken === undefined) {
      throw new AtlasError(
        `this pass cannot be renewed; it works until ${this.#expiresAt.toISOString()}, and then the person must consent again`,
      );
    }
    const body: TokenExchangeRequest = { grantType: 'refresh_token', refreshToken, clientId: this.#clientId };
    let response: DelegatedPassResponse;
    try {
      response = await this.#transport.call<DelegatedPassResponse>('exchangeDelegatedToken', {
        body,
        signal,
      });
    } catch (error) {
      if (error instanceof AtlasApiError) {
        if (error.status === 400) {
          // The exchange's one refusal: the token is spent, revoked or unknown. Never again.
          this.#refreshToken = undefined;
          this.#outcomeUnknown = false;
        } else if (error.status >= 500 || error.status < 400) {
          this.#outcomeUnknown = true;
        }
        // Any other 4xx, a 429 among them, was refused before the token was looked at.
        throw new RefreshRefusedError(error, this.expiresAt);
      }
      if (error instanceof AtlasConnectionError) {
        if (error.mayHaveReachedServer) this.#outcomeUnknown = true;
        throw new RefreshRefusedError(error, this.expiresAt);
      }
      throw error;
    }
    const next = DelegatedPass.#snapshotOf(response, this.#now());
    this.#accessToken = next.accessToken;
    this.#refreshToken = next.refreshToken;
    this.#expiresAt = new Date(next.expiresAt);
    this.#scope = next.scope;
    this.#outcomeUnknown = false;
    await this.#onRenewed?.(this.snapshot());
  }

  /**
   * The access token to send now: renewed first when it is within 30 seconds of expiry, unless an
   * earlier renewal's outcome is unknown. If the renewal fails while the pass still works, the pass
   * is used as it is.
   */
  async currentAccessToken(): Promise<string> {
    const nearExpiry = this.#now().getTime() + RENEW_MARGIN_MS >= this.#expiresAt.getTime();
    if (nearExpiry && this.#refreshToken !== undefined && !this.#outcomeUnknown) {
      try {
        await this.refresh();
      } catch (error) {
        if (!(error instanceof RefreshRefusedError) || this.isExpired()) throw error;
      }
    }
    return this.#accessToken;
  }
}

/**
 * Swaps the one-time `code` from the consent page for a pass. Run it on your server: it sends the
 * PKCE verifier, and it answers with a refresh token.
 *
 * The request is camelCase and the answer snake_case, on purpose - see `TokenExchangeRequest` and
 * `DelegatedPassResponse`. It is sent once and never retried after a failure that may have reached
 * the API: a code works once.
 *
 * @example
 * ```ts
 * const pass = await exchangeCode({
 *   baseUrl: process.env.ATLAS_BASE_URL!, clientId,
 *   code: request.query.code, redirectUri, codeVerifier: storedVerifier,
 * });
 * const asLearner = new PassClient({ baseUrl: process.env.ATLAS_BASE_URL!, orgId, pass });
 * ```
 */
export async function exchangeCode(
  options: ExchangeCodeOptions,
  internals: TransportInternals = {},
): Promise<DelegatedPass> {
  for (const name of ['clientId', 'code', 'redirectUri', 'codeVerifier'] as const) {
    if (typeof options?.[name] !== 'string' || options[name] === '') {
      throw new AtlasConfigurationError(`${name} is required`);
    }
  }
  const body: TokenExchangeRequest = {
    grantType: 'authorization_code',
    code: options.code,
    redirectUri: options.redirectUri,
    codeVerifier: options.codeVerifier,
    clientId: options.clientId,
  };
  const transport = new Transport(options, internals);
  const response = await transport.call<DelegatedPassResponse>('exchangeDelegatedToken', {
    body,
    signal: options.signal,
  });
  return DelegatedPass.fromResponse(response, options, internals);
}
