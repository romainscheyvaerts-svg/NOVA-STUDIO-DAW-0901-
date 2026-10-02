/**
 * Bibliothèque de batterie Make Music (dossier DRUMS du studio, sons du sampler
 * Make Music), servie depuis /drums/lib/. Fichier généré : ne pas éditer à la main.
 * Les sons présents dans plusieurs styles ne sont stockés qu'une fois.
 */
export type LibCategory = 'kick' | 'snare' | 'clap' | 'hatc' | 'hato' | 'rim' | 'cymbal';

export const DRUM_LIBRARY_STYLES: Record<string, string> = {
  "afro": "Afro",
  "boombap": "Boom Bap",
  "drill": "Drill",
  "dnb": "Drum & Bass",
  "house": "House",
  "indie": "Indie / Rock",
  "pop": "Pop",
  "reggaeton": "Reggaeton",
  "rnb": "R&B",
  "soul": "Soul",
  "trap": "Trap"
};

/** style → catégorie → identifiants de sons (fichier /drums/lib/<id>.wav). */
export const DRUM_LIBRARY: Record<string, Partial<Record<LibCategory, string[]>>> = {
  "afro": {
    "kick": [
      "kick-31742016",
      "kick-bae45dd7",
      "kick-e22025f0"
    ],
    "rim": [
      "rim-d8d18124",
      "rim-77975ba2",
      "rim-d3d68f2a",
      "rim-391546e3",
      "rim-b2b7d6ac"
    ],
    "snare": [
      "snare-34bbf362"
    ]
  },
  "boombap": {
    "clap": [
      "clap-8d3fd475",
      "clap-af5ac42d"
    ],
    "cymbal": [
      "cymbal-06c50e97"
    ],
    "hatc": [
      "hatc-bc5c2f48"
    ],
    "hato": [
      "hato-9acdbd38"
    ],
    "kick": [
      "kick-62143a9b",
      "kick-91e842da",
      "kick-5f3c0d7e",
      "kick-1ab8d1be",
      "kick-47242087"
    ],
    "rim": [
      "rim-04a873b9"
    ],
    "snare": [
      "snare-d93b8de5",
      "snare-f9f7d1af",
      "snare-f96fecf1"
    ]
  },
  "drill": {
    "clap": [
      "clap-f3755063",
      "clap-699e2169",
      "clap-c2a3b8fd",
      "clap-b0d4e036",
      "clap-bd530d42",
      "clap-bbfb4874",
      "clap-f21b3b0f",
      "clap-9f782a76"
    ],
    "hatc": [
      "hatc-4cd51aa6",
      "hatc-05bf936e",
      "hatc-574cb373",
      "hatc-554e1cda",
      "hatc-801bec9a"
    ],
    "hato": [
      "hato-2326f551",
      "hato-c26097b1",
      "hato-6ade4617"
    ],
    "kick": [
      "kick-5e129585",
      "kick-7a6f2889",
      "kick-98177e5b",
      "kick-5203e3bf",
      "kick-87f94514",
      "kick-9571423e",
      "kick-bf217c56",
      "kick-f6e2c51f"
    ],
    "rim": [
      "rim-d8d18124",
      "rim-d3d68f2a",
      "rim-043effb8",
      "rim-62d1dc2a",
      "rim-5f96460f"
    ],
    "snare": [
      "snare-d631cd51",
      "snare-ad95ca5e",
      "snare-5a840643",
      "snare-e8f93f3c"
    ]
  },
  "dnb": {
    "clap": [
      "clap-c0f45c11"
    ],
    "cymbal": [
      "cymbal-902062fa"
    ],
    "hatc": [
      "hatc-4cd51aa6",
      "hatc-f09f1278",
      "hatc-63449eb6"
    ],
    "kick": [
      "kick-31742016",
      "kick-0544e741"
    ]
  },
  "house": {
    "clap": [
      "clap-d7dda04c",
      "clap-f3755063",
      "clap-a7e88ee4",
      "clap-3e4019ae",
      "clap-2197ddaf",
      "clap-5591989b"
    ],
    "cymbal": [
      "cymbal-36b11ded",
      "cymbal-47036d8d",
      "cymbal-90ba65c1"
    ],
    "hato": [
      "hato-0acb749f"
    ],
    "kick": [
      "kick-644d1b77",
      "kick-31742016",
      "kick-bae45dd7",
      "kick-d6fefd74",
      "kick-e5cdf38e",
      "kick-35c13e00",
      "kick-e22025f0",
      "kick-3cbe9943",
      "kick-f5786874"
    ],
    "rim": [
      "rim-65027ae0",
      "rim-1d33e72d",
      "rim-0624e193"
    ],
    "snare": [
      "snare-7945efa7"
    ]
  },
  "indie": {
    "kick": [
      "kick-14c09288",
      "kick-fd708dbb",
      "kick-209a0350",
      "kick-1ab8d1be",
      "kick-47242087",
      "kick-f5786874"
    ],
    "rim": [
      "rim-a36cf531"
    ]
  },
  "pop": {
    "clap": [
      "clap-8d3fd475",
      "clap-c1344394"
    ],
    "cymbal": [
      "cymbal-227f3a71"
    ],
    "hatc": [
      "hatc-f09f1278"
    ],
    "hato": [
      "hato-0acb749f"
    ],
    "kick": [
      "kick-e5cdf38e",
      "kick-35c13e00",
      "kick-e22025f0"
    ],
    "snare": [
      "snare-4ec33198",
      "snare-1d86d67f"
    ]
  },
  "reggaeton": {
    "hato": [
      "hato-c26097b1"
    ],
    "kick": [
      "kick-8137683f",
      "kick-0544e741"
    ],
    "rim": [
      "rim-391546e3"
    ],
    "snare": [
      "snare-d93b8de5",
      "snare-bec77bec",
      "snare-34bbf362",
      "snare-e4495796"
    ]
  },
  "rnb": {
    "clap": [
      "clap-81041b2a",
      "clap-699e2169",
      "clap-d2a68400",
      "clap-c2a3b8fd",
      "clap-d32dc798",
      "clap-af5ac42d",
      "clap-a7e88ee4",
      "clap-bbfb4874",
      "clap-1fa049c5"
    ],
    "cymbal": [
      "cymbal-7bb22c6d"
    ],
    "hatc": [
      "hatc-4cd51aa6",
      "hatc-bc5c2f48",
      "hatc-554e1cda",
      "hatc-9398d1fe",
      "hatc-f09f1278",
      "hatc-609590f4"
    ],
    "hato": [
      "hato-c26097b1",
      "hato-6ade4617",
      "hato-e5d68c0c",
      "hato-ed7ce0dd",
      "hato-9acdbd38"
    ],
    "kick": [
      "kick-5e129585",
      "kick-8e790d4f",
      "kick-9571423e"
    ],
    "rim": [
      "rim-71b29fc8",
      "rim-d8d18124",
      "rim-d3d68f2a",
      "rim-043effb8",
      "rim-003f7faa",
      "rim-a5ca6881",
      "rim-d218dd56"
    ],
    "snare": [
      "snare-a36cf531"
    ]
  },
  "soul": {
    "clap": [
      "clap-699e2169",
      "clap-d2a68400",
      "clap-a7e88ee4",
      "clap-1fa049c5",
      "clap-9f782a76"
    ],
    "cymbal": [
      "cymbal-7bb22c6d"
    ],
    "hatc": [
      "hatc-4cd51aa6",
      "hatc-554e1cda",
      "hatc-9398d1fe",
      "hatc-f09f1278",
      "hatc-609590f4"
    ],
    "hato": [
      "hato-2326f551",
      "hato-aa5676ad",
      "hato-c26097b1",
      "hato-6ade4617",
      "hato-e5d68c0c",
      "hato-9acdbd38"
    ],
    "kick": [
      "kick-91e842da",
      "kick-8e790d4f",
      "kick-5f3c0d7e",
      "kick-9571423e"
    ],
    "rim": [
      "rim-d8d18124",
      "rim-fdf2983d",
      "rim-d3d68f2a",
      "rim-043effb8",
      "rim-04a873b9",
      "rim-003f7faa",
      "rim-a5ca6881"
    ],
    "snare": [
      "snare-a36cf531"
    ]
  },
  "trap": {
    "clap": [
      "clap-8d3fd475",
      "clap-f3755063",
      "clap-699e2169",
      "clap-0dfe0de6",
      "clap-d2a68400",
      "clap-c2a3b8fd",
      "clap-afd2e9f4",
      "clap-b0d4e036",
      "clap-bd530d42",
      "clap-bbfb4874",
      "clap-1fa049c5",
      "clap-9f782a76"
    ],
    "cymbal": [
      "cymbal-7bb22c6d"
    ],
    "hatc": [
      "hatc-4cd51aa6",
      "hatc-05bf936e",
      "hatc-84b24600",
      "hatc-574cb373",
      "hatc-554e1cda",
      "hatc-9398d1fe",
      "hatc-f09f1278",
      "hatc-609590f4"
    ],
    "hato": [
      "hato-2326f551",
      "hato-c26097b1",
      "hato-6ade4617",
      "hato-e5d68c0c",
      "hato-ed7ce0dd",
      "hato-9acdbd38"
    ],
    "kick": [
      "kick-5e129585",
      "kick-7a6f2889",
      "kick-98177e5b",
      "kick-5203e3bf",
      "kick-8e790d4f",
      "kick-87f94514",
      "kick-9571423e",
      "kick-bf217c56",
      "kick-f6e2c51f"
    ],
    "rim": [
      "rim-71b29fc8",
      "rim-d8d18124",
      "rim-fdf2983d",
      "rim-d3d68f2a",
      "rim-043effb8",
      "rim-d218dd56",
      "rim-edb01a81"
    ],
    "snare": [
      "snare-e3c1441f",
      "snare-5e9aa78c",
      "snare-2c73d67b",
      "snare-bf0b78a3",
      "snare-ad95ca5e",
      "snare-5a840643",
      "snare-e8f93f3c"
    ]
  }
};

export const libUrl = (id: string) => `url:/drums/lib/${id}.wav`;
