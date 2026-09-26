import type { DelegatedPass } from './delegated.js';
import { AtlasConfigurationError } from './errors.js';
import type { components, operations } from './generated/contract.js';
import type { RateLimitState } from './rate-limit.js';
import { Transport, type CallOptions, type ClientOptions, type TransportInternals } from './transport.js';
import { VERSIONS, type Versions } from './version.js';

type Schemas = components['schemas'];

export type KeyIdentity = Schemas['KeyIdentityResponse'];
export type EndUser = Schemas['EndUserResponse'];
export type EndUserPage = Schemas['EndUserPage'];
export type LinkEndUserRequest = Schemas['LinkEndUserRequest'];
export type PresentEndUserRequest = Schemas['PresentEndUserRequest'];
export type LearnerProfile = Schemas['LearnerProfile'];
export type SubDimensionScore = Schemas['SubDimensionScore'];
export type BipolarScore = Schemas['BipolarScore'];
export type MultiCategoryScore = Schemas['MultiCategoryScore'];
export type PersonalisationProfile = Schemas['PersonalisationProfile'];
export type DeveloperUsage = Schemas['DeveloperUsageResponse'];
export type Resource = Schemas['ResourceResponse'];
export type ResourceList = Schemas['ResourceListResponse'];
export type ResourceDownload = Schemas['ResourceDownloadResponse'];
export type ListResourcesQuery = NonNullable<operations['listResources']['parameters']['query']>;

/** Options for `linkEndUser`. */
export interface LinkEndUserOptions extends CallOptions {
  /**
   * The repeat guard, 8-255 characters. The SDK generates one per call when you do not, and sends
   * the same one on every attempt, so a retried call acts once. Pass your own to make a retry that
   * crosses a process restart act once too - and never reuse one for a different request.
   */
  readonly idempotencyKey?: string;
}

/** A client authenticated with an API key. */
export interface KeyClientOptions extends ClientOptions {
  /**
   * Your API key (`atl_sk_live_...`). It is a server-side secret: never put it in browser code or
   * a mobile app, where anyone can read it.
   */
  readonly apiKey: string;
  /**
   * The organisation your key belongs to. Optional: when you leave it out, the first call that
   * needs it asks `describeKey` once and remembers the answer.
   */
  readonly orgId?: string;
}

/** A client authenticated with a delegated pass: it acts as the person who consented. */
export interface PassClientOptions extends ClientOptions {
  /** The organisation the person consented for: the `org_id` you sent them to consent with. */
  readonly orgId: string;
  /**
   * The pass. A `DelegatedPass` renews itself before it expires, and keeps working until it
   * expires if a renewal is refused. A bare access token is sent as it is, until it stops working.
   */
  readonly pass: DelegatedPass | string;
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AtlasConfigurationError(`${name} is required`);
  }
  return value;
}

/**
 * Calls the ATLAS API with an API key. It has exactly the operations a key can reach, so an
 * operation your credential could never call is a type error rather than a `403`.
 *
 * @example
 * ```ts
 * import { KeyClient } from '@devatlasframework/sdk';
 *
 * const atlas = new KeyClient({
 *   baseUrl: process.env.ATLAS_BASE_URL!, // the API address you were given
 *   apiKey: process.env.ATLAS_API_KEY!,
 * });
 * const key = await atlas.describeKey();
 * console.log(key.orgId, key.scopes);
 * ```
 */
export class KeyClient {
  /** This SDK's version and the contract it was generated from. */
  readonly versions: Versions = VERSIONS;
  readonly #transport: Transport;
  readonly #apiKey: string;
  #orgId: string | undefined;

  constructor(options: KeyClientOptions, internals?: TransportInternals) {
    this.#apiKey = required(options?.apiKey, 'apiKey');
    this.#orgId = options.orgId;
    this.#transport = new Transport(options, internals);
  }

  /**
   * Your request-rate budget as the most recent response reported it, or `undefined` when no
   * response has reported one. Diagnose a refusal from the error's `retryAfter` and `errorCode`,
   * never from this: a narrower per-operation limit can refuse you while it reads healthy.
   */
  get rateLimit(): RateLimitState | undefined {
    return this.#transport.rateLimit;
  }

