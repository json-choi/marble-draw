import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ChevronDown, Copy, Crosshair, FastForward, ListOrdered, Maximize, Minimize, Minus, Music, Pause, Play, Plus,
  Repeat, Search, Settings2, Shuffle, Square, Trophy, Volume2, VolumeX, X,
} from "lucide-react";
import { Engine, type Hud, type Phase, type Rule, type RuleMode, type Winner } from "./engine";
import { MAPS, type MapId, type MapLength } from "./map";
import { MAX_BALLS, parseRoster } from "./parse";
import { newSeed, parseSeed, seedText } from "./rng";

const SAMPLE = "김하늘\n이바다\n박구름*2\n최별\n정노을\n강새벽\n윤봄비\n한여름\n서가을\n조겨울";
const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// The engine reports the HUD several times a second. Only the HUD listens, so the setup panel
// does not re-render while the marbles run.
type HudStore = { get: () => Hud | null; set: (h: Hud) => void; sub: (f: () => void) => () => void };
function createHudStore(): HudStore {
  let v: Hud | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set: (h) => { v = h; subs.forEach((f) => f()); },
    sub: (f) => { subs.add(f); return () => { subs.delete(f); }; },
  };
}
const useHud = (store: HudStore) => useSyncExternalStore(store.sub, store.get);

const marble = (color: string) => ({ "--c": color }) as React.CSSProperties;

