import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  collectLinks,
  filterDownloadable,
  htmlToMarkdown,
  isHtmlResponse,
  isLikelyDocument,
  parseLlmsTxt,
  resolveHref,
  rewriteNodes,
  run,
  stringifyTree,
  swapExtensionToMd,
  urlToLocalPath,
} from "./main.ts";

Deno.test("isLikelyDocument: accepts anything without a non-doc extension", () => {
  assert(isLikelyDocument("https://x.com/a.md"));
  assert(isLikelyDocument("https://x.com/a.mdx"));
  assert(isLikelyDocument("https://x.com/a.json"));
  assert(isLikelyDocument("https://x.com/a.yaml"));
  assert(isLikelyDocument("https://x.com/a.yml"));
  assert(isLikelyDocument("https://x.com/a.html"));
  assert(isLikelyDocument("https://x.com/a"));
  assert(isLikelyDocument("https://x.com/docs/intro"));
  assert(isLikelyDocument("https://x.com/"));
});

Deno.test("isLikelyDocument: rejects assets and fragment-only", () => {
  assert(!isLikelyDocument("https://x.com/img.png"));
  assert(!isLikelyDocument("https://x.com/logo.svg"));
  assert(!isLikelyDocument("https://x.com/video.mp4"));
  assert(!isLikelyDocument("https://x.com/font.woff2"));
  assert(!isLikelyDocument("https://x.com/archive.zip"));
  assert(!isLikelyDocument("https://x.com/script.js"));
  assert(!isLikelyDocument("#top"));
  assert(!isLikelyDocument("#section-1"));
});

Deno.test("isLikelyDocument: ignores query and hash for extension check", () => {
  assert(isLikelyDocument("https://x.com/a.md?x=1"));
  assert(isLikelyDocument("https://x.com/docs/page#foo"));
  assert(isLikelyDocument("https://x.com/docs/page#delete.md"));
  assert(!isLikelyDocument("https://x.com/img.png?x=1"));
});

Deno.test("collectLinks: only list-item links", () => {
  const md = [
    "# Title",
    "",
    "Intro paragraph with [inline](https://example.com/inline.md) link.",
    "",
    "- [a](https://example.com/a.md)",
    "- [b](https://example.com/b)",
    "",
  ].join("\n");
  const tree = parseLlmsTxt(md);
  const hrefs = collectLinks(tree).map((l) => l.href).sort();
  assertEquals(hrefs, [
    "https://example.com/a.md",
    "https://example.com/b",
  ]);
});

Deno.test("collectLinks: reference-style inside list", () => {
  const md = [
    "- [b][ref]",
    "",
    "[ref]: https://example.com/b.md",
    "",
  ].join("\n");
  const tree = parseLlmsTxt(md);
  const hrefs = collectLinks(tree).map((l) => l.href).sort();
  assert(hrefs.includes("https://example.com/b.md"));
});

Deno.test("collectLinks: ignores links inside fenced code blocks", () => {
  const md = [
    "```",
    "[nope](https://example.com/nope.md)",
    "```",
    "",
    "- [yes](https://example.com/yes.md)",
    "",
  ].join("\n");
  const tree = parseLlmsTxt(md);
  const hrefs = collectLinks(tree).map((l) => l.href);
  assertEquals(hrefs, ["https://example.com/yes.md"]);
});

Deno.test("collectLinks: ignores MDX JSX attributes", () => {
  const md = [
    '<Card href="https://example.com/jsx.md" />',
    "",
    "- [y](https://example.com/y.md)",
    "",
  ].join("\n");
  const tree = parseLlmsTxt(md);
  const hrefs = collectLinks(tree).map((l) => l.href);
  assertEquals(hrefs, ["https://example.com/y.md"]);
});

Deno.test("filterDownloadable: keeps docs, drops assets", () => {
  const md = [
    "- [a](https://x.com/a.md)",
    "- [b](https://x.com/b.html)",
    "- [c](https://x.com/c.json)",
    "- [d](https://x.com/d)",
    "- [e](https://x.com/e.png)",
  ].join("\n");
  const tree = parseLlmsTxt(md);
  const filtered = filterDownloadable(collectLinks(tree));
  assertEquals(filtered.map((l) => l.href).sort(), [
    "https://x.com/a.md",
    "https://x.com/b.html",
    "https://x.com/c.json",
    "https://x.com/d",
  ]);
});

