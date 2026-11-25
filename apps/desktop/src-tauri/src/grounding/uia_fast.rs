//! Fast bounded UI Automation (UIA) + Windows Taskbar grounding collector.

use crate::grounding::GroundingCandidate;
use crate::types::{GroundedElementSource, MonitorInfo};
use std::time::Duration;

const TARGET_UIA_BUDGET: Duration = Duration::from_millis(90);
const TASKBAR_UIA_BUDGET: Duration = Duration::from_millis(40);

#[cfg(windows)]
pub fn collect_fast_uia_and_taskbar(
    target_hwnd: isize,
    monitor: &MonitorInfo,
) -> Vec<GroundingCandidate> {
    use crate::locator::uia::{walk_hwnd_controls, with_uia_session, UiaWalkOptions};
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;

    let taskbar_hwnd = unsafe {
        FindWindowW(w!("Shell_TrayWnd"), None)
            .map(|h| h.0 as isize)
            .unwrap_or(0)
    };
    let secondary_taskbar_hwnd = unsafe {
        FindWindowW(w!("Shell_SecondaryTrayWnd"), None)
            .map(|h| h.0 as isize)
            .unwrap_or(0)
    };

    with_uia_session(|automation, walker| {
        let mut out = Vec::new();
        let mut collect_into = |hwnd: isize,
                                budget: Duration,
                                max_visited: usize,
                                max_depth: usize,
                                source: GroundedElementSource| {
            let opts = UiaWalkOptions {
                budget,
                max_visited,
                max_depth,
                min_w: 8,
                min_h: 8,
                skip_root: true,
                interactive_only: true,
                fallback_to_class_or_type: true,
                max_root_area_fraction: Some(0.85),
                monitor_bounds: Some(monitor.clone()),
            };
            let is_taskbar = source == GroundedElementSource::Taskbar;
            let controls = unsafe { walk_hwnd_controls(automation, walker, hwnd, &opts) };
            for ctrl in controls {
                out.push(GroundingCandidate {
                    label: ctrl.label,
                    control_type: ctrl.control_type,
                    rect_px: ctrl.rect,
                    source,
                    is_taskbar,
                    has_semantic_label: ctrl.has_semantic_label,
                });
            }
        };

        if target_hwnd != 0 {
            let source = if target_hwnd == taskbar_hwnd || target_hwnd == secondary_taskbar_hwnd {
                GroundedElementSource::Taskbar
            } else {
                GroundedElementSource::Uia
            };
            collect_into(target_hwnd, TARGET_UIA_BUDGET, 1800, 14, source);
        }

        for tb_hwnd in [taskbar_hwnd, secondary_taskbar_hwnd] {
            if tb_hwnd == 0 || tb_hwnd == target_hwnd {
                continue;
            }
            collect_into(
                tb_hwnd,
                TASKBAR_UIA_BUDGET,
                450,
                10,
                GroundedElementSource::Taskbar,
            );
        }

        out
    })
    .unwrap_or_default()
}

#[cfg(not(windows))]
pub fn collect_fast_uia_and_taskbar(
    _target_hwnd: isize,
    _monitor: &MonitorInfo,
) -> Vec<GroundingCandidate> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_uia_zero_hwnd_does_not_panic_and_filters_gracefully() {
        let mon = MonitorInfo {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
            scale: 1.0,
        };
        let items = collect_fast_uia_and_taskbar(0, &mon);
        for item in &items {
            assert!(item.rect_px.w >= 8 && item.rect_px.h >= 8);
            assert!(!item.label.is_empty());
        }
    }
}
