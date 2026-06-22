/**
 * src\core\score\types.ts
 * 입력되는 악보 JSON 파일의 저장 구조와 로드 직후 런타임 인덱스 타입을 정의한다.
 * 모든 상위 모듈에서 공통으로 사용되는 타입이 존재한다면 추후 src\core\common.types.ts로 이동한다.
 */

/** 트랙은 세 종류 존재한다. */
export type TrackId = "basic" | "optional" | "extra";   

/** 전역 행은 네 종류 존재한다. */
export type GlobalKind =
  | "bpm"
  | "beatsPerBar"
  | "stepsPerBeat"
  | "dynamics";

/** 행에 할당되는 ID. */
export type RowId = string;

/** 현에 할당되는 ID. */
export type StringId = string;

/**
 * 파일 포맷과 버전.
 * - 기본적 형식 검사 용도.
 */
export type ScoreFormat = {
    formatName: string; // 포맷명. "spred-sheet"일 때만 해석을 이어간다.
    version: string; // 버전(시멘틱 형식)
};

/**
 *  곡에 대한 정보.
 * - UI(플레이어 부분) 상에 표시되어 사용자에게 곡 정보를 제공한다.
 */
export type MusicData = {
    musicTitle: string;     // 곡의 제목 (default : "Unknown")
    musicArtist: string;    // 아티스트명 (default : "Unknown")
    musicGenre: string;     // 곡의 장르 (default : "Unknown")
    scoreWriter: string;    // 악보 제작자명 (default : "Anonymous")
    comment: string;        // 악보 제작자 코멘트 (100자 이하)
    scoreDifficulty: ScoreDifficulty;   // 트랙별 난이도
    createdAt: string;      // 악보 생성 날짜 (ISO 형식)
    updatedAt: string;      // 악보 마지막 수정 날짜 (생성 시각보다 과거일 수 없음)
    youtube: YoutubeSync;   // 유튜브 모드 관련 정보
};

export type ScoreDifficulty = Record<TrackId, number>;  // 난이도는 트랙마다 하나씩 필수로 할당한다. (default : 0)

export type YoutubeSync = {
  videoId: string;      // 유튜브 동영상 ID
  offsetMs: number;     // 악보재생 위치와의 싱크를 위한 보정 ms값 (default:0)
};

/**
 * 악기 정보.
 * - 악기 종류와 필드 정보에 따라 다른 UI를 제공한다.
 */
export type InstrumentData = {
  presetId: string;         // 파일 내에 정의된 악기 프리셋을 불러온다. 사용자 임의 설정은 "custom"
  family: string;           // 악기의 종류
  instName: string;         // 사용자가 정할 수 있는 악기명. ex: "Otamatone Dx basic"
  supportsOpen: boolean;    // 악기가 개방현을 지원하는가
  strings: InstrumentString[];  // 현의 개수와 특성을 정의하는 배열
};

export type InstrumentString = {
  stringId: StringId;       // 현 구분을 위한 식별자 ex: s1, s2, s3, ...
  stringName: string;       // UI상으로 뜨게 되는 현 이름 ex: 1st String
  openMidi?: number;        // (지원시) 개방현의 음정
  minMidi: number;          // 지판을 눌러서 연주되는 최저음
  maxMidi: number;          // 현의 최고음
};

/**
 * 악보 레이아웃 정보.
 * - 악보의 기본 구성과 행 순서, 시각적 표시를 위한 정보를 제공한다.
 */
export type LayoutData = {
  baseColumnWidthPx: number;        // 열의 기본 너비
  rowDefinitions: RowDefinition[];  // 행 위->아래 순으로 나열
};

export type RowDefinition =
  | GlobalRowDefinition   // 전역 행 정의
  | NoteRowDefinition     // 노트 행 정의
  | GapRowDefinition;     // 갭 행 정의

export type GlobalRowDefinition = {
  rowId: RowId;         // 전역 행의 RowId. 종류: global-bpm / global-bpb / global-spb / global-dyn
  type: "global";       // 전역 행 타입 : "global"
  kind: GlobalKind;     // 종류
  height: number;       // 행의 높이(px)
};

