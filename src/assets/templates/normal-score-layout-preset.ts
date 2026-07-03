import type { UserLayoutPresetData } from "../../app/layout/layout_types";

/**
 * 기본 제공 Normal Score 레이아웃 프리셋이다.
 * - C3~C6 note row만 21px 높이로 배치한다.
 * - gap row는 포함하지 않는다.
 */
export const NORMAL_SCORE_LAYOUT_PRESET: UserLayoutPresetData = {
  formatVersion: "1",
  layoutPresetId: "slot-1",
  layoutPresetDisplayName: "Normal Score",
  instrumentPresetId: "otamatone-basic",
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
  instData: {
    presetId: "otamatone-basic",
    family: "otamatone",
    instName: "Normal Score",
    supportsOpen: false,
    strings: [
      {
        stringId: "s1",
        stringName: "1st String",
        minMidi: 48,
        maxMidi: 84,
      },
    ],
  },
  rowDefinitions: [
    { rowId: "s1-note-84", type: "note", stringId: "s1", midi: 84, height: 21, displayLabel: "C6" },
    { rowId: "s1-note-83", type: "note", stringId: "s1", midi: 83, height: 21, displayLabel: "B5" },
    { rowId: "s1-note-82", type: "note", stringId: "s1", midi: 82, height: 21, displayLabel: "A#5" },
    { rowId: "s1-note-81", type: "note", stringId: "s1", midi: 81, height: 21, displayLabel: "A5" },
    { rowId: "s1-note-80", type: "note", stringId: "s1", midi: 80, height: 21, displayLabel: "G#5" },
    { rowId: "s1-note-79", type: "note", stringId: "s1", midi: 79, height: 21, displayLabel: "G5" },
    { rowId: "s1-note-78", type: "note", stringId: "s1", midi: 78, height: 21, displayLabel: "F#5" },
    { rowId: "s1-note-77", type: "note", stringId: "s1", midi: 77, height: 21, displayLabel: "F5" },
    { rowId: "s1-note-76", type: "note", stringId: "s1", midi: 76, height: 21, displayLabel: "E5" },
    { rowId: "s1-note-75", type: "note", stringId: "s1", midi: 75, height: 21, displayLabel: "D#5" },
    { rowId: "s1-note-74", type: "note", stringId: "s1", midi: 74, height: 21, displayLabel: "D5" },
    { rowId: "s1-note-73", type: "note", stringId: "s1", midi: 73, height: 21, displayLabel: "C#5" },
    { rowId: "s1-note-72", type: "note", stringId: "s1", midi: 72, height: 21, displayLabel: "C5" },
    { rowId: "s1-note-71", type: "note", stringId: "s1", midi: 71, height: 21, displayLabel: "B4" },
    { rowId: "s1-note-70", type: "note", stringId: "s1", midi: 70, height: 21, displayLabel: "A#4" },
    { rowId: "s1-note-69", type: "note", stringId: "s1", midi: 69, height: 21, displayLabel: "A4" },
    { rowId: "s1-note-68", type: "note", stringId: "s1", midi: 68, height: 21, displayLabel: "G#4" },
    { rowId: "s1-note-67", type: "note", stringId: "s1", midi: 67, height: 21, displayLabel: "G4" },
    { rowId: "s1-note-66", type: "note", stringId: "s1", midi: 66, height: 21, displayLabel: "F#4" },
    { rowId: "s1-note-65", type: "note", stringId: "s1", midi: 65, height: 21, displayLabel: "F4" },
    { rowId: "s1-note-64", type: "note", stringId: "s1", midi: 64, height: 21, displayLabel: "E4" },
    { rowId: "s1-note-63", type: "note", stringId: "s1", midi: 63, height: 21, displayLabel: "D#4" },
    { rowId: "s1-note-62", type: "note", stringId: "s1", midi: 62, height: 21, displayLabel: "D4" },
    { rowId: "s1-note-61", type: "note", stringId: "s1", midi: 61, height: 21, displayLabel: "C#4" },
    { rowId: "s1-note-60", type: "note", stringId: "s1", midi: 60, height: 21, displayLabel: "C4" },
    { rowId: "s1-note-59", type: "note", stringId: "s1", midi: 59, height: 21, displayLabel: "B3" },
    { rowId: "s1-note-58", type: "note", stringId: "s1", midi: 58, height: 21, displayLabel: "A#3" },
    { rowId: "s1-note-57", type: "note", stringId: "s1", midi: 57, height: 21, displayLabel: "A3" },
    { rowId: "s1-note-56", type: "note", stringId: "s1", midi: 56, height: 21, displayLabel: "G#3" },
    { rowId: "s1-note-55", type: "note", stringId: "s1", midi: 55, height: 21, displayLabel: "G3" },
    { rowId: "s1-note-54", type: "note", stringId: "s1", midi: 54, height: 21, displayLabel: "F#3" },
    { rowId: "s1-note-53", type: "note", stringId: "s1", midi: 53, height: 21, displayLabel: "F3" },
    { rowId: "s1-note-52", type: "note", stringId: "s1", midi: 52, height: 21, displayLabel: "E3" },
    { rowId: "s1-note-51", type: "note", stringId: "s1", midi: 51, height: 21, displayLabel: "D#3" },
    { rowId: "s1-note-50", type: "note", stringId: "s1", midi: 50, height: 21, displayLabel: "D3" },
    { rowId: "s1-note-49", type: "note", stringId: "s1", midi: 49, height: 21, displayLabel: "C#3" },
    { rowId: "s1-note-48", type: "note", stringId: "s1", midi: 48, height: 21, displayLabel: "C3" },
  ],
};
