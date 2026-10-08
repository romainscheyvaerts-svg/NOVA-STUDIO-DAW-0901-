/*
    NovaARAHost — flux audio temps réel par tube nommé (voir AudioPipe.h).
    (c) Make Music.
*/
#include "AudioPipe.h"

#include <avrt.h>

#include <algorithm>
#include <cstring>

namespace nova
{
    void AudioPipe::start (const std::string& name, Fn fn)
    {
        stop();
        pipeName = name;
        process = std::move (fn);
        quit = false;
        stopEvent = CreateEventW (nullptr, TRUE, FALSE, nullptr);
        listening = false;
        thread = std::thread ([this] { run(); });
        // Le tube existe avant de rendre la main (le pont s'y connecte aussitôt).
        for (int i = 0; i < 200 && ! listening; ++i) Sleep (5);
    }

    void AudioPipe::stop()
    {
        if (! thread.joinable()) return;
        quit = true;
        if (stopEvent) SetEvent (stopEvent);
        // Débloque un ConnectNamedPipe en attente : connexion éphémère à soi-même.
        const auto full = widen ("\\\\.\\pipe\\" + pipeName);
        HANDLE h = CreateFileW (full.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
        if (h != INVALID_HANDLE_VALUE) CloseHandle (h);
        // Client connecté et fil bloqué dans ReadFile : lecture synchrone annulée.
        for (int i = 0; i < 50 && thread.joinable(); ++i)
        {
            CancelSynchronousIo ((HANDLE) thread.native_handle());
            if (WaitForSingleObject ((HANDLE) thread.native_handle(), 20) == WAIT_OBJECT_0) break;
        }
        thread.join();
        if (stopEvent) { CloseHandle (stopEvent); stopEvent = nullptr; }
    }

    static bool readAll (HANDLE h, void* dst, DWORD len)
    {
        auto* p = static_cast<uint8_t*> (dst);
        while (len > 0)
        {
            DWORD got = 0;
            if (! ReadFile (h, p, len, &got, nullptr) || got == 0) return false;
            p += got; len -= got;
        }
        return true;
    }

    static bool writeAll (HANDLE h, const void* src, DWORD len)
    {
        auto* p = static_cast<const uint8_t*> (src);
        while (len > 0)
        {
            DWORD put = 0;
            if (! WriteFile (h, p, len, &put, nullptr) || put == 0) return false;
            p += put; len -= put;
        }
        return true;
    }

    void AudioPipe::run()
    {
        DWORD taskIndex = 0;
        HANDLE task = AvSetMmThreadCharacteristicsW (L"Pro Audio", &taskIndex);
        const auto full = widen ("\\\\.\\pipe\\" + pipeName);
        std::vector<float> inBuf ((size_t) kMaxFrames * kMaxChannels), outBuf ((size_t) kMaxFrames * 2);
        std::vector<uint8_t> reply (16 + (size_t) kMaxFrames * 2 * sizeof (float));
        while (! quit)
        {
            pipe = CreateNamedPipeW (full.c_str(), PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                                     1, 1 << 20, 1 << 20, 0, nullptr);
            if (pipe == INVALID_HANDLE_VALUE) { Sleep (200); continue; }
            listening = true;
            const BOOL ok = ConnectNamedPipe (pipe, nullptr) ? TRUE : (GetLastError() == ERROR_PIPE_CONNECTED);
            if (! ok || quit) { CloseHandle (pipe); pipe = INVALID_HANDLE_VALUE; continue; }
            ++connections;
            for (;;)
            {
                uint32_t head[4];
                int64_t pos = 0;
                if (! readAll (pipe, head, sizeof (head)) || ! readAll (pipe, &pos, sizeof (pos))) break;
                if (head[0] != kMagic) break;
                const int n = (int) head[1], nch = (int) head[2];
                if (n <= 0 || n > kMaxFrames || nch <= 0 || nch > kMaxChannels) break;
                if (! readAll (pipe, inBuf.data(), (DWORD) (sizeof (float) * (size_t) n * (size_t) nch))) break;
                const float* ins[kMaxChannels];
                for (int c = 0; c < nch; ++c) ins[c] = inBuf.data() + (size_t) c * (size_t) n;
                float* outs[2] = { outBuf.data(), outBuf.data() + n };
                std::fill (outBuf.begin(), outBuf.begin() + 2 * n, 0.0f);
                bool done = false;
                try { done = process && process (ins, nch, outs, n, pos, (head[3] & 1u) != 0); }
                catch (...) { done = false; }
                ++blocks;
                if (done) ++rendered;
                const uint32_t rh[4] = { kMagic, (uint32_t) n, 2u, done ? 1u : 0u };
                std::memcpy (reply.data(), rh, sizeof (rh));
                std::memcpy (reply.data() + 16, outBuf.data(), sizeof (float) * 2 * (size_t) n);
                if (! writeAll (pipe, reply.data(), (DWORD) (16 + sizeof (float) * 2 * (size_t) n))) break;
            }
            FlushFileBuffers (pipe);
            DisconnectNamedPipe (pipe);
            CloseHandle (pipe);
            pipe = INVALID_HANDLE_VALUE;
        }
        if (task) AvRevertMmThreadCharacteristics (task);
    }
}
