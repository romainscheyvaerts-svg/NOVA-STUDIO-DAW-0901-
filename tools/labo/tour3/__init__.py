"""Tour 3 du labo NOVA (précision : F/M de l'Opto Vintage, FET 76, Vox Strip, batterie, Mastering Transient)."""
import ctypes


def lowprio():
    """Priorité basse (BELOW_NORMAL) : la machine reste utilisable ; héritée par les sous-processus."""
    try:
        k = ctypes.windll.kernel32
        k.SetPriorityClass(k.GetCurrentProcess(), 0x4000)
    except Exception:
        pass
