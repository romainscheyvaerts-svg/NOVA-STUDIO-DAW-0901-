/*
    NovaARAHost — fenêtre Win32 de la vue du plugin (sans JUCE).
    (c) Make Music.
*/
#include "EditorWindow.h"

#include <algorithm>
#include <stdexcept>

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"

using namespace Steinberg;

namespace nova
{
    static const wchar_t* kTopClass = L"NovaARAHostEditor";
    static const wchar_t* kContainerClass = L"NovaARAHostView";

    class EditorWindow::Frame final : public U::Implements<U::Directly<IPlugFrame>>
    {
    public:
        explicit Frame (EditorWindow* w) : owner (w) {}
        tresult PLUGIN_API resizeView (IPlugView* v, ViewRect* r) override
        {
            return owner != nullptr ? owner->resizeView (v, r) : kResultFalse;
        }
        EditorWindow* owner;
    };

    LRESULT CALLBACK EditorWindow::wndProc (HWND h, UINT m, WPARAM w, LPARAM l)
    {
        if (m == WM_NCCREATE)
        {
            auto* cs = reinterpret_cast<CREATESTRUCTW*> (l);
            SetWindowLongPtrW (h, GWLP_USERDATA, (LONG_PTR) cs->lpCreateParams);
            if (auto* w0 = reinterpret_cast<EditorWindow*> (cs->lpCreateParams)) w0->top = h;
        }
        auto* self = reinterpret_cast<EditorWindow*> (GetWindowLongPtrW (h, GWLP_USERDATA));
        if (self != nullptr && h == self->top) return self->handleMessage (m, w, l);
        return DefWindowProcW (h, m, w, l);
    }

    static LRESULT CALLBACK containerProc (HWND h, UINT m, WPARAM w, LPARAM l)
    {
        if (m == WM_ERASEBKGND) return 1;
        return DefWindowProcW (h, m, w, l);
    }

    EditorWindow::EditorWindow (IPtr<IPlugView> v, const std::string& title, bool offscreenIn, std::function<void()> onCloseIn)
        : offscreen (offscreenIn), view (std::move (v)), onClose (std::move (onCloseIn))
    {
        static bool registered = false;
        if (! registered)
        {
            registered = true;
            WNDCLASSEXW wc { sizeof (wc) };
            wc.style = CS_HREDRAW | CS_VREDRAW;
            wc.lpfnWndProc = &EditorWindow::wndProc;
            wc.hInstance = GetModuleHandleW (nullptr);
            wc.hCursor = LoadCursor (nullptr, IDC_ARROW);
            wc.hbrBackground = CreateSolidBrush (RGB (0x15, 0x16, 0x1c));
            wc.hIcon = LoadIcon (nullptr, IDI_APPLICATION);
            wc.lpszClassName = kTopClass;
            RegisterClassExW (&wc);
            WNDCLASSEXW cc { sizeof (cc) };
            cc.lpfnWndProc = &containerProc;
            cc.hInstance = GetModuleHandleW (nullptr);
            cc.hCursor = LoadCursor (nullptr, IDC_ARROW);
            cc.lpszClassName = kContainerClass;
            RegisterClassExW (&cc);
        }
        if (view == nullptr) throw std::runtime_error ("Fenêtre du plugin indisponible");
        if (view->isPlatformTypeSupported (kPlatformTypeHWND) != kResultTrue)
            throw std::runtime_error ("Fenêtre du plugin indisponible (HWND non pris en charge)");

        const bool resizable = view->canResize() == kResultTrue;
        DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_CLIPCHILDREN;
        if (resizable) style |= WS_THICKFRAME | WS_MAXIMIZEBOX;
        DWORD ex = offscreen ? (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) : WS_EX_APPWINDOW;
        const int x = offscreen ? -20000 : CW_USEDEFAULT, y = offscreen ? -20000 : CW_USEDEFAULT;
        top = CreateWindowExW (ex, kTopClass, widen (title).c_str(), style, x, y, 400, 300,
                               nullptr, nullptr, GetModuleHandleW (nullptr), this);
        if (top == nullptr) throw std::runtime_error ("Création de la fenêtre impossible");
        container = CreateWindowExW (0, kContainerClass, L"", WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                                     0, 0, 400, 300, top, nullptr, GetModuleHandleW (nullptr), nullptr);

        frame = owned (new Frame (this));
        view->setFrame (frame.get());
        applyScale();
        ViewRect r {};
        if (view->getSize (&r) == kResultTrue && r.getWidth() > 0 && r.getHeight() > 0)
            setClientSize (r.getWidth(), r.getHeight());
        if (view->attached (container, kPlatformTypeHWND) != kResultTrue)
        {
            view->setFrame (nullptr);
            frame->owner = nullptr;
            DestroyWindow (top);
            top = nullptr;
            throw std::runtime_error ("Le plugin refuse d'ouvrir sa fenêtre");
        }
        attached = true;
        applyScale();
        if (view->getSize (&r) == kResultTrue && r.getWidth() > 0 && r.getHeight() > 0)
            setClientSize (r.getWidth(), r.getHeight());
    }

