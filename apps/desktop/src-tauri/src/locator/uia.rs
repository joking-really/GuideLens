//! Windows UI Automation (UIA) bounded tree collector.

use crate::locator::UiaCandidate;
use crate::types::{MonitorInfo, RectPx};
use std::time::Duration;

/// Rich UIA element emitted by the bounded tree walker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiaControlRecord {
    pub label: String,
    pub control_type: String,
    pub rect: RectPx,
    pub has_semantic_label: bool,
}

#[derive(Debug, Clone)]
pub struct UiaWalkOptions {
    pub budget: Duration,
    pub max_visited: usize,
    pub max_depth: usize,
    pub min_w: i32,
    pub min_h: i32,
    pub skip_root: bool,
    pub interactive_only: bool,
    pub fallback_to_class_or_type: bool,
    pub max_root_area_fraction: Option<f64>,
    pub monitor_bounds: Option<MonitorInfo>,
}

impl Default for UiaWalkOptions {
    fn default() -> Self {
        Self {
            budget: Duration::from_millis(150),
            max_visited: 1500,
            max_depth: 12,
            min_w: 2,
            min_h: 2,
            skip_root: false,
            interactive_only: false,
            fallback_to_class_or_type: false,
            max_root_area_fraction: None,
            monitor_bounds: None,
        }
    }
}

#[cfg(windows)]
pub(crate) struct ComMtaGuard {
    should_uninit: bool,
}

#[cfg(windows)]
impl ComMtaGuard {
    pub(crate) fn enter() -> Self {
        use std::sync::Once;
        use windows::Win32::System::Com::{
            CoIncrementMTAUsage, CoInitializeEx, COINIT_MULTITHREADED,
        };

        static MTA_PIN: Once = Once::new();
        // Keep the process MTA alive across worker-thread CoUninitialize calls so
        // static WinRT FactoryCache activation pointers never become dangling under concurrency.
        MTA_PIN.call_once(|| unsafe {
            let _ = CoIncrementMTAUsage();
        });

        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        Self {
            should_uninit: hr.is_ok(),
        }
    }
}

#[cfg(windows)]
impl Drop for ComMtaGuard {
    fn drop(&mut self) {
        if self.should_uninit {
            unsafe {
                windows::Win32::System::Com::CoUninitialize();
            }
        }
    }
}

#[cfg(windows)]
pub(crate) fn with_uia_session<R, F>(f: F) -> Option<R>
where
    F: FnOnce(
        &windows::Win32::UI::Accessibility::IUIAutomation,
        &windows::Win32::UI::Accessibility::IUIAutomationTreeWalker,
    ) -> R,
{
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

    let _com_guard = ComMtaGuard::enter();
    unsafe {
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let walker = automation.ControlViewWalker().ok()?;
        Some(f(&automation, &walker))
    }
}

#[cfg(windows)]
pub(crate) fn control_type_name(
    id: windows::Win32::UI::Accessibility::UIA_CONTROLTYPE_ID,
) -> &'static str {
    use windows::Win32::UI::Accessibility::*;
    match id {
        x if x == UIA_ButtonControlTypeId => "Button",
        x if x == UIA_CheckBoxControlTypeId => "CheckBox",
        x if x == UIA_ComboBoxControlTypeId => "ComboBox",
        x if x == UIA_CustomControlTypeId => "Custom",
        x if x == UIA_DataGridControlTypeId => "DataGrid",
        x if x == UIA_DataItemControlTypeId => "DataItem",
        x if x == UIA_DocumentControlTypeId => "Document",
        x if x == UIA_EditControlTypeId => "Edit",
        x if x == UIA_GroupControlTypeId => "Group",
        x if x == UIA_HeaderItemControlTypeId => "HeaderItem",
        x if x == UIA_HyperlinkControlTypeId => "Hyperlink",
        x if x == UIA_ImageControlTypeId => "Image",
        x if x == UIA_ListControlTypeId => "List",
        x if x == UIA_ListItemControlTypeId => "ListItem",
        x if x == UIA_MenuControlTypeId => "Menu",
        x if x == UIA_MenuBarControlTypeId => "MenuBar",
        x if x == UIA_MenuItemControlTypeId => "MenuItem",
        x if x == UIA_PaneControlTypeId => "Pane",
        x if x == UIA_ProgressBarControlTypeId => "ProgressBar",
        x if x == UIA_RadioButtonControlTypeId => "RadioButton",
        x if x == UIA_ScrollBarControlTypeId => "ScrollBar",
        x if x == UIA_SliderControlTypeId => "Slider",
        x if x == UIA_SpinnerControlTypeId => "Spinner",
        x if x == UIA_SplitButtonControlTypeId => "SplitButton",
        x if x == UIA_StatusBarControlTypeId => "StatusBar",
        x if x == UIA_TabControlTypeId => "Tab",
        x if x == UIA_TabItemControlTypeId => "TabItem",
        x if x == UIA_TextControlTypeId => "Text",
        x if x == UIA_TitleBarControlTypeId => "TitleBar",
        x if x == UIA_ToolBarControlTypeId => "ToolBar",
        x if x == UIA_ToolTipControlTypeId => "ToolTip",
        x if x == UIA_TreeControlTypeId => "Tree",
        x if x == UIA_TreeItemControlTypeId => "TreeItem",
        x if x == UIA_WindowControlTypeId => "Window",
        _ => "Control",
    }
}

