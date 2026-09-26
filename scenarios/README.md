# Scenarios

`live.json` is what every SDK's live suite executes against a deployed ATLAS API, in the order
listed. It is data rather than code so that the SDKs cannot drift into testing different things.

- **A runner fails on a scenario it does not implement.** Adding one here turns every SDK's live
  run red until each implements it.
- **A run fails when its configuration is missing,** rather than skipping. A green live run that
  never reached the API would prove nothing.
- **A run fails unless it called every operation its SDK covers** on the deployed API. The set is
  derived from the contract, never listed.
- **The arbiter is the deployed API.** A mock generated from the same contract compares two copies
  of one document.

The live suites run where the API does. No ATLAS environment has a public address yet, so they are
not part of CI; their output is quoted in the pull request that needs it.

## Fixtures

- `fixtures/profile-scored.json`: a learner profile built by the ATLAS scorer, not by hand. A
  learner answered every scored item of every dimension, and this is what the API returned for
  them. It carries both sub-dimension shapes, bipolar and multi-category, the input a generator most
  easily gets wrong.
- `fixtures/webhook-delivery-dev.json`: a delivery captured from ATLAS's real webhook sender on a
  development environment, with the headers it arrived with and its endpoint's signing secret. The
  endpoint was deleted as soon as the delivery was captured, so the secret verifies nothing. It is
  here because every SDK's webhook verifier is tested against real sender output, never against
  output it signed itself.
