import React, { useEffect, useState } from "react";
import { FloatingBar } from "./components/FloatingBar";
import { OnboardingView } from "./components/OnboardingView";
import { OverlayCanvas } from "./components/OverlayCanvas";
import { SettingsView } from "./components/SettingsView";
import { closeCurrentWindow, getSettings } from "./lib/ipc";
import { DEFAULT_SETTINGS, type Settings } from "./types";

function resolveRoute(): {
  path: string;
  tab: "brains" | "account" | "privacy" | "history";
} {
  if (typeof window === "undefined") {
    return { path: "/", tab: "brains" };
  }
  const params = new URLSearchParams(window.location.search);
  const queryRoute = params.get("route");
  const hashPath = window.location.hash.replace(/^#/, "");
  const rawPath = queryRoute || hashPath || window.location.pathname || "/";
  const normalized = rawPath.toLowerCase().replace(/\/+$/, "") || "/";

  const rawTab = params.get("tab");
  const tab =
    rawTab === "account" || rawTab === "privacy" || rawTab === "history"
      ? rawTab
      : "brains";

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

export const App: React.FC = () => {
  const { path, tab } = resolveRoute();

  if (path === "/overlay") {
    return <OverlayCanvas />;
  }

  if (path === "/settings") {
    return (
      <SettingsView
        initialTab={tab}
        onClose={() => {
          void closeCurrentWindow();
        }}
      />
    );
  }

  if (path === "/onboarding") {
    return <OnboardingRoute />;
  }

  return <FloatingBar />;
};

export default App;
