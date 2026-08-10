# Recorded LLM provider payloads

One response per provider, each answering the same classification request against the same
schema. Spec 03 criterion 2 asks that all three adapters turn these into the same validated
structured object, and `test/llm/adapters/adapters.test.ts` is where that is asserted.

The payloads are shaped as the providers send them, trimmed to the fields the adapters read
plus enough of the envelope to stay recognisable. Token counts are deliberately identical
across the three, so a test asserting usage is asserting the adapter's field mapping rather
than a difference between the recordings.

No real content, no real message ids, and no test in this repository reaches the network.
