"""Lecture / écriture de l'état VST3 enveloppé par JUCE (pedalboard raw_state)."""
import re, struct
TABLE = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+"

def juce_b64_decode(s: str) -> bytes:
    size_str, enc = s.split(".", 1)
    size = int(size_str)
    out = bytearray(size)
    pos = 0
    for ch in enc:
        v = TABLE.index(ch)
        for b in range(6):
            bit = pos + b
            if (v >> b) & 1 and (bit >> 3) < size:
                out[bit >> 3] |= 1 << (bit & 7)
        pos += 6
    return bytes(out)

def juce_b64_encode(data: bytes) -> str:
    n = ((len(data) << 3) + 5) // 6
    chars = []
    for i in range(n):
        v = 0
        for b in range(6):
            bit = i * 6 + b
            if (bit >> 3) < len(data) and (data[bit >> 3] >> (bit & 7)) & 1:
                v |= 1 << b
        chars.append(TABLE[v])
    return f"{len(data)}." + "".join(chars)

def unpack(raw: bytes):
    assert raw[:4] == b"VC2!"
    n = struct.unpack("<I", raw[4:8])[0]
    xml = raw[8:8 + n].decode("utf-8")
    comp = re.search(r"<IComponent>(.*?)</IComponent>", xml, re.S)
    ctrl = re.search(r"<IEditController>(.*?)</IEditController>", xml, re.S)
    return xml, juce_b64_decode(comp.group(1).strip()) if comp else None, juce_b64_decode(ctrl.group(1).strip()) if ctrl else None

def pack(xml_template: str, component: bytes) -> bytes:
    xml = re.sub(r"<IComponent>.*?</IComponent>", "<IComponent>" + juce_b64_encode(component) + "</IComponent>", xml_template, flags=re.S)
    b = xml.encode("utf-8")
    return b"VC2!" + struct.pack("<I", len(b)) + b

if __name__ == "__main__":
    from pedalboard import load_plugin
    p = load_plugin(r"C:\Program Files\Common Files\VST3\Slate Digital\VerbSuite Classics.vst3")
    xml, comp, ctrl = unpack(p.raw_state)
    print("xml enveloppe:", re.sub(r">[^<]{60,}<", ">…<", xml)[:400])
    print("IComponent:", len(comp), comp[:200])
    print("IEditController:", None if ctrl is None else (len(ctrl), ctrl[:120]))
    print("aller-retour b64 ok:", juce_b64_decode(juce_b64_encode(comp)) == comp)
