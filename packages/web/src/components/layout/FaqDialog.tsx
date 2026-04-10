import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface FaqDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Lang = "ru" | "en";

const LANG_LABELS: Record<Lang, string> = {
  ru: "RU",
  en: "EN",
};

// Sidebar section headers (not clickable, just labels)
const SECTION_LABELS: Record<Lang, { aif: string; handoff: string }> = {
  ru: { aif: "Обзор AIF", handoff: "Обзор Handoff" },
  en: { aif: "AIF Skills", handoff: "Handoff Docs" },
};

// Display names for AIF skill slugs (lang-neutral, except README which is lang-aware via SLUG_LABELS_LANG)
const SLUG_LABELS_BASE: Record<string, string> = {
  README: "Overview", // overridden per lang below
  "skill-context": "Skill-Context",
  aif: "/aif",
  "aif-plan": "/aif-plan",
  "aif-implement": "/aif-implement",
  "aif-improve": "/aif-improve",
  "aif-verify": "/aif-verify",
  "aif-fix": "/aif-fix",
  "aif-commit": "/aif-commit",
  "aif-review": "/aif-review",
  "aif-docs": "/aif-docs",
  "aif-evolve": "/aif-evolve",
  "aif-architecture": "/aif-architecture",
  "aif-security-checklist": "/aif-security-checklist",
  "aif-reference": "/aif-reference",
  "aif-roadmap": "/aif-roadmap",
  "aif-rules": "/aif-rules",
  "aif-dockerize": "/aif-dockerize",
  "aif-ci": "/aif-ci",
  "aif-build-automation": "/aif-build-automation",
  "aif-skill-generator": "/aif-skill-generator",
  "aif-best-practices": "/aif-best-practices",
  "aif-loop": "/aif-loop",
};

// Display names for Handoff doc slugs (lang-aware)
const HANDOFF_LABELS: Record<string, Record<Lang, string>> = {
  "handoff-overview": { ru: "Обзор", en: "Overview" },
  "handoff-getting-started": { ru: "Быстрый старт", en: "Getting Started" },
  "handoff-configuration": { ru: "Конфигурация", en: "Configuration" },
  "handoff-architecture": { ru: "Архитектура", en: "Architecture" },
  "handoff-providers": { ru: "Провайдеры", en: "Providers" },
  "handoff-api": { ru: "REST API", en: "REST API" },
  "handoff-mcp-sync": { ru: "MCP Sync", en: "MCP Sync" },
};

// Preferred order within the Handoff section
const HANDOFF_ORDER = [
  "handoff-overview",
  "handoff-getting-started",
  "handoff-configuration",
  "handoff-architecture",
  "handoff-providers",
  "handoff-api",
  "handoff-mcp-sync",
];

const markdownClassName =
  "min-h-[2em] leading-relaxed break-words [&_p]:my-2 [&_h1]:my-3 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:text-sm [&_h3]:font-semibold [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:border [&_code]:border-border [&_code]:bg-secondary/80 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_code]:text-amber-700 dark:[&_code]:text-amber-300/90 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:border [&_pre]:border-border [&_pre]:bg-secondary/45 [&_pre]:p-3 [&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:list-inside [&_ul]:list-inside [&_li]:my-1 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left [&_th]:border [&_th]:border-border [&_th]:bg-secondary/45 [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_hr]:my-3 [&_hr]:border-border";

const SLUG_LABELS_LANG: Partial<Record<string, Record<Lang, string>>> = {
  README: { ru: "Обзор", en: "Overview" },
  "skill-context": { ru: "Skill-Context", en: "Skill-Context" },
};

function slugLabel(slug: string, lang: Lang): string {
  if (slug in HANDOFF_LABELS) return HANDOFF_LABELS[slug][lang];
  if (slug in SLUG_LABELS_LANG) return SLUG_LABELS_LANG[slug]![lang];
  return SLUG_LABELS_BASE[slug] ?? slug;
}

/** Split slug list into AIF and Handoff groups in the correct order. */
function groupSlugs(slugs: string[]): { aif: string[]; handoff: string[] } {
  const handoffSet = new Set(slugs.filter((s) => s.startsWith("handoff-")));
  const handoff = [
    ...HANDOFF_ORDER.filter((s) => handoffSet.has(s)),
    ...[...handoffSet].filter((s) => !HANDOFF_ORDER.includes(s)),
  ];
  const priority = ["README", "skill-context"];
  const rest = slugs.filter((s) => !priority.includes(s) && !handoffSet.has(s));
  const aif = [...priority.filter((p) => slugs.includes(p)), ...rest];
  return { aif, handoff };
}

