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

const SettingsWindowHost: React.FC<{
  initialRoute: "/settings" | "/onboarding";
  tab: "brains" | "account" | "privacy" | "history";
}> = ({ initialRoute, tab }) => {
  const [activeRoute, setActiveRoute] = useState<"/settings" | "/onboarding">(
    initialRoute,
  );

  useEffect(() => {
    setActiveRoute(initialRoute);
  }, [initialRoute]);

  useEffect(() => {
    let mounted = true;
    const unlistenPromise = onSettingsRoute((nextRoute) => {
      if (mounted) {
        setActiveRoute(nextRoute);
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
      initialTab={tab}
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
