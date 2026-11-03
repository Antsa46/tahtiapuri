import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, extname, isAbsolute } from "node:path";
export const PAGE_URL = "tahtiapuri://app/index.html";
export async function localPageResponse(request: Request, root: string): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.protocol !== "tahtiapuri:" || url.hostname !== "app"
    || url.username || url.password || url.port || url.search)
    return new Response(null, { status: 403 });
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { return new Response(null, { status: 400 }); }
  if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some(part => part === ".." || part === "."))
    return new Response(null, { status: 403 });
  if (pathname !== "/index.html" && !/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(pathname))
    return new Response(null, { status: 404 });
  try {
    const base = await realpath(root);
    const file = await realpath(resolve(base, "." + pathname));
    const rel = relative(base, file);
    if (rel.startsWith("..") || isAbsolute(rel)) return new Response(null, { status: 403 });
    const body = await readFile(file);
    const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" }[extname(file)];
    return new Response(new Uint8Array(body), {
      headers: {
        "content-type": type ?? "application/octet-stream",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
        "x-content-type-options": "nosniff",
      },
    });
  } catch { return new Response(null, { status: 404 }); }
}
