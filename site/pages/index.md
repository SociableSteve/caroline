# Caroline

{{lede}}

{{start}}

{{diagram}}

## What it does

- **Collects.** Pull requests waiting on your review, mail threads in your inbox, and the events in
  your calendar. Every quarter of an hour, without being asked.
- **Sorts.** A model of your choosing empties the inbox hourly into the columns of a GTD board.
  Where it is not confident it says so on the card and waits for one click rather than guessing.
- **Plans.** A daily plan sized to the free time your calendar actually leaves, with a fifth of the
  day held back for the things that arrive.
- **Discusses.** Chat in a rail beside whatever you are looking at, so asking about the board does
  not take the board away. Its tools reach Caroline's own database and nothing else, and every
  change it makes can be put back in one press.

## What it will not do

- **Write anything back.** It never writes to GitHub, Gmail or Calendar. The credentials it asks for
  are read-only, and the list of things chat can do is the enforcement rather than an instruction it
  has been given.
- **Leave your machine.** It binds to your own loopback address, keeps everything in one SQLite
  file, and one command removes every trace of it.
- **Send your correspondence to a model because it felt like it.** Two settings decide how much of
  an item goes to a provider and how much is written to disk. They default to the cautious answers,
  and a screen shows you the exact payload, for a real item of your own, before you leave it
  running.
- **Ask you to trust a service.** There is nothing hosted, no account to make, and no shared
  credential: your own API key, or a local model, and an OAuth client belonging to a Google Cloud
  project of yours.

## What it needs

A machine you use, with Node 24 or later on it, and a browser. There is nothing to compile and no
container to run. Every integration is optional and Caroline says which are configured: with none of
them it is a manual GTD board, which is a fair way to decide whether you like it before handing it
any credentials.

Then, one at a time and in any order: a GitHub account whose review requests you want to see, a
Google account whose mail and calendar you want read, and either an API key from Anthropic or
OpenAI or a model you run yourself.

## Where to start

[Setting Caroline up](../../docs/setup.md) is the guide: it is written in the order somebody
actually does it, and each integration ends with a way to check it works before you move on. The two
steps that cost people an afternoon, GitHub's token scopes and Google's consent screen, are called
out where you meet them.

[What leaves the machine](../../docs/content-policy.md) is worth reading before you point it at a
work mailbox rather than after.

[The documentation](../../docs/README.md) is the rest: the specs are the contract each part is held
to, and the tests assert their acceptance criteria one by one.