const fmtTime = (t: number) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const bannerAt = useRef(0);
  const [text, setText] = useState(() => store.get("draw.text") ?? SAMPLE);
  const [mapId, setMapId] = useState<MapId>(() => (store.get("draw.map") as MapId) || "meteor");
  const [length, setLength] = useState<MapLength>(() => (store.get("draw.len") as MapLength) || "normal");
  const [mode, setMode] = useState<RuleMode>("first");
  const [nth, setNth] = useState(1);
  const [count, setCount] = useState(1);
  const [events, setEvents] = useState(true);
  const [slowmo, setSlowmo] = useState(true);
  const [sfx, setSfx] = useState(true);
  const [music, setMusic] = useState(true);
  const [record, setRecord] = useState(false);
  const [seed, setSeed] = useState(() => newSeed());
  const [seedInput, setSeedInput] = useState("");
  const hudStore = useMemo(createHudStore, []);
  const [phase, setPhase] = useState<Phase>("empty");
  const [winners, setWinners] = useState<Winner[]>([]);
  const [banner, setBanner] = useState<Winner | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [showList, setShowList] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [toast, setToast] = useState("");

  const roster = useMemo(() => parseRoster(text), [text]);
  const n = roster.names.length;
  const rule: Rule = useMemo(() => ({ mode, nth: Math.max(1, Math.min(nth, n || 1)), count: Math.max(1, Math.min(count, n || 1)) }), [mode, nth, count, n]);
  const busy = phase === "countdown" || phase === "racing";

  useEffect(() => {
    const e = new Engine(canvasRef.current!, {
      onHud: (h) => { hudStore.set(h); setPhase(h.phase); },
      onWinner: (w) => {
        setWinners((ws) => [...ws, w]);
        // several winners can be decided in the same instant: keep the first one on screen
        const now = performance.now();
        if (now - bannerAt.current > 400) {
          bannerAt.current = now;
          setBanner(w);
        }
      },
      onDone: () => setTimeout(() => setShowResult(true), 1800),
    });
    engineRef.current = e;
    (window as unknown as { __draw: Engine }).__draw = e;
    return () => e.destroy();
  }, []);

  useEffect(() => { store.set("draw.text", text); }, [text]);
  useEffect(() => { store.set("draw.map", mapId); store.set("draw.len", length); }, [mapId, length]);

  // rebuild the preview whenever the setup changes (not mid-race)
  const setupKey = `${text}|${mapId}|${length}|${JSON.stringify(rule)}|${events}|${slowmo}`;
  const lastKey = useRef("");
  useEffect(() => {
    const e = engineRef.current;
    if (!e || busy) return;
    if (lastKey.current === setupKey && e.phase !== "empty") return;
    const id = setTimeout(() => {
      lastKey.current = setupKey;
      e.setup({ roster, mapId, length, seed, rule, events, slowmo });
    }, 200);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupKey]);

  useEffect(() => { engineRef.current?.sound.setSfx(sfx); }, [sfx]);
  useEffect(() => {
    const s = engineRef.current?.sound;
    if (!s) return;
    s.setMusic(music);
    if (music && busy) { s.ensure(); s.startMusic(); }
  }, [music, busy]);

  useEffect(() => {
    if (!banner) return;
    const id = setTimeout(() => setBanner(null), 2600);
    return () => clearTimeout(id);
  }, [banner]);

  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const flashToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 1800);
  };

  const shuffle = () => {
    const s = newSeed();
    setSeed(s);
    engineRef.current?.shuffleTo(s);
  };

  const begin = useCallback((replaySeed?: number) => {
    const e = engineRef.current;
    if (!e || !n) return;
    const s = replaySeed ?? seed;
    if (replaySeed !== undefined) setSeed(s);
    e.setup({ roster, mapId, length, seed: s, rule, events, slowmo });
    lastKey.current = setupKey;
    setWinners([]);
    setShowResult(false);
    setBanner(null);
    if (window.matchMedia("(max-width: 900px)").matches) setPanelOpen(false);
    e.sound.ensure();
    e.sound.setSfx(sfx);
    e.sound.setMusic(music);
    if (record && !e.startRecording()) flashToast("이 브라우저는 녹화를 지원하지 않아요");
    e.start();
  }, [n, seed, roster, mapId, length, rule, events, slowmo, setupKey, sfx, music, record]);

  const stop = () => {
    engineRef.current?.stop();
    setWinners([]);
    setShowResult(false);
    setBanner(null);
  };

  const again = () => {
    const s = newSeed();
    setSeed(s);
    setShowResult(false);
    setTimeout(() => begin(s), 50);
  };

  const applySeed = () => {
    const s = parseSeed(seedInput);
    if (s === null) return flashToast("시드는 16진수 8자리까지예요");
    setSeed(s);
    setSeedInput("");
    engineRef.current?.shuffleTo(s);
  };

  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen?.();
  };

  const copyResult = async () => {
    const lines = winners.map((w) => `${w.place}. ${w.name}  (${w.rank}번째 ${w.arrived ? "도착" : "확정"}, ${fmtTime(w.time)})`);
    const ruleText = mode === "first" ? "먼저 도착" : mode === "last" ? "마지막 도착" : `${rule.nth}번째 도착`;
    const body = `구슬 추첨 결과 · ${MAPS.find((m) => m.id === mapId)!.name} · ${ruleText} · 참가 ${n}개 · 시드 ${seedText(seed)}\n${lines.join("\n")}`;
    try {
      await navigator.clipboard.writeText(body);
      flashToast("결과를 복사했어요");
    } catch {
      flashToast("복사하지 못했어요");
    }
  };

  const ruleLabel = mode === "first" ? `먼저 도착한 ${rule.count}개` : mode === "last" ? `마지막에 도착한 ${rule.count}개` : `${rule.nth}번째부터 ${rule.count}개`;

  return (
    <div className={`app ${panelOpen ? "panel-open" : ""}`}>
      <aside className="panel" aria-label="추첨 설정">
        <header className="brand">
          <svg className="logo" viewBox="0 0 24 24" aria-hidden>
            <circle cx="12" cy="7.5" r="5" /><circle cx="6.5" cy="16.5" r="5" /><circle cx="17.5" cy="16.5" r="5" />
          </svg>
          <div>
            <h1>구슬 레이스 추첨</h1>
            <p>최대 {MAX_BALLS.toLocaleString()}개 구슬이 굴러 내려가 결승선 도착 순서로 당첨을 정해요</p>
          </div>
          <button className="icon-btn only-mobile" onClick={() => setPanelOpen(false)} aria-label="설정 닫기"><X size={18} /></button>
        </header>

        <fieldset disabled={busy}>
          <section className="step">
            <div className="step-head">
              <h2>참가자</h2>
              <span className={`count ${roster.requested > MAX_BALLS ? "over" : ""}`}>{n.toLocaleString()}개</span>
              {text && <button type="button" className="link" onClick={() => setText("")}>비우기</button>}
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              placeholder={"한 줄에 하나씩\n예) 김하늘, 이바다*3, 1~100"}
              rows={7}
              aria-label="참가자"
            />
            <p className="hint">
              <b>1~100</b>은 번호 구슬 100개, <b>이름*3</b>은 같은 이름 3개
              {roster.requested > MAX_BALLS && <span className="warn"> · 앞의 {MAX_BALLS.toLocaleString()}개만 참가해요</span>}
            </p>
          </section>

          <section className="step">
            <h2>당첨</h2>
            <div className="seg-control" role="radiogroup" aria-label="당첨 순서">
              {(["first", "last", "nth"] as RuleMode[]).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
                  {m === "first" ? "먼저 도착" : m === "last" ? "마지막 도착" : "N번째"}
                </button>
              ))}
            </div>
            <div className="rule-line">
              {mode === "nth" && <><Stepper value={rule.nth} set={setNth} max={Math.max(1, n)} label="몇 번째부터" /><span>번째부터</span></>}
              <Stepper value={rule.count} set={setCount} max={Math.max(1, n)} label="당첨 개수" />
              <span>개 당첨</span>
            </div>
          </section>

          <section className="step">
            <h2>코스</h2>
            <div className="maps" role="radiogroup" aria-label="코스">
              {MAPS.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={mapId === m.id} className={`map-card ${mapId === m.id ? "on" : ""}`} style={{ "--h": m.hue } as React.CSSProperties} onClick={() => setMapId(m.id)} title={m.desc}>
                  <MapThumb id={m.id} />
                  <span className="map-name">{m.name}</span>
                </button>
              ))}
            </div>
            <p className="hint">{MAPS.find((m) => m.id === mapId)!.desc}</p>
          </section>

          <details className="more">
            <summary>세부 설정<ChevronDown size={16} /></summary>
            <div className="more-body">
              <div className="field">
                <span>코스 길이</span>
                <div className="seg-control" role="radiogroup" aria-label="코스 길이">
                  {(["short", "normal", "long"] as MapLength[]).map((l) => (
                    <button key={l} type="button" role="radio" aria-checked={length === l} className={length === l ? "on" : ""} onClick={() => setLength(l)}>
                      {l === "short" ? "짧게" : l === "normal" ? "보통" : "길게"}
                    </button>
                  ))}
                </div>
              </div>
              <Toggle on={events} set={setEvents} title="돌발 이벤트" desc="대시·충격파·돌풍이 무작위로 일어나요" />
              <Toggle on={slowmo} set={setSlowmo} title="결승 슬로모션" desc="당첨이 갈리는 순간 느려져요" />
              <Toggle on={record} set={setRecord} title="영상 저장" desc="레이스가 끝나면 webm 파일로 받아요" />
              <div className="field">
                <span>시드 <code>{seedText(seed)}</code></span>
                <div className="row">
                  <input className="seed-input" value={seedInput} onChange={(e) => setSeedInput(e.target.value)} placeholder="다른 시드 입력" aria-label="시드 입력" maxLength={8} />
                  <button type="button" className="chip" onClick={applySeed} disabled={!seedInput}>적용</button>
                </div>
                <p className="hint">같은 참가자·코스·시드면 같은 레이스가 다시 나와요. 결과는 미리 정해지지 않아요.</p>
              </div>
            </div>
          </details>
        </fieldset>

        <div className="actions">
          {busy ? (
            <button className="btn danger" onClick={stop}><Square size={18} /> 멈추고 처음으로</button>
          ) : (
            <>
              <button className="btn ghost" onClick={shuffle} disabled={!n}><Shuffle size={18} /> 섞기</button>
              <button className="btn primary" onClick={() => begin()} disabled={!n}><Play size={18} /> 시작</button>
            </>
          )}
        </div>
      </aside>

      <main className="stage" ref={stageRef}>
        <canvas ref={canvasRef} className="board" />

        <StageHud
          store={hudStore}
          engine={engineRef}
          panelOpen={panelOpen}
          openPanel={() => setPanelOpen(true)}
          n={n}
          winners={winners}
          sfx={sfx}
          setSfx={setSfx}
          music={music}
          setMusic={setMusic}
          onList={() => setShowList(true)}
          onResult={() => setShowResult(true)}
        />
        <button className="icon-btn fs" onClick={toggleFs} aria-label="전체화면">{fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}</button>

        {banner && (
          <div className="banner" key={banner.ball}>
            <div className="banner-rank">{rule.count > 1 ? `${banner.place}번째 당첨` : "당첨"}</div>
            <div className="banner-name"><span className="marble lg" style={marble(banner.color)} />{banner.name}</div>
          </div>
        )}

        {showResult && (
          <div className="modal-back" onClick={() => setShowResult(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="추첨 결과">
              <button className="icon-btn close" onClick={() => setShowResult(false)} aria-label="닫기"><X size={18} /></button>
              {winners[0] && <span className="marble hero" style={marble(winners[0].color)} aria-hidden />}
              <h2>추첨 결과</h2>
              <p className="sub">{ruleLabel} · 참가 {n.toLocaleString()}개 · {MAPS.find((m) => m.id === mapId)!.name} · 시드 {seedText(seed)}</p>
              <ol className="result-list">
                {winners.map((w) => (
                  <li key={w.ball}>
                    <span className="place">{w.place}</span>
                    <span className="marble" style={marble(w.color)} />
                    <span className="nm">{w.name}</span>
                    <span className="meta">{w.arrived ? `${w.rank}번째 도착 · ${fmtTime(w.time)}` : `${w.rank}번째 확정 · ${fmtTime(w.time)}`}</span>
                  </li>
                ))}
              </ol>
              <div className="modal-actions">
                <button className="btn ghost" onClick={copyResult}><Copy size={16} /> 결과 복사</button>
                <button className="btn primary" onClick={again}><Shuffle size={16} /> 새로 추첨</button>
              </div>
              <div className="modal-links">
                <button className="link" onClick={() => { setShowResult(false); setShowList(true); }}><ListOrdered size={14} /> 전체 순위</button>
                <button className="link" onClick={() => { setShowResult(false); setTimeout(() => begin(seed), 50); }}><Repeat size={14} /> 같은 레이스 다시 보기</button>
              </div>
            </div>
          </div>
        )}

        {showList && <FinishList engine={engineRef.current!} store={hudStore} winners={winners} onClose={() => setShowList(false)} />}
        {toast && <div className="toast">{toast}</div>}
      </main>
    </div>
  );
}

