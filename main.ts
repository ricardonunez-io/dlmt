import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs/ensure-dir";
import { dirname, join, relative, resolve, toFileUrl } from "@std/path";
import { pooledMap } from "@std/async/pool";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkStringify from "remark-stringify";
import rehypeParse from "rehype-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { select } from "hast-util-select";
import { toMdast } from "hast-util-to-mdast";

export const VERSION = "0.1.5";

const ACCEPT_HEADER = "text/markdown";

function fetchWithAccept(fetchFn: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("accept")) headers.set("accept", ACCEPT_HEADER);
    return fetchFn(input, { ...init, headers });
  }) as typeof fetch;
}

const NON_DOCUMENT_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".bmp",
  ".tiff",
  ".avif",
  ".mp4",
  ".webm",
  ".mov",
  ".avi",
  ".mkv",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".pdf",
  ".exe",
  ".dmg",
  ".pkg",
  ".deb",
  ".rpm",
  ".msi",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".css",
  ".js",
  ".mjs",
  ".wasm",
]);

export interface CollectedLink {
  kind: "link" | "definition";
  node: { url: string };
  href: string;
}

export function createProcessor() {
  return remark().use(remarkGfm).use(remarkMdx);
}

export function parseLlmsTxt(md: string) {
  return createProcessor().parse(md);
}

export function collectLinks(tree: unknown): CollectedLink[] {
  const out: CollectedLink[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: { type: string; children?: unknown[]; url?: string }, inListItem: boolean) => {
    if (inListItem) {
      if (node.type === "link" && typeof node.url === "string") {
        if (!seen.has(node)) {
          seen.add(node);
          out.push({ kind: "link", node: node as { url: string }, href: node.url });
        }
      }
    }
    const nextInListItem = inListItem || node.type === "listItem";
    const children = node.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        walk(child as { type: string; children?: unknown[]; url?: string }, nextInListItem);
      }
    }
  };
  walk(tree as { type: string; children?: unknown[]; url?: string }, false);

  visit(tree as never, (node: { type: string; url?: string }) => {
    if (node.type === "definition" && typeof node.url === "string") {
      if (!seen.has(node)) {
        seen.add(node);
        out.push({
          kind: "definition",
          node: node as { url: string },
          href: node.url,
        });
      }
    }
  });
  return out;
}

function parseHref(href: string): { path: string; fragment: string } {
  let path = href;
  const hashIdx = path.indexOf("#");
  let fragment = "";
  if (hashIdx !== -1) {
    fragment = path.slice(hashIdx + 1);
    path = path.slice(0, hashIdx);
  }
  const queryIdx = path.indexOf("?");
  if (queryIdx !== -1) path = path.slice(0, queryIdx);
  return { path, fragment };
}

function extensionOf(s: string): string | null {
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  const dot = s.lastIndexOf(".");
  if (dot <= slash) return null;
  return s.slice(dot).toLowerCase();
}

export function isLikelyDocument(href: string): boolean {
  if (href.startsWith("#")) return false;
  const { path, fragment } = parseHref(href);
  if (path === "" && fragment === "") return false;
  if (path === "") return false;
  const pathExt = extensionOf(path);
  if (pathExt && NON_DOCUMENT_EXTENSIONS.has(pathExt)) return false;
  const fragExt = fragment ? extensionOf(fragment) : null;
  if (fragExt && NON_DOCUMENT_EXTENSIONS.has(fragExt)) return false;
  return true;
}

export function filterDownloadable(links: CollectedLink[]): CollectedLink[] {
  const seenHref = new Set<string>();
  const out: CollectedLink[] = [];
  for (const l of links) {
    if (!isLikelyDocument(l.href)) continue;
    if (seenHref.has(l.href)) {
      out.push(l);
      continue;
    }
    seenHref.add(l.href);
    out.push(l);
  }
  return out;
}

export function resolveHref(href: string, baseUrl?: string): URL {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
    return new URL(href);
  }
  if (!baseUrl) {
    throw new Error(
      `Cannot resolve relative href "${href}" without a base URL. Pass --base-url.`,
    );
  }
  return new URL(href, baseUrl);
}

export function urlToLocalPath(url: URL, outDir: string): string {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith("/")) pathname = pathname.slice(1);
  if (pathname === "" || pathname.endsWith("/")) {
    pathname = pathname + "index";
  }
  return join(outDir, pathname);
}

export function resolvePathCollisions(items: DownloadPlanItem[]): void {
  const paths = new Set<string>();
  const pathToItems = new Map<string, DownloadPlanItem[]>();
  for (const item of items) {
    paths.add(item.localPath);
    const arr = pathToItems.get(item.localPath) ?? [];
    arr.push(item);
    pathToItems.set(item.localPath, arr);
  }
  const prefixes = new Set<string>();
  for (const p of paths) {
    const parts = p.split(/[\\/]/);
    for (let i = 1; i < parts.length; i++) {
      prefixes.add(parts.slice(0, i).join("/"));
    }
  }
  for (const [p, arr] of pathToItems) {
    const normalized = p.split(/[\\/]/).join("/");
    if (prefixes.has(normalized)) {
      for (const it of arr) it.localPath = join(p, "index");
    }
  }
}

