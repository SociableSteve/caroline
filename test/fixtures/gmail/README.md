# Gmail fixtures

Recorded `users.threads.list` and `users.threads.get` responses, reduced to the fields the
connector reads and scrubbed of real addresses, names and subjects before being committed. Spec 02
criterion 8: no test in this repository reaches the network, so these are what the Gmail connector
is driven by.

| File                      | What it is                                                                      |
| ------------------------- | ------------------------------------------------------------------------------- |
| `threads-list.json`       | Two threads matching the default query, as `threads.list` returns them          |
| `thread-hub-numbers.json` | A two-message thread with plain text and HTML alternatives, and a second sender |
| `thread-invoice.json`     | A one-message thread with a PDF attachment, which the body extraction skips     |

The bodies are base64url as Gmail sends them. `node -e "Buffer.from(data, 'base64url').toString()"`
reads one back if you need to check what a test is asserting about.
