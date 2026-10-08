/*
    NovaARAHost — utilitaires communs : sortie JSON (stdout), conversions UTF-8 ↔ UTF-16.
    (c) Make Music. Aucune dépendance tierce.
*/
#pragma once

#ifndef NOMINMAX
 #define NOMINMAX 1
#endif
#include <windows.h>

#include <cstdint>
#include <mutex>
#include <string>

#include "Json.h"

namespace nova
{
    inline std::wstring widen (const std::string& s)
    {
        if (s.empty()) return {};
        const int n = MultiByteToWideChar (CP_UTF8, 0, s.data(), (int) s.size(), nullptr, 0);
        std::wstring w ((size_t) n, L'\0');
        MultiByteToWideChar (CP_UTF8, 0, s.data(), (int) s.size(), w.data(), n);
        return w;
    }

    inline std::string narrow (const std::wstring& w)
    {
        if (w.empty()) return {};
        const int n = WideCharToMultiByte (CP_UTF8, 0, w.data(), (int) w.size(), nullptr, 0, nullptr, nullptr);
        std::string s ((size_t) n, '\0');
        WideCharToMultiByte (CP_UTF8, 0, w.data(), (int) w.size(), s.data(), n, nullptr, nullptr);
        return s;
    }

    inline double nowMs()
    {
        static LARGE_INTEGER freq = [] { LARGE_INTEGER f; QueryPerformanceFrequency (&f); return f; }();
        LARGE_INTEGER c;
        QueryPerformanceCounter (&c);
        return 1000.0 * (double) c.QuadPart / (double) freq.QuadPart;
    }

    // Sortie JSON (stdout), une ligne par message ; protégée : plusieurs threads peuvent écrire.
    namespace io
    {
        inline std::mutex& outLock() { static std::mutex m; return m; }

        inline void writeLine (const json::Value& v)
        {
            auto s = v.dump();
            s.push_back ('\n');
            std::lock_guard<std::mutex> l (outLock());
            auto h = GetStdHandle (STD_OUTPUT_HANDLE);
            DWORD written = 0;
            WriteFile (h, s.data(), (DWORD) s.size(), &written, nullptr);
            FlushFileBuffers (h);
        }

        inline void event (const std::string& name, json::Value o = json::Value::object())
        {
            o.set ("event", name);
            writeLine (o);
        }

        inline void log (const std::string& msg)
        {
            auto o = json::Value::object();
            o.set ("message", msg);
            event ("log", o);
        }
    }
}