export interface DownloadPlanItem {
  href: string;
  url: URL;
  localPath: string;
  node: { url: string };
  shared?: DownloadPlanItem;
}

export interface DownloadResult {
  item: DownloadPlanItem;
  ok: boolean;
  error?: string;
}

export interface DownloadOptions {
  concurrency: number;
  noClobber: boolean;
  fetchFn?: typeof fetch;
  onResult?: (r: DownloadResult) => void;
}

export function isHtmlResponse(
  contentType: string | null,
  body: string,
): boolean {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("text/html") || ct.includes("application/xhtml")) {
      return true;
    }
    if (ct.includes("text/markdown") || ct.includes("application/json")) {
      return false;
    }
    if (ct.includes("yaml")) return false;
  }
  const head = body.slice(0, 1024).toLowerCase().trimStart();
  return head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    /<html[\s>]/i.test(body.slice(0, 2048));
}

export function htmlToMarkdown(html: string): string {
  const hast = unified().use(rehypeParse, { fragment: false }).parse(html);
  const root = select("article", hast) ??
    select("main", hast) ??
    select("body", hast) ??
    hast;
  const mdast = toMdast(root as never);
  return String(
    unified()
      .use(remarkGfm)
      .use(remarkStringify)
      .stringify(mdast as never),
  );
}

export function swapExtensionToMd(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (dot <= slash) return path + ".md";
  return path.slice(0, dot) + ".md";
}

export async function downloadOne(
  item: DownloadPlanItem,
  opts: DownloadOptions,
): Promise<DownloadResult> {
  const fetchFn = fetchWithAccept(opts.fetchFn ?? fetch);
  try {
    if (opts.noClobber) {
      try {
        await Deno.stat(item.localPath);
        return { item, ok: true };
      } catch (_) {
        // not exists, continue
      }
      const mdPath = swapExtensionToMd(item.localPath);
      if (mdPath !== item.localPath) {
        try {
          await Deno.stat(mdPath);
          item.localPath = mdPath;
          return { item, ok: true };
        } catch (_) {
          // not exists, continue
        }
      }
    }
    const res = await fetchFn(item.url);
    if (!res.ok) {
      return { item, ok: false, error: `HTTP ${res.status}` };
    }
    const contentType = res.headers.get("content-type");
    const text = await res.text();
    let outPath = item.localPath;
    let bodyBytes: Uint8Array;
    if (isHtmlResponse(contentType, text)) {
      const md = htmlToMarkdown(text);
      outPath = swapExtensionToMd(item.localPath);
      item.localPath = outPath;
      bodyBytes = new TextEncoder().encode(md);
    } else {
      const ct = (contentType ?? "").toLowerCase();
      const isMarkdown = ct.includes("text/markdown") ||
        (!ct && /^\s*#/.test(text));
      if (isMarkdown) {
        const ext = extensionOf(item.localPath);
        if (!ext || (ext !== ".md" && ext !== ".mdx")) {
          outPath = swapExtensionToMd(item.localPath);
          item.localPath = outPath;
        }
      }
      bodyBytes = new TextEncoder().encode(text);
    }
    await ensureDir(dirname(outPath));
    await Deno.writeFile(outPath, bodyBytes);
    return { item, ok: true };
  } catch (err) {
    return { item, ok: false, error: (err as Error).message };
  }
}

export async function downloadAll(
  plan: DownloadPlanItem[],
  opts: DownloadOptions,
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];
  const iter = pooledMap(
    opts.concurrency,
    plan,
    (item) => downloadOne(item, opts),
  );
  for await (const r of iter) {
    if (opts.onResult) opts.onResult(r);
    results.push(r);
  }
  return results;
}

export function rewriteNodes(
  plan: DownloadPlanItem[],
  llmsTxtDir: string,
): void {
  for (const item of plan) {
    const rel = relative(llmsTxtDir, item.localPath);
    const normalized = rel.split("\\").join("/");
    const base = normalized.startsWith(".") ? normalized : "./" + normalized;
    const hashIdx = item.href.indexOf("#");
    const frag = hashIdx !== -1 ? item.href.slice(hashIdx) : "";
    const fragExt = frag ? extensionOf(frag.slice(1)) : null;
    const keepFrag = frag && !fragExt;
    item.node.url = keepFrag ? base + frag : base;
  }
}

export function stringifyTree(tree: unknown): string {
  return String(createProcessor().stringify(tree as never));
}

function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