  /**
   * What this key is: its organisation, its application and the permissions it carries. Needs no
   * permission, so a key can always ask what it is before it is told what it lacks.
   *
   * @example
   * ```ts
   * const { orgId, appId, scopes, expiresAt } = await atlas.describeKey();
   * ```
   */
  describeKey(options: CallOptions = {}): Promise<KeyIdentity> {
    return this.#transport.call('describeKey', { credential: this.#credential, signal: options.signal });
  }

  /**
   * Every learner of yours linked to the application this key belongs to. Needs `end-users:manage`.
   *
   * @example
   * ```ts
   * const { items } = await atlas.listEndUsers();
   * const active = items.filter((endUser) => endUser.active);
   * ```
   */
  async listEndUsers(options: CallOptions = {}): Promise<EndUserPage> {
    return this.#transport.call('listEndUsers', {
      path: { orgId: await this.#org(options) },
      credential: this.#credential,
      signal: options.signal,
    });
  }

  /**
   * Links one of your own learners, named by your reference for them. Linking one already linked
   * returns the existing link. Needs `end-users:manage`. Retried safely: every attempt carries the
   * same `Idempotency-Key`, so a retry after a lost response acts once.
   *
   * @example
   * ```ts
   * const endUser = await atlas.linkEndUser({ ref: 'learner-4821' });
   * ```
   */
  async linkEndUser(body: LinkEndUserRequest, options: LinkEndUserOptions = {}): Promise<EndUser> {
    return this.#transport.call('linkEndUser', {
      path: { orgId: await this.#org(options) },
      body,
      credential: this.#credential,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      signal: options.signal,
    });
  }

  /**
   * Unlinks a learner. Needs `end-users:manage`. Retried after a lost response, safely: revoking
   * a link that is already revoked answers with that link, because it is the state you asked for.
   *
   * @example
   * ```ts
   * await atlas.revokeEndUser(endUser.id);
   * ```
   */
  async revokeEndUser(endUserId: string, options: CallOptions = {}): Promise<EndUser> {
    return this.#transport.call('revokeEndUser', {
      path: { orgId: await this.#org(options), endUserId: required(endUserId, 'endUserId') },
      credential: this.#credential,
      signal: options.signal,
    });
  }

  /**
   * How to present content to one of your learners, computed from the profile you send - their
   * endorsed preferences, the features to offer and the presentation to apply. Needs `ai:use`.
   *
   * It is sent once and never retried after a failure that may have reached the API, because
   * every call is counted in your usage and a retry would count twice. A `429` is still retried
   * after its `Retry-After`, because a throttled call is not counted.
   *
   * @example
   * ```ts
   * const plan = await atlas.presentForEndUser(endUser.id, { profile });
   * for (const endorsement of plan.endorsements) console.log(endorsement.key, endorsement.strength);
   * ```
   */
  async presentForEndUser(
    endUserId: string,
    body: PresentEndUserRequest,
    options: CallOptions = {},
  ): Promise<PersonalisationProfile> {
    return this.#transport.call('presentForEndUser', {
      path: { orgId: await this.#org(options), endUserId: required(endUserId, 'endUserId') },
      body,
      credential: this.#credential,
      signal: options.signal,
    });
  }

  /**
   * How much your applications have used this period, and where you stand against your request
   * rate. Needs `usage:read`.
   *
   * @example
   * ```ts
   * const usage = await atlas.developerUsage();
   * console.log(usage.calls, usage.state);
   * ```
   */
  async developerUsage(options: CallOptions = {}): Promise<DeveloperUsage> {
    return this.#transport.call('developerUsage', {
      path: { orgId: await this.#org(options) },
      credential: this.#credential,
      signal: options.signal,
    });
  }

  /**
   * Your organisation's lectures, a page at a time. Needs `content:read`.
   *
   * @example
   * ```ts
   * const page = await atlas.listResources({ status: ['READY'], size: 50 });
   * for (const resource of page.items) console.log(resource.id, resource.title);
   * ```
   */
  async listResources(query: ListResourcesQuery = {}, options: CallOptions = {}): Promise<ResourceList> {
    return this.#transport.call('listResources', {
      path: { orgId: await this.#org(options) },
      query,
      credential: this.#credential,
      signal: options.signal,
    });
  }

  /**
   * One lecture: its title, status and current version. Needs `content:read`.
   *
   * @example
   * ```ts
   * const resource = await atlas.getResource(resourceId);
   * ```
   */
  async getResource(resourceId: string, options: CallOptions = {}): Promise<Resource> {
    return this.#transport.call('getResource', {
      path: { orgId: await this.#org(options), resourceId: required(resourceId, 'resourceId') },
      credential: this.#credential,
      signal: options.signal,
    });
  }

  /**
   * A short-lived address to download a lecture's original file from. Needs `content:read`.
   *
   * @example
   * ```ts
   * const { downloadUrl, expiresAt, filename } = await atlas.getResourceDownload(resourceId);
   * ```
   */
  async getResourceDownload(resourceId: string, options: CallOptions = {}): Promise<ResourceDownload> {
    return this.#transport.call('getResourceDownload', {
      path: { orgId: await this.#org(options), resourceId: required(resourceId, 'resourceId') },
      credential: this.#credential,
      signal: options.signal,
    });
  }

  readonly #credential = (): string => this.#apiKey;

  async #org(options: CallOptions): Promise<string> {
    this.#orgId ??= (await this.describeKey(options)).orgId;
    return this.#orgId;
  }
}

