import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CompanionSprite } from "../companions/CompanionSprite";
import { getCompanionPersona } from "../companions/personas";
import {
  authStatus,
  detectAgents,
  getKnowledgeGraph,
  getLatencyStats,
  getLiveSession,
  getSettings,
  listApiKeyProviders,
  ollamaStatus,
  onLiveSessionEvent,
  onOllamaPullProgress,
  onScreenDayFrame,
  onSettingsChanged,
  previewCompanion,
  screendayListDays,
  screendaySetEnabled,
  screendayStatus,
  setSettings,
} from "../lib/ipc";
import {
  type ApiProvider,
  type AuthStatus,
  DEFAULT_SETTINGS,
  type DetectedAgent,
  formatBrainPillLabel,
  type LatencyStats,
  type LiveSessionState,
  type OllamaStatus,
  type ScreenDayStatusDto,
  type ScreenDaySummaryDto,
  type Settings,
  type SettingsTab,
} from "../types";
import { BrainsAgentsTab } from "./BrainsAgentsTab";
import { CompanionsVoiceTab } from "./CompanionsVoiceTab";
import {
  BrainIcon,
  CloseIcon,
  CompassIcon,
  CompanionIcon,
  DiaryIcon,
  EyeIcon,
  GraphIcon,
  ShieldIcon,
  UserIcon,
} from "./HubIcons";
import { KnowledgeGraphTab } from "./KnowledgeGraphTab";
import { OverviewTab } from "./OverviewTab";
import { PrivacySystemTab } from "./PrivacySystemTab";
import { ScreenDayTab } from "./ScreenDayTab";

export type AdminHubTabId =
  | "overview"
  | "diary"
  | "graph"
  | "companions"
  | "brains"
  | "privacy";

export interface AdminHubProps {
  initialSettings?: Settings;
  initialTab?: SettingsTab;
  tabSyncSeq?: number;
  onSettingsChange?: (settings: Settings) => void;
  onClose?: () => void;
}

export function mapSettingsTabToAdminTab(tab?: SettingsTab): AdminHubTabId {
  switch (tab) {
    case "overview":
      return "overview";
    case "diary":
    case "history":
      return "diary";
    case "graph":
      return "graph";
    case "companions":
    case "voice":
      return "companions";
    case "privacy":
    case "account":
      return "privacy";
    case "brains":
    default:
      return "brains";
  }
}

interface NavItemMeta {
  id: AdminHubTabId;
  label: string;
  subtitle: string;
  icon: React.FC<{ className?: string }>;
}

const NAV_ITEMS: readonly NavItemMeta[] = [
  {
    id: "overview",
    label: "Overview",
    subtitle: "Live Copilot, Screen Day toggle & pipeline latency telemetry",
    icon: CompassIcon,
  },
  {
    id: "diary",
    label: "Screen Day Diary",
    subtitle: "Visual timeline scrub, projects, meetings OCR & nightly digest",
    icon: DiaryIcon,
  },
  {
    id: "graph",
    label: "Knowledge Graph",
    subtitle: "Learned App → Screen → Control → Intent paths & .graph.md",
    icon: GraphIcon,
  },
  {
    id: "companions",
    label: "Companions & Voice",
    subtitle: "Animated sprites (Mochi, Byte, Sora, Flow) & tiny-voca TTS",
    icon: CompanionIcon,
  },
  {
    id: "brains",
    label: "Brains & Agents",
    subtitle: "Subscription CLIs, API providers, Credential vault & Ollama",
    icon: BrainIcon,
  },
  {
    id: "privacy",
    label: "Privacy & System",
    subtitle: "Privacy Shield, accessibility, hotkeys & GuideLens Cloud",
    icon: ShieldIcon,
  },
];

const EMPTY_LIVE_SESSION: LiveSessionState = {
  session_id: null,
  status: "idle",
  goal: "",
  companion_id: DEFAULT_SETTINGS.companion_id,
  current_step: null,
  current_monitor: null,
  turn_count: 0,
  turns: [],
  graph_md_path: null,
  started_at: null,
};

