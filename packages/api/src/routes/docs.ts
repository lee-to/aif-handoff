import { Hono } from "hono";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Resolve docs/aif-skills relative to monorepo root (4 levels up from packages/api/src/routes/)
const DOCS_ROOT = resolve(__dirname, "../../../../docs/aif-skills");

type SupportedLang = "ru" | "en";

function resolveDocsDir(lang: SupportedLang): string {
  return join(DOCS_ROOT, lang);
}

export const docsRouter = new Hono();

// GET /docs/aif-skills/index?lang=ru — list of available skill doc slugs
docsRouter.get("/aif-skills/index", async (c) => {
  const lang = (c.req.query("lang") ?? "ru") as SupportedLang;
  const dir = resolveDocsDir(lang);
  try {
    const files = await readdir(dir);
    const slugs = files
      .filter((f) => f.endsWith(".md"))
      .map((f) => basename(f, ".md"))
      .sort();
    return c.json({ lang, slugs });
  } catch {
    return c.json({ lang, slugs: [] });
  }
});

// GET /docs/aif-skills/:slug?lang=ru — content of a single skill doc
docsRouter.get("/aif-skills/:slug", async (c) => {
  const lang = (c.req.query("lang") ?? "ru") as SupportedLang;
  const slug = c.req.param("slug").replace(/[^a-z0-9_-]/gi, "");
  const dir = resolveDocsDir(lang);
  const filePath = join(dir, `${slug}.md`);

  // Security: ensure resolved path stays inside DOCS_ROOT
  if (!filePath.startsWith(DOCS_ROOT)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  try {
    const content = await readFile(filePath, "utf-8");
    return c.json({ lang, slug, content });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});
