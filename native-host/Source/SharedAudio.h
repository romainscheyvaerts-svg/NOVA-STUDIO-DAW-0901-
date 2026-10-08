/*
    NovaVSTHost — zone de mémoire partagée avec le pont Python (blocs audio, réglages, MIDI).

    Une zone par instance de plugin, créée par le pont (nom « Local\NovaVST-<pid>-<n> »),
    ouverte ici. Deux événements Windows à remise automatique : « req » (le pont a posé une
    demande) et « done » (l'hôte a fini). Le pont attend « done » ET la fin du processus de
    l'hôte : un plugin qui plante ne bloque jamais le pont.

    Disposition (little-endian, alignement naturel ; le pont relit sizeof / offsets via la
    commande « shm_layout » et refuse une zone qui ne correspond pas) :
      Header
      in   [kMaxChannels][kMaxFrames] float     entrée principale
      key  [kMaxKeyChannels][kMaxFrames] float  clé de side-chain (bus auxiliaire)
      out  [kMaxChannels][kMaxFrames] float     sortie principale

    (c) Make Music.
*/
#pragma once

#include <cstddef>
#include <cstdint>

namespace nova::shm
{
    constexpr uint32_t kMagic = 0x3154564Eu;   // « NVT1 »
    constexpr uint32_t kVersion = 1;
    constexpr int kMaxChannels = 8;
    constexpr int kMaxKeyChannels = 2;
    constexpr int kMaxFrames = 16384;
    constexpr int kMaxChanges = 4096;
    constexpr int kMaxEvents = 4096;
    constexpr int kMaxOutChanges = 2048;

    enum RequestFlags : uint32_t
    {
        kTransportValid = 1u << 0,   // les champs de transport sont renseignés (sinon : comme JUCE sans tête de lecture)
        kPlaying        = 1u << 1,
        kResetFirst     = 1u << 2,   // remise à zéro (setActive off/on) avant ce bloc
    };

    // Réglage posé à l'échantillon près : décalage depuis le début de la demande.
    struct ParamChange
    {
        uint32_t id;      // ParamID VST3
        int32_t offset;   // échantillon dans la demande (0 … nframes-1)
        double value;     // valeur normalisée 0–1
    };

    // Message MIDI court (note, contrôleur, pitch bend, aftertouch) à l'échantillon près.
    struct MidiEvent
    {
        int32_t offset;
        uint8_t data[3];
        uint8_t size;
    };

    struct Header
    {
        uint32_t magic;
        uint32_t version;
        uint32_t maxFrames;
        uint32_t maxChannels;
        uint32_t headerSize;
        uint32_t reserved0;

        // ---- demande (pont → hôte)
        uint32_t reqSeq;
        uint32_t nframes;
        uint32_t inChannels;
        uint32_t keyChannels;
        uint32_t outChannels;
        uint32_t flags;
        uint32_t blockSize;         // taille des sous-blocs passés au plugin (0 : la plus grande préparée)
        uint32_t nChanges;
        uint32_t nEvents;
        int32_t sigNum;
        int32_t sigDen;
        uint32_t reserved1;
        int64_t projectTimeSamples;
        double tempo;

        // ---- réponse (hôte → pont)
        uint32_t respSeq;
        int32_t status;             // 0 : ok ; < 0 : erreur (voir error)
        uint32_t nOutChanges;
        int32_t latency;            // latence annoncée par le plugin (échantillons)
        uint32_t outFrames;
        uint32_t outChannelsWritten;
        double processUs;           // temps passé dans process() du plugin (µs)
        char error[256];

        ParamChange changes[kMaxChanges];
        MidiEvent events[kMaxEvents];
        ParamChange outChanges[kMaxOutChanges];   // réglages renvoyés par le processeur (vu-mètres…)
    };

    constexpr size_t audioBytes (int channels) { return sizeof (float) * (size_t) channels * (size_t) kMaxFrames; }
    constexpr size_t inOffset() { return (sizeof (Header) + 63) / 64 * 64; }
    constexpr size_t keyOffset() { return inOffset() + audioBytes (kMaxChannels); }
    constexpr size_t outOffset() { return keyOffset() + audioBytes (kMaxKeyChannels); }
    constexpr size_t totalSize() { return outOffset() + audioBytes (kMaxChannels); }
}
