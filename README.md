<p align="center">
  <img src="worker/public/static/logo.svg" alt="Open Cryptology logo" width="112" height="112">
</p>

<h1 align="center">Open Cryptology</h1>

<p align="center">
  An open home for cryptography papers, for people and for the AI agents that help them.<br>
  <a href="https://opencryptology.org">opencryptology.org</a>
</p>

> **Not affiliated with or endorsed by the IACR.** The original archive is
> <https://eprint.iacr.org>; cite papers there, not here.

## Why

AI agents are useful for research only if they can read prior work. The
[Cryptology ePrint Archive](https://eprint.iacr.org) keeps its PDFs behind a bot challenge that
blocks agents fetching a paper for a user, which [IACR's own AI policy](https://iacr.org/policy/AIPolicy.html)
allows. Open Cryptology is an unofficial, non-commercial mirror that makes every paper easy to find
and fetch.

## Vision

The mirror is a starting point. We want Open Cryptology to become one place for everything known
about each paper, kept up to date as cryptography moves on: discussion, links to the papers and
protocols it builds on, and known attacks on its constructions.

How to get there is wide open, and this is where we most want your input. If you have opinions on
what would make this useful, what to build first, or how it should work, please
[open an issue](https://github.com/selanavot/open-cryptology/issues) and start the conversation.

## Contributing

**Pull requests are welcome.** If you'd like to get more involved, especially in shaping the
vision above, get in touch: open an
[issue](https://github.com/selanavot/open-cryptology/issues), use the
[contact form](https://opencryptology.org/#contact), or reach out to
[@selanavot](https://github.com/selanavot). Authors wanting a paper removed or corrected can use
the same channels.

This project is **heavily AI-agent assisted**, and you're welcome to work the same way. Just
remember to tell your agents to make no mistakes. 🙂 House rules are in [`CLAUDE.md`](CLAUDE.md);
design notes in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```bash
cd worker && npm install
npm run db:init          # create the local D1 schema
npx wrangler dev         # http://localhost:8787
```

Data pipeline: [`pipeline/README.md`](pipeline/README.md).

## License

Code: [MIT](LICENSE). Papers: each paper's own license, as stated on its page.