async function loadSource(
  source: string,
  fetchFn: typeof fetch,
): Promise<{ text: string; baseUrl?: string }> {
  if (isUrl(source)) {
    const res = await fetchFn(source);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${source}: HTTP ${res.status}`);
    }
    return { text: await res.text(), baseUrl: source };
  }
  const abs = resolve(source);
  const text = await Deno.readTextFile(abs);
  return { text, baseUrl: toFileUrl(abs).href };
}

const HELP = `dlmt ${VERSION}

Download an llms.txt index and all linked markdown/JSON/YAML resources.

USAGE:
  dlmt <source> [options]

ARGS:
  <source>              Path or URL to an llms.txt file.

OPTIONS:
  -o, --out <dir>       Output directory (default: current working directory).
      --base-url <url>  Base URL for resolving relative links in a local llms.txt.
  -c, --concurrency <n> Max concurrent downloads (default: 10).
      --no-clobber      Skip files that already exist locally.
  -h, --help            Show this help.
  -v, --version         Show version.

EXAMPLES:
  dlmt https://mintlify.com/docs/llms.txt -o ./docs
  dlmt ./llms.txt --base-url https://mintlify.com -o out -c 20
`;

export interface RunOptions {
  source: string;
  outDir: string;
  baseUrl?: string;
  concurrency: number;
  noClobber: boolean;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
}

export async function run(opts: RunOptions): Promise<{
  written: number;
  failed: number;
  skipped: number;
  results: DownloadResult[];
}> {
  const fetchFn = fetchWithAccept(opts.fetchFn ?? fetch);
  const log = opts.log ?? ((m) => console.log(m));

  const { text, baseUrl: detectedBase } = await loadSource(opts.source, fetchFn);
  const baseUrl = opts.baseUrl ?? detectedBase;

  const tree = parseLlmsTxt(text);
  const links = filterDownloadable(collectLinks(tree));

  const plan: DownloadPlanItem[] = [];
  const planByKey = new Map<string, DownloadPlanItem>();
  const allItems: DownloadPlanItem[] = [];
  let skipped = 0;
  for (const link of links) {
    try {
      const url = resolveHref(link.href, baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        skipped++;
        continue;
      }
      const key = url.origin + url.pathname + url.search;
      const existing = planByKey.get(key);
      if (existing) {
        allItems.push({
          href: link.href,
          url: existing.url,
          localPath: existing.localPath,
          node: link.node,
          shared: existing,
        });
      } else {
        const localPath = urlToLocalPath(url, opts.outDir);
        const item: DownloadPlanItem = {
          href: link.href,
          url,
          localPath,
          node: link.node,
        };
        planByKey.set(key, item);
        plan.push(item);
        allItems.push(item);
      }
    } catch (err) {
      log(`skip: ${link.href} (${(err as Error).message})`);
      skipped++;
    }
  }

  await ensureDir(opts.outDir);
  resolvePathCollisions(plan);
  for (const item of allItems) {
    if (item.shared) item.localPath = item.shared.localPath;
  }
  log(`Downloading ${plan.length} files to ${opts.outDir}...`);

  const results = await downloadAll(plan, {
    concurrency: opts.concurrency,
    noClobber: opts.noClobber,
    fetchFn,
    onResult: (r) => {
      if (r.ok) log(`  ok   ${r.item.url}`);
      else log(`  FAIL ${r.item.url} (${r.error})`);
    },
  });

  const okByItem = new Map<DownloadPlanItem, boolean>();
  for (let i = 0; i < plan.length; i++) okByItem.set(plan[i], results[i].ok);

  const successful: DownloadPlanItem[] = [];
  for (const item of allItems) {
    const root = item.shared ?? item;
    if (okByItem.get(root)) {
      item.localPath = root.localPath;
      successful.push(item);
    }
  }
  rewriteNodes(successful, opts.outDir);
  const rewritten = stringifyTree(tree);
  await Deno.writeTextFile(join(opts.outDir, "llms.txt"), rewritten);

  const written = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  log(`Done. ${written} written, ${failed} failed, ${skipped} skipped.`);

  return { written, failed, skipped, results };
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, {
    string: ["out", "base-url", "concurrency"],
    boolean: ["help", "version", "no-clobber"],
    alias: {
      h: "help",
      v: "version",
      o: "out",
      c: "concurrency",
    },
    default: {
      "no-clobber": false,
    },
  });

  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.version) {
    console.log(VERSION);
    return 0;
  }

  const source = args._[0];
  if (typeof source !== "string" || source.length === 0) {
    console.error("error: missing <source> argument\n");
    console.error(HELP);
    return 2;
  }

  const concurrency = args.concurrency ? Number(args.concurrency) : 10;
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    console.error(`error: invalid --concurrency: ${args.concurrency}`);
    return 2;
  }

  try {
    const res = await run({
      source,
      outDir: args.out ? resolve(args.out) : Deno.cwd(),
      baseUrl: args["base-url"],
      concurrency,
      noClobber: args["no-clobber"],
    });
    return res.failed > 0 ? 1 : 0;
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