type StageHudProps = {
  store: HudStore; engine: React.RefObject<Engine | null>; panelOpen: boolean; openPanel: () => void;
  n: number; winners: Winner[]; sfx: boolean; setSfx: (v: boolean) => void; music: boolean; setMusic: (v: boolean) => void;
  onList: () => void; onResult: () => void;
};

function StageHud({ store, engine, panelOpen, openPanel, n, winners, sfx, setSfx, music, setMusic, onList, onResult }: StageHudProps) {
  const hud = useHud(store);
  const phase = hud?.phase ?? "empty";
  const e = engine.current;
  return (
    <>
      <div className="hud-top">
        {!panelOpen && <button className="icon-btn" onClick={openPanel} aria-label="설정 열기"><Settings2 size={18} /></button>}
        <div className="status">
          {phase === "preview" && <span>준비 완료 · 구슬 {n.toLocaleString()}개</span>}
          {phase === "empty" && <span>참가자를 입력해 주세요</span>}
          {(phase === "racing" || phase === "done") && hud && (
            <>
              <span className="timer">{fmtTime(hud.elapsed)}</span>
              <span className="sep" />
              <span>도착 {hud.finished.toLocaleString()} / {hud.total.toLocaleString()}</span>
            </>
          )}
          {phase === "countdown" && <span>곧 출발해요</span>}
          {hud?.slow && <span className="slow-tag">슬로모션</span>}
        </div>
      </div>

      {phase === "countdown" && hud && hud.countdown > 0 && <div className="countdown" key={hud.countdown}>{hud.countdown}</div>}

      {(phase === "racing" || phase === "done") && hud && (
        <div className="leaders">
          <div className="leaders-head">
            <span>실시간 순위</span>
            <button className="mini-link" onClick={onList}><ListOrdered size={14} /> 전체</button>
          </div>
          <ol>
            {hud.leaders.map((l) => (
              <li key={l.ball} className={l.done ? "done" : ""}>
                <span className="rk">{l.rank}</span>
                <span className="marble" style={marble(l.color)} />
                <span className="nm">{l.name}</span>
                {l.done && <span className="flag">도착</span>}
              </li>
            ))}
          </ol>
          {winners.length > 0 && (
            <div className="won">
              {winners.map((w) => (
                <div key={w.ball} className="won-row"><Trophy size={14} /><span className="marble" style={marble(w.color)} /><span className="nm">{w.name}</span></div>
              ))}
            </div>
          )}
        </div>
      )}

      {(phase === "racing" || phase === "done" || phase === "countdown") && hud && (
        <div className="controls">
          <button className="icon-btn" onClick={() => e?.setPaused(!hud.paused)} aria-label={hud.paused ? "계속" : "일시정지"}>
            {hud.paused ? <Play size={18} /> : <Pause size={18} />}
          </button>
          <button className="icon-btn wide" onClick={() => e?.setSpeed(hud.speed >= 4 ? 1 : hud.speed * 2)} aria-label="배속">
            <FastForward size={16} /> <span className="mono">{hud.speed}x</span>
          </button>
          <button className={`icon-btn ${hud.follow ? "on" : ""}`} onClick={() => e?.setFollow()} aria-label="따라가기" aria-pressed={hud.follow}>
            <Crosshair size={18} />
          </button>
          <button className={`icon-btn ${sfx ? "" : "off"}`} onClick={() => setSfx(!sfx)} aria-label="효과음" aria-pressed={sfx}>
            {sfx ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
          <button className={`icon-btn ${music ? "" : "off"}`} onClick={() => setMusic(!music)} aria-label="배경 음악" aria-pressed={music}><Music size={18} /></button>
          {e?.recording && <span className="rec"><span className="rec-dot" /> 녹화 중</span>}
          {phase === "done" && <button className="icon-btn wide gold" onClick={onResult}><Trophy size={16} /> 결과</button>}
        </div>
      )}
    </>
  );
}

function Stepper({ value, set, max, label }: { value: number; set: (v: number) => void; max: number; label: string }) {
  const clamp = (v: number) => Math.max(1, Math.min(max, Math.floor(v) || 1));
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" onClick={() => set(clamp(value - 1))} disabled={value <= 1} aria-label={`${label} 줄이기`}><Minus size={14} /></button>
      <input type="number" inputMode="numeric" min={1} max={max} value={value} onChange={(e) => set(clamp(+e.target.value))} aria-label={label} />
      <button type="button" onClick={() => set(clamp(value + 1))} disabled={value >= max} aria-label={`${label} 늘리기`}><Plus size={14} /></button>
    </div>
  );
}