async function fetchSlugs(lang: Lang): Promise<string[]> {
  const res = await fetch(`/docs/aif-skills/index?lang=${lang}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { slugs: string[] };
  return data.slugs;
}

async function fetchContent(lang: Lang, slug: string): Promise<string> {
  const res = await fetch(`/docs/aif-skills/${slug}?lang=${lang}`);
  if (!res.ok) {
    return lang === "en" ? `_Page not found: ${slug}_` : `_Страница не найдена: ${slug}_`;
  }
  const data = (await res.json()) as { content: string };
  return data.content;
}

export function FaqDialog({ open, onOpenChange }: FaqDialogProps) {
  const [lang, setLang] = useState<Lang>("ru");
  const [slugs, setSlugs] = useState<string[]>([]);
  const [activeSlug, setActiveSlug] = useState<string>("README");
  const [content, setContent] = useState<string>("");
  const [loadingContent, setLoadingContent] = useState(false);

  const { aif: aifSlugs, handoff: handoffSlugs } = groupSlugs(slugs);

  // Load slug list when dialog opens or lang changes
  useEffect(() => {
    if (!open) return;
    fetchSlugs(lang).then((list) => {
      setSlugs(list);
      if (list.length > 0 && !list.includes(activeSlug)) {
        setActiveSlug(list[0]);
      }
    });
    // activeSlug intentionally excluded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lang]);

  // Load content when active slug or lang changes
  useEffect(() => {
    if (!open || !activeSlug) return;
    let cancelled = false;
    fetchContent(lang, activeSlug).then((text) => {
      if (cancelled) return;
      setContent(text);
      setLoadingContent(false);
    });
    const timer = setTimeout(() => {
      if (!cancelled) setLoadingContent(true);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, activeSlug, lang]);

  function NavItem({ slug }: { slug: string }) {
    return (
      <button
        onClick={() => setActiveSlug(slug)}
        className={cn(
          "w-full px-4 py-1.5 text-left font-mono text-2xs transition-colors",
          activeSlug === slug
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        {slugLabel(slug, lang)}
      </button>
    );
  }

  function SectionHeader({ label }: { label: string }) {
    return (
      <div className="px-4 pb-1 pt-3">
        <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-muted-foreground/50">
          {label}
        </span>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-5xl flex-col p-0">
        <DialogClose onClose={() => onOpenChange(false)} />
        <DialogHeader className="border-b border-border px-6 py-4">
          <div className="flex items-center justify-between pr-8">
            <DialogTitle className="font-mono text-sm">AIF HANDOFF</DialogTitle>
            {/* Language switcher */}
            <div className="flex h-7 border border-border">
              {(["ru", "en"] as Lang[]).map((l, i) => (
                <button
                  key={l}
                  onClick={() => setLang(l)}
                  className={cn(
                    "px-3 font-mono text-2xs transition-colors",
                    i > 0 && "border-l border-border",
                    lang === l
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {LANG_LABELS[l]}
                </button>
              ))}
            </div>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* Sidebar */}
          <nav className="w-52 shrink-0 overflow-y-auto border-r border-border py-1">
            {/* AIF section */}
            {aifSlugs.length > 0 && (
              <>
                <SectionHeader label={SECTION_LABELS[lang].aif} />
                {aifSlugs.map((slug) => (
                  <NavItem key={slug} slug={slug} />
                ))}
              </>
            )}

            {/* Handoff section */}
            {handoffSlugs.length > 0 && (
              <>
                <div className="mt-2 border-t border-border" />
                <SectionHeader label={SECTION_LABELS[lang].handoff} />
                {handoffSlugs.map((slug) => (
                  <NavItem key={slug} slug={slug} />
                ))}
              </>
            )}
          </nav>

          {/* Content */}
          <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
            {loadingContent ? (
              <div className="flex h-32 items-center justify-center">
                <span className="font-mono text-xs text-muted-foreground">Loading...</span>
              </div>
            ) : (
              <div className={cn("text-sm", markdownClassName)}>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a({ href, children }) {
                      if (!href) return <span>{children}</span>;
                      // Internal link: ./aif-plan.md → navigate inside dialog
                      if (href.startsWith("./") && href.endsWith(".md")) {
                        const slug = href.slice(2, -3);
                        return (
                          <button
                            onClick={() => setActiveSlug(slug)}
                            className="text-primary underline underline-offset-2 hover:opacity-80"
                          >
                            {children}
                          </button>
                        );
                      }
                      // External link → open in new tab
                      return (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline underline-offset-2 hover:opacity-80"
                        >
                          {children}
                        </a>
                      );
                    },
                  }}
                >
                  {content}
                </ReactMarkdown>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