#[cfg(windows)]
fn is_always_interactive(type_name: &str) -> bool {
    matches!(
        type_name,
        "Button"
            | "SplitButton"
            | "CheckBox"
            | "RadioButton"
            | "ComboBox"
            | "Edit"
            | "Hyperlink"
            | "MenuItem"
            | "TabItem"
            | "ListItem"
            | "TreeItem"
            | "Slider"
            | "Spinner"
            | "DataItem"
            | "HeaderItem"
    )
}

#[cfg(windows)]
fn is_pure_container(type_name: &str) -> bool {
    matches!(
        type_name,
        "Window"
            | "Pane"
            | "Group"
            | "ToolBar"
            | "MenuBar"
            | "Menu"
            | "Tab"
            | "List"
            | "Tree"
            | "DataGrid"
            | "TitleBar"
            | "StatusBar"
            | "ScrollBar"
            | "ToolTip"
            | "ProgressBar"
    )
}

#[cfg(windows)]
fn rect_intersects_monitor(rect: RectPx, monitor: &MonitorInfo) -> bool {
    let rx2 = rect.x + rect.w;
    let ry2 = rect.y + rect.h;
    let mx2 = monitor.x + monitor.w as i32;
    let my2 = monitor.y + monitor.h as i32;
    rx2 > monitor.x && rect.x < mx2 && ry2 > monitor.y && rect.y < my2
}

/// Extracts the best available label for a UIA element without discarding icon-only controls.
/// Fallback order: `CurrentName` -> `CurrentHelpText` -> `CurrentAutomationId` ->
/// `CurrentClassName` -> `type_name`.
#[cfg(windows)]
unsafe fn resolve_element_label(
    elem: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    type_name: &str,
    fallback_to_class_or_type: bool,
) -> (String, bool) {
    if let Ok(name_bstr) = elem.CurrentName() {
        let s = name_bstr.to_string().trim().to_string();
        if !s.is_empty() {
            return (s, true);
        }
    }
    if let Ok(help_bstr) = elem.CurrentHelpText() {
        let s = help_bstr.to_string().trim().to_string();
        if !s.is_empty() {
            return (s, true);
        }
    }
    if let Ok(auto_bstr) = elem.CurrentAutomationId() {
        let s = auto_bstr.to_string().trim().to_string();
        if !s.is_empty() {
            return (s, true);
        }
    }
    if fallback_to_class_or_type {
        if let Ok(class_bstr) = elem.CurrentClassName() {
            let s = class_bstr.to_string().trim().to_string();
            if !s.is_empty() {
                return (s, false);
            }
        }
        return (type_name.to_string(), false);
    }
    (String::new(), false)
}

