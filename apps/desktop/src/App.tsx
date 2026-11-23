import React, { useEffect, useState } from "react";
import { FloatingBar } from "./components/FloatingBar";
import { OnboardingView } from "./components/OnboardingView";
import { OverlayCanvas } from "./components/OverlayCanvas";
import { SettingsView } from "./components/SettingsView";
import {
  closeCurrentWindow,
  getSettings,
  onSettingsRoute,
} from "./lib/ipc";
import { DEFAULT_SETTINGS, type Settings, type SettingsTab } from "./types";

const VALID_SETTINGS_TABS: readonly SettingsTab[] = [
  "brains",
  "voice",
  "account",
  "privacy",
  "history",
];

function parseSettingsTab(raw: string | null): SettingsTab {
  return raw && (VALID_SETTINGS_TABS as readonly string[]).includes(raw)
    ? (raw as SettingsTab)
    : "brains";
}

function resolveRoute(): {
  path: string;
  tab: SettingsTab;
} {
  if (typeof window === "undefined") {
    return { path: "/", tab: "brains" };
  }
  const params = new URLSearchParams(window.location.search);
  const queryRoute = params.get("route");
  const hashPath = window.location.hash.replace(/^#/, "");
  const rawPath = queryRoute || hashPath || window.location.pathname || "/";
  const normalized = rawPath.toLowerCase().replace(/\/+$/, "") || "/";

  const tab = parseSettingsTab(params.get("tab"));

  return { path: normalized, tab };
}

const OnboardingRoute: React.FC = () => {
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    let mounted = true;
    getSettings()
      .then((s) => {
        if (mounted) setSettingsState(s);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <OnboardingView
      settings={settings}
      onComplete={() => {
        void closeCurrentWindow();
      }}
    />
  );
};

const SettingsWindowHost: React.FC<{
  initialRoute: "/settings" | "/onboarding";
  tab: SettingsTab;
}> = ({ initialRoute, tab }) => {
  const [activeRoute, setActiveRoute] = useState<"/settings" | "/onboarding">(
    initialRoute,
  );
  const [activeTab, setActiveTab] = useState<SettingsTab>(tab);
  const [tabSyncSeq, setTabSyncSeq] = useState(0);

  useEffect(() => {
    setActiveRoute(initialRoute);
  }, [initialRoute]);

  useEffect(() => {
    setActiveTab(tab);
    setTabSyncSeq((n) => n + 1);
  }, [tab]);

  useEffect(() => {
    let mounted = true;
    const unlistenPromise = onSettingsRoute((payload) => {
      if (!mounted) return;
      setActiveRoute(payload.route);
      if (payload.tab) {
        setActiveTab(payload.tab);
        setTabSyncSeq((n) => n + 1);
      }
    });
    return () => {
      mounted = false;
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, []);

  if (activeRoute === "/onboarding") {
    return <OnboardingRoute />;
  }

  return (
    <SettingsView
      initialTab={activeTab}
      tabSyncSeq={tabSyncSeq}
      onClose={() => {
        void closeCurrentWindow();
      }}
    />
  );
};

export const App: React.FC = () => {
  const { path, tab } = resolveRoute();

  if (path === "/overlay") {
    return <OverlayCanvas />;
  }

  if (path === "/settings" || path === "/onboarding") {
    return (
      <SettingsWindowHost
        initialRoute={path === "/onboarding" ? "/onboarding" : "/settings"}
        tab={tab}
      />
    );
  }

  return <FloatingBar />;
};

export default App;
