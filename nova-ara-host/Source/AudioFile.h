/*
    NovaARAHost — lecture / écriture WAV (PCM 8/16/24/32 bits, float 32/64, WAVE_FORMAT_EXTENSIBLE).
    (c) Make Music. Aucune dépendance tierce.
*/
#pragma once

#include "Common.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <vector>

namespace nova
{
    struct AudioData
    {
        double sampleRate = 44100.0;
        std::vector<std::vector<float>> channels;   // un vecteur par canal

        int numChannels() const { return (int) channels.size(); }
        int64_t numFrames() const { return channels.empty() ? 0 : (int64_t) channels[0].size(); }

        void setSize (int nch, int64_t frames)
        {
            channels.assign ((size_t) nch, std::vector<float> ((size_t) frames, 0.0f));
        }

        float magnitude() const
        {
            float m = 0;
            for (auto& c : channels)
                for (float v : c) m = std::max (m, std::abs (v));
            return m;
        }
    };

    inline std::vector<uint8_t> readFileBytes (const std::string& pathUtf8)
    {
        std::ifstream f (widen (pathUtf8), std::ios::binary);
        if (! f) return {};
        f.seekg (0, std::ios::end);
        const auto size = (size_t) f.tellg();
        f.seekg (0);
        std::vector<uint8_t> b (size);
        if (size > 0) f.read (reinterpret_cast<char*> (b.data()), (std::streamsize) size);
        return b;
    }

    // Renvoie false si le fichier n'est pas un WAV lisible.
    inline bool readWav (const std::string& pathUtf8, AudioData& out)
    {
        const auto b = readFileBytes (pathUtf8);
        if (b.size() < 12 || std::memcmp (b.data(), "RIFF", 4) != 0 || std::memcmp (b.data() + 8, "WAVE", 4) != 0)
            return false;
        auto u16 = [&] (size_t p) { return (uint32_t) b[p] | ((uint32_t) b[p + 1] << 8); };
        auto u32 = [&] (size_t p) { return u16 (p) | (u16 (p + 2) << 16); };

        size_t pos = 12;
        uint32_t tag = 0, nch = 0, sr = 0, bits = 0;
        const uint8_t* data = nullptr;
        size_t dataSize = 0;
        bool haveFmt = false;
        while (pos + 8 <= b.size())
        {
            const uint32_t size = u32 (pos + 4);
            const size_t body = pos + 8;
            const size_t avail = std::min<size_t> (size, b.size() - std::min (body, b.size()));
            if (std::memcmp (b.data() + pos, "fmt ", 4) == 0 && avail >= 16)
            {
                tag = u16 (body); nch = u16 (body + 2); sr = u32 (body + 4); bits = u16 (body + 14);
                if (tag == 0xFFFE && avail >= 26) tag = u16 (body + 24);
                haveFmt = true;
            }
            else if (std::memcmp (b.data() + pos, "data", 4) == 0)
            {
                data = b.data() + body;
                dataSize = avail;
            }
            pos = body + (size_t) size + (size & 1);
        }
        if (! haveFmt || data == nullptr || nch == 0 || sr == 0) return false;
        const uint32_t bytesPer = bits / 8;
        if (bytesPer == 0) return false;
        const int64_t frames = (int64_t) (dataSize / (bytesPer * nch));
        out.sampleRate = (double) sr;
        out.setSize ((int) nch, frames);
        for (int64_t i = 0; i < frames; ++i)
        {
            for (uint32_t c = 0; c < nch; ++c)
            {
                const uint8_t* p = data + ((size_t) i * nch + c) * bytesPer;
                float v = 0;
                if (tag == 3 && bits == 32) { std::memcpy (&v, p, 4); }
                else if (tag == 3 && bits == 64) { double d; std::memcpy (&d, p, 8); v = (float) d; }
                else if (tag == 1 && bits == 8) v = ((float) p[0] - 128.0f) / 128.0f;
                else if (tag == 1 && bits == 16) v = (float) (int16_t) (p[0] | (p[1] << 8)) / 32768.0f;
                else if (tag == 1 && bits == 24)
                {
                    int32_t x = (int32_t) ((uint32_t) p[0] << 8 | (uint32_t) p[1] << 16 | (uint32_t) p[2] << 24) >> 8;
                    v = (float) x / 8388608.0f;
                }
                else if (tag == 1 && bits == 32)
                {
                    int32_t x; std::memcpy (&x, p, 4);
                    v = (float) ((double) x / 2147483648.0);
                }
                else return false;
                out.channels[c][(size_t) i] = v;
            }
        }
        return true;
    }

    // WAV float 32 bits (même forme que le pont : fmt + fact + data).
    inline void writeWavFloat (const std::string& pathUtf8, const AudioData& a)
    {
        const uint32_t nch = (uint32_t) std::max (1, a.numChannels());
        const uint32_t frames = (uint32_t) a.numFrames();
        const uint32_t sr = (uint32_t) std::llround (a.sampleRate);
        std::vector<float> inter ((size_t) frames * nch, 0.0f);
        for (uint32_t c = 0; c < (uint32_t) a.numChannels(); ++c)
            for (uint32_t i = 0; i < frames; ++i) inter[(size_t) i * nch + c] = a.channels[c][i];
        const uint32_t dataBytes = (uint32_t) (inter.size() * 4);
        std::vector<uint8_t> h;
        auto put4 = [&] (const char* s) { h.insert (h.end(), s, s + 4); };
        auto p32 = [&] (uint32_t v) { for (int i = 0; i < 4; ++i) h.push_back ((uint8_t) (v >> (8 * i))); };
        auto p16 = [&] (uint32_t v) { h.push_back ((uint8_t) v); h.push_back ((uint8_t) (v >> 8)); };
        put4 ("RIFF"); p32 (4 + 8 + 16 + 8 + 4 + 8 + dataBytes); put4 ("WAVE");
        put4 ("fmt "); p32 (16); p16 (3); p16 (nch); p32 (sr); p32 (sr * nch * 4); p16 (nch * 4); p16 (32);
        put4 ("fact"); p32 (4); p32 (frames);
        put4 ("data"); p32 (dataBytes);
        DeleteFileW (widen (pathUtf8).c_str());
        std::ofstream f (widen (pathUtf8), std::ios::binary | std::ios::trunc);
        if (! f) throw std::runtime_error ("Écriture WAV impossible : " + pathUtf8);
        f.write (reinterpret_cast<const char*> (h.data()), (std::streamsize) h.size());
        f.write (reinterpret_cast<const char*> (inter.data()), (std::streamsize) dataBytes);
        if (! f) throw std::runtime_error ("Écriture WAV impossible : " + pathUtf8);
    }
}