#[cfg(windows)]
pub(crate) unsafe fn walk_hwnd_controls(
    automation: &windows::Win32::UI::Accessibility::IUIAutomation,
    walker: &windows::Win32::UI::Accessibility::IUIAutomationTreeWalker,
    hwnd: isize,
    opts: &UiaWalkOptions,
) -> Vec<UiaControlRecord> {
    use std::collections::VecDeque;
    use std::ffi::c_void;
    use std::time::Instant;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::Accessibility::IUIAutomationElement;

    if hwnd == 0 {
        return Vec::new();
    }

    let Ok(root) = automation.ElementFromHandle(HWND(hwnd as *mut c_void)) else {
        return Vec::new();
    };

    let root_area = root
        .CurrentBoundingRectangle()
        .ok()
        .map(|r| {
            let rw = (r.right - r.left).max(1) as f64;
            let rh = (r.bottom - r.top).max(1) as f64;
            rw * rh
        })
        .filter(|a| *a > 100.0)
        .or_else(|| {
            opts.monitor_bounds
                .as_ref()
                .map(|m| (m.w.max(1) as f64) * (m.h.max(1) as f64))
        })
        .unwrap_or(1920.0 * 1080.0);

    let start = Instant::now();
    let mut records = Vec::new();
    let mut queue: VecDeque<(IUIAutomationElement, usize)> = VecDeque::new();
    queue.push_back((root, 0));

    let mut visited = 0usize;
    while let Some((elem, depth)) = queue.pop_front() {
        if visited >= opts.max_visited || start.elapsed() >= opts.budget {
            break;
        }
        visited += 1;

        let is_offscreen = elem
            .CurrentIsOffscreen()
            .map(|b| b.as_bool())
            .unwrap_or(false);

        if !is_offscreen && !(opts.skip_root && depth == 0) {
            if let (Ok(rect), Ok(ctype)) = (elem.CurrentBoundingRectangle(), elem.CurrentControlType()) {
                let RECT {
                    left,
                    top,
                    right,
                    bottom,
                } = rect;
                let w = right - left;
                let h = bottom - top;
                let rect_px = RectPx {
                    x: left,
                    y: top,
                    w,
                    h,
                };

                let size_ok = w >= opts.min_w && h >= opts.min_h && w < 8000 && h < 8000;
                let monitor_ok = opts
                    .monitor_bounds
                    .as_ref()
                    .is_none_or(|mon| rect_intersects_monitor(rect_px, mon));
                let not_giant = opts
                    .max_root_area_fraction
                    .is_none_or(|frac| (w as f64 * h as f64) <= root_area * frac);

                if size_ok && monitor_ok && not_giant {
                    let type_name = control_type_name(ctype);
                    let include_type = if opts.interactive_only {
                        if is_always_interactive(type_name) {
                            true
                        } else if is_pure_container(type_name) {
                            false
                        } else {
                            match type_name {
                                "Custom" => w <= 380 && h <= 160,
                                "Document" => w <= 680 && h <= 120,
                                "Image" => (14..=160).contains(&w) && (14..=120).contains(&h),
                                "Text" => (12..=340).contains(&w) && (12..=64).contains(&h),
                                _ => w <= 360 && h <= 140,
                            }
                        }
                    } else {
                        true
                    };

                    if include_type {
                        let (label, has_semantic_label) =
                            resolve_element_label(&elem, type_name, opts.fallback_to_class_or_type);

                        // For non-always-interactive fallback types (Custom/Image/Text), avoid
                        // polluting candidates unless they carry a real label or keyboard focus.
                        let allow_record = if opts.interactive_only
                            && !is_always_interactive(type_name)
                            && !has_semantic_label
                        {
                            elem.CurrentIsKeyboardFocusable()
                                .map(|b| b.as_bool())
                                .unwrap_or(false)
                        } else {
                            !label.is_empty()
                        };

                        if allow_record && !label.is_empty() {
                            records.push(UiaControlRecord {
                                label,
                                control_type: type_name.to_string(),
                                rect: rect_px,
                                has_semantic_label,
                            });
                        }
                    }
                }
            }
        }

        if depth < opts.max_depth && start.elapsed() < opts.budget {
            if let Ok(mut child) = walker.GetFirstChildElement(&elem) {
                loop {
                    if start.elapsed() >= opts.budget || queue.len() >= opts.max_visited {
                        break;
                    }
                    let next = walker.GetNextSiblingElement(&child);
                    queue.push_back((child, depth + 1));
                    match next {
                        Ok(n) => child = n,
                        Err(_) => break,
                    }
                }
            }
        }
    }

    records
}

#[cfg(windows)]
pub fn collect_window_controls(hwnd: isize, budget: Duration) -> Vec<UiaCandidate> {
    if hwnd == 0 {
        return Vec::new();
    }
    let opts = UiaWalkOptions {
        budget,
        max_visited: 1500,
        max_depth: 12,
        min_w: 2,
        min_h: 2,
        skip_root: false,
        interactive_only: false,
        fallback_to_class_or_type: false,
        max_root_area_fraction: None,
        monitor_bounds: None,
    };

    with_uia_session(|automation, walker| unsafe {
        walk_hwnd_controls(automation, walker, hwnd, &opts)
            .into_iter()
            .map(|r| UiaCandidate {
                name: r.label,
                control_type: r.control_type,
                rect: r.rect,
            })
            .collect()
    })
    .unwrap_or_default()
}

#[cfg(not(windows))]
pub fn collect_window_controls(_hwnd: isize, _budget: Duration) -> Vec<UiaCandidate> {
    Vec::new()
}
