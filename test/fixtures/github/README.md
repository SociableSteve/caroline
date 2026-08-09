# Recorded GitHub payloads

GraphQL responses as `api.github.com/graphql` returns them, scrubbed of real addresses,
names and repository identifiers before being committed. Spec 02, criterion 8: every
connector is testable against recorded fixtures with no network access, and nothing in the
suite ever reaches the network.

The cast is fixed so the tests read the same way across files:

| Name                                                     | Is                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| `reviewer-you`                                           | The authenticated user, whose review is being requested           |
| `author-one`, `author-two`                               | Pull request authors                                              |
| `platform`                                               | A team `reviewer-you` belongs to, used for team-requested reviews |
| `example-org/example-service`, `example-org/example-web` | Repositories                                                      |

| File                             | Is                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `discovery.json`                 | The discovery search: two open pull requests requesting your review, one directly and one through the team                  |
| `refresh-changes-requested.json` | The refresh pass over a pull request you have reviewed with changes requested, which the discovery search no longer returns |
| `refresh-merged.json`            | The refresh pass over a pull request that has since merged                                                                  |
