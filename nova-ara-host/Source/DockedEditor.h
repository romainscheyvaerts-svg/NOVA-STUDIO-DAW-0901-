/*
    NovaARAHost — vue IPlugView du plugin ANCRÉE dans la fenêtre de Nova Studio (comme le panneau ARA
    en bas de la fenêtre Édition de Pro Tools) : fenêtre enfant (WS_CHILD) de la fenêtre de l'appli
    (autre processus), posée sur un repère de la page (coordonnées physiques, client du parent).
    Si Windows refuse l'enfant d'un autre processus, repli : fenêtre sans bordure POSSÉDÉE par
    l'appli, placée au même endroit à l'écran.
    (c) Make Music.
*/
#pragma once

#include "Common.h"

#include <functional>
#include <string>

#include "pluginterfaces/gui/iplugview.h"

namespace nova
{
    class DockedEditor
    {
    public:
        DockedEditor (Steinberg::IPtr<Steinberg::IPlugView> view, HWND parent);
        ~DockedEditor();

        // Repère dans le client du parent (pixels physiques). visible=false : masquée.
        void setBounds (int x, int y, int w, int h, bool visible);
        HWND handle() const { return top; }
        HWND parent() const { return parentWnd; }
        bool isChild() const { return child; }
        bool isVisible() const { return top != nullptr && IsWindowVisible (top) != FALSE; }
        int viewWidth() const { return vw; }
        int viewHeight() const { return vh; }
        bool resizable() const { return canResize; }

        Steinberg::tresult resizeView (Steinberg::IPlugView* v, Steinberg::ViewRect* r);

    private:
        static LRESULT CALLBACK wndProc (HWND, UINT, WPARAM, LPARAM);
        void layout();
        void applyScale();

        class Frame;
        Steinberg::IPtr<Steinberg::IPlugView> view;
        Steinberg::IPtr<Frame> frame;
        HWND parentWnd = nullptr, top = nullptr, container = nullptr;
        bool child = true, attached = false, canResize = false, inResize = false;
        int bx = 0, by = 0, bw = 0, bh = 0;   // repère
        int vw = 0, vh = 0;                   // taille de la vue du plugin
    };
}
