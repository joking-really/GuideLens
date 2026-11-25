import React from "react";
import { AdminHub } from "../hub/AdminHub";
import type { Settings, SettingsTab } from "../types";

export interface SettingsViewProps {
  initialSettings?: Settings;
  initialTab?: SettingsTab;
  tabSyncSeq?: number;
  onSettingsChange?: (settings: Settings) => void;
  onClose?: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  initialSettings,
  initialTab = "brains",
  tabSyncSeq = 0,
  onSettingsChange,
  onClose,
}) => {
  return (
    <AdminHub
      initialSettings={initialSettings}
      initialTab={initialTab}
      tabSyncSeq={tabSyncSeq}
      onSettingsChange={onSettingsChange}
      onClose={onClose}
    />
  );
};
