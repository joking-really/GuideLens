import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  icon: React.FC<{ className?: string }>;
}

const NAV_ITEMS: readonly NavItemMeta[] = [
  {
    id: "overview",
    label: "Overview",
    icon: CompassIcon,
  },
  {
    id: "diary",
    label: "Daily Diary",
    icon: DiaryIcon,
  },
  {
    id: "graph",
    label: "Knowledge Graph",
    icon: GraphIcon,
  },
  {
    id: "companions",
    label: "Companion & Voice",
    icon: CompanionIcon,
  },
  {
    id: "brains",
    label: "Models & Agents",
    icon: BrainIcon,
  },
  {
    id: "privacy",
    label: "Settings",
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
  const [focusHistorySeq, setFocusHistorySeq] = useState(() =>
    initialTab === "history" ? 1 : 0,
  );

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
      className="h-screen w-full overflow-hidden bg-[#0A0B0D] text-[#F4F4F5] flex select-none"
    >
      {/* Left Navigation Sidebar */}
      <aside className="w-[212px] shrink-0 border-r border-white/[0.07] bg-[#0A0B0D] flex flex-col justify-between px-3 py-4">
        <div className="space-y-6">
          {/* Minimal Brand Lockup */}
          <div className="flex items-center gap-2.5 px-2">
            <div className="w-6 h-6 rounded-md bg-[#17191E] border border-white/[0.08] flex items-center justify-center text-[#F4F4F5] font-semibold text-[11px]">
              G
            </div>
            <span className="text-[13px] font-semibold tracking-tight text-[#F4F4F5]">
              GuideLens
            </span>
          </div>

          {/* Primary 6 Navigation Items */}
          <nav
            role="tablist"
            aria-label="Control Center Sections"
            className="space-y-0.5"
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
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[12.5px] font-medium transition-colors border ${
                    selected
                      ? "bg-[#17191E] border-white/[0.07] text-[#F4F4F5]"
                      : "border-transparent text-[#8E929B] hover:text-[#F4F4F5] hover:bg-white/[0.03]"
                  }`}
                >
                  <Icon
                    className={`w-4 h-4 shrink-0 ${
                      selected ? "text-[#F4F4F5]" : "text-[#5C606A]"
                    }`}
                  />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Left Rail Footer: Signed-in account ONLY if logged_in, else understated v2 */}
        <div className="pt-3 border-t border-white/[0.07]">
          {auth.logged_in ? (
            <button
              type="button"
              data-testid="tab-account"
              onClick={() => {
                setActiveTab("privacy");
                setFocusAccountSeq((n) => n + 1);
              }}
              className="w-full text-left rounded-lg bg-[#111317] hover:bg-[#17191E] border border-white/[0.07] p-2.5 flex items-center gap-2.5 transition-colors"
            >
              <div className="w-7 h-7 rounded-md bg-white/[0.05] border border-white/[0.08] flex items-center justify-center text-[#E4E4E7] shrink-0">
                <UserIcon className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-[#F4F4F5] truncate">
                  {auth.email || "Signed in"}
                </div>
                <div className="text-[10.5px] text-[#8E929B] flex items-center justify-between">
                  <span className="capitalize">
                    {auth.tier === "free" ? "Free" : auth.tier.replace("_", " ")}
                  </span>
                  <span className="font-mono text-[#5C606A]">
                    {auth.usage}/{auth.limit}
                  </span>
                </div>
              </div>
            </button>
          ) : (
            <div className="px-2.5 py-1 text-[11px] font-mono text-[#5C606A]">
              v2
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-[#0A0B0D]">
        {/* Calm 52px Top Header */}
        <header className="h-[52px] shrink-0 border-b border-white/[0.07] bg-[#0A0B0D] px-6 flex items-center justify-between gap-4">
          <h1 className="text-[14px] font-semibold text-[#F4F4F5] tracking-tight truncate">
            {activeNavMeta.label}
          </h1>

          <div className="flex items-center gap-3 shrink-0">
            <div
              data-testid="topbar-status-summary"
              className="hidden sm:flex items-center gap-2 text-[12px] text-[#8E929B]"
            >
              {sdStatus.enabled && (
                <span className="inline-flex items-center gap-1.5 text-[#F4F4F5]">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  <span>Screen Day</span>
                  <span className="text-[#5C606A]">·</span>
                </span>
              )}
              <span>{activePersona.name}</span>
              <span className="text-[#5C606A]">·</span>
              <span>{formatBrainPillLabel(settings)}</span>
              {avgLatencyMs != null && (
                <>
                  <span className="text-[#5C606A]">·</span>
                  <span className="font-mono text-[#8E929B]">
                    {avgLatencyMs}ms
                  </span>
                </>
              )}
            </div>

            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close Settings"
                data-testid="close-settings-btn"
                className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.07] text-[#8E929B] hover:text-[#F4F4F5] transition-colors"
              >
                <CloseIcon className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </header>

        {/* Scrollable Active Panel */}
        <main className="flex-1 overflow-y-auto px-6 py-6 select-text">
          <div className="max-w-4xl mx-auto">
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
