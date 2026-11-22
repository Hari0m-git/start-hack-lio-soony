import { AskForedock } from "./AskForedock";
import { useCallback, useEffect, useRef, useState } from "react";
import { accessKey, getOverview, needsCaseAttention, setAccessKey, Unauthorized, type Overview } from "./api";
import { CasePanel } from "./CasePanel";
import { countdown, forecastTime, hoursBetween } from "./format";
import { Activity, Agents, Parts } from "./Pages";
import { Today } from "./Today";
import { Button, Card } from "./ui";

const REFRESH_MS = 20_000;
type Page = "today" | "parts" | "activity" | "agents";
const PAGES: { id: Page; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "parts", label: "Parts" },
  { id: "activity", label: "Activity" },
  { id: "agents", label: "Agents" },
];

function Mic() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v2.5" />
    </svg>
  );
}

function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="h-9 w-9 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="9" className="fill-accent-600" />
        <path d="M8 21l8-4.5 8 4.5-8 4.5z" fill="#fff" opacity=".55" />
        <path d="M8 15.5L16 11l8 4.5-8 4.5z" fill="#fff" opacity=".8" />
        <path d="M8 10l8-4.5L24 10l-8 4.5z" fill="#fff" />
      </svg>
      <div className="leading-tight">
        <div className="font-display text-base font-semibold tracking-tight">Foredock</div>
        <div className="text-[11px] text-muted">Soony · Grand Heist 6 launch</div>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const system = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? system());
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        localStorage.setItem("foredock.theme", next);
        setTheme(next);
        window.dispatchEvent(new Event("foredock-theme"));
      }}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-card text-accent-ink hover:bg-accent-soft"
    >
      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
        {theme === "dark" ? (
          <path d="M12 4v1.5M12 18.5V20M4 12h1.5M18.5 12H20M6.3 6.3l1.1 1.1M16.6 16.6l1.1 1.1M6.3 17.7l1.1-1.1M16.6 7.4l1.1-1.1M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z" />
        ) : (
          <path d="M19.5 14.2A7.5 7.5 0 019.8 4.5a7.5 7.5 0 109.7 9.7z" />
        )}
      </svg>
    </button>
  );
}

