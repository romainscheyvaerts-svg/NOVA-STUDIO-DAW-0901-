/*
    Hôtes natifs de Nova Studio (NovaARAHost, NovaVSTHost) — fenêtre Win32 native (CreateWindowEx) qui accueille la vue IPlugView du plugin.
    Hors écran (offscreen) : sans activation ni bouton de barre des tâches, placée à -20000.

    Fenêtre « possédée » (owner = fenêtre de Nova Studio, autre processus) : comme dans un DAW, aucun
    bouton dans la barre des tâches ni dans Alt+Tab, toujours au-dessus de Nova Studio (jamais derrière
    quand on clique dans Nova), réduite et rétablie avec elle, mais pas « toujours au-dessus » des
    autres applications. Sans owner (site + pont dans un navigateur) : fenêtre indépendante, comme avant.

    Risque connu d'une fenêtre possédée par une fenêtre d'un AUTRE processus : Windows attache les files
    d'entrée des deux fils (AttachThreadInput implicite) ; un plugin dont l'interface se fige pourrait
    figer Nova. Chien de garde (un fil par processus) : il sonde le fil de l'interface du plugin toutes
    les 50 ms (WM_NULL, SendMessageTimeout) ; sans réponse depuis hangMs() (400 ms), la fenêtre est détachée de
    Nova (propriétaire retiré, Nova libérée) ; elle est rattachée quand l'interface répond de nouveau.
    Mesuré (qa/vst_fenetre_possedee.py) : un geste de Nova qui touche la fenêtre possédée (remontée,
    activation) attend le plugin figé ; après le détachement, il passe en 1 ms. Un geste fait pendant
    les 400 premières ms reste bloqué jusqu'au retour du plugin : le pont arrête alors l'hôte si Nova
    est elle-même « ne répond pas » (vst_native.NativePlugin.show_editor).
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
        // owner : fenêtre de Nova Studio (n'importe quelle fenêtre de l'appli : sa fenêtre racine est
        // retenue) ; nullptr ou fenêtre invalide : fenêtre indépendante.
        EditorWindow (Steinberg::IPtr<Steinberg::IPlugView> view, const std::string& title, bool offscreen,
                      std::function<void()> onClose, HWND owner = nullptr);
        ~EditorWindow();

        void show();               // visible (centrée, au premier plan) ou hors écran selon le mode
        void showAt (int x, int y);  // tests : affichée à (x, y) sans activation (propriétaire compris)
        void hide();
        bool isVisible() const { return top != nullptr && IsWindowVisible (top) != FALSE; }
        HWND handle() const { return top; }
        HWND ownerWindow() const { return ownerWnd; }
        int clientWidth() const;
        int clientHeight() const;

        const bool offscreen;

        // Chien de garde : délai sans réponse avant de détacher la fenêtre de Nova (ms) ; 400 par
        // défaut, NOVA_EDITOR_HANG_MS pour changer (0 : pas de chien de garde, mesures seulement).
        static DWORD hangMs();
        // Événements du chien de garde (détachée / rattachée), appelés depuis son fil.
        static void setWatchdogListener (std::function<void (HWND, bool attached, double hungMs)> fn);
        // Propriétaire posé à la création d'une fenêtre (racine de owner) ; nullptr si refusé.
        static HWND resolveOwner (HWND owner);

        // IPlugFrame::resizeView
        Steinberg::tresult resizeView (Steinberg::IPlugView* v, Steinberg::ViewRect* r);

    private:
        static LRESULT CALLBACK wndProc (HWND, UINT, WPARAM, LPARAM);
        LRESULT handleMessage (UINT, WPARAM, LPARAM);
        void setClientSize (int w, int h);
        void adoptOwner();
        void applyScale();

        class Frame;
        Steinberg::IPtr<Steinberg::IPlugView> view;
        Steinberg::IPtr<Frame> frame;
        HWND top = nullptr, container = nullptr, ownerWnd = nullptr;
        std::function<void()> onClose;
        bool inResize = false, attached = false, destroying = false;
    };
}
