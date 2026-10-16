/**
 * Identifiants AAF utilisés par NOVA (modèle d'objets AAF 1.1 / SMPTE, AAF Edit
 * Protocol) : classes, numéros de propriétés (pid) et définitions du dictionnaire.
 */

// ── Classes ──────────────────────────────────────────────────────────────────────────────
export const CLS = {
  Root: 'b3b398a5-1c90-11d4-8053-080036210804',
  Header: '0d010101-0101-2f00-060e-2b3402060101',
  ContentStorage: '0d010101-0101-1800-060e-2b3402060101',
  Identification: '0d010101-0101-3000-060e-2b3402060101',
  CompositionMob: '0d010101-0101-3500-060e-2b3402060101',
  MasterMob: '0d010101-0101-3600-060e-2b3402060101',
  SourceMob: '0d010101-0101-3700-060e-2b3402060101',
  TimelineMobSlot: '0d010101-0101-3b00-060e-2b3402060101',
  Sequence: '0d010101-0101-0f00-060e-2b3402060101',
  Filler: '0d010101-0101-0900-060e-2b3402060101',
  SourceClip: '0d010101-0101-1100-060e-2b3402060101',
  Transition: '0d010101-0101-1700-060e-2b3402060101',
  OperationGroup: '0d010101-0101-0a00-060e-2b3402060101',
  EssenceGroup: '0d010101-0101-0500-060e-2b3402060101',
  Selector: '0d010101-0101-0e00-060e-2b3402060101',
  NestedScope: '0d010101-0101-0b00-060e-2b3402060101',
  ConstantValue: '0d010101-0101-3d00-060e-2b3402060101',
  VaryingValue: '0d010101-0101-3e00-060e-2b3402060101',
  ControlPoint: '0d010101-0101-1900-060e-2b3402060101',
  EssenceData: '0d010101-0101-2300-060e-2b3402060101',
  PCMDescriptor: '0d010101-0101-4800-060e-2b3402060101',
  WAVEDescriptor: '0d010101-0101-2c00-060e-2b3402060101',
  AIFCDescriptor: '0d010101-0101-2600-060e-2b3402060101',
  SoundDescriptor: '0d010101-0101-4200-060e-2b3402060101',
  MultipleDescriptor: '0d010101-0101-4400-060e-2b3402060101',
  NetworkLocator: '0d010101-0101-3200-060e-2b3402060101',
} as const;

/** Descripteurs de fichier audio (fin de la chaîne des sources). */
export const AUDIO_FILE_DESCRIPTORS = new Set<string>([CLS.PCMDescriptor, CLS.WAVEDescriptor, CLS.AIFCDescriptor, CLS.SoundDescriptor, CLS.MultipleDescriptor]);

