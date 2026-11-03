import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
/** Only the owning main process chooses this root; no renderer path is accepted. */
export function prepareOwnedDataRoot(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.startsWith("\\\\") || path.includes("\0")) throw new Error("Data root unavailable");
  const root = resolve(path);
  if (path.startsWith("//") || root.startsWith("\\\\")) throw new Error("Data root unavailable");
  let existing = root;
  for (;;) {
    try {
      const stat = lstatSync(existing);
      if (!stat.isDirectory() || stat.isSymbolicLink() || relative(existing, realpathSync(existing)) !== "") throw new Error("Data root unavailable");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Data root unavailable");
      const parent = dirname(existing); if (parent === existing) throw new Error("Data root unavailable"); existing = parent;
    }
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root), canonical = realpathSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || relative(root, canonical) !== "") throw new Error("Data root unavailable");
  return canonical;
}
