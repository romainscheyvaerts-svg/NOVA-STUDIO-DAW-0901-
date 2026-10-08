/*
    NovaARAHost — vue du plugin ancrée dans la fenêtre de Nova Studio (panneau du bas).
    (c) Make Music.
*/
#include "DockedEditor.h"

#include <algorithm>
#include <stdexcept>

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"

using namespace Steinberg;

namespace nova
{
    static const wchar_t* kDockClass = L"NovaARAHostDock";
    static const wchar_t* kDockViewClass = L"NovaARAHostDockView";

    class DockedEditor::Frame final : public U::Implements<U::Directly<IPlugFrame>>
    {
    public:
        explicit Frame (DockedEditor* d) : owner (d) {}
        tresult PLUGIN_API resizeView (IPlugView* v, ViewRect* r) override
        {
            return owner != nullptr ? owner->resizeView (v, r) : kResultFalse;
        }
        DockedEditor* owner;
    };

    static LRESULT CALLBACK dockViewProc (HWND h, UINT m, WPARAM w, LPARAM l)
    {
        if (m == WM_ERASEBKGND) return 1;
        return DefWindowProcW (h, m, w, l);
    }

    LRESULT CALLBACK DockedEditor::wndProc (HWND h, UINT m, WPARAM w, LPARAM l)
    {
        if (m == WM_NCCREATE)
        {
            auto* cs = reinterpret_cast<CREATESTRUCTW*> (l);
            SetWindowLongPtrW (h, GWLP_USERDATA, (LONG_PTR) cs->lpCreateParams);
        }
        auto* self = reinterpret_cast<DockedEditor*> (GetWindowLongPtrW (h, GWLP_USERDATA));
        if (self != nullptr)
        {
            switch (m)
            {
                case WM_SIZE:
                    if (! self->inResize) self->layout();
                    return 0;
                case WM_MOUSEACTIVATE:
                    // Clic dans le panneau : le plugin reçoit le focus clavier (raccourcis de Melodyne).
                    return MA_ACTIVATE;
                case WM_DPICHANGED_AFTERPARENT:
                    self->applyScale();
                    self->layout();
                    return 0;
                default:
                    break;
            }
        }
        return DefWindowProcW (h, m, w, l);
    }

    DockedEditor::DockedEditor (IPtr<IPlugView> v, HWND parentIn) : view (std::move (v)), parentWnd (parentIn)
    {
        static bool registered = false;
        if (! registered)
        {
            registered = true;
            WNDCLASSEXW wc { sizeof (wc) };
            wc.lpfnWndProc = &DockedEditor::wndProc;
            wc.hInstance = GetModuleHandleW (nullptr);
            wc.hCursor = LoadCursor (nullptr, IDC_ARROW);
            wc.hbrBackground = CreateSolidBrush (RGB (0x0c, 0x0e, 0x12));
            wc.lpszClassName = kDockClass;
            RegisterClassExW (&wc);
            WNDCLASSEXW cc { sizeof (cc) };
            cc.lpfnWndProc = &dockViewProc;
            cc.hInstance = GetModuleHandleW (nullptr);
            cc.hCursor = LoadCursor (nullptr, IDC_ARROW);
            cc.lpszClassName = kDockViewClass;
            RegisterClassExW (&cc);
        }
        if (view == nullptr) throw std::runtime_error ("Fenêtre du plugin indisponible");
        if (parentWnd == nullptr || ! IsWindow (parentWnd)) throw std::runtime_error ("Fenêtre de Nova Studio introuvable pour ancrer le plugin");
        if (view->isPlatformTypeSupported (kPlatformTypeHWND) != kResultTrue)
            throw std::runtime_error ("Fenêtre du plugin indisponible (HWND non pris en charge)");
        canResize = view->canResize() == kResultTrue;

        // Enfant de la fenêtre de l'appli (autre processus) : suit ses déplacements tout seul.
        top = CreateWindowExW (0, kDockClass, L"NovaARAHostDock", WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                               0, 0, 10, 10, parentWnd, nullptr, GetModuleHandleW (nullptr), this);
        if (top == nullptr)
        {
            // Repli : fenêtre sans bordure possédée par l'appli (reste au-dessus d'elle).
            child = false;
            top = CreateWindowExW (WS_EX_TOOLWINDOW, kDockClass, L"NovaARAHostDock", WS_POPUP | WS_CLIPCHILDREN,
                                   0, 0, 10, 10, GetAncestor (parentWnd, GA_ROOT), nullptr, GetModuleHandleW (nullptr), this);
        }
        if (top == nullptr) throw std::runtime_error ("Création du panneau du plugin impossible");
        container = CreateWindowExW (0, kDockViewClass, L"", WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                                     0, 0, 10, 10, top, nullptr, GetModuleHandleW (nullptr), nullptr);

        frame = owned (new Frame (this));
        view->setFrame (frame.get());
        applyScale();
        ViewRect r {};
        if (view->getSize (&r) == kResultTrue) { vw = r.getWidth(); vh = r.getHeight(); }
        if (view->attached (container, kPlatformTypeHWND) != kResultTrue)
        {
            view->setFrame (nullptr);
            frame->owner = nullptr;
            DestroyWindow (top);
            top = nullptr;
            throw std::runtime_error ("Le plugin refuse d'ouvrir sa fenêtre dans le panneau");
        }
        attached = true;
        applyScale();
        if (view->getSize (&r) == kResultTrue) { vw = r.getWidth(); vh = r.getHeight(); }
        MoveWindow (container, 0, 0, std::max (1, vw), std::max (1, vh), TRUE);
    }

