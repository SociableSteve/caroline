# 11. Public site

Everything Caroline is written down is in a source tree. Somebody who has not decided to clone it
yet has to read the setup guide through GitHub's file viewer, next to a directory listing, which is
a fair place to keep a document and a poor place to answer "what is this and do I want it".

This spec is the site that answers that: what Caroline is, whether you want it, and how to set it
up, at a URL. It is a documentation site and not a second set of documentation. The setup guide is
`docs/setup.md`, the content policy is `docs/content-policy.md`, and the site renders both. A setup
guide maintained in two places is a setup guide that is wrong in one of them, and the wrong one is
always the one a stranger reads.

It shares the application's appearance for the same reason it shares its documents: the site and the
thing it describes should read as one piece of work. Spec 10's tokens are the source, extracted from
`web/styles.css` at build time rather than copied into a second palette that can drift from the
first.

## Pages

| Page | Renders | For |
| --- | --- | --- |
| `index.html` | `site/pages/index.md` | What Caroline is, what it will not do, what it needs, and where to start |
| `setup.html` | `docs/setup.md` | Setting it up from nothing |
| `content-policy.html` | `docs/content-policy.md` | What leaves the machine |
| `docs.html` | `docs/README.md` | The documentation index |
| `reference.html` | `README.md` | The whole of it in short, and the configuration reference |
| `plan.html` | `docs/plan.md` | The order it was built in |
| `specs/index.html` | `docs/specs/README.md` | The specs, which are the contract |
| `specs/NN-name.html` | `docs/specs/NN-name.md` | One per spec |

The home page is the only prose the site owns, because it is the only thing nobody has written yet:
a reader arriving at a repository already has a README, and a reader arriving at a site has nothing.
It says what Caroline is and sends you to the setup guide; it does not tell you how to set anything
up.

## Rules

**One source per sentence.** Every page but the home page is a rendered Markdown file that already
exists in the repository. The site adds a shell, a table of contents and a link to the source, and
changes no words.

**Links survive the move.** The documents link to each other by file path, and those paths are
rewritten to the site's pages. Heading identifiers are GitHub's slugs, so a fragment such as
`#6b-the-consent-screen`, already written into the guide, lands where it did on GitHub. A link that
resolves to no page and no file in the repository fails the build rather than shipping.

**Relative, so it works anywhere.** A project site is served under a path, not at a domain root.
Every link and asset reference within the site is relative to the page holding it, so the same output
works at `https://user.github.io/caroline/`, at a domain root, and from a local directory. A link out
of the site is absolute because it has to be: the repository, and whatever a document already links
to.

**No link that is code, and none that is an address.** A page may link out over `http` or `https` and
nothing else. The Markdown rendered here is authored in the repository and reviewed as code, so a
`javascript:` or `data:` URL, or a page carrying a `<script>`, is a mistake rather than an attack, and
the build refuses it rather than quietly rewriting what somebody wrote. `mailto:` is refused for a
different reason: no page may carry an address, and a link that is one is a leak with a scheme in
front of it.

**Static, and nothing fetched.** No client-side JavaScript, no web fonts, no analytics and no
external requests of any kind. The pages read offline, and nothing about who read what leaves the
reader's machine.

**Built from the tree, offline.** The generator reads the repository and nothing else. Two runs over
the same tree produce the same bytes, so a change in the output is a change somebody made.

**Published by one workflow, enabled by one setting.** A GitHub Actions workflow builds the site and
deploys it to Pages. Turning Pages on, with its source set to GitHub Actions, is the one step that
lives in repository settings rather than in the repository.

## Non-goals

- Search, versioned documentation, a blog, comments, or anything a reader has to run JavaScript to
  read.
- A custom domain, redirects from one, or anything that assumes a host other than GitHub Pages.
- Screenshots or a live demo. Both would need seeded data in the repository and would be a second
  thing to keep true. No asset is copied into the output either, so the build refuses a Markdown image
  rather than publishing a request for a file that is not there.
- A documentation framework. The generator is one file, and its job is a shell around Markdown that
  is already written.
- Publishing anything that is not documentation: no fixtures, no database, no configuration of
  anybody's.

## Acceptance criteria

1. Every page other than the home page is generated from a Markdown file in the repository, and
   carries that file's headings and body text. A test asserts a page against its source, so a page
   cannot drift from the document it renders.
2. The home page instructs nobody: it contains no code block and names no environment variable, and
   it links to the setup guide instead.
3. Every internal link in the built site resolves. A link to a page names a file that was built, and
   a fragment names a heading identifier present in that file. The build fails on one that does not,
   and a test asserts that failure.
4. Heading identifiers are GitHub's slugs, so every fragment already written into the documents
   still lands on its heading.
5. No link or asset reference within the built site is absolute or root-relative, so the site works
   under a project path as well as at a domain root. A link that leaves the site is absolute and its
   scheme is `http` or `https`: the build refuses any other, in any spelling of the attribute, and
   refuses a page that carries a `<script>`, an `<iframe>` or an inline event handler.
6. The built stylesheet declares every token `web/styles.css` declares, in both palettes, with the
   same values, because it is extracted from that file rather than written again. The site's own
   rules name a colour, a spacing, a font size or a radius only as a token, which is spec 10's first
   two criteria applied to the second stylesheet.
7. No page loads a script, an external stylesheet, a font or an image from another host, and no page
   contains a `<script>` element at all.
8. Every page renders a document from `README.md`, `docs/` or `site/`, and no rendered page carries an
   email address or anything shaped like an API key or token, in its text or in an attribute.
   `web/styles.css` is the one file outside those three that reaches the output, and only as the tokens
   criterion 6 takes from it.
9. Two builds of the same tree produce identical output.
10. Every page carries the same navigation and a `<title>` naming the page, and every page is
    reachable from the home page in at most two links.
11. One workflow builds and deploys the site, on a push to `main` and on demand, with the `pages` and
    `id-token` permissions it needs for that and no write permission on the repository's contents.