/**
 * Calls the ATLAS API with a delegated pass, as the person who consented. It has exactly the
 * operations a pass can reach - the three content reads - so anything else is a type error.
 *
 * @example
 * ```ts
 * import { PassClient } from '@devatlasframework/sdk';
 *
 * const asLearner = new PassClient({ baseUrl: process.env.ATLAS_BASE_URL!, orgId, pass });
 * const page = await asLearner.listResources();
 * ```
 */
export class PassClient {
  /** This SDK's version and the contract it was generated from. */
  readonly versions: Versions = VERSIONS;
  readonly #transport: Transport;
  readonly #orgId: string;
  readonly #pass: DelegatedPass | string;

  constructor(options: PassClientOptions, internals?: TransportInternals) {
    this.#orgId = required(options?.orgId, 'orgId');
    if (typeof options.pass !== 'string' && (typeof options.pass !== 'object' || options.pass === null)) {
      throw new AtlasConfigurationError('pass is required: a DelegatedPass, or an access token');
    }
    this.#pass = typeof options.pass === 'string' ? required(options.pass, 'pass') : options.pass;
    this.#transport = new Transport(options, internals);
  }

  /** Your request-rate budget as the most recent response reported it; see `KeyClient.rateLimit`. */
  get rateLimit(): RateLimitState | undefined {
    return this.#transport.rateLimit;
  }

  /**
   * The lectures the person can read in this organisation, a page at a time. The pass needs
   * `content:read`.
   *
   * @example
   * ```ts
   * const page = await asLearner.listResources({ size: 20 });
   * ```
   */
  listResources(query: ListResourcesQuery = {}, options: CallOptions = {}): Promise<ResourceList> {
    return this.#transport.call('listResources', {
      path: { orgId: this.#orgId },
      query,
      credential: this.#credential,
      signal: options.signal,
    });
  }

  /**
   * One lecture, as the person can see it. The pass needs `content:read`.
   *
   * @example
   * ```ts
   * const resource = await asLearner.getResource(resourceId);
   * ```
   */
  getResource(resourceId: string, options: CallOptions = {}): Promise<Resource> {
    return this.#transport.call('getResource', {
      path: { orgId: this.#orgId, resourceId: required(resourceId, 'resourceId') },
      credential: this.#credential,
      signal: options.signal,
    });
  }

  /**
   * A short-lived download address for a lecture's original file. The pass needs `content:read`.
   *
   * @example
   * ```ts
   * const { downloadUrl } = await asLearner.getResourceDownload(resourceId);
   * ```
   */
  getResourceDownload(resourceId: string, options: CallOptions = {}): Promise<ResourceDownload> {
    return this.#transport.call('getResourceDownload', {
      path: { orgId: this.#orgId, resourceId: required(resourceId, 'resourceId') },
      credential: this.#credential,
      signal: options.signal,
    });
  }

  readonly #credential = (): string | Promise<string> =>
    typeof this.#pass === 'string' ? this.#pass : this.#pass.currentAccessToken();
}