    DockedEditor::~DockedEditor()
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

    void DockedEditor::applyScale()
    {
        if (auto scale = U::cast<IPlugViewContentScaleSupport> (view))
        {
            const UINT dpi = top != nullptr ? GetDpiForWindow (top) : 96;
            scale->setContentScaleFactor ((IPlugViewContentScaleSupport::ScaleFactor) dpi / 96.0f);
        }
    }

    // La vue occupe tout le panneau quand le plugin se laisse redimensionner (Melodyne) ;
    // sinon elle garde sa taille, en haut à gauche du panneau.
    void DockedEditor::layout()
    {
        if (top == nullptr || ! attached || view == nullptr || bw <= 0 || bh <= 0) return;
        if (canResize)
        {
            ViewRect r { 0, 0, bw, bh };
            view->checkSizeConstraint (&r);
            inResize = true;
            vw = r.getWidth(); vh = r.getHeight();
            MoveWindow (container, 0, 0, std::max (1, vw), std::max (1, vh), TRUE);
            view->onSize (&r);
            inResize = false;
        }
        else
        {
            MoveWindow (container, 0, 0, std::max (1, vw), std::max (1, vh), TRUE);
        }
    }

    void DockedEditor::setBounds (int x, int y, int w, int h, bool visible)
    {
        if (top == nullptr) return;
        bx = x; by = y; bw = std::max (1, w); bh = std::max (1, h);
        int sx = x, sy = y;
        if (! child)
        {
            POINT p { x, y };
            ClientToScreen (parentWnd, &p);
            sx = p.x; sy = p.y;
        }
        inResize = true;
        SetWindowPos (top, HWND_TOP, sx, sy, bw, bh, SWP_NOACTIVATE | (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
        inResize = false;
        layout();
        if (visible) RedrawWindow (top, nullptr, nullptr, RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW);
    }

    tresult DockedEditor::resizeView (IPlugView* v, ViewRect* r)
    {
        if (r == nullptr || top == nullptr) return kInvalidArgument;
        vw = r->getWidth(); vh = r->getHeight();
        inResize = true;
        MoveWindow (container, 0, 0, std::max (1, vw), std::max (1, vh), TRUE);
        inResize = false;
        if (v != nullptr) v->onSize (r);
        return kResultTrue;
    }
}