const EMPTY_SCREENDAY_STATUS: ScreenDayStatusDto = {
  enabled: false,
  interval_sec: DEFAULT_SETTINGS.screenday_interval_sec,
  today_key: new Date().toISOString().slice(0, 10),
  today_frames: 0,
  today_bytes: 0,
  last_captured_at: null,
  current_project: null,
  current_meeting: null,
  skipped_private: false,
};

export const AdminHub: React.FC<AdminHubProps> = ({
  initialSettings,
  initialTab = "overview",
  tabSyncSeq = 0,
  onSettingsChange,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<AdminHubTabId>(() =>
    mapSettingsTabToAdminTab(initialTab),
  );
  const [focusAccountSeq, setFocusAccountSeq] = useState(0);
  const [focusHistorySeq, setFocusHistorySeq] = useState(0);

  useEffect(() => {
    setActiveTab(mapSettingsTabToAdminTab(initialTab));
    if (initialTab === "account") {
      setFocusAccountSeq((n) => n + 1);
    } else if (initialTab === "history") {
      setFocusHistorySeq((n) => n + 1);
    }
  }, [initialTab, tabSyncSeq]);

  const [settings, setLocalSettings] = useState<Settings>(
    initialSettings ?? DEFAULT_SETTINGS,
  );
  const [configuredProviders, setConfiguredProviders] = useState<ApiProvider[]>(
    [],
  );
  const [ollamaInfo, setOllamaInfo] = useState<OllamaStatus>({
    running: false,
    models: [],
    install_url: "https://ollama.com/download",
  });
  const [pullProgress, setPullProgress] = useState<{
    model: string;
    pct: number;
  } | null>(null);
  const [detectedAgents, setDetectedAgents] = useState<DetectedAgent[]>([]);
  const [auth, setAuth] = useState<AuthStatus>({
    logged_in: false,
    email: null,
    tier: "free",
    status: "inactive",
    usage: 0,
    limit: 1500,
  });

  const [liveSession, setLiveSession] =
    useState<LiveSessionState>(EMPTY_LIVE_SESSION);
  const [sdStatus, setSdStatus] = useState<ScreenDayStatusDto>(
    EMPTY_SCREENDAY_STATUS,
  );
  const [todaySummary, setTodaySummary] = useState<ScreenDaySummaryDto | null>(
    null,
  );
  const [latencyStats, setLatencyStats] = useState<LatencyStats>({
    recent: [],
    average: null,
    count: 0,
  });
  const [kgStats, setKgStats] = useState({ nodes: 0, sessions: 0 });
  const [peekToast, setPeekToast] = useState<string | null>(null);

  const refreshTelemetry = useCallback(async () => {
    const [sd, days, lat, kg] = await Promise.all([
      screendayStatus().catch(() => EMPTY_SCREENDAY_STATUS),
      screendayListDays(7).catch(() => []),
      getLatencyStats(25).catch(() => ({ recent: [], average: null, count: 0 })),
      getKnowledgeGraph().catch(() => ({
        nodes: [],
        edges: [],
        sessions: [],
        master_md_path: null,
      })),
    ]);
    setSdStatus(sd);
    setTodaySummary(
      days.find((d) => d.day_key === sd.today_key) ?? days[0] ?? null,
    );
    setLatencyStats(lat);
    setKgStats({
      nodes: kg.nodes.length,
      sessions: kg.sessions.length,
    });
  }, []);

  const hasInitialSettingsRef = useRef(Boolean(initialSettings));

  useEffect(() => {
    let mounted = true;
    if (!hasInitialSettingsRef.current) {
      getSettings()
        .then((s) => {
          if (mounted) setLocalSettings(s);
        })
        .catch(() => {});
    }

    listApiKeyProviders()
      .then((list) => {
        if (mounted) setConfiguredProviders(list);
      })
      .catch(() => {});

    ollamaStatus()
      .then((info) => {
        if (mounted) setOllamaInfo(info);
      })
      .catch(() => {});

    detectAgents()
      .then((list) => {
        if (mounted) setDetectedAgents(list);
      })
      .catch(() => {});

    authStatus()
      .then((st) => {
        if (mounted) setAuth(st);
      })
      .catch(() => {});

    getLiveSession()
      .then((st) => {
        if (mounted) setLiveSession(st);
      })
      .catch(() => {});

    void refreshTelemetry();

    const unlistenPullPromise = onOllamaPullProgress((payload) => {
      if (mounted) {
        setPullProgress({ model: payload.model, pct: payload.pct });
      }
    });

    const unlistenLivePromise = onLiveSessionEvent((state) => {
      if (mounted) {
        setLiveSession(state);
        void getLatencyStats(25)
          .then((lat) => {
            if (mounted) setLatencyStats(lat);
          })
          .catch(() => {});
      }
    });

    const unlistenFramePromise = onScreenDayFrame(() => {
      if (mounted) {
        void screendayStatus()
          .then((st) => {
            if (mounted) setSdStatus(st);
          })
          .catch(() => {});
      }
    });

    const unlistenSettingsPromise = onSettingsChanged((updated) => {
      if (mounted && !hasInitialSettingsRef.current) {
        setLocalSettings(updated);
      }
    });

    return () => {
      mounted = false;
      unlistenPullPromise.then((fn) => fn()).catch(() => {});
      unlistenLivePromise.then((fn) => fn()).catch(() => {});
      unlistenFramePromise.then((fn) => fn()).catch(() => {});
      unlistenSettingsPromise.then((fn) => fn()).catch(() => {});
    };
  }, [refreshTelemetry]);

  const updateSettings = async (patch: Partial<Settings>) => {
    const next: Settings = { ...settings, ...patch };
    setLocalSettings(next);
    onSettingsChange?.(next);
    try {
      await setSettings(next);
    } catch {
      // Ignore error in preview/test if mock doesn't handle
    }
  };

  const handleToggleScreenDay = async (enabled: boolean) => {
    try {
      const nextStatus = await screendaySetEnabled(enabled);
      setSdStatus(nextStatus);
    } catch {
      setSdStatus((prev) => ({ ...prev, enabled }));
    }
    setLocalSettings((prev) => ({ ...prev, screenday_enabled: enabled }));
  };

  const handleTestOverlayPeek = async () => {
    const targetId =
      settings.companion_id === "none" ? "pixel_cat" : settings.companion_id;
    const persona = getCompanionPersona(targetId);
    setPeekToast(`Sent peek to ${persona.name} on overlay`);
    window.setTimeout(() => setPeekToast(null), 2200);
    try {
      await previewCompanion(
        targetId,
        "peeking",
        persona.idleWhisper || "Peeking from GuideLens Control Center!",
      );
    } catch {
      // Ignore in browser preview
    }
  };

  const activeNavMeta = useMemo(
    () => NAV_ITEMS.find((item) => item.id === activeTab) ?? NAV_ITEMS[0],
    [activeTab],
  );

  const activePersona = getCompanionPersona(settings.companion_id);
  const avgLatencyMs = latencyStats.average?.total_ms;

  return (
    <div
      aria-label="GuideLens Control Center"
      data-testid="settings-view"
      className="h-screen w-full overflow-hidden bg-[#080A0F] text-zinc-100 flex select-none relative"
    >
      {/* Subtle Atmospheric Radial Glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_rgba(56,189,248,0.09),transparent_48%),radial-gradient(ellipse_at_bottom_right,_rgba(129,140,248,0.08),transparent_52%)]"
      />

      {/* Left Navigation Rail */}
      <aside className="relative z-10 w-60 shrink-0 border-r border-white/[0.08] bg-[#0B0E15]/95 backdrop-blur-xl flex flex-col justify-between p-3.5">
        <div className="space-y-5">
          {/* Brand Lockup */}
          <div className="flex items-center justify-between px-1.5 pt-0.5">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-sky-400 to-indigo-500 flex items-center justify-center shadow-lg shadow-sky-500/20 text-slate-950 font-black text-sm">
                G
              </div>
              <div>
                <div className="text-[13.5px] font-bold tracking-tight text-zinc-100">
                  GuideLens
                </div>
                <div className="text-[10.5px] text-zinc-400">
                  Control Center
                </div>
              </div>
            </div>
            <span className="px-1.5 py-0.5 rounded bg-white/[0.06] border border-white/10 font-mono text-[10px] text-sky-300">
              v2
            </span>
          </div>

          {/* Primary 6 Nav Tabs */}
          <nav
            role="tablist"
            aria-label="Control Center Sections"
            className="space-y-1"
          >
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const selected = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  data-testid={`tab-${item.id}`}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[12.5px] font-medium transition-all ${
                    selected
                      ? "bg-sky-400/15 border border-sky-400/40 text-sky-200 shadow-sm"
                      : "border border-transparent text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]"
                  }`}
                >
                  <Icon
                    className={`w-4 h-4 shrink-0 ${
                      selected ? "text-sky-300" : "text-zinc-500"
                    }`}
                  />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Compact History Shortcut */}
          <div className="pt-2 border-t border-white/[0.06]">
            <button
              type="button"
              data-testid="tab-history"
              onClick={() => {
                setActiveTab("diary");
                setFocusHistorySeq((n) => n + 1);
              }}
              className="w-full flex items-center justify-between px-3 py-1.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.07] text-[11.5px] text-zinc-300 transition-colors"
            >
              <span>Guided Session History</span>
              <span className="font-mono text-[10.5px] text-sky-300">→</span>
            </button>
          </div>
        </div>

        {/* Left Rail Footer: Cloud Account & Pro Badge */}
        <div className="space-y-2 pt-3 border-t border-white/[0.07]">
          <button
            type="button"
            data-testid="tab-account"
            onClick={() => {
              setActiveTab("privacy");
              setFocusAccountSeq((n) => n + 1);
            }}
            className="w-full text-left rounded-xl bg-[#11141D] hover:bg-[#161B26] border border-white/[0.08] p-2.5 flex items-center gap-2.5 transition-colors"
          >
            <div className="w-8 h-8 rounded-lg bg-sky-400/15 border border-sky-400/30 flex items-center justify-center text-sky-300 shrink-0">
              <UserIcon className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-zinc-100 truncate">
                {auth.logged_in && auth.email ? auth.email : "GuideLens Cloud"}
              </div>
              <div className="text-[10.5px] text-zinc-400 flex items-center justify-between">
                <span className="uppercase font-mono text-sky-300">
                  {auth.tier === "free" ? "Free Tier" : auth.tier.replace("_", " ")}
                </span>
                <span>
                  {auth.usage}/{auth.limit}
                </span>
              </div>
            </div>
          </button>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="relative z-10 flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Live Status Top Bar */}
        <header className="h-14 shrink-0 border-b border-white/[0.08] bg-[#0B0E15]/80 backdrop-blur-xl px-5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[14.5px] font-bold text-zinc-100 truncate">
              {activeNavMeta.label}
            </h1>
            <p className="text-[11px] text-zinc-400 truncate">
              {activeNavMeta.subtitle}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Active Companion Badge */}
            <button
              type="button"
              data-testid="topbar-companion-badge"
              onClick={() => setActiveTab("companions")}
              title="Open Companions & Voice Studio"
              className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-[11.5px] text-zinc-200 transition-colors"
            >
              <CompanionSprite
                companionId={
                  settings.companion_id === "none"
                    ? "pixel_cat"
                    : settings.companion_id
                }
                emotion={sdStatus.enabled ? "peeking" : "idle"}
                size={18}
              />
              <span className="font-medium">{activePersona.name}</span>
            </button>

            {/* Active Brain + Latency Pill */}
            <button
              type="button"
              data-testid="topbar-brain-latency-pill"
              onClick={() => setActiveTab("brains")}
              title="Configure Active Brain & Test Speed"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-500/12 hover:bg-indigo-500/20 border border-indigo-400/30 text-[11.5px] text-indigo-200 transition-colors"
            >
              <span className="font-medium">
                {formatBrainPillLabel(settings)}
              </span>
              <span className="font-mono text-[10.5px] text-sky-300 border-l border-white/15 pl-1.5">
                {avgLatencyMs ? `${avgLatencyMs}ms` : "--ms"}
              </span>
            </button>

            {/* Screen Day Live Toggle */}
            <button
              type="button"
              data-testid="topbar-screenday-toggle"
              onClick={() => void handleToggleScreenDay(!sdStatus.enabled)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11.5px] font-medium transition-colors ${
                sdStatus.enabled
                  ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-300"
                  : "bg-white/[0.04] border-white/10 text-zinc-300 hover:bg-white/[0.08]"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  sdStatus.enabled
                    ? "bg-emerald-400 animate-pulse"
                    : "bg-zinc-500"
                }`}
              />
              <span>Screen Day {sdStatus.enabled ? "Live" : "Off"}</span>
            </button>

            {/* Test Overlay Peek Shortcut */}
            <button
              type="button"
              data-testid="topbar-test-peek-btn"
              onClick={() => void handleTestOverlayPeek()}
              className="hidden md:inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-sky-400/12 hover:bg-sky-400/22 border border-sky-400/35 text-[11.5px] text-sky-200 font-medium transition-colors"
            >
              <EyeIcon className="w-3.5 h-3.5" />
              <span>{peekToast ? "Peek Sent!" : "Test Overlay Peek"}</span>
            </button>

            {/* Privacy Shield Pill */}
            <button
              type="button"
              data-testid="topbar-privacy-pill"
              onClick={() => setActiveTab("privacy")}
              title="Privacy Shield & Hotkeys"
              className={`hidden xl:inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px] font-medium ${
                settings.screenday_skip_private
                  ? "bg-amber-500/12 border-amber-400/30 text-amber-200"
                  : "bg-white/[0.04] border-white/10 text-zinc-400"
              }`}
            >
              <ShieldIcon className="w-3 h-3" />
              <span>
                {settings.screenday_skip_private ? "Shield ON" : "Shield OFF"}
              </span>
            </button>

            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close Settings"
                data-testid="close-settings-btn"
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                <CloseIcon className="w-4 h-4" />
              </button>
            )}
          </div>
        </header>

        {/* Scrollable Active Panel */}
        <main className="flex-1 overflow-y-auto p-5 select-text">
          <div className="max-w-5xl mx-auto">
            {activeTab === "overview" && (
              <OverviewTab
                settings={settings}
                liveSession={liveSession}
                screenDayStatus={sdStatus}
                todaySummary={todaySummary}
                latencyStats={latencyStats}
                kgNodeCount={kgStats.nodes}
                sessionGraphCount={kgStats.sessions}
                onLiveSessionChange={setLiveSession}
                onToggleScreenDay={handleToggleScreenDay}
                onRefreshTelemetry={refreshTelemetry}
                onJumpToTab={(target) => setActiveTab(target)}
              />
            )}

            {activeTab === "diary" && (
              <ScreenDayTab
                screenDayStatus={sdStatus}
                onToggleScreenDay={handleToggleScreenDay}
                focusHistorySeq={focusHistorySeq}
              />
            )}

            {activeTab === "graph" && <KnowledgeGraphTab />}

            {activeTab === "companions" && (
              <CompanionsVoiceTab
                settings={settings}
                onUpdateSettings={updateSettings}
              />
            )}

            {activeTab === "brains" && (
              <BrainsAgentsTab
                settings={settings}
                onUpdateSettings={updateSettings}
                configuredProviders={configuredProviders}
                onConfiguredProvidersChange={setConfiguredProviders}
                ollamaInfo={ollamaInfo}
                onOllamaInfoChange={setOllamaInfo}
                pullProgress={pullProgress}
                onPullProgressChange={setPullProgress}
                detectedAgents={detectedAgents}
              />
            )}

            {activeTab === "privacy" && (
              <PrivacySystemTab
                settings={settings}
                onUpdateSettings={updateSettings}
                auth={auth}
                onAuthChange={setAuth}
                onOpenCompanionsVoice={() => setActiveTab("companions")}
                focusAccountSeq={focusAccountSeq}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
};