function Toggle({ on, set, title, desc }: { on: boolean; set: (v: boolean) => void; title: string; desc?: string }) {
  return (
    <button type="button" className="toggle" role="switch" aria-checked={on} onClick={() => set(!on)}>
      <span className="toggle-text"><span>{title}</span>{desc && <small>{desc}</small>}</span>
      <span className={`switch ${on ? "on" : ""}`}><span /></span>
    </button>
  );
}

// little line drawing of each course for the picker
function MapThumb({ id }: { id: MapId }) {
  const art: Record<MapId, React.ReactNode> = {
    meteor: (
      <>
        {[0, 1, 2, 3].map((r) => [0, 1, 2, 3, 4].map((c) => <circle key={`${r}${c}`} cx={10 + c * 15 + (r % 2) * 7} cy={8 + r * 7} r={1.6} />))}
        <path d="M22 44 l8 -8 M22 36 l8 8 M52 44 l8 -8 M52 36 l8 8" />
        <path d="M6 54 L60 60 M80 64 L26 70" />
      </>
    ),
    windmill: (
      <>
        <path d="M14 12 l12 12 M26 12 l-12 12 M54 12 l12 12 M66 12 l-12 12" />
        <path d="M40 34 l0 26 M28 54 l24 -14 M28 40 l24 14" />
        <circle cx={40} cy={47} r={2.5} />
      </>
    ),
    chaos: (
      <>
        {[[16, 14], [40, 14], [64, 14], [28, 32], [52, 32], [16, 50], [40, 50], [64, 50]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r={5} />)}
        <path d="M8 66 l10 -6 l10 6 M34 66 l10 -6 l10 6 M60 66 l10 -6 l10 6" />
      </>
    ),
  };
  return <svg className="thumb" viewBox="0 0 80 76" aria-hidden>{art[id]}</svg>;
}

