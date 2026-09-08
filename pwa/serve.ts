import { join, normalize } from "node:path";

const root = join(import.meta.dir, "out");
const port = Number(process.env.WRANGLR_PWA_PORT ?? 3000);
const hostname = process.env.WRANGLR_PWA_HOST ?? "127.0.0.1";

function candidatePaths(pathname: string): string[] {
  const decoded = decodeURIComponent(pathname);
  const normalized = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const relative = normalized === "/" ? "index.html" : normalized.replace(/^\//, "");
  return [relative, `${relative}.html`, join(relative, "index.html")];
}

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    for (const relative of candidatePaths(url.pathname)) {
      const file = Bun.file(join(root, relative));
      if (await file.exists()) return new Response(file);
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Wranglr PWA available at http://${server.hostname}:${server.port}`);
