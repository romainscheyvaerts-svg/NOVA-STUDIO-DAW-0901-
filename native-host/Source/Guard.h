/*
    NovaVSTHost — garde contre les plantages natifs d'un plugin (violation d'accès…).

    guard::call exécute fn ; une exception matérielle (SEH) levée par le plugin est arrêtée
    là et call renvoie faux (code dans lastCode()). Les exceptions C++ passent normalement.
    Le plugin fautif est ensuite considéré comme perdu : le pont arrête ce processus et
    passe la piste en signal sec ; le pont lui-même et les autres plugins ne sont pas touchés.

    (c) Make Music.
*/
#pragma once

#include <functional>
#include <stdexcept>

namespace nova::guard
{
    struct Crash : std::runtime_error
    {
        using std::runtime_error::runtime_error;
    };

    bool call (const std::function<void()>& fn);
    unsigned lastCode();
}
