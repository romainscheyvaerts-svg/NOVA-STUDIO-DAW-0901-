/*
    NovaARAHost — sortie audio temps réel (WASAPI partagé, sortie Windows par défaut), sans JUCE.
    Le rappel reçoit des canaux séparés (float) ; la conversion vers le format du mixeur est faite ici.
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
    class WasapiOutput
    {
    public:
        // out : numChannels pointeurs, numFrames ≤ maxFrames()
        using Callback = std::function<void (float* const* out, int numChannels, int numFrames)>;

        ~WasapiOutput() { close(); }

        // Ouvre la sortie par défaut (sinon la première active) ; lève std::runtime_error sinon.
        void open (Callback cb);
        void close();
        bool isOpen() const { return running.load(); }

        double sampleRate() const { return rate; }
        int maxFrames() const { return bufferFrames; }
        int numChannels() const { return channels; }
        const std::string& deviceName() const { return name; }

    private:
        void run();

        Callback callback;
        std::thread thread;
        std::atomic<bool> running { false };
        void* client = nullptr;       // IAudioClient*
        void* render = nullptr;       // IAudioRenderClient*
        HANDLE eventHandle = nullptr;
        double rate = 48000.0;
        int bufferFrames = 0, channels = 2, bytesPerSample = 4;
        bool isFloat = true;
        std::string name;
    };
}