export type NoteRowDefinition = {
  rowId: RowId;         // 노트 행의 RowId. 형식: `{stringId}-note-{midi}`
  type: "note";         // 노트 행 타입 : "note"
  stringId: StringId;   // 소속 StringId
  midi: number;         // 할당 음정의 MIDI 노트 번호
  height: number;       // 행의 높이(px)
  displayLabel: string; // 레이아웃 캔버스에 표시될 단어
};

export type GapRowDefinition = {
  rowId: RowId;         // 갭 행의 RowId. 형식: `{stringId}-gap-{fromMidi}-{toMidi}`
  type: "gap";          // 갭 행 타입 : "gap"
  stringId: StringId;   // 소속 StringId
  fromMidi: number;     // 갭행과 이웃한 음정 중 저음
  toMidi: number;       // 갭행과 이웃한 음정 중 고음
  height: number;       // 행의 높이 (px)
};

/**
 * 악보 전역 정보.
 * - 악보의 열 개수(=길이)
 * - 전역 행 셀 입력 정보.
 */
export type GlobalLines = {
  columnCount: number;      // 악보의 전체 열 개수
  cells: GlobalCell[];      // 전역 행의 셀 입력 정보
};

export type GlobalCell = {
  rowId: RowId;             // 전역 행 좌표
  col: number;              // 열 좌표
  rawText: string;          // 입력된 원본 문자열
};

/**
 * 트랙별 정보.
 * - 단일 트랙에 속한 셀 입력 정보
 */
export type Track = {
  trackId: TrackId;     // 이 입력이 어느 트랙의 입력인지
  trackName: string;    // UI상에 표시되는 트랙 이름
  cells: ScoreCell[];   // 셀 입력 정보
};

export type ScoreCell = {
  rowId: RowId;         // 행 좌표
  col: number;          // 열 좌표
  rawText: string;      // 입력된 원본 문자열
};

/** 후속 모듈에서 참고할 악보 전체의 해석 정보와 실행시간용 요약 정보의 종합 타입. */
export type RuntimeDocument = {
  score: ScoreFile;       // 악보 파일의 해석 정보
  indexes: ScoreIndexes;  // ScoreFile을 바탕으로 생성된 핵심 정보 요약본
};

/** 악보 파일 전체의 원본. */
export type ScoreFile = {
  format: ScoreFormat;
  musicData: MusicData;
  instData: InstrumentData;
  layout: LayoutData;
  globalLines: GlobalLines;
  tracks: Track[];
};

/**
 * 자주 찾게 될 정보를 매핑해둔 요약 정보.
 * - 런타임에 validator 통과 이후 생성된다.
 */
export type ScoreIndexes = {
  /** 용도 : RowId에서 바로 행 종류, 할당 현, MIDI 정보 파악 가능. */
  rowById: Map<RowId, RowDefinition>;

  /** 용도 : 기본 렌더링 순서에 따라 배치된 행 배열. */
  rowsInDisplayOrder: RowDefinition[];

  /** 용도 : 특정 현에 소속된 행을 빠른 조회. */
  noteRowIdsByStringId: Map<StringId, RowId[]>;

  /** 용도 : `@n(midi_num)`을 실제 행과 연결. */
  noteRowIdByStringMidi: Map<`${StringId}|${number}`, RowId>;

  /** 용도 : 트랙별 내부 정보에 ID만으로 빠른 접근. */
  trackById: Map<TrackId, Track>;

  /** 용도 : 트랙, 좌표 정보로 단일 셀을 빠르게 조회. */
  cellMapByTrackId: Map<TrackId, Map<CellCoordKey, ScoreCell>>;

  /** 용도 : 특정 열에 포함된 셀 집합 모두 찾기 */
  cellsByTrackAndCol: Map<TrackId, Map<number, ScoreCell[]>>;

  /** 용도 : 행렬 좌표로 단일 전역 셀을 빠르게 조회. */
  globalCellMapByCoord: Map<GlobalCellCoordKey, GlobalCell>;

  /** 용도 : 특정 전역 행 내부의 셀 조회 */
  globalCellsByKindAndCol: Map<GlobalKind, Map<number, GlobalCell>>;

  /** 용도 : 입력된 전역 셀의 시간 오름차순 파악. */
  globalCellsInColOrder: Map<GlobalKind, GlobalCell[]>;
};

export type CellCoordKey = `${RowId}|${number}`;
export type GlobalCellCoordKey = `${RowId}|${number}`;
