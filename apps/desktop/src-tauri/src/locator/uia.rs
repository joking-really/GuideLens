//! Windows UI Automation (UIA) bounded tree collector.

use crate::locator::UiaCandidate;
use std::time::Duration;

#[cfg(windows)]
pub fn collect_window_controls(hwnd: isize, budget: Duration) -> Vec<UiaCandidate> {
    use std::collections::VecDeque;
    use std::ffi::c_void;
    use std::time::Instant;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, UIA_ButtonControlTypeId,
        UIA_CheckBoxControlTypeId, UIA_ComboBoxControlTypeId, UIA_CustomControlTypeId,
        UIA_DataItemControlTypeId, UIA_DocumentControlTypeId, UIA_EditControlTypeId,
        UIA_GroupControlTypeId, UIA_HyperlinkControlTypeId, UIA_ImageControlTypeId,
        UIA_ListControlTypeId, UIA_ListItemControlTypeId, UIA_MenuBarControlTypeId,
        UIA_MenuControlTypeId, UIA_MenuItemControlTypeId, UIA_PaneControlTypeId,
        UIA_RadioButtonControlTypeId, UIA_SliderControlTypeId, UIA_SplitButtonControlTypeId,
        UIA_TabControlTypeId, UIA_TabItemControlTypeId, UIA_TextControlTypeId,
        UIA_ToolBarControlTypeId, UIA_TreeControlTypeId, UIA_TreeItemControlTypeId,
        UIA_WindowControlTypeId, UIA_CONTROLTYPE_ID,
    };

    if hwnd == 0 {
        return Vec::new();
    }

    fn control_type_name(id: UIA_CONTROLTYPE_ID) -> &'static str {
        match id {
            x if x == UIA_ButtonControlTypeId => "Button",
            x if x == UIA_CheckBoxControlTypeId => "CheckBox",
            x if x == UIA_ComboBoxControlTypeId => "ComboBox",
            x if x == UIA_CustomControlTypeId => "Custom",
            x if x == UIA_DataItemControlTypeId => "DataItem",
            x if x == UIA_DocumentControlTypeId => "Document",
            x if x == UIA_EditControlTypeId => "Edit",
            x if x == UIA_GroupControlTypeId => "Group",
            x if x == UIA_HyperlinkControlTypeId => "Hyperlink",
            x if x == UIA_ImageControlTypeId => "Image",
            x if x == UIA_ListControlTypeId => "List",
            x if x == UIA_ListItemControlTypeId => "ListItem",
            x if x == UIA_MenuControlTypeId => "Menu",
            x if x == UIA_MenuBarControlTypeId => "MenuBar",
            x if x == UIA_MenuItemControlTypeId => "MenuItem",
            x if x == UIA_PaneControlTypeId => "Pane",
            x if x == UIA_RadioButtonControlTypeId => "RadioButton",
            x if x == UIA_SliderControlTypeId => "Slider",
            x if x == UIA_SplitButtonControlTypeId => "SplitButton",
            x if x == UIA_TabControlTypeId => "Tab",
            x if x == UIA_TabItemControlTypeId => "TabItem",
            x if x == UIA_TextControlTypeId => "Text",
            x if x == UIA_ToolBarControlTypeId => "ToolBar",
            x if x == UIA_TreeControlTypeId => "Tree",
            x if x == UIA_TreeItemControlTypeId => "TreeItem",
            x if x == UIA_WindowControlTypeId => "Window",
            _ => "Control",
        }
    }

    const MAX_VISITED_NODES: usize = 1500;
    const MAX_DEPTH: usize = 12;

    unsafe {
        let com_hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        let should_uninit = com_hr.is_ok();

        let result = (|| -> Vec<UiaCandidate> {
            let Ok(automation): Result<IUIAutomation, _> =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            else {
                return Vec::new();
            };

            let Ok(walker) = automation.ControlViewWalker() else {
                return Vec::new();
            };

            let Ok(root) = automation.ElementFromHandle(HWND(hwnd as *mut c_void)) else {
                return Vec::new();
            };

            let start = Instant::now();
            let mut candidates = Vec::new();
            let mut queue: VecDeque<(IUIAutomationElement, usize)> = VecDeque::new();
            queue.push_back((root, 0));

            let mut visited = 0usize;
            while let Some((elem, depth)) = queue.pop_front() {
                if visited >= MAX_VISITED_NODES || start.elapsed() >= budget {
                    break;
                }
                visited += 1;

                let is_offscreen = elem
                    .CurrentIsOffscreen()
                    .map(|b| b.as_bool())
                    .unwrap_or(false);

                if !is_offscreen {
                    if let (Ok(name_bstr), Ok(rect), Ok(ctype)) = (
                        elem.CurrentName(),
                        elem.CurrentBoundingRectangle(),
                        elem.CurrentControlType(),
                    ) {
                        let name = name_bstr.to_string().trim().to_string();
                        let RECT {
                            left,
                            top,
                            right,
                            bottom,
                        } = rect;
                        let w = right - left;
                        let h = bottom - top;
                        if !name.is_empty() && w > 1 && h > 1 && w < 8000 && h < 8000 {
                            candidates.push(UiaCandidate {
                                name,
                                control_type: control_type_name(ctype).to_string(),
                                rect: crate::types::RectPx {
                                    x: left,
                                    y: top,
                                    w,
                                    h,
                                },
                            });
                        }
                    }
                }

                if depth < MAX_DEPTH && start.elapsed() < budget {
                    if let Ok(mut child) = walker.GetFirstChildElement(&elem) {
                        loop {
                            if start.elapsed() >= budget || queue.len() >= MAX_VISITED_NODES {
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

            candidates
        })();

        if should_uninit {
            CoUninitialize();
        }
        result
    }
}

#[cfg(not(windows))]
pub fn collect_window_controls(_hwnd: isize, _budget: Duration) -> Vec<UiaCandidate> {
    Vec::new()
}