Deno.test("resolveHref: absolute", () => {
  const u = resolveHref("https://example.com/a.md");
  assertEquals(u.href, "https://example.com/a.md");
});

Deno.test("resolveHref: relative with base", () => {
  const u = resolveHref("/docs/a.md", "https://example.com/llms.txt");
  assertEquals(u.href, "https://example.com/docs/a.md");
});

Deno.test("resolveHref: relative without base throws", () => {
  assertThrows(() => resolveHref("/docs/a.md"));
});

Deno.test("urlToLocalPath: mirrors pathname", () => {
  const p = urlToLocalPath(
    new URL("https://x.com/docs/intro.md"),
    "/tmp/out",
  );
  assertEquals(p, join("/tmp/out", "docs/intro.md"));
});

Deno.test("urlToLocalPath: trailing slash gets index", () => {
  const p = urlToLocalPath(new URL("https://x.com/docs/"), "/tmp/out");
  assertEquals(p, join("/tmp/out", "docs/index"));
});

Deno.test("rewriteNodes + stringify round-trip", () => {
  const md = "- [a](https://example.com/docs/a.md)\n";
  const tree = parseLlmsTxt(md);
  const links = filterDownloadable(collectLinks(tree));
  const plan = links.map((l) => ({
    href: l.href,
    url: new URL(l.href),
    localPath: "/tmp/out/docs/a.md",
    node: l.node,
  }));
  rewriteNodes(plan, "/tmp/out");
  const out = stringifyTree(tree);
  assert(out.includes("(./docs/a.md)"), `got: ${out}`);
});

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "dlmt-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function stubFetch(map: Record<string, { status?: number; body: string }>): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const entry = map[url];
    if (!entry) {
      return Promise.resolve(
        new Response("not found", { status: 404 }),
      );
    }
    return Promise.resolve(
      new Response(entry.body, { status: entry.status ?? 200 }),
    );
  }) as unknown as typeof fetch;
}

Deno.test("run: downloads files and rewrites llms.txt (URL source)", async () => {
  await withTempDir(async (dir) => {
    const llmsTxt = [
      "# Docs",
      "",
      "- [Intro](https://example.com/docs/intro.md)",
      "- [Config](https://example.com/config.json)",
      "- [Logo](https://example.com/logo.png)",
      "",
    ].join("\n");

    const fetchFn = stubFetch({
      "https://example.com/llms.txt": { body: llmsTxt },
      "https://example.com/docs/intro.md": { body: "# intro" },
      "https://example.com/config.json": { body: "{}" },
    });

    const res = await run({
      source: "https://example.com/llms.txt",
      outDir: dir,
      concurrency: 4,
      noClobber: false,
      fetchFn,
      log: () => {},
    });

    assertEquals(res.written, 2);
    assertEquals(res.failed, 0);

    const intro = await Deno.readTextFile(join(dir, "docs/intro.md"));
    assertEquals(intro, "# intro");
    const config = await Deno.readTextFile(join(dir, "config.json"));
    assertEquals(config, "{}");

    const rewritten = await Deno.readTextFile(join(dir, "llms.txt"));
    assert(rewritten.includes("./docs/intro.md"), rewritten);
    assert(rewritten.includes("./config.json"), rewritten);
    assert(!rewritten.includes("https://example.com/docs/intro.md"));
  });
});

Deno.test("run: local llms.txt with --base-url", async () => {
  await withTempDir(async (dir) => {
    const src = join(dir, "llms.txt");
    await Deno.writeTextFile(src, "- [a](/a.md)\n");

    const fetchFn = stubFetch({
      "https://example.com/a.md": { body: "A" },
    });

    const out = join(dir, "out");
    const res = await run({
      source: src,
      outDir: out,
      baseUrl: "https://example.com",
      concurrency: 2,
      noClobber: false,
      fetchFn,
      log: () => {},
    });

    assertEquals(res.written, 1);
    const a = await Deno.readTextFile(join(out, "a.md"));
    assertEquals(a, "A");
  });
});

