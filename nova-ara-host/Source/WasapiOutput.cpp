/*
    NovaARAHost — sortie WASAPI partagée (sans JUCE).
    (c) Make Music.
*/
#include "WasapiOutput.h"

#include <initguid.h>
#include <audioclient.h>
#include <propkeydef.h>
#include <avrt.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmdeviceapi.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace nova
{
    template <typename T> static void safeRelease (T*& p) { if (p != nullptr) { p->Release(); p = nullptr; } }

    static std::string friendlyName (IMMDevice* d)
    {
        std::string out;
        IPropertyStore* props = nullptr;
        if (SUCCEEDED (d->OpenPropertyStore (STGM_READ, &props)))
        {
            PROPVARIANT v;
            PropVariantInit (&v);
            if (SUCCEEDED (props->GetValue (PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR)
                out = narrow (v.pwszVal);
            PropVariantClear (&v);
            props->Release();
        }
        return out;
    }

    void WasapiOutput::open (Callback cb)
    {
        close();
        callback = std::move (cb);
        IMMDeviceEnumerator* en = nullptr;
        if (FAILED (CoCreateInstance (__uuidof (MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof (IMMDeviceEnumerator), (void**) &en)))
            throw std::runtime_error ("Aucune sortie audio disponible : WASAPI indisponible");
        IMMDevice* dev = nullptr;
        if (FAILED (en->GetDefaultAudioEndpoint (eRender, eConsole, &dev)) || dev == nullptr)
        {
            // Pas de sortie par défaut : première sortie active.
            IMMDeviceCollection* list = nullptr;
            if (SUCCEEDED (en->EnumAudioEndpoints (eRender, DEVICE_STATE_ACTIVE, &list)))
            {
                UINT n = 0;
                list->GetCount (&n);
                if (n > 0) list->Item (0, &dev);
                list->Release();
            }
        }
        if (dev == nullptr)
        {
            // Diagnostic : toutes les sorties connues et leur état.
            std::string diag;
            IMMDeviceCollection* all = nullptr;
            if (SUCCEEDED (en->EnumAudioEndpoints (eRender, DEVICE_STATEMASK_ALL, &all)))
            {
                UINT n = 0;
                all->GetCount (&n);
                for (UINT i = 0; i < n && i < 12; ++i)
                {
                    IMMDevice* d = nullptr;
                    if (FAILED (all->Item (i, &d))) continue;
                    DWORD st = 0;
                    d->GetState (&st);
                    diag += (diag.empty() ? "" : ", ") + friendlyName (d)
                          + (st == DEVICE_STATE_ACTIVE ? "" : st == DEVICE_STATE_DISABLED ? " (désactivée)"
                             : st == DEVICE_STATE_UNPLUGGED ? " (débranchée)" : " (absente)");
                    d->Release();
                }
                all->Release();
            }
            en->Release();
            throw std::runtime_error ("Aucune sortie audio disponible [Windows Audio : " + diag + "]");
        }
        en->Release();
        name = "Windows Audio / " + friendlyName (dev);

        IAudioClient* ac = nullptr;
        HRESULT hr = dev->Activate (__uuidof (IAudioClient), CLSCTX_ALL, nullptr, (void**) &ac);
        dev->Release();
        if (FAILED (hr)) throw std::runtime_error ("Aucune sortie audio disponible : " + name + " refuse de s'ouvrir");

        WAVEFORMATEX* mix = nullptr;
        if (FAILED (ac->GetMixFormat (&mix)))
        {
            ac->Release();
            throw std::runtime_error ("Aucune sortie audio disponible : format de " + name + " illisible");
        }
        rate = (double) mix->nSamplesPerSec;
        channels = mix->nChannels;
        bytesPerSample = mix->wBitsPerSample / 8;
        isFloat = mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT
               || (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE
                   && reinterpret_cast<WAVEFORMATEXTENSIBLE*> (mix)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
        hr = ac->Initialize (AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 200000 /* 20 ms */, 0, mix, nullptr);
        CoTaskMemFree (mix);
        if (FAILED (hr))
        {
            ac->Release();
            throw std::runtime_error ("Aucune sortie audio disponible : " + name + " refuse le mode partagé");
        }
        UINT32 frames = 0;
        ac->GetBufferSize (&frames);
        bufferFrames = (int) frames;
        IAudioRenderClient* rc = nullptr;
        if (FAILED (ac->GetService (__uuidof (IAudioRenderClient), (void**) &rc)))
        {
            ac->Release();
            throw std::runtime_error ("Aucune sortie audio disponible : rendu refusé par " + name);
        }
        eventHandle = CreateEventW (nullptr, FALSE, FALSE, nullptr);
        ac->SetEventHandle (eventHandle);
        client = ac;
        render = rc;
        running = true;
        thread = std::thread ([this] { run(); });
    }

    void WasapiOutput::close()
    {
        if (running.exchange (false))
        {
            if (eventHandle != nullptr) SetEvent (eventHandle);
            if (thread.joinable()) thread.join();
        }
        else if (thread.joinable())
            thread.join();
        auto* ac = static_cast<IAudioClient*> (client);
        auto* rc = static_cast<IAudioRenderClient*> (render);
        if (ac != nullptr) ac->Stop();
        safeRelease (rc);
        safeRelease (ac);
        client = render = nullptr;
        if (eventHandle != nullptr) { CloseHandle (eventHandle); eventHandle = nullptr; }
    }

    void WasapiOutput::run()
    {
        CoInitializeEx (nullptr, COINIT_MULTITHREADED);
        DWORD taskIndex = 0;
        HANDLE task = AvSetMmThreadCharacteristicsW (L"Pro Audio", &taskIndex);
        auto* ac = static_cast<IAudioClient*> (client);
        auto* rc = static_cast<IAudioRenderClient*> (render);
        std::vector<std::vector<float>> planar ((size_t) channels, std::vector<float> ((size_t) bufferFrames, 0.0f));
        std::vector<float*> ptrs ((size_t) channels);
        for (int c = 0; c < channels; ++c) ptrs[(size_t) c] = planar[(size_t) c].data();

        auto fill = [&] (UINT32 n)
        {
            BYTE* data = nullptr;
            if (n == 0 || FAILED (rc->GetBuffer (n, &data))) return;
            for (auto& p : planar) std::fill (p.begin(), p.begin() + n, 0.0f);
            if (callback) callback (ptrs.data(), channels, (int) n);
            for (UINT32 i = 0; i < n; ++i)
                for (int c = 0; c < channels; ++c)
                {
                    const float v = std::clamp (planar[(size_t) c][i], -1.0f, 1.0f);
                    BYTE* p = data + ((size_t) i * (size_t) channels + (size_t) c) * (size_t) bytesPerSample;
                    if (isFloat && bytesPerSample == 4) std::memcpy (p, &v, 4);
                    else if (bytesPerSample == 2) { const int16_t x = (int16_t) std::lrint (v * 32767.0f); std::memcpy (p, &x, 2); }
                    else if (bytesPerSample == 3) { const int32_t x = (int32_t) std::lrint (v * 8388607.0f); p[0] = (BYTE) x; p[1] = (BYTE) (x >> 8); p[2] = (BYTE) (x >> 16); }
                    else if (bytesPerSample == 4) { const int32_t x = (int32_t) std::llrint ((double) v * 2147483647.0); std::memcpy (p, &x, 4); }
                }
            rc->ReleaseBuffer (n, 0);
        };

        fill ((UINT32) bufferFrames);   // pré-remplissage
        ac->Start();
        while (running.load())
        {
            if (WaitForSingleObject (eventHandle, 200) != WAIT_OBJECT_0) continue;
            if (! running.load()) break;
            UINT32 padding = 0;
            if (FAILED (ac->GetCurrentPadding (&padding))) break;
            fill ((UINT32) bufferFrames - padding);
        }
        ac->Stop();
        if (task != nullptr) AvRevertMmThreadCharacteristics (task);
        CoUninitialize();
    }
}
