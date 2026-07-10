// 住環境見取り図アプリのデータモデル。
// ジェノグラムアプリ(genogram_web)とは別データ構造だが、保存の考え方（1ケース=1書類、
// 端末への複数ケース自動保存）は同じ設計を踏襲する。

(function (Madori) {
  // 家具・設備アイコンの種類。値はcanvas.jsのdrawFixtureIcon()が参照するキー。
  const FixtureType = {
    DOOR: "door",
    SLIDING_DOOR: "sliding_door",
    DOUBLE_DOOR: "double_door",
    PARENT_CHILD_DOOR: "parent_child_door",
    FOLDING_DOOR: "folding_door",
    OPENING: "opening",
    WINDOW: "window",
    TOILET: "toilet",
    BATHTUB: "bathtub",
    SINK: "sink",
    KITCHEN: "kitchen",
    BED: "bed",
    TABLE: "table",
    WHEELCHAIR: "wheelchair",
    PORTABLE_TOILET: "portable_toilet",
    HANDRAIL_V: "handrail_v",
    HANDRAIL_H: "handrail_h",
    HANDRAIL_L: "handrail_l",
    STEP: "step",
    RAMP: "ramp",
    STAIRS: "stairs",
    NORTH: "north",
    ARROW: "arrow",
    CUSTOM: "custom",
  };

  // 「自由入力」種類で選べる図形の一覧
  const CustomShape = {
    RECT: "rect",
    CIRCLE: "circle",
    TRIANGLE: "triangle",
    DIAMOND: "diamond",
  };

  // 壁に自動フィットする（開口部として扱う）種類。ドア・窓は部屋の辺に近づけると
  // 壁に隙間ができ、壁の向きに合わせて自動で回転する。それ以外の家具は自由配置のまま。
  const WALL_ATTACHABLE_TYPES = [
    FixtureType.DOOR,
    FixtureType.SLIDING_DOOR,
    FixtureType.DOUBLE_DOOR,
    FixtureType.PARENT_CHILD_DOOR,
    FixtureType.FOLDING_DOOR,
    FixtureType.OPENING,
    FixtureType.WINDOW,
  ];

  // 壁の辺ごとの回転角度。アイコンは「上側の壁に取り付き、部屋の内側(+y方向)へ
  // 開く」向きを基準(0度)に描く前提で統一している（canvas.jsのdrawFixtureIcon参照）。
  const WALL_SIDE_ROTATION = { top: 0, right: 90, bottom: 180, left: 270 };

  // パレットに並べる順番・日本語ラベル・既定サイズ(幅,高さ／ワールド座標)。
  // 全種類とも角のハンドルでリサイズでき、初期値はあくまで置いた時の目安。
  const FIXTURE_CATALOG = [
    { type: FixtureType.DOOR, label: "開き戸", w: 50, h: 50 },
    { type: FixtureType.SLIDING_DOOR, label: "引き戸", w: 60, h: 16 },
    { type: FixtureType.DOUBLE_DOOR, label: "両開き戸", w: 80, h: 40 },
    { type: FixtureType.PARENT_CHILD_DOOR, label: "親子扉", w: 90, h: 50 },
    { type: FixtureType.FOLDING_DOOR, label: "折れ戸", w: 50, h: 34 },
    { type: FixtureType.OPENING, label: "開口部(勝手口・扉なし)", w: 50, h: 16 },
    { type: FixtureType.WINDOW, label: "窓", w: 50, h: 12 },
    { type: FixtureType.TOILET, label: "便器", w: 40, h: 50 },
    { type: FixtureType.BATHTUB, label: "浴槽", w: 70, h: 40 },
    { type: FixtureType.SINK, label: "洗面台", w: 50, h: 34 },
    { type: FixtureType.KITCHEN, label: "キッチン(シンク)", w: 80, h: 40 },
    { type: FixtureType.BED, label: "ベッド", w: 60, h: 100 },
    { type: FixtureType.TABLE, label: "テーブル・椅子", w: 70, h: 70 },
    { type: FixtureType.WHEELCHAIR, label: "車椅子", w: 44, h: 50 },
    { type: FixtureType.PORTABLE_TOILET, label: "ポータブルトイレ", w: 40, h: 40 },
    { type: FixtureType.HANDRAIL_V, label: "縦手すり", w: 12, h: 60 },
    { type: FixtureType.HANDRAIL_H, label: "横手すり", w: 60, h: 12 },
    { type: FixtureType.HANDRAIL_L, label: "L型手すり", w: 60, h: 60 },
    { type: FixtureType.STEP, label: "段差解消", w: 60, h: 20 },
    { type: FixtureType.RAMP, label: "スロープ", w: 50, h: 70 },
    { type: FixtureType.STAIRS, label: "階段", w: 80, h: 140 },
    { type: FixtureType.NORTH, label: "方位記号(北)", w: 36, h: 36 },
    { type: FixtureType.ARROW, label: "動線矢印", w: 90, h: 16 },
    { type: FixtureType.CUSTOM, label: "✏️ 自由入力", w: 60, h: 60 },
  ];

  function findCatalogEntry(type) {
    return FIXTURE_CATALOG.find((e) => e.type === type) || FIXTURE_CATALOG[0];
  }

  function isWallAttachable(type) {
    return WALL_ATTACHABLE_TYPES.indexOf(type) !== -1;
  }

  let idCounter = 0;
  function makeId(prefix) {
    idCounter += 1;
    return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
  }

  function createRoom(overrides) {
    return Object.assign(
      {
        id: makeId("room"),
        x: 0,
        y: 0,
        width: 140,
        height: 100,
        label: "部屋",
        tatami: "", // 任意の畳数など（文字列のまま自由記入、例："6帖"）
        manuallyMoved: true, // 部屋は常に手動配置なので他アプリのような自動整列は行わない
      },
      overrides || {}
    );
  }

  function createFixture(type, overrides) {
    const entry = findCatalogEntry(type);
    return Object.assign(
      {
        id: makeId("fixture"),
        type,
        x: 0,
        y: 0,
        width: entry.w,
        height: entry.h,
        rotation: 0, // 0/90/180/270度（壁付け中は壁の向きに自動設定される）
        flipped: false, // 左右反転。ドアの丁番側など、回転だけでは表現できない向きに対応する
        label: "", // 任意の注釈（例："手すり 高さ75cm"）。CUSTOM種類ではこれが表示名そのものになる
        wall: null, // 壁に自動フィットした場合 {roomId, side, offset}（offsetは壁沿いの中心位置）
        customShape: type === FixtureType.CUSTOM ? CustomShape.RECT : null, // CUSTOM種類のみ使う図形の種類
      },
      overrides || {}
    );
  }

  function duplicateRoom(room) {
    return createRoom(
      Object.assign({}, room, {
        id: makeId("room"),
        x: room.x + 24,
        y: room.y + 24,
      })
    );
  }

  function duplicateFixture(fixture) {
    return createFixture(
      fixture.type,
      Object.assign({}, fixture, {
        id: makeId("fixture"),
        x: fixture.x + 24,
        y: fixture.y + 24,
        // 壁に付いていた場合、複製後も同じ壁のwallの上に重ねて置いてしまうと開口部が
        // 重複して分かりにくくなるため、複製直後は自由配置に戻す（必要ならドラッグで
        // 別の壁に付け直してもらう）
        wall: null,
      })
    );
  }

  function createAnnotation(overrides) {
    return Object.assign(
      {
        id: makeId("text"),
        x: 0,
        y: 0,
        text: "メモ",
      },
      overrides || {}
    );
  }

  function createDocument(overrides) {
    return Object.assign(
      {
        caseId: null,
        caseLabel: "", // 例："主任ケアマネ更新研修用"
        title: "", // 対象者名・案件名など
        creatorName: "",
        note: "",
        rooms: [],
        fixtures: [],
        annotations: [],
        updatedAt: Date.now(),
      },
      overrides || {}
    );
  }

  Madori.FixtureType = FixtureType;
  Madori.CustomShape = CustomShape;
  Madori.WALL_ATTACHABLE_TYPES = WALL_ATTACHABLE_TYPES;
  Madori.WALL_SIDE_ROTATION = WALL_SIDE_ROTATION;
  Madori.FIXTURE_CATALOG = FIXTURE_CATALOG;
  Madori.findCatalogEntry = findCatalogEntry;
  Madori.isWallAttachable = isWallAttachable;
  Madori.makeId = makeId;
  Madori.createRoom = createRoom;
  Madori.duplicateRoom = duplicateRoom;
  Madori.createFixture = createFixture;
  Madori.duplicateFixture = duplicateFixture;
  Madori.createAnnotation = createAnnotation;
  Madori.createDocument = createDocument;
})((window.Madori = window.Madori || {}));
