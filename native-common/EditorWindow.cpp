/*
    Hôtes natifs de Nova Studio (NovaARAHost, NovaVSTHost) — fenêtre Win32 de la vue du plugin (sans JUCE).
    (c) Make Music.
*/
#include "EditorWindow.h"

#include <algorithm>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"

using namespace Steinberg;

namespace nova
{
    static const wchar_t* kTopClass = L"NovaPluginEditor";
    static const wchar_t* kContainerClass = L"NovaPluginView";

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

    //==========================================================================
    // Chien de garde des fenêtres possédées par Nova Studio (voir EditorWindow.h).
    namespace watchdog
    {
        struct Entry
        {
            HWND top = nullptr, owner = nullptr;
            double lastOk = 0, okSince = 0, detachedAt = 0;
            bool detached = false;
        };

        static std::mutex lock;
        static std::vector<Entry> entries;
        static std::function<void (HWND, bool, double)> listener;
        static bool started = false;

        static void loop()
        {
            for (;;)
            {
                Sleep (50);
                std::vector<HWND> tops;
                {
                    std::lock_guard<std::mutex> l (lock);
                    for (auto& e : entries) tops.push_back (e.top);
                }
                for (HWND h : tops)
                {
                    DWORD_PTR r = 0;
                    // WM_NULL est traité dès que le fil de l'interface lit ses messages (boucles modales
                    // des plugins comprises : une fenêtre de licence ou un menu ouverts ne comptent pas).
                    const bool ok = SendMessageTimeoutW (h, WM_NULL, 0, 0, SMTO_NORMAL, 50, &r) != 0;
                    const double now = nowMs();
                    std::function<void (HWND, bool, double)> notify;
                    bool change = false, attachedNow = false;
                    HWND newOwner = nullptr;
                    double ms = 0;
                    {
                        std::lock_guard<std::mutex> l (lock);
                        auto it = std::find_if (entries.begin(), entries.end(), [h] (const Entry& e) { return e.top == h; });
                        if (it == entries.end()) continue;
                        auto& e = *it;
                        if (ok)
                        {
                            if (e.okSince <= 0) e.okSince = now;
                            e.lastOk = now;
                            // Rattachée quand l'interface répond de nouveau (300 ms d'affilée).
                            if (e.detached && now - e.okSince >= 300 && IsWindow (e.owner))
                            {
                                e.detached = false;
                                change = attachedNow = true;
                                newOwner = e.owner;
                                ms = now - e.detachedAt;
                            }
                        }
                        else
                        {
                            e.okSince = 0;
                            if (! e.detached && now - e.lastOk >= EditorWindow::hangMs())
                            {
                                e.detached = true;
                                e.detachedAt = now;
                                change = true;
                                ms = now - e.lastOk;
                            }
                        }
                        if (change) notify = listener;
                    }
                    if (! change) continue;
                    // Hors du verrou. Sans propriétaire : files d'entrée séparées, Nova n'attend plus le
                    // plugin (mesuré : n'envoie aucun message au fil figé, passe pendant le blocage).
                    SetWindowLongPtrW (h, GWLP_HWNDPARENT, (LONG_PTR) newOwner);
                    if (notify) notify (h, attachedNow, ms);
                }
            }
        }

        static void add (HWND top, HWND owner)
        {
            std::lock_guard<std::mutex> l (lock);
            for (auto& e : entries)
                if (e.top == top) { e.owner = owner; return; }
            Entry e;
            e.top = top;
            e.owner = owner;
            e.lastOk = e.okSince = nowMs();
            entries.push_back (e);
            if (! started)
            {
                started = true;
                std::thread (loop).detach();
            }
        }

        static void remove (HWND top)
        {
            std::lock_guard<std::mutex> l (lock);
            entries.erase (std::remove_if (entries.begin(), entries.end(), [top] (const Entry& e) { return e.top == top; }),
                           entries.end());
        }
    }

    DWORD EditorWindow::hangMs()
    {
        static const DWORD v = []
        {
            wchar_t buf[32] {};
            if (GetEnvironmentVariableW (L"NOVA_EDITOR_HANG_MS", buf, 31) > 0) return (DWORD) _wtoi (buf);
            return (DWORD) 400;
        }();
        return v;
    }

    void EditorWindow::setWatchdogListener (std::function<void (HWND, bool, double)> fn)
    {
        std::lock_guard<std::mutex> l (watchdog::lock);
        watchdog::listener = std::move (fn);
    }

    HWND EditorWindow::resolveOwner (HWND owner)
    {
        if (owner == nullptr || ! IsWindow (owner)) return nullptr;
        HWND root = GetAncestor (owner, GA_ROOT);
        if (root == nullptr) root = owner;
        // Jamais une fenêtre de ce processus-ci, ni le bureau.
        DWORD pid = 0;
        GetWindowThreadProcessId (root, &pid);
        if (pid == 0 || pid == GetCurrentProcessId() || root == GetDesktopWindow()) return nullptr;
        return root;
    }

    EditorWindow::EditorWindow (IPtr<IPlugView> v, const std::string& title, bool offscreenIn, std::function<void()> onCloseIn,
                                HWND ownerIn)
        : offscreen (offscreenIn), view (std::move (v)), onClose (std::move (onCloseIn))
    {
        ownerWnd = resolveOwner (ownerIn);
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
        // Possédée par Nova : pas de WS_EX_APPWINDOW (aucun bouton dans la barre des tâches). Le
        // propriétaire est posé à l'affichage, une fois la vue du plugin en place (show()).
        DWORD ex = offscreen ? (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) : (ownerWnd != nullptr ? 0 : WS_EX_APPWINDOW);
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
            watchdog::remove (top);
            destroying = true;
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

    void EditorWindow::adoptOwner()
    {
        if (ownerWnd != nullptr && IsWindow (ownerWnd))
        {
            // Possédée par la fenêtre de Nova Studio (autre processus), sous chien de garde.
            if ((HWND) GetWindowLongPtrW (top, GWLP_HWNDPARENT) != ownerWnd)
                SetWindowLongPtrW (top, GWLP_HWNDPARENT, (LONG_PTR) ownerWnd);
            if (hangMs() > 0) watchdog::add (top, ownerWnd);
        }
    }

    void EditorWindow::showAt (int x, int y)
    {
        adoptOwner();
        SetWindowPos (top, HWND_TOP, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
        ShowWindow (top, SW_SHOWNA);
    }

    void EditorWindow::show()
    {
        adoptOwner();
        if (offscreen)
        {
            SetWindowPos (top, nullptr, -20000, -20000, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            ShowWindow (top, SW_SHOWNA);
            return;
        }
        if (IsWindowVisible (top) && ! IsIconic (top))
        {
            // Déjà ouverte : ramenée devant, là où le musicien l'a laissée.
            SetWindowPos (top, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            SetForegroundWindow (top);
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
            case WM_DESTROY:
                // Détruite par Windows (fenêtre de Nova Studio fermée), pas par nous : la vue du plugin
                // est retirée tant que sa fenêtre existe encore, puis la fenêtre est signalée fermée.
                if (! destroying)
                {
                    destroying = true;
                    watchdog::remove (top);
                    if (attached && view != nullptr) view->removed();
                    attached = false;
                    if (onClose) onClose();
                }
                break;
            default:
                break;
        }
        return DefWindowProcW (top, m, w, l);
    }
}
