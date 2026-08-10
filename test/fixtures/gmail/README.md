# Gmail fixtures

Recorded `users.threads.list` and `users.threads.get` responses, reduced to the fields the
connector reads and scrubbed of real addresses, names and subjects before being committed. Spec 02
criterion 8: no test in this repository reaches the network, so these are what the Gmail connector
is driven by.

| File                                | What it is                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `threads-list.json`                 | Two threads matching the default query, as `threads.list` returns them                                                      |
| `thread-hub-numbers.json`           | A two-message thread with plain text and HTML alternatives, and a second sender                                             |
| `thread-invoice.json`               | A one-message thread with a PDF attachment, which the body extraction skips                                                 |
| `thread-github-review-request.json` | A GitHub review-request notification with a later comment on the same pull request, which the backup-source rule recognises |
| `thread-github-issue.json`          | A GitHub notification about an _issue_, which is not a pull request and must not be recognised                              |

The `Message-ID` headers are part of what is read, not decoration: GitHub writes
`owner/repo/pull/<number>@github.com`, which is how a notification is recognised without a body.
They are scrubbed like everything else, but their shape is GitHub's own.

The bodies are base64url as Gmail sends them. To read one back:

```sh
node -p "Buffer.from(process.argv[1], 'base64url').toString()" '<data>'
```