Deno.test("run: --no-clobber skips existing files", async () => {
  await withTempDir(async (dir) => {
    const llmsTxt = "- [a](https://example.com/a.md)\n";
    const existing = join(dir, "a.md");
    await Deno.writeTextFile(existing, "ORIGINAL");

    let fetched = 0;
    const fetchFn = ((input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      if (url === "https://example.com/llms.txt") {
        return Promise.resolve(new Response(llmsTxt));
      }
      fetched++;
      return Promise.resolve(new Response("NEW"));
    }) as unknown as typeof fetch;

    const res = await run({
      source: "https://example.com/llms.txt",
      outDir: dir,
      concurrency: 2,
      noClobber: true,
      fetchFn,
      log: () => {},
    });

    assertEquals(res.written, 1);
    assertEquals(fetched, 0);
    const content = await Deno.readTextFile(existing);
    assertEquals(content, "ORIGINAL");
  });
});

Deno.test("run: reports failures on non-200", async () => {
  await withTempDir(async (dir) => {
    const llmsTxt = "- [a](https://example.com/missing.md)\n";
    const fetchFn = stubFetch({
      "https://example.com/llms.txt": { body: llmsTxt },
      "https://example.com/missing.md": { status: 404, body: "nope" },
    });

    const res = await run({
      source: "https://example.com/llms.txt",
      outDir: dir,
      concurrency: 2,
      noClobber: false,
      fetchFn,
      log: () => {},
    });

    assertEquals(res.written, 0);
    assertEquals(res.failed, 1);
  });
});

Deno.test("run: local source with relative href + no base-url throws per-link", async () => {
  await withTempDir(async (dir) => {
    const src = join(dir, "llms.txt");
    await Deno.writeTextFile(src, "- [a](/a.md)\n- [b](https://example.com/b.md)\n");

    const fetchFn = stubFetch({
      "https://example.com/b.md": { body: "B" },
    });

    const res = await run({
      source: src,
      outDir: join(dir, "out"),
      concurrency: 2,
      noClobber: false,
      fetchFn,
      log: () => {},
    });

    assertEquals(res.written, 1);
  });
});

Deno.test("run: throws on unreachable source URL", async () => {
  const fetchFn = stubFetch({});
  await assertRejects(
    () =>
      run({
        source: "https://example.com/llms.txt",
        outDir: "/tmp",
        concurrency: 2,
        noClobber: false,
        fetchFn,
        log: () => {},
      }),
    Error,
    "Failed to fetch",
  );
});

Deno.test("run: sends Accept: text/markdown header on all fetches", async () => {
  await withTempDir(async (dir) => {
    const llmsTxt = "- [a](https://example.com/a.md)\n";
    const seenAccept: string[] = [];
    const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenAccept.push(headers.get("accept") ?? "");
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      if (url === "https://example.com/llms.txt") {
        return Promise.resolve(new Response(llmsTxt));
      }
      return Promise.resolve(new Response("A"));
    }) as unknown as typeof fetch;

    await run({
      source: "https://example.com/llms.txt",
      outDir: dir,
      concurrency: 2,
      noClobber: false,
      fetchFn,
      log: () => {},
    });

    assertEquals(seenAccept.length, 2);
    for (const a of seenAccept) assertEquals(a, "text/markdown");
  });
});

Deno.test("isHtmlResponse: content-type detection", () => {
  assert(isHtmlResponse("text/html; charset=utf-8", ""));
  assert(isHtmlResponse("application/xhtml+xml", ""));
  assert(!isHtmlResponse("text/markdown", "<html>oops</html>"));
  assert(!isHtmlResponse("application/json", "{}"));
  assert(!isHtmlResponse("text/yaml", "a: 1"));
});

