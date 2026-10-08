/*
    NovaARAHost — fenêtre Win32 native (CreateWindowEx) qui accueille la vue IPlugView du plugin.
    Hors écran (offscreen) : sans activation ni bouton de barre des tâches, placée à -20000.
    (c) Make Music.
*/
#pragma once

#include "Common.h"

#include <functional>
#include <string>

#include "pluginterfaces/gui/iplugview.h"

namespace nova
{
    class EditorWindow
    {
    public:
        EditorWindow (Steinberg::IPtr<Steinberg::IPlugView> view, const std::string& title, bool offscreen,
                      std::function<void()> onClose);
        ~EditorWindow();

        void show();               // visible (centrée, au premier plan) ou hors écran selon le mode
        void hide();
        bool isVisible() const { return top != nullptr && IsWindowVisible (top) != FALSE; }
        HWND handle() const { return top; }
        int clientWidth() const;
        int clientHeight() const;

        const bool offscreen;

        // IPlugFrame::resizeView
        Steinberg::tresult resizeView (Steinberg::IPlugView* v, Steinberg::ViewRect* r);

    private:
        static LRESULT CALLBACK wndProc (HWND, UINT, WPARAM, LPARAM);
        LRESULT handleMessage (UINT, WPARAM, LPARAM);
        void setClientSize (int w, int h);
        void applyScale();

        class Frame;
        Steinberg::IPtr<Steinberg::IPlugView> view;
        Steinberg::IPtr<Frame> frame;
        HWND top = nullptr, container = nullptr;
        std::function<void()> onClose;
        bool inResize = false, attached = false;
    };
}
