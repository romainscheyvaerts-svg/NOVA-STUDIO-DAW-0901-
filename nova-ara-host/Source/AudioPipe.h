/*
    NovaARAHost — flux audio temps réel avec le pont (insert ARA sur une piste, comme Pro Tools).

    Tube nommé \\.\pipe\<nom>, un client à la fois (le pont), un fil dédié (priorité « Pro Audio »).
    Le pont envoie chaque bloc de la piste avec la position du morceau, l'hôte le passe au plugin
    (rendu de lecture ARA calé sur cette position) et renvoie la sortie, bloc pour bloc.

    Requête (little-endian)
      u32 magic 'NARA' | u32 nframes | u32 nch | u32 flags (1 = lecture) | i64 position (échantillons,
      temps du morceau du 1er échantillon) | float32 planaire [nch][nframes]
    Réponse
      u32 magic | u32 nframes | u32 nch = 2 | u32 flags (1 = rendu par le plugin) | float32 planaire [2][nframes]
    (c) Make Music.
*/
#pragma once

#include "Common.h"

#include <atomic>
#include <functional>
#include <string>
#include <thread>
#include <vector>

namespace nova
{
    class AudioPipe
    {
    public:
        static constexpr uint32_t kMagic = 0x4152414E;   // « NARA »
        static constexpr int kMaxFrames = 8192;
        static constexpr int kMaxChannels = 8;

        // in : nin canaux ; out : 2 canaux ; renvoie vrai si le plugin a rendu le bloc.
        using Fn = std::function<bool (const float* const* in, int nin, float* const* out, int n, int64_t pos, bool playing)>;

        ~AudioPipe() { stop(); }
        void start (const std::string& name, Fn fn);
        void stop();
        bool running() const { return thread.joinable(); }
        const std::string& name() const { return pipeName; }
        std::atomic<int64_t> blocks { 0 }, rendered { 0 }, connections { 0 };

    private:
        void run();
        std::string pipeName;
        Fn process;
        std::thread thread;
        std::atomic<bool> quit { false }, listening { false };
        HANDLE pipe = INVALID_HANDLE_VALUE;
        HANDLE stopEvent = nullptr;
    };
}