Deno.test("isHtmlResponse: body sniff when no content-type", () => {
  assert(isHtmlResponse(null, "<!DOCTYPE html><html></html>"));
  assert(isHtmlResponse(null, "<html><body>x</body></html>"));
  assert(!isHtmlResponse(null, "# markdown"));
  assert(!isHtmlResponse(null, "{\n  \"x\": 1\n}"));
});

Deno.test("htmlToMarkdown: prefers <article>", () => {
  const html = `<!DOCTYPE html><html><body>
    <nav>skip</nav>
    <main><p>main content</p></main>
    <article><h1>Title</h1><p>Hello <strong>world</strong>.</p></article>
    <footer>skip</footer>
  </body></html>`;
  const md = htmlToMarkdown(html);
  assert(md.includes("# Title"), md);
  assert(md.includes("Hello **world**."), md);
  assert(!md.includes("main content"), md);
  assert(!md.includes("skip"), md);
});

Deno.test("htmlToMarkdown: falls back to <main> when no <article>", () => {
  const html = `<html><body>
    <nav>skip</nav>
    <main><h2>Main</h2><p>body text</p></main>
  </body></html>`;
  const md = htmlToMarkdown(html);
  assert(md.includes("## Main"), md);
  assert(md.includes("body text"), md);
  assert(!md.includes("skip"), md);
});

Deno.test("htmlToMarkdown: falls back to <body> when no article/main", () => {
  const html = "<html><body><p>only body</p></body></html>";
  const md = htmlToMarkdown(html);
  assert(md.includes("only body"), md);
});

Deno.test("swapExtensionToMd", () => {
  assertEquals(swapExtensionToMd("/tmp/a.html"), "/tmp/a.md");
  assertEquals(swapExtensionToMd("/tmp/a.mdx"), "/tmp/a.md");
  assertEquals(swapExtensionToMd("/tmp/a"), "/tmp/a.md");
  assertEquals(swapExtensionToMd("/tmp/dir.v1/a.html"), "/tmp/dir.v1/a.md");
});

Deno.test("run: converts HTML response to markdown and swaps extension", async () => {
  await withTempDir(async (dir) => {
    const llmsTxt = "- [a](https://example.com/a.md)\n";
    const fetchFn = ((input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      if (url === "https://example.com/llms.txt") {
        return Promise.resolve(
          new Response(llmsTxt, {
            headers: { "content-type": "text/markdown" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          "<!DOCTYPE html><html><body><article><h1>Hi</h1><p>yo</p></article></body></html>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      );
    }) as unknown as typeof fetch;

    const res = await run({
      source: "https://example.com/llms.txt",
      outDir: dir,
      concurrency: 2,
      noClobber: false,
      fetchFn,
      log: () => {},
    });

    assertEquals(res.written, 1);
    const out = await Deno.readTextFile(join(dir, "a.md"));
    assert(out.includes("# Hi"), out);
    assert(out.includes("yo"), out);

    const rewritten = await Deno.readTextFile(join(dir, "llms.txt"));
    assert(rewritten.includes("./a.md"), rewritten);
  });
});

Deno.test("run: downloads and rewrites fragment-hint URLs (e.g. /page#name.md)", async () => {
  await withTempDir(async (dir) => {
    const llmsTxt =
      "- [a](https://example.com/docs/delete#delete.md)\n- [b](https://example.com/docs/get#get.md)\n";
    const fetchFn = ((input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      if (url === "https://example.com/llms.txt") {
        return Promise.resolve(
          new Response(llmsTxt, {
            headers: { "content-type": "text/markdown" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          "<!DOCTYPE html><html><body><article><h1>Page</h1></article></body></html>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      );
    }) as unknown as typeof fetch;

    const res = await run({
      source: "https://example.com/llms.txt",
      outDir: dir,
      concurrency: 2,
      noClobber: false,
      fetchFn,
      log: () => {},
    });

    assertEquals(res.written, 2);
    assertEquals(res.failed, 0);

    const rewritten = await Deno.readTextFile(join(dir, "llms.txt"));
    assert(rewritten.includes("./docs/delete.md"), rewritten);
    assert(rewritten.includes("./docs/get.md"), rewritten);
    assert(!rewritten.includes("https://example.com/docs/"), rewritten);
  });
});