function Gate({ onDone, refused }: { onDone: () => void; refused: boolean }) {
  const [key, setKey] = useState("");
  return (
    <div className="dusk flex min-h-screen items-center justify-center p-4">
      <Card className="glass w-full max-w-sm p-6">
        <Wordmark />
        <h1 className="mt-5 font-display text-xl font-semibold tracking-tight">Know before the dock</h1>
        <p className="mt-1 text-sm text-muted">This desk shows Soony's data. Enter your team's access key.</p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setAccessKey(key.trim());
            onDone();
          }}
        >
          <input
            autoFocus
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Access key"
            aria-label="Access key"
            className="w-full min-w-0 rounded-xl border border-line bg-card px-3 py-2.5 text-sm"
          />
          {refused && (
            <p role="alert" className="text-sm text-bad-ink">
              That key was not accepted. Check for a typo or an extra space, and that it is the key for this copy of the desk.
            </p>
          )}
          <Button disabled={!key.trim()}>Open the desk</Button>
        </form>
      </Card>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState<Overview | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState("");
  // The page and the open case live in the address, so either can be shared as a link.
  const [page, setPageState] = useState<Page>(() => {
    const asked = new URLSearchParams(location.search).get("page") as Page | null;
    return PAGES.some((p) => p.id === asked) ? asked! : "today";
  });
  const [open, setOpenState] = useState<string | null>(() => {
    try { return decodeURIComponent(location.hash.slice(1)) || null; }
    catch { return null; }
  });
  const address = (p: Page, key: string | null) => {
    const url = new URL(location.href);
    if (p === "today") url.searchParams.delete("page");
    else url.searchParams.set("page", p);
    url.hash = key ? encodeURIComponent(key) : "";
    history.replaceState(null, "", url);
  };
  const setPage = (p: Page) => {
    setPageState(p);
    address(p, open);
    window.scrollTo(0, 0);
  };
  const setOpen = (key: string | null) => {
    setOpenState(key);
    address(page, key);
  };
  const [ask, setAsk] = useState(false);

  const requestId = useRef(0);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const overview = await getOverview();
      if (id !== requestId.current) return;
      setData(overview);
      setLocked(false);
      setError("");
    } catch (e) {
      if (id !== requestId.current) return;
      if (e instanceof Unauthorized) setLocked(true);
      else setError(e instanceof Error ? e.message : "The desk cannot reach its server.");
    }
  }, []);

  useEffect(() => {
    load();
    const refresh = setInterval(load, REFRESH_MS);
    return () => clearInterval(refresh);
  }, [load]);

  if (locked) return <Gate onDone={load} refused={!!accessKey()} />;
  if (!data)
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted">{error || "Opening the desk…"}</div>;

  const f = data.forecast;
  if (!f.ready)
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center text-sm text-muted">
        <div>
          <div className="text-base font-medium text-ink">Reading Soony's files…</div>
          <p className="mt-1">
            {data.files} files found, {data.documents_read} documents read so far. {f.reason}
          </p>
        </div>
      </div>
    );

  const hoursLeft = hoursBetween(data.now, f.deadline);
  const waiting = data.cases.filter(needsCaseAttention).length;
  const opened = data.cases.find((c) => c.key === open);
  const loop = data.loop.running ? "Agents working" : data.loop.agents_on ? "Agents on" : "Agents off";

  return (
    <div className="min-h-screen">
      <header className="glass sticky top-0 z-10 border-b border-line">
        <div className="mx-auto flex max-w-[1480px] flex-wrap items-center justify-between gap-x-5 gap-y-2 px-4 py-2.5 sm:px-6 xl:px-10">
          <Wordmark />
          <nav aria-label="Pages" className="order-3 flex w-full gap-1 rounded-full border border-line bg-card p-1 lg:order-none lg:w-auto">
            {PAGES.map((p) => (
              <button
                key={p.id}
                onClick={() => setPage(p.id)}
                aria-current={page === p.id ? "page" : undefined}
                className={`flex-1 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors duration-200 lg:flex-none ${page === p.id ? "bg-accent-600 text-white" : "text-muted hover:bg-accent-soft hover:text-ink"}`}
              >
                {p.label}
                {p.id === "today" && waiting > 0 && (
                  <span className={`ml-1.5 rounded-full px-1.5 text-xs font-semibold ${page === p.id ? "bg-white text-accent-700" : "bg-bad-soft text-bad-ink"}`}>
                    {waiting}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-2 text-xs">
            <div className="mr-1 text-right leading-tight">
              <div className="text-[11px] text-muted">Truck deadline: {forecastTime(f.deadline)}</div>
              <div className="font-display text-base font-semibold text-accent-ink">
                {hoursLeft > 0 ? `${countdown(hoursLeft)} left` : "Deadline passed"}
              </div>
            </div>
            <span className="hidden items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 xl:flex">
              <span className={`h-2 w-2 rounded-full ${data.loop.running ? "node-live bg-accent" : data.loop.agents_on ? "bg-good" : "bg-muted"}`} />
              {loop}
            </span>
            <span className="hidden max-w-36 truncate rounded-full border border-line bg-card px-3 py-1.5 font-medium 2xl:inline">
              {data.me.name ?? "Shared access"}
              {data.me.role === "viewer" && " · view only"}
            </span>
            <button
              onClick={() => setAsk(!ask)}
              aria-expanded={ask}
              className="hidden items-center gap-1.5 rounded-full bg-accent-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-accent-700 sm:flex"
            >
              <Mic /> {ask ? "Close" : "Ask Foredock"}
            </button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1480px] px-4 pb-24 pt-6 sm:px-6 xl:px-10">
        {error && <p role="alert" className="mb-4 rounded-xl border border-warn/40 bg-warn-soft p-3 text-sm text-warn-ink">Couldn’t refresh. Showing the last loaded figures. <button onClick={load} className="font-semibold underline">Try again</button></p>}
        {page === "today" && <Today data={data} onOpen={setOpen} />}
        {page === "parts" && <Parts data={data} onOpen={setOpen} />}
        {page === "activity" && <Activity data={data} onOpen={setOpen} />}
        {page === "agents" && <Agents data={data} />}
      </main>

      {ask && (
        <div className="rise fixed inset-x-3 bottom-20 top-16 z-30 rounded-2xl shadow-2xl sm:inset-x-auto sm:bottom-6 sm:right-6 sm:top-[72px] sm:h-[min(680px,calc(100vh-96px))] sm:w-[440px]">
          {accessKey() ? (
            <AskForedock
              key={accessKey()}
              caseKey={open}
              // A case opens in the same corner, so the assistant steps aside for it.
              onOpen={(key) => (setOpen(key), setAsk(false))}
              onClose={() => setAsk(false)}
              verified={data.me.verified}
              availability={data.voice}
            />
          ) : (
            <section className="glass rounded-2xl border border-line p-4 text-sm">
              <div className="font-semibold">Ask Foredock</div>
              <p className="mt-2 text-muted">
                The assistant is unavailable on this copy. Open the signed-in desk to ask questions.
              </p>
            </section>
          )}
        </div>
      )}
      {/* On phones the assistant opens from a floating button; it steps aside while a case is open so it never covers an approve button. */}
      <button
        hidden={!!opened}
        onClick={() => setAsk(!ask)}
        aria-expanded={ask}
        aria-label={ask ? "Close Ask Foredock" : "Open Ask Foredock, the question and voice assistant"}
        className="fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-full bg-accent-600 px-5 py-3 text-sm font-semibold text-white shadow-xl hover:bg-accent-700 sm:hidden [&[hidden]]:hidden"
      >
        <Mic /> {ask ? "Close" : "Ask Foredock"}
      </button>
      {opened && (
        <CasePanel
          key={opened.key}
          item={opened}
          findings={data.findings.filter((x) => x.material_id === opened.material_id)}
          canEdit={data.me.role !== "viewer"}
          canSend={data.loop.agents_on && !!data.mail_address}
          canRecordConcession={data.me.verified && data.me.role !== "viewer"}
          hasNamedUser={!!data.me.name}
          onClose={() => setOpen(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