// ── Propriétés (pid) ─────────────────────────────────────────────────────────────────────
export const PID = {
  Root_MetaDictionary: 0x0001,
  Root_Header: 0x0002,
  Component_DataDefinition: 0x0201,
  Component_Length: 0x0202,
  Sequence_Components: 0x1001,
  SourceReference_SourceID: 0x1101,
  SourceReference_SourceMobSlotID: 0x1102,
  SourceClip_StartTime: 0x1201,
  SourceClip_FadeInLength: 0x1202,
  SourceClip_FadeInType: 0x1203,
  SourceClip_FadeOutLength: 0x1204,
  SourceClip_FadeOutType: 0x1205,
  Transition_OperationGroup: 0x1801,
  Transition_CutPoint: 0x1802,
  OperationGroup_Operation: 0x0b01,
  OperationGroup_InputSegments: 0x0b02,
  OperationGroup_Parameters: 0x0b03,
  EssenceGroup_Choices: 0x0501,
  Selector_Selected: 0x0f01,
  NestedScope_Slots: 0x0c01,
  Parameter_Definition: 0x4c01,
  ConstantValue_Value: 0x4d01,
  VaryingValue_Interpolation: 0x4e01,
  VaryingValue_PointList: 0x4e02,
  ControlPoint_Value: 0x1a02,
  ControlPoint_Time: 0x1a03,
  ControlPoint_EditHint: 0x1a04,
  MobSlot_SlotID: 0x4801,
  MobSlot_SlotName: 0x4802,
  MobSlot_Segment: 0x4803,
  MobSlot_PhysicalTrackNumber: 0x4804,
  TimelineMobSlot_EditRate: 0x4b01,
  TimelineMobSlot_Origin: 0x4b02,
  Mob_MobID: 0x4401,
  Mob_Name: 0x4402,
  Mob_Slots: 0x4403,
  Mob_LastModified: 0x4404,
  Mob_CreationTime: 0x4405,
  Mob_UsageCode: 0x4408,
  SourceMob_EssenceDescription: 0x4701,
  Header_ByteOrder: 0x3b01,
  Header_LastModified: 0x3b02,
  Header_Content: 0x3b03,
  Header_Dictionary: 0x3b04,
  Header_Version: 0x3b05,
  Header_IdentificationList: 0x3b06,
  Header_ObjectModelVersion: 0x3b07,
  Header_OperationalPattern: 0x3b09,
  Header_EssenceContainers: 0x3b0a,
  ContentStorage_Mobs: 0x1901,
  ContentStorage_EssenceData: 0x1902,
  EssenceData_MobID: 0x2701,
  EssenceData_Data: 0x2702,
  Identification_CompanyName: 0x3c01,
  Identification_ProductName: 0x3c02,
  Identification_ProductVersionString: 0x3c04,
  Identification_ProductID: 0x3c05,
  Identification_Date: 0x3c06,
  Identification_Platform: 0x3c08,
  Identification_GenerationAUID: 0x3c09,
  EssenceDescriptor_Locator: 0x2f01,
  FileDescriptor_SampleRate: 0x3001,
  FileDescriptor_Length: 0x3002,
  FileDescriptor_ContainerFormat: 0x3004,
  Sound_QuantizationBits: 0x3d01,
  Sound_AudioSamplingRate: 0x3d03,
  Sound_Channels: 0x3d07,
  PCM_AverageBPS: 0x3d09,
  PCM_BlockAlign: 0x3d0a,
  WAVE_Summary: 0x3801,
  AIFC_Summary: 0x3101,
  MultipleDescriptor_FileDescriptors: 0x3f01,
  NetworkLocator_URLString: 0x4001,
  DefinitionObject_Identification: 0x1b01,
} as const;

// ── Définitions du dictionnaire ──────────────────────────────────────────────────────────
export const DATADEF = {
  Sound: '01030202-0200-0000-060e-2b3404010101',
  LegacySound: '78e1ebe1-6cef-11d2-807d-006008143e6f',
  Picture: '01030202-0100-0000-060e-2b3404010101',
  Timecode: '01030201-0100-0000-060e-2b3404010101',
} as const;
export const isSoundDef = (k: string | null) => k === DATADEF.Sound || k === DATADEF.LegacySound;

export const OPDEF = {
  MonoAudioGain: '9d2ea894-0968-11d3-8a38-0050040ef7d2',
  StereoAudioGain: '9d2ea895-0968-11d3-8a38-0050040ef7d2',
  MonoAudioPan: '9d2ea893-0968-11d3-8a38-0050040ef7d2',
  MonoAudioDissolve: '0c3bea41-fc05-11d2-8a29-0050040ef7d2',
  StereoAudioDissolve: '0c3bea42-fc05-11d2-8a29-0050040ef7d2',
  TwoParameterMonoAudioDissolve: '2311bd90-b5da-4285-aa3a-8552848779b3',
} as const;

export const PARAMDEF = {
  Amplitude: 'e4962321-2267-11d3-8a4c-0050040ef7d2',
  Pan: 'e4962322-2267-11d3-8a4c-0050040ef7d2',
  Level: 'e4962320-2267-11d3-8a4c-0050040ef7d2',
} as const;

export const INTERPDEF = {
  None: '5b6c85a3-0ede-11d3-80a9-006008143e6f',
  Linear: '5b6c85a4-0ede-11d3-80a9-006008143e6f',
  Constant: '5b6c85a5-0ede-11d3-80a9-006008143e6f',
  BSpline: '5b6c85a6-0ede-11d3-80a9-006008143e6f',
  Log: '15829ec3-1f24-458a-960d-c65bb23c2aa1',
  Power: 'c09153f7-bd18-4e5a-ad09-cbdd654fa001',
} as const;

export const CONTAINERDEF_AAF = '4313b571-d8ba-11d2-809b-006008143e6f';
export const USAGE_TOPLEVEL = '0d010102-0101-0700-060e-2b3404010101';
/** Signature de fichier AAF (CLSID de l'en-tête CFB) : secteurs de 4096 et de 512 octets. */
export const AAF_FILE_SIGNATURE_4K = '0d010201-0200-0000-060e-2b3403020101';
