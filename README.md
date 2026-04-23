# dlmt

Download a site's `llms.txt` and all linked markdown/JSON/YAML resources into a local directory, preserving URL path structure. The saved `llms.txt` is rewritten to point at the local copies.

Aliases: `dlmt`, `download-llmstxt`, `dl-llmstxt`, `dl-mintlify`, `download-mintlify`.

## Install

### Homebrew

```sh
brew install ricardonunez-io/dlmt/dlmt
```

### Deno

```sh
deno install -gA -n dlmt https://raw.githubusercontent.com/ricardonunez-io/dlmt/main/main.ts
```

### Manual

Download a prebuilt tarball from [Releases](https://github.com/ricardonunez-io/dlmt/releases), extract, and place on your `PATH`.

## Usage

```
dlmt <source> [options]
```

Arguments:

- `<source>` — path or URL to an `llms.txt` file.

Options:

- `-o, --out <dir>` — output directory (default: cwd).
- `--base-url <url>` — base URL for resolving relative links in a local `llms.txt`.
- `-c, --concurrency <n>` — max concurrent downloads (default: 10).
- `--no-clobber` — skip files that already exist locally.
- `-h, --help`, `-v, --version`.

Examples:

```sh
dlmt https://mintlify.com/docs/llms.txt -o ./docs
dlmt ./llms.txt --base-url https://mintlify.com -o out -c 20
```

## How it works

- Parses the input using [`remark`](https://github.com/remarkjs/remark) with `remark-gfm` and `remark-mdx`.
- Collects `link` and `definition` nodes; ignores links inside code blocks and MDX JSX attributes.
- Filters to `.md`, `.mdx`, `.json`, `.yaml`, `.yml` targets.
- Downloads concurrently with a bounded pool, mirroring URL path structure under the output directory.
- Rewrites the AST so the saved `llms.txt` references local relative paths, then stringifies via `remark-stringify`.

## Development

```sh
deno task test
deno task dlmt <source>
deno task compile
```