    EditorWindow::~EditorWindow()
    {
        if (view != nullptr)
        {
            if (attached) view->removed();
            view->setFrame (nullptr);
        }
        if (frame) frame->owner = nullptr;
        view = nullptr;
        if (top != nullptr)
        {
            SetWindowLongPtrW (top, GWLP_USERDATA, 0);
            DestroyWindow (top);
        }
    }

    void EditorWindow::applyScale()
    {
        if (auto scale = U::cast<IPlugViewContentScaleSupport> (view))
        {
            const UINT dpi = top != nullptr ? GetDpiForWindow (top) : 96;
            scale->setContentScaleFactor ((IPlugViewContentScaleSupport::ScaleFactor) dpi / 96.0f);
        }
    }

    void EditorWindow::setClientSize (int w, int h)
    {
        RECT rc { 0, 0, w, h };
        const DWORD style = (DWORD) GetWindowLongW (top, GWL_STYLE), ex = (DWORD) GetWindowLongW (top, GWL_EXSTYLE);
        AdjustWindowRectExForDpi (&rc, style, FALSE, ex, GetDpiForWindow (top));
        inResize = true;
        SetWindowPos (top, nullptr, 0, 0, rc.right - rc.left, rc.bottom - rc.top,
                      SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
        MoveWindow (container, 0, 0, w, h, TRUE);
        inResize = false;
    }

    int EditorWindow::clientWidth() const { RECT r {}; GetClientRect (top, &r); return r.right - r.left; }
    int EditorWindow::clientHeight() const { RECT r {}; GetClientRect (top, &r); return r.bottom - r.top; }

    tresult EditorWindow::resizeView (IPlugView* v, ViewRect* r)
    {
        if (r == nullptr || top == nullptr) return kInvalidArgument;
        setClientSize (r->getWidth(), r->getHeight());
        if (v != nullptr) v->onSize (r);
        return kResultTrue;
    }

    void EditorWindow::show()
    {
        if (offscreen)
        {
            SetWindowPos (top, nullptr, -20000, -20000, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            ShowWindow (top, SW_SHOWNA);
            return;
        }
        RECT wr {};
        GetWindowRect (top, &wr);
        POINT pt {};
        GetCursorPos (&pt);
        MONITORINFO mi { sizeof (mi) };
        GetMonitorInfoW (MonitorFromPoint (pt, MONITOR_DEFAULTTOPRIMARY), &mi);
        const int w = wr.right - wr.left, h = wr.bottom - wr.top;
        const int x = mi.rcWork.left + std::max (0L, ((mi.rcWork.right - mi.rcWork.left) - w) / 2);
        const int y = mi.rcWork.top + std::max (0L, ((mi.rcWork.bottom - mi.rcWork.top) - h) / 2);
        SetWindowPos (top, HWND_TOP, x, y, 0, 0, SWP_NOSIZE);
        ShowWindow (top, SW_SHOWNORMAL);
        SetForegroundWindow (top);
        BringWindowToTop (top);
    }

    void EditorWindow::hide()
    {
        if (top != nullptr) ShowWindow (top, SW_HIDE);
    }

    LRESULT EditorWindow::handleMessage (UINT m, WPARAM w, LPARAM l)
    {
        switch (m)
        {
            case WM_SIZE:
            {
                const int cw = LOWORD (l), ch = HIWORD (l);
                if (container != nullptr) MoveWindow (container, 0, 0, cw, ch, TRUE);
                if (! inResize && attached && view != nullptr && view->canResize() == kResultTrue && cw > 0 && ch > 0)
                {
                    ViewRect r { 0, 0, cw, ch };
                    view->checkSizeConstraint (&r);
                    view->onSize (&r);
                }
                return 0;
            }
            case WM_DPICHANGED:
            {
                applyScale();
                auto* r = reinterpret_cast<RECT*> (l);
                SetWindowPos (top, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top,
                              SWP_NOZORDER | SWP_NOACTIVATE);
                return 0;
            }
            case WM_MOUSEACTIVATE:
                if (offscreen) return MA_NOACTIVATE;
                break;
            case WM_CLOSE:
                hide();
                if (onClose) onClose();
                return 0;
            default:
                break;
        }
        return DefWindowProcW (top, m, w, l);
    }
}
