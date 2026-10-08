"""R16 : contrôleurs MIDI (pitch bend, CC, aftertouch) envoyés aux instruments VST3."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vst_host import midi_events  # noqa: E402


class MidiEventsTest(unittest.TestCase):
    def test_notes_seules_comme_avant(self):
        ev = midi_events([{"pitch": 60, "start": 0.5, "duration": 1, "velocity": 1}], 4)
        self.assertEqual([(list(b), t) for b, t in ev], [([0x90, 60, 127], 0.5), ([0x80, 60, 0], 1.5)])

    def test_controleurs_avant_les_notes_au_meme_instant(self):
        ev = midi_events(
            [{"pitch": 60, "start": 0, "duration": 1, "velocity": 0.5}], 4,
            [{"time": 0, "status": 0xB0, "data1": 64, "data2": 127},
             {"time": 0.5, "status": 0xE0, "data1": 0, "data2": 96},
             {"time": 0.7, "status": 0xD0, "data1": 40, "data2": 0}])
        self.assertEqual([(list(b), round(t, 3)) for b, t in ev],
                         [([0xB0, 64, 127], 0.0), ([0x90, 60, 64], 0.0), ([0xE0, 0, 96], 0.5), ([0xD0, 40], 0.7), ([0x80, 60, 0], 1.0)])

    def test_controleurs_invalides_ignores(self):
        ev = midi_events([], 2, [{"time": "x"}, {"time": 1, "status": 0x90, "data1": 1, "data2": 1}, {"time": 5, "status": 0xB0, "data1": 1, "data2": 1}, None])
        self.assertEqual(ev, [])


if __name__ == "__main__":
    unittest.main()
