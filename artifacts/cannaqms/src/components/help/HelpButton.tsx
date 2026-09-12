// Context-aware "?" help button (Session 71, PR 1 + PR 1.5 — static, zero AI).
//
// Lives in the AppLayout top bar next to the NotificationBell. On open it shows
// the help topic for the CURRENT route (resolved via helpTopicForRoute), with a
// "Why?" toggle that reveals the regulatory basis. A search box switches to
// browsing every help topic AND jumping to actual records (PR 1.5 — backed by
// GET /search); selecting either navigates there.
//
// The "Ask a question" box (Layer 2a) is wired to POST /help/ask as of PR 3, but
// the server ships it DARK (HELP_AI_ENABLED off) so every ask returns the
// "turns on at launch" state until launch — no spend, no frontend change needed
// when it's switched on.

import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { HelpCircle, ArrowRight, Search, ChevronLeft, Sparkles, FileText, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { HELP_TOPICS, helpTopicForRoute, type HelpTopic } from "@/lib/help/helpRegistry";

const BASE = import.meta.env.BASE_URL ?? "/";

// Mirror of the server's GET /search result shape (routes/search.ts).
type SearchResult = {
  type: string;
  typeLabel: string;
  id: number;
  label: string;
  sublabel?: string;
  route: string;
};

export function HelpButton() {
  const [location, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [showWhy, setShowWhy] = useState(false);

  const topic = helpTopicForRoute(location);

  // Reset the inner view each time the popover closes so it always reopens on
  // the current page's help rather than a stale search or expanded "Why?".
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setSearching(false);
      setShowWhy(false);
    }
  }

  function goTo(route: string) {
    setLocation(route);
    handleOpenChange(false);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          aria-label="Help"
          data-testid="button-help"
        >
          <HelpCircle className="h-5 w-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-96 p-0 max-h-[85vh] overflow-y-auto"
        data-testid="popover-help"
      >
        {searching ? (
          <HelpSearch onPick={goTo} onBack={() => setSearching(false)} />
        ) : (
          <HelpTopicView
            topic={topic}
            route={location}
            showWhy={showWhy}
            onToggleWhy={() => setShowWhy((v) => !v)}
            onSearch={() => setSearching(true)}
            onPickRelated={goTo}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

// Flatten a help topic into a short grounding string for the AI assist call.
function composeContext(topic?: HelpTopic): string {
  if (!topic) return "";
  const tasks = topic.commonTasks.map((t) => `${t.label}: ${t.how}`).join("; ");
  const related = topic.relatedProcesses.map((r) => r.label).join(", ");
  return [
    topic.whatItIs,
    tasks ? `Common tasks — ${tasks}.` : "",
    related ? `Related pages — ${related}.` : "",
    topic.regulatoryBasis ? `Regulatory basis — ${topic.regulatoryBasis}` : "",
  ].filter(Boolean).join(" ");
}

function HelpTopicView({
  topic,
  route,
  showWhy,
  onToggleWhy,
  onSearch,
  onPickRelated,
}: {
  topic: HelpTopic | undefined;
  route: string;
  showWhy: boolean;
  onToggleWhy: () => void;
  onSearch: () => void;
  onPickRelated: (route: string) => void;
}) {
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <HelpCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-semibold truncate">
            {topic ? topic.title : "Help"}
          </span>
        </div>
        <button
          onClick={onSearch}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Search all help topics"
          data-testid="button-help-search"
        >
          <Search className="h-3.5 w-3.5" />
          Search
        </button>
      </div>

      {/* Body */}
      <div className="max-h-[420px] overflow-y-auto px-4 py-3">
        {topic ? (
          <div className="space-y-4">
            <p className="text-sm leading-snug text-foreground">{topic.whatItIs}</p>

            {topic.commonTasks.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Common tasks
                </h4>
                <ul className="space-y-1.5">
                  {topic.commonTasks.map((t) => (
                    <li key={t.label} className="text-xs leading-snug">
                      <span className="font-medium text-foreground">{t.label}.</span>{" "}
                      <span className="text-muted-foreground">{t.how}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {topic.relatedProcesses.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Related
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {topic.relatedProcesses.map((r) => (
                    <button
                      key={r.route}
                      onClick={() => onPickRelated(r.route)}
                      className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-1 text-xs text-foreground hover:bg-muted transition-colors"
                      data-testid={`link-help-related-${r.route.replace(/\//g, "")}`}
                    >
                      {r.label}
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {topic.regulatoryBasis && (
              <div className="border-t pt-3">
                <button
                  onClick={onToggleWhy}
                  className="text-xs font-medium text-primary hover:underline"
                  data-testid="button-help-why"
                  aria-expanded={showWhy}
                >
                  {showWhy ? "Hide why this matters" : "Why? (regulatory basis)"}
                </button>
                {showWhy && (
                  <p className="mt-2 text-xs leading-snug text-muted-foreground">
                    {topic.regulatoryBasis}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="py-4 text-center">
            <p className="text-sm text-foreground">No page-specific help here yet.</p>
            <button
              onClick={onSearch}
              className="mt-1 text-xs font-medium text-primary hover:underline"
            >
              Search all help topics
            </button>
          </div>
        )}
      </div>

      {/* Ask-a-question (Layer 2a — wired, but dark until HELP_AI_ENABLED) */}
      <AskBox route={topic?.route ?? route} pageTitle={topic?.title} pageContext={composeContext(topic)} />
    </div>
  );
}

// The "Ask a question" box. Posts to /help/ask, which is shipped DARK: until the
// server flips HELP_AI_ENABLED on (and funds the API), every ask comes back
// enabled:false and we show the "turns on at launch" note. When enabled, the
// same box renders the model's answer with no frontend change.
function AskBox({ route, pageTitle, pageContext }: { route: string; pageTitle?: string; pageContext: string }) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  async function ask() {
    const q = question.trim();
    if (!q || loading) return;
    setLoading(true);
    setAnswer(null);
    setOffline(false);
    try {
      const r = await fetch(`${BASE}api/help/ask`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route, question: q, pageTitle, pageContext }),
      });
      const data = (await r.json()) as { enabled?: boolean; failed?: boolean; answer?: string };
      if (r.ok && data.enabled && !data.failed && data.answer) {
        setAnswer(data.answer);
      } else {
        setOffline(true);
      }
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border-t bg-muted/30 px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">Ask a question</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void ask(); } }}
          placeholder="Ask about this page…"
          className="flex-1 rounded-md border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
          data-testid="input-help-ask"
        />
        <Button
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => void ask()}
          disabled={loading || !question.trim()}
          aria-label="Ask"
          data-testid="button-help-ask"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
      {answer && (
        <p
          className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-md border bg-background px-2.5 py-2 text-xs leading-snug text-foreground"
          data-testid="text-help-answer"
        >
          {answer}
        </p>
      )}
      {offline && (
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground" data-testid="text-help-ai-off">
          AI help isn't switched on yet — it'll answer here at launch. For now, use the page guide above or search.
        </p>
      )}
    </div>
  );
}

function HelpSearch({
  onPick,
  onBack,
}: {
  onPick: (route: string) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const q = query.trim();

  // Help topics are filtered client-side (we already have them); records come
  // from the server. cmdk's built-in filtering is disabled (shouldFilter=false)
  // so async record rows aren't dropped by the local filter — each source owns
  // its own matching.
  const filteredTopics =
    q.length === 0
      ? HELP_TOPICS
      : HELP_TOPICS.filter((t) =>
          `${t.title} ${t.whatItIs}`.toLowerCase().includes(q.toLowerCase()),
        );

  // Debounced record search. Aborts the in-flight request when the query
  // changes so a slow response can't overwrite a newer one.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.length < 2) {
      setRecords([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`${BASE}api/search?q=${encodeURIComponent(q)}`, {
          credentials: "include",
          signal: controller.signal,
        });
        if (r.ok) {
          const data = (await r.json()) as { results?: SearchResult[] };
          setRecords(data.results ?? []);
        } else {
          setRecords([]);
        }
      } catch {
        // Aborted or network error — record search just shows nothing; topics
        // still work, so help never hard-fails.
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      controller.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

  const showEmpty = q.length >= 2 && !loading && filteredTopics.length === 0 && records.length === 0;

  return (
    <div>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Back to page help"
          data-testid="button-help-back"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Back
        </button>
      </div>
      <Command shouldFilter={false}>
        <CommandInput
          placeholder="Search help & records…"
          value={query}
          onValueChange={setQuery}
          data-testid="input-help-search"
        />
        <CommandList>
          {showEmpty && <CommandEmpty>No matching help or records.</CommandEmpty>}

          {filteredTopics.length > 0 && (
            <CommandGroup heading="Help topics">
              {filteredTopics.map((t) => (
                <CommandItem
                  key={`topic-${t.route}`}
                  value={`topic-${t.route}`}
                  onSelect={() => onPick(t.route)}
                  data-testid={`item-help-topic-${t.route.replace(/\//g, "")}`}
                >
                  <HelpCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{t.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{t.whatItIs}</p>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {q.length >= 2 && (
            <CommandGroup heading={loading ? "Records — searching…" : "Records"}>
              {records.map((r) => (
                <CommandItem
                  key={`record-${r.type}-${r.id}`}
                  value={`record-${r.type}-${r.id}`}
                  onSelect={() => onPick(r.route)}
                  data-testid={`item-help-record-${r.type}-${r.id}`}
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {r.label}
                      {r.sublabel ? (
                        <span className="font-normal text-muted-foreground"> — {r.sublabel}</span>
                      ) : null}
                    </p>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
                      {r.typeLabel}
                    </p>
                  </div>
                </CommandItem>
              ))}
              {!loading && records.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No matching records.</p>
              )}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </div>
  );
}
