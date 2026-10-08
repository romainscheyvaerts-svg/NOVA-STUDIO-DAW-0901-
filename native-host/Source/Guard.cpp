/*
    NovaVSTHost — garde SEH (voir Guard.h). (c) Make Music.
*/
#ifndef NOMINMAX
 #define NOMINMAX 1
#endif
#include <windows.h>

#include "Guard.h"

namespace nova::guard
{
    static thread_local unsigned code = 0;

    static int filter (unsigned c)
    {
        if (c == 0xE06D7363u) return EXCEPTION_CONTINUE_SEARCH;   // exception C++ : laissée passer
        code = c;
        return EXCEPTION_EXECUTE_HANDLER;
    }

    static void invoke (void* p) { (*static_cast<const std::function<void()>*> (p))(); }

    static bool sehCall (void (*f) (void*), void* p)
    {
        __try
        {
            f (p);
            return true;
        }
        __except (filter (GetExceptionCode()))
        {
            return false;
        }
    }

    bool call (const std::function<void()>& fn) { return sehCall (&invoke, (void*) &fn); }
    unsigned lastCode() { return code; }
}
