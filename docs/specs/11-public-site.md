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
| `index.html` | `site/pages/index.md` | A product landing page: what Caroline is, what it does, what it will not do, and how long each step of setting it up takes |
| `setup.html` | `docs/setup.md` | Setting it up from nothing |
| `using.html` | `docs/using.md` | Using it once it runs: what to press and what to say |
| `content-policy.html` | `docs/content-policy.md` | What leaves the machine |
| `reference.html` | `README.md` | The whole of it in short, and the configuration reference |
| `plan.html` | `docs/plan.md` | The order it was built in |
| `specs/index.html` | `docs/specs/README.md` | The specs, which are the contract |
| `specs/NN-name.html` | `docs/specs/NN-name.md` | One per spec |

`docs.html` is retired. Its "read it for" table said exactly what the grouped sidebar below now
says for every docs page, and a page whose whole content is a second copy of the sidebar is the kind
of drift this spec exists to rule out. `docs/README.md` is unchanged and unpublished: GitHub still
renders it as the directory's own index, the site simply stops generating a page from it, and
`reference.html` carries the one link to it that page used to be reached by, from the sidebar's
Reference group.

The home page is a product page rather than the paragraph and link list it used to be, and it is
still the only prose the site owns: every claim on it is copy that already exists, verbatim,
elsewhere in this repository (`site/pages/index.md`'s own existing text, and the README's), gathered
into a hero, four things it does, four things it will not, and the setup guide's own time-per-step
table read live rather than retyped. It sends a reader to the setup guide and to the specs; it does
not tell you how to set anything up.

## The docs shell

Every page but the home page shares a second piece of navigation beside the top one: a sidebar,
grouped by what a reader is trying to do rather than by which file the answer lives in.

- **Start here**: what Caroline is, setting it up, using it day to day.
- **Set up, in order**: the eleven steps of `docs/setup.md`'s own table, each with the time
  estimate the table states, shown only while a setup page is open.
- **Trust**: what leaves the machine, logins and exposure, removing everything.
- **Reference**: the specs, troubleshooting, the implementation plan, and the README.

The eleven-step group and the estimates on every group's entries are read from `docs/setup.md`'s own
table rather than written a second time in the sidebar, for the same reason spec 10's tokens are
extracted rather than copied: two copies of a number are one of them wrong the day the other
changes.

Every docs page also carries an "on this page" rail built from its own `##` headings, and a
previous/next pair at its foot along the reading order the sidebar's first two groups state, so a
sidebar that lets a reader jump anywhere does not cost them the guide's own order. A `**Check it:**`
paragraph, already a convention in `docs/setup.md`, renders as a callout rather than a bold run of
text.

A live, in-page search field is deliberately not part of this: the Non-goals below already rule out
anything a reader has to run JavaScript to read, and doing a search field honestly needs one. A
decorative field that does nothing would be worse than no field.

## Rules

**One source per sentence.** Every page but the home page is a rendered Markdown file that already
exists in the repository. The site adds a shell, a table of contents and a link to the source, and
changes no words.

**Links survive the move.** The documents link to each other by file path, and those paths are
rewritten to the site's pages. Heading identifiers are GitHub's slugs, so a fragment such as
`#6b-the-consent-screen`, already written into the guide, lands where it did on GitHub. A link that
names no page of the site fails the build rather than shipping: a document that wants to point at a
file rather than at a document writes that file's URL, so that no answer here depends on what happens
to be on the machine the site was built on.

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

**Pictures are generated, not captured.** The documentation shows the board, the dashboard and the
rail, and every one of those images is `tools/demo/shoot.mjs` driving the built client against the
seeded demonstration day. A hand-captured screenshot would be two things this site cannot have: stale
the first time a surface changed, and a picture of somebody's own board. The seeded items are invented,
and on a published page they should read that way: a plausible repository name under a real
organisation's would leave a stranger unsure whose pull requests they are looking at, so one invented
owner is used throughout instead. No namespace is safe by being unregistered, so what the pictures are
held to is the link rather than the name: every URL the seed writes is on a `.invalid` host, which can
never resolve, so nothing published or clicked lands in somebody's real repository. Each image is taken
in both palettes and the document carries both, so a reader sees the application in the theme they are
reading the page in.

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
- A live demo, or anything that needs a running Caroline behind the site.
- An asset of any other kind. `docs/images` is copied and nothing else is, so the build refuses an
  image from anywhere else rather than publishing a request for a file that is not there.
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
   Two files outside those three reach the output and no others: `web/styles.css`, as the tokens
   criterion 6 takes from it, and `package.json`, as the repository every page links its source at.
9. Two builds of the same tree produce identical output.
10. Every page carries the same top navigation and a `<title>` naming the page, and every page is
    reachable from the home page in at most two links. Every page but the home page also carries the
    docs shell's grouped sidebar, which is additional wayfinding rather than a second, differing
    navigation: the top navigation stays identical everywhere it appears.
11. One workflow builds and deploys the site, on a push to `main` and on demand, with the `pages` and
    `id-token` permissions it needs for that and no write permission on the repository's contents.
12. Every image the site publishes comes from `docs/images`, is named in the shot list of
    `tools/demo/shoot.mjs`, exists in both palettes, and is shown by a document, the specs included.
    The build refuses an image from anywhere else, a document embedding one that is not there, and a
    fragment on an image reference that is not a palette; the suite refuses an image no document shows,
    which the build cannot see. The seeded day those images are taken from carries no address, names one
    invented repository owner throughout, and writes every URL on a host that can never resolve, so no
    picture of it points into a real namespace. Every published image carries alternative text.
