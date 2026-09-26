import { CONTRACT } from './generated/surface.js';

/**
 * This SDK's own version. It moves when this SDK changes, never because the contract did: a
 * breaking change to this SDK's own surface is this SDK's major, and the contract keeps a version
 * of its own. `npm run check:promises` holds it equal to `package.json`.
 */
export const SDK_VERSION = '0.1.0';

/** The contract this build was generated from: its own version, and the file's sha256. */
export const CONTRACT_VERSION: string = CONTRACT.version;
export const CONTRACT_SHA256: string = CONTRACT.sha256;

/** Both numbers, readable at run time from any client as `client.versions`. */
export interface Versions {
  /** This SDK's version. */
  readonly sdk: string;
  /** The version of the API contract this SDK was generated from. */
  readonly contract: string;
  /** The sha256 of that contract file. */
  readonly contractSha256: string;
}

export const VERSIONS: Versions = Object.freeze({
  sdk: SDK_VERSION,
  contract: CONTRACT_VERSION,
  contractSha256: CONTRACT_SHA256,
});
