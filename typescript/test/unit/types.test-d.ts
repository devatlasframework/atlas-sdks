import { describe, expectTypeOf, it } from 'vitest';
import type {
  BipolarScore,
  DelegatedPassResponse,
  KeyClient,
  LearnerProfile,
  MultiCategoryScore,
  PassClient,
  Problem,
  SubDimensionScore,
  TokenExchangeRequest,
} from '../../src/index.js';

// Checked by the compiler, not run: each assertion here is a property of the generated types, and
// each `@ts-expect-error` fails the build if the thing it forbids ever becomes allowed.

describe('the one discriminated union in the surface', () => {
  it('narrows on structureType', () => {
    const score = {} as SubDimensionScore;
    if (score.structureType === 'bipolar') {
      expectTypeOf(score).toEqualTypeOf<BipolarScore>();
      expectTypeOf(score.score).toEqualTypeOf<number>();
    } else {
      expectTypeOf(score).toEqualTypeOf<MultiCategoryScore>();
      expectTypeOf(score.categories).toEqualTypeOf<{ [key: string]: number }>();
    }
  });

  it('cannot be built without its discriminator', () => {
    // @ts-expect-error structureType is required on every variant
    const missing: SubDimensionScore = {
      score: 4,
      scorePercent: 75,
      poleALabel: 'Quiet',
      poleBLabel: 'Noise',
    };
    // And it must name the variant whose shape follows. The directive sits on the property the
    // compiler reports, so that reformatting the literal cannot move the error off it.
    const crossed: SubDimensionScore = {
      structureType: 'bipolar',
      // @ts-expect-error a bipolar score has no categories
      categories: {},
      dominantCategory: 'Visual',
    };
    void missing;
    void crossed;
  });
});

describe('the four maps', () => {
  it('are typed by their values, keyed by data', () => {
    expectTypeOf<LearnerProfile['categoryScores']>().toEqualTypeOf<{ [key: string]: number }>();
    expectTypeOf<LearnerProfile['percentScores']>().toEqualTypeOf<{ [key: string]: number }>();
    expectTypeOf<LearnerProfile['subDimensionScores']>().toEqualTypeOf<{
      [key: string]: SubDimensionScore;
    }>();
    expectTypeOf<MultiCategoryScore['categories']>().toEqualTypeOf<{ [key: string]: number }>();
  });
});

describe('a refusal', () => {
  it('carries errorCode and errorId', () => {
    expectTypeOf<Problem>().toHaveProperty('errorCode').toEqualTypeOf<string | undefined>();
    expectTypeOf<Problem>().toHaveProperty('errorId').toEqualTypeOf<string | undefined>();
  });
});

describe('what a credential can call', () => {
  it('gives a pass the three content reads and nothing else', () => {
    const asLearner = {} as PassClient;
    expectTypeOf(asLearner.listResources).toBeFunction();
    expectTypeOf(asLearner.getResource).toBeFunction();
    expectTypeOf(asLearner.getResourceDownload).toBeFunction();
    // @ts-expect-error a pass cannot link a learner
    void asLearner.linkEndUser;
    // @ts-expect-error a pass cannot present for one
    void asLearner.presentForEndUser;
    // @ts-expect-error a pass has no key to describe
    void asLearner.describeKey;
  });

  it('gives a key the nine key operations', () => {
    const withKey = {} as KeyClient;
    expectTypeOf(withKey.describeKey).toBeFunction();
    expectTypeOf(withKey.linkEndUser).toBeFunction();
    expectTypeOf(withKey.presentForEndUser).toBeFunction();
    expectTypeOf(withKey.developerUsage).toBeFunction();
  });
});

describe('the token leg', () => {
  it('asks camelCase and answers snake_case, and neither can be written in the other', () => {
    expectTypeOf<TokenExchangeRequest>().toHaveProperty('grantType');
    expectTypeOf<TokenExchangeRequest>().toHaveProperty('codeVerifier');
    expectTypeOf<DelegatedPassResponse>().toHaveProperty('access_token');
    expectTypeOf<DelegatedPassResponse>().toHaveProperty('refresh_token');
    // @ts-expect-error the request is camelCase: grant_type is not a field
    const renamed: TokenExchangeRequest = { grant_type: 'refresh_token', clientId: 'c' };
    void renamed;
  });
});