// virtualised: 1000 rows stay cheap, and the list never yanks your scroll position
function FinishList({ engine, store, winners, onClose }: { engine: Engine; store: HudStore; winners: Winner[]; onClose: () => void }) {
  const finished = useHud(store)?.finished ?? 0;
  const ROW = 36;
  const [scroll, setScroll] = useState(0);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(400);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const order = engine.finishOrder();
  const winSet = useMemo(() => new Set(winners.map((w) => w.ball)), [winners]);
  const rows = useMemo(() => {
    const all = order.slice(0, finished).map((b, k) => ({ b, k }));
    const t = q.trim();
    return t ? all.filter((r) => engine.nameOf(r.b).includes(t)) : all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, q, order]);
  const first = Math.max(0, Math.floor(scroll / ROW) - 6);
  const last = Math.min(rows.length, Math.ceil((scroll + h) / ROW) + 6);
  return (
    <div className="drawer" role="dialog" aria-label="전체 순위">
      <div className="drawer-head">
        <h2><ListOrdered size={18} /> 전체 순위 <small>{finished.toLocaleString()}개 도착</small></h2>
        <button className="icon-btn" onClick={onClose} aria-label="닫기"><X size={18} /></button>
      </div>
      <label className="search"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름 찾기" /></label>
      <div className="vlist" ref={boxRef} onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
        <div style={{ height: rows.length * ROW, position: "relative" }}>
          {rows.slice(first, last).map((r, j) => (
            <div key={r.k} className={`vrow ${winSet.has(r.b) ? "win" : ""}`} style={{ top: (first + j) * ROW, height: ROW }}>
              <span className="rk">{r.k + 1}</span>
              <span className="marble" style={marble(engine.colorOf(r.b))} />
              <span className="nm">{engine.nameOf(r.b)}</span>
              {winSet.has(r.b) && <Trophy size={14} />}
              <span className="meta">{fmtTime(engine.finishTime(r.k))}</span>
            </div>
          ))}
        </div>
        {!rows.length && <p className="empty">{q ? "찾는 이름이 아직 도착하지 않았어요" : "아직 도착한 구슬이 없어요"}</p>}
      </div>
    </div>
  );
}
